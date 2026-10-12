// Nestrel's push notification sender (2026-10-12)
//
// This is the only piece of Nestrel that runs on a server. It lives on Supabase as an Edge Function
// and is never published on nestrel.org (.vercelignore leaves this folder out).
//
// Its name on Supabase is `dynamic-action`: the random name the dashboard editor gave it. A function's
// address cannot be renamed, so the database triggers (push_notify) call that name. The folder here
// carries the same name, so the repo always says what is deployed.
//
// WHO CALLS IT: the database. sql/changes/2026-10-12_push_notifications.sql puts triggers on
// `messages` and `listings` that send it {"kind": "message" | "listing", "id": "…"} and nothing else.
//
// WHAT IT DOES
//   1. asks the database push_targets(kind, id) which devices to alert and what to say. The database
//      answers each id once, only while it is fresh, and decides every word — so this function is
//      safe to leave open (Supabase's "Verify JWT" switch OFF): calling it can only ever cause an
//      alert that was going to be sent anyway.
//   2. encrypts the alert separately for each device (only that device can read it) and signs the
//      request with Nestrel's VAPID key (proves to Apple/Google that it really comes from Nestrel)
//   3. hands each one to the device's push service, and tells the database to forget any device
//      the push service says is gone (the student turned notifications off, or signed out)
//
// SECRETS it needs (Supabase → Edge Functions → Secrets): VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// The public key is also in js/push.js (PUSH_PUBLIC_KEY). The two must be a matching pair.
//
// No web-push library on purpose: the standard (RFC 8291 encryption + RFC 8292 VAPID) is about
// 80 lines of the browser-style crypto Deno already has, and a library built for Node is the most
// likely thing to break here. tests/push-crypto.js checks this code against an independent
// implementation of the same standard.

import { createClient } from 'npm:@supabase/supabase-js@2.117.1';

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
// Who to contact about these pushes, if a push service ever needs to. Apple rejects a subject that
// is not a real https address or mailto:.
const SUBJECT = 'https://www.nestrel.org';
// The same list as the endpoint check on push_subscriptions. Never send anywhere else.
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

type Device = { endpoint: string; p256dh: string; auth: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return reply({ error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set (Edge Functions → Secrets)' }, 500);

  let kind = '', id = '';
  try {
    const b = await req.json();
    kind = String(b.kind ?? '');
    id = String(b.id ?? '');
  } catch {
    return reply({ error: 'expected {"kind": …, "id": …}' }, 400);
  }

  const { data, error } = await db.rpc('push_targets', { p_kind: kind, p_id: id });
  if (error) { console.error('push_targets:', error.message); return reply({ error: error.message }, 500); }
  if (!data) return reply({ sent: 0, note: 'nothing to send' });

  const payload = new TextEncoder().encode(JSON.stringify(data.payload));
  const urgency = data.payload.urgency === 'high' ? 'high' : 'normal';
  const key = await vapidSigningKey(VAPID_PUBLIC, VAPID_PRIVATE);
  const devices: Device[] = data.devices ?? [];

  const gone: string[] = [];
  let sent = 0, failed = 0;
  // 50 at a time: fast for one message (one or two devices), and gentle for a listing alert that
  // goes to everyone.
  for (let i = 0; i < devices.length; i += 50) {
    await Promise.all(devices.slice(i, i + 50).map(async (d) => {
      const host = safeHost(d.endpoint);
      try {
        const res = await sendPush(d, payload, key, urgency);
        const text = await res.text();
        if (res.ok) sent++;
        else if (res.status === 404 || res.status === 410) gone.push(d.endpoint);   // the device unsubscribed
        else { failed++; console.error('push refused by', host, res.status, text.slice(0, 200)); }
      } catch (e) {
        failed++;
        console.error('push error for', host, String(e));
      }
    }));
  }

  if (gone.length) {
    const { error: fe } = await db.rpc('push_forget', { p_endpoints: gone });
    if (fe) console.error('push_forget:', fe.message);
  }
  return reply({ sent, removed: gone.length, failed });
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Logs name the push service only (fcm.googleapis.com, web.push.apple.com), never the device address.
function safeHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return '?'; }
}

async function sendPush(d: Device, payload: Uint8Array, key: CryptoKey, urgency: string): Promise<Response> {
  if (!PUSH_HOSTS.test(d.endpoint)) throw new Error('not a known push service');
  const body = await encryptPayload(payload, d.p256dh, d.auth);
  const jwt = await vapidJWT(d.endpoint, key, SUBJECT);
  return fetch(d.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',                       // keep trying for a day if the phone is off
      'Urgency': urgency,                   // 'high' wakes a sleeping phone for a message
      'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
    },
    body,
  });
}

// ===== WEB PUSH CRYPTO ===========================================================================
// Everything below uses only the standard Web Crypto API, so the same code runs in Deno (here) and in
// Node (tests/push-crypto.js). Keys travel as base64url, the format browsers hand them out in.

const utf8 = new TextEncoder();

function b64uDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

// RFC 8291: encrypt one alert for one device ("aes128gcm" content coding, a single record).
//   p256dh = the device's public key, auth = its 16-byte secret; both come from the browser.
async function encryptPayload(plain: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dh);                     // 65 bytes
  const authSecret = b64uDecode(auth);                     // 16 bytes
  // A fresh key pair for every alert, so no two alerts share a key.
  const ours = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ours.publicKey));
  const theirs = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, ours.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks "last record" (RFC 8188); no extra padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plain, new Uint8Array([2]))));

  // Header: salt (16) | record size (4, = 4096) | key id length (1, = 65) | our public key (65)
  return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic, sealed);
}

// RFC 8292 (VAPID): the key that signs every request. The public key is the 65-byte point the
// browser was given (x and y); the private key is the 32-byte secret (d).
async function vapidSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64uDecode(publicKey);
  // A secret that happens to start with a zero byte can come out of a key generator 31 bytes long;
  // the JWK format insists on exactly 32, so put the zero back.
  const raw = b64uDecode(privateKey);
  const d = concat(new Uint8Array(Math.max(0, 32 - raw.length)), raw);
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: b64uEncode(d),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// A short-lived signed note: "this request is for <push service>, from <subject>, valid 12 hours".
// The standard allows at most 24 hours.
async function vapidJWT(endpoint: string, key: CryptoKey, subject: string): Promise<string> {
  const head = b64uEncode(utf8.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(utf8.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  // Web Crypto's ECDSA signature is already the raw 64-byte r|s form a JWT wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64uEncode(sig)}`;
}
