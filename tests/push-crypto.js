// Checks the encryption and signing in supabase/functions/dynamic-action/index.ts — the part of push
// notifications that cannot be seen working until a real phone shows a real alert, and fails
// silently when it is wrong (the push service just answers "bad request" and nothing appears).
//
//   node tests/push-crypto.js
//
// What it checks:
//   1. The official example from the encryption standard (RFC 8291, section 5): with the RFC's keys
//      and salt, our code must produce the RFC's message byte for byte.
//   2. A random round trip: encrypt with our code, decrypt with a second implementation written
//      here with Node's own crypto (HMAC by hand), the way a phone would.
//   3. The VAPID signature: Node verifies our signed note with the public key, and the note says
//      the right push service, a real https subject, and expires in under 24 hours.
//   4. A private key that comes out 31 bytes long (it happens when the secret starts with a zero
//      byte) still works.
//
// It reads the crypto section of index.ts (everything after "===== WEB PUSH CRYPTO"), so it tests
// the exact code that is deployed. Needs Node 23.6 or newer, which runs TypeScript directly.
// Exits non-zero on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/dynamic-action/index.ts'), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);
const b64u = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

async function loadCrypto() {
  const at = SRC.indexOf('// ===== WEB PUSH CRYPTO');
  if (at < 0) throw new Error('marker "// ===== WEB PUSH CRYPTO" not found in index.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-crypto-'));
  const file = path.join(dir, 'webpush.ts');
  fs.writeFileSync(file, SRC.slice(at) + '\nexport { encryptPayload, vapidSigningKey, vapidJWT, b64uEncode, b64uDecode };\n');
  try { return await import(pathToFileURL(file).href); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- an independent decryptor (RFC 8291 + RFC 8188), with HKDF written out as plain HMAC ----
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function decrypt(body, uaECDH, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = uaECDH.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaECDH.getPublicKey(), asPublic]);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  let i = plain.length - 1;
  while (i >= 0 && plain[i] === 0) i--;
  if (plain[i] !== 2) throw new Error('last-record marker (0x02) missing');
  return { plain: plain.subarray(0, i), recordSize: body.readUInt32BE(16) };
}

(async () => {
  const wp = await loadCrypto();

  // ---- 1. RFC 8291 section 5, byte for byte ----
  {
    const asPub = b64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const asPriv = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
    const uaPub = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    const auth = 'BTBZMqHH6r4Tts7J_aSIgg';
    const salt = b64u('DGv6ra1nlYgDCS1FRnbzlw');
    const expected = b64u(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
      mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
      pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`);

    // Hand our code the RFC's "random" key pair and salt instead of fresh ones.
    const subtle = globalThis.crypto.subtle;
    const realGen = subtle.generateKey, realRand = globalThis.crypto.getRandomValues;
    const jwk = { kty: 'EC', crv: 'P-256', x: asPub.subarray(1, 33).toString('base64url'), y: asPub.subarray(33).toString('base64url') };
    const pair = {
      publicKey: await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
      privateKey: await subtle.importKey('jwk', { ...jwk, d: asPriv }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    };
    subtle.generateKey = async () => pair;
    globalThis.crypto.getRandomValues = (arr) => { arr.set(salt); return arr; };
    let got;
    try { got = Buffer.from(await wp.encryptPayload(new TextEncoder().encode('When I grow up, I want to be a watermelon'), uaPub, auth)); }
    finally { subtle.generateKey = realGen; globalThis.crypto.getRandomValues = realRand; }
    if (got.equals(expected)) pass('RFC 8291 example: identical to the standard, byte for byte');
    else fail(`RFC 8291 example differs\n        got      ${got.toString('base64url')}\n        expected ${expected.toString('base64url')}`);
  }

  // ---- 2. Random round trip through the independent decryptor ----
  {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const message = JSON.stringify({ title: 'Sam Rivera', body: 'Is the room still free? 🏠', url: '/#/chat/x', tag: 'chat-x' });
    const body = Buffer.from(await wp.encryptPayload(new TextEncoder().encode(message), ua.getPublicKey().toString('base64url'), authSecret.toString('base64url')));
    try {
      const { plain, recordSize } = decrypt(body, ua, authSecret);
      if (plain.toString('utf8') === message) pass('random round trip: decrypts to the same alert (emoji included)');
      else fail('random round trip: decrypted to something else');
      if (recordSize === 4096) pass('header: record size 4096'); else fail('header: record size ' + recordSize);
    } catch (e) { fail('random round trip: ' + e.message); }
  }

  // ---- 3 + 4. VAPID signature, with a normal and a 31-byte private key ----
  async function checkVapid(label, wantShortKey) {
    let ecdh, pubRaw, privRaw;
    // Node itself hands such a key out 31 bytes long (it drops the leading zero) — exactly what
    // the web-push key generator is built on. About 1 key in 256; look until one turns up.
    for (let i = 0; i < 5000; i++) {
      ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      privRaw = ecdh.getPrivateKey();
      if (!wantShortKey || privRaw.length < 32 || privRaw[0] === 0) break;
    }
    pubRaw = ecdh.getPublicKey();
    const privOut = wantShortKey && privRaw.length === 32 ? privRaw.subarray(1) : privRaw;
    if (wantShortKey && privOut.length !== 31) { fail(`${label}: could not make a 31-byte key to test with`); return; }
    const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH-xyz';
    try {
      const key = await wp.vapidSigningKey(pubRaw.toString('base64url'), privOut.toString('base64url'));
      const jwt = await wp.vapidJWT(endpoint, key, 'https://www.nestrel.org');
      const [h, c, s] = jwt.split('.');
      const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pubRaw.subarray(1, 33).toString('base64url'), y: pubRaw.subarray(33).toString('base64url') }, format: 'jwk' });
      const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
      const head = JSON.parse(Buffer.from(h, 'base64url'));
      const claims = JSON.parse(Buffer.from(c, 'base64url'));
      const life = claims.exp - Math.floor(Date.now() / 1000);
      if (ok) pass(`${label}: signature verifies with the public key`); else fail(`${label}: signature does not verify`);
      if (head.alg === 'ES256' && head.typ === 'JWT') pass(`${label}: header ES256 / JWT`); else fail(`${label}: header ${JSON.stringify(head)}`);
      if (claims.aud === 'https://web.push.apple.com') pass(`${label}: aud is the push service's origin`); else fail(`${label}: aud ${claims.aud}`);
      if (life > 0 && life <= 24 * 3600) pass(`${label}: expires in ${Math.round(life / 3600)} h (limit 24)`); else fail(`${label}: expires in ${life}s`);
      if (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/.test(claims.sub) || claims.sub.startsWith('mailto:')) pass(`${label}: subject is a real https address`); else fail(`${label}: subject ${claims.sub}`);
    } catch (e) { fail(`${label}: ${e.message}`); }
  }
  await checkVapid('VAPID', false);
  await checkVapid('VAPID, 31-byte private key', true);

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll push crypto checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
