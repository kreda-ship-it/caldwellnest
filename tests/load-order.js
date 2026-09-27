// Loads every js/ file the way the BROWSER loads them — in the order index.html lists
// them, concatenated into ONE shared scope — and reports anything that would stop a
// file executing. Then checks that every icon name the app asks for actually exists.
//
// Why this exists. The js/ files are plain scripts, not modules, so they all share one
// global scope. That means two files can each be perfectly valid on their own and still
// break the app together: a `const` declared in two files is a SyntaxError, and the file
// that loses stops executing entirely. `node --check` reads one file at a time and cannot
// see it.
//
// That is not hypothetical. Adding CATEGORY_ICON to config.js when listings.js already
// had one stopped listings.js from ever running, which removed showPage, goHome and
// renderListings. The visible symptom was logging in and staying on the landing page —
// no error, no clue. This harness finds that in about a second.
//
//   node tests/load-order.js
//
// Exits non-zero on failure, so it can gate a commit.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = [...html.matchAll(/src="(js\/[a-z]+\.js)/g)].map(m => m[1]);

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);

// ---------------------------------------------------------------- a fake browser
// Deliberately permissive: this harness is not testing behaviour, only that each file
// can be parsed and executed to the point where its functions are defined.
const el = new Proxy(function () {}, {
  get: (t, k) =>
    k === 'style' ? {} :
    k === 'classList' ? { add() {}, remove() {}, contains: () => false, replace() {}, toggle() {} } :
    k === 'dataset' ? {} :
    (typeof k === 'string' && /^(innerHTML|textContent|value|id|className)$/.test(k)) ? '' : el,
  set: () => true,
  apply: () => el,
  has: () => true,
});
const doc = {
  getElementById: () => el, querySelector: () => el, querySelectorAll: () => [],
  createElement: () => el, addEventListener() {}, removeEventListener() {},
  body: el, documentElement: el, head: el, cookie: '',
};
const storage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const supabaseStub = new Proxy(function () {}, { get: () => supabaseStub, apply: () => supabaseStub });

const ctx = {
  console: { log() {}, warn() {}, error() {}, info() {} },  // the app logs on load; stay quiet
  document: doc, localStorage: storage, sessionStorage: storage,
  location: { href: 'http://127.0.0.1:5500/', search: '', hash: '', pathname: '/', origin: 'http://127.0.0.1:5500' },
  navigator: { userAgent: 'load-order-harness', onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => f(), cancelAnimationFrame() {},
  fetch: () => Promise.resolve({ json: () => ({}), ok: true }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  supabase: { createClient: () => supabaseStub },
  alert() {}, confirm: () => true, prompt: () => null,
  URL, URLSearchParams, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean,
  RegExp, Error, Map, Set, WeakMap, isNaN, parseInt, parseFloat, encodeURIComponent,
  decodeURIComponent, Intl, TextEncoder, TextDecoder, btoa: (s) => s, atob: (s) => s,
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

console.log(`\nLoading ${files.length} files from index.html, in order, as one scope\n`);

// ------------------------------------------------- 1. duplicate top-level declarations
// Reported before executing, because the error a collision produces names the identifier
// but not the two files it came from — which is the part you actually need.
const declaredIn = new Map();
for (const f of files) {
  for (const [, kind, name] of fs.readFileSync(path.join(ROOT, f), 'utf8')
    .matchAll(/^(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!declaredIn.has(name)) declaredIn.set(name, []);
    declaredIn.get(name).push({ file: f, kind });
  }
}
const clashes = [...declaredIn.entries()].filter(([, where]) => {
  if (where.length < 2) return false;
  // Two `function` declarations of the same name are legal — the last one wins. Only
  // const/let/class actually throw.
  return where.some(w => w.kind !== 'function' && w.kind !== 'var');
});
if (clashes.length) {
  for (const [name, where] of clashes) {
    fail(`'${name}' declared in ${where.map(w => `${w.file} (${w.kind})`).join(' and ')}`);
  }
  console.log('\n        Two top-level const/let/class of the same name is a SyntaxError.');
  console.log('        The losing file will not execute at all — rename one of them.\n');
} else {
  pass(`no duplicate top-level const/let/class across ${files.length} files`);
}

// ---------------------------------------------------------------- 2. does it all run
const bundle = files
  .map(f => `\n//# ${f}\n` + fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n;\n');
let ran = false;
try {
  vm.runInContext(bundle, ctx, { filename: 'js/* (concatenated)' });
  ran = true;
  pass('every file executes');
} catch (e) {
  fail(`execution stopped: ${e.message}`);
}

// -------------------------------------------------- 3. the functions the app navigates by
// If any of these are missing, the app loads but cannot move between pages — the quiet
// failure mode this harness was written for.
if (ran) {
  const required = ['showPage', 'goHome', 'goSearch', 'renderListings', 'updateSNav',
                    'enterStudentSession', 'icon', 'catIcon', 'toast', 'openModal',
                    'renderFeed', 'loadEvents'];
  const missing = required.filter(fn => typeof ctx[fn] !== 'function');
  missing.length
    ? fail(`missing after load: ${missing.join(', ')}`)
    : pass(`all ${required.length} core functions defined`);
}

// ---------------------------------------------------------------- 4. every icon resolves
if (ran) {
  const asked = new Set();
  for (const f of files) {
    for (const [, name] of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/\bicon\('([a-zA-Z]+)'/g)) {
      asked.add(name);
    }
  }
  try {
    const missing = vm.runInContext(`(${JSON.stringify([...asked])}).filter(n => !(n in ICON))`, ctx);
    missing.length
      ? fail(`icon names with no entry in ICON: ${missing.join(', ')}`)
      : pass(`all ${asked.size} icon names resolve`);

    const badCats = vm.runInContext(
      `Object.entries(CATEGORY_ICON).filter(([, n]) => !(n in ICON)).map(([c]) => c)`, ctx);
    badCats.length
      ? fail(`categories with no icon: ${badCats.join(', ')}`)
      : pass('every listing category resolves to an icon');
  } catch (e) {
    fail(`icon registry not reachable: ${e.message}`);
  }
}

// ------------------------------------------------ 5. calls trapped in template literal TEXT
// A quirk of how the emoji-to-icon conversion was done, and it has bitten twice. Replacing a
// glyph with `${icon('flag',14)}` is correct inside a template literal; rewriting it to
// `' + icon('flag',14) + '` is correct inside a single-quoted string. Applying the second
// repair to the first kind of string turns working code into literal characters, and the
// button then renders the text  ' + icon('flag',14) + ' Report this listing.
//
// It parses, so node --check is happy. It only shows up by looking at the screen — which is
// how it survived: the detail modal's Report link and two admin controls shipped that way.
//
// Two signals together, because either alone is noisy. The call must sit immediately after
// a '>' — the damage only ever happened where a glyph followed markup — and the line must
// also contain a backtick, since a legitimate concatenation of this shape lives in a plain
// single-quoted string and never shares a line with one.
//
// Matching only the first half flags `'v' + esc(v)` inside a ${...}, which is correct code.
// An earlier attempt used a string/template state machine and drifted on regex literals,
// reporting ordinary code as broken. A check you learn to ignore is worse than no check.
{
  const suspects = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((ln, i) => {
      if (/>['"] \+ (icon|catIcon|esc|escAttr)\(/.test(ln) && ln.includes('`')) {
        suspects.push(`${f}:${i + 1}`);
      }
    });
  }
  suspects.length
    ? fail(`call(s) may be trapped as text inside a template literal: ${suspects.join(', ')}\n` +
           `        Inside a template literal use \${icon('name',14)}, not ' + icon('name',14) + '.`)
    : pass('no icon()/esc() calls trapped in template literal text');
}

// ------------------------------------------------ 6. another student's text stays text
// renderListingGrid() draws a student's listings on THEIR profile — and viewStudentProfile()
// uses it for someone ELSE's, so whatever a student types into a title is rendered in the
// browser of every visitor. It wrote the title and the photo URL into innerHTML unescaped.
// Found 2026-09-11 while wiring the profile counts; xss-test.html never exercised this path,
// which is why it survived. The two payloads are the two ways in: markup in a title, and a
// quote in a photo URL that closes src="…" and opens an attribute of its own.
if (ran) {
  const TITLE = '<img src=x onerror=alert(1)>';
  const URL_  = 'x" onerror="alert(1)';
  ctx.__hostile = [
    { id: 1, title: TITLE, category: 'housing', rent: 5, photo_urls: [URL_], lifecycle_status: 'active', status: 'approved' },
    { id: 2, title: TITLE, category: 'housing', rent: 5, photo_urls: [],     lifecycle_status: 'sold',   status: 'approved' },
  ];
  try {
    const out = vm.runInContext('renderListingGrid(__hostile, false) + renderListingGrid(__hostile, true)', ctx);
    const leaks = [out.includes(TITLE) && 'title rendered as markup', out.includes(URL_) && 'photo URL broke out of src'].filter(Boolean);
    leaks.length ? fail(`renderListingGrid: ${leaks.join('; ')}`) : pass('hostile listing title and photo URL stay text in renderListingGrid');
  } catch (e) {
    fail(`renderListingGrid could not be exercised: ${e.message}`);
  }
}

// ------------------------------------------------ 7. a typed URL cannot become script
// safeUrl() guards hrefs built from what a student typed — first a club's website on its own
// page, which officers set and every visitor is invited to click. escAttr() alone keeps a value
// inside href="…" but cannot stop javascript:… from being a valid href. Found 2026-09-11 while
// rebuilding that page's contact rows.
if (ran) {
  try {
    const cases = [
      ['javascript:alert(1)', 'blocked'], [' JavaScript:alert(1)', 'blocked'],
      ['data:text/html,<b>x</b>', 'blocked'], ['vbscript:msgbox(1)', 'blocked'],
      ['java\nscript:alert(1)', 'never-script'], ['', 'blocked'],
      ['https://caldwell.edu/chess', 'kept'], ['chessclub.org', 'kept'],
    ];
    const bad = [];
    for (const [input, want] of cases) {
      const out = vm.runInContext(`safeUrl(${JSON.stringify(input)})`, ctx);
      const ok = want === 'kept' ? /^https?:\/\//.test(out)
               : want === 'blocked' ? out === ''
               : out === '' || /^https?:\/\//.test(out);
      if (!ok) bad.push(`${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
    bad.length ? fail(`safeUrl let something through: ${bad.join('; ')}`)
               : pass('safeUrl keeps http(s) and blocks javascript:, data:, vbscript: and the whitespace tricks');
  } catch (e) {
    fail(`safeUrl could not be exercised: ${e.message}`);
  }
}

// ------------------------------------------------ 8. every inline handler calls something real
// An onclick naming a function that nothing defines does nothing when tapped: no error on screen,
// just a dead button. It parses, it renders, it looks right. Found 2026-09-11 — every draft
// event's green "Publish" button called ocEvPublish(), which had never been written.
//
// typeof is asked of the sandbox rather than of the global object, so a handler that calls a
// top-level const arrow function counts as defined too. `var` is here for the CSS var(--x) that
// sits inside some inline style strings, and prompt() is the browser's own.
if (ran) {
  const BUILTIN = new Set(['event', 'this', 'if', 'return', 'confirm', 'alert', 'prompt', 'setTimeout',
    'clearTimeout', 'history', 'location', 'Number', 'String', 'Boolean', 'JSON', 'Math', 'Date', 'parseInt',
    'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'console', 'requestAnimationFrame',
    'Promise', 'Object', 'Array', 'typeof', 'new', 'void', 'var']);
  const sources = [['index.html', html], ...files.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])];
  const dead = new Set();
  for (const [f, s] of sources) {
    for (const m of s.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|blur|focus)\s*=\s*"([^"]*)"/g)) {
      for (const [, name] of m[1].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (BUILTIN.has(name)) continue;
        if (vm.runInContext(`typeof ${name}`, ctx) === 'function') continue;
        dead.add(`${name}() at ${f}:${s.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  dead.size ? fail(`inline handler(s) call a function that does not exist: ${[...dead].join(', ')}`)
            : pass('every inline handler calls a function that exists');
}

// ------------------------------------------------ 9. a log entry's text stays out of onclick
// Students write rows into admin_activity_log on purpose — logEvent() records their own actions —
// and the admin dashboard draws the newest ones with activityItem() the moment an admin signs in.
// It used to paste target_id into onclick="undoActivityEntry('…')". esc() cannot help there: the
// browser decodes &#39; back into ' BEFORE the JavaScript runs, so one quote turned a student's
// text into code running in the admin's browser. Found 2026-09-25 (security audit, H1).
//
// The payload closes both the JavaScript string and the attribute, so either way out is caught.
// target_label is kept plain on purpose: it goes through esc(), which leaves the words "alert(1)"
// visible as harmless text, and that would make this check fail for the wrong reason.
if (ran) {
  const PAYLOAD = `1');alert(1);//"><img src=x onerror=alert(1)>`;
  ctx.__logRow = { id: 7, action_type: 'approve_listing', target_type: 'listing', target_id: PAYLOAD,
                   target_label: 'A listing', created_at: '2026-09-25T12:00:00Z', undone_at: null };
  try {
    const out = vm.runInContext('activityItem(__logRow)', ctx);
    const leaks = [
      out.includes('alert(1)')           && 'target_id reached the markup',
      !out.includes('undoActivityEntry(7)') && 'the Undo button does not carry just the entry number',
    ].filter(Boolean);
    leaks.length ? fail(`activityItem: ${leaks.join('; ')}`)
                 : pass('a hostile target_id in the activity log never reaches an onclick');
  } catch (e) {
    fail(`activityItem could not be exercised: ${e.message}`);
  }
}

// ------------------------------------------------ 10. a CSV cell cannot become a spreadsheet formula
// Excel and Google Sheets treat a cell starting with = + - @ (or a tab / carriage return) as a
// FORMULA. Our exports carry text students and officers typed — a listing titled
// =HYPERLINK("https://…") became a live link in the admin's spreadsheet. csvCell() (js/utils.js)
// prefixes those cells with ' so they stay text. Found 2026-09-25 (security audit, L8).
// Two halves: csvCell behaves, and no export hand-rolls its own quoting again, which is how three
// copies of the unsafe version existed in the first place.
if (ran) {
  try {
    const cases = [
      ['=HYPERLINK("https://evil.example","x")', `"'=HYPERLINK(""https://evil.example"",""x"")"`],
      ['+1+1', `"'+1+1"`], ['-2+3', `"'-2+3"`], ['@SUM(A1)', `"'@SUM(A1)"`], ['\tx', `"'\tx"`],
      ['Couch, blue — 2 seats', '"Couch, blue — 2 seats"'], ['say "hi"', '"say ""hi"""'],
      [42, '"42"'], [-5, '"-5"'], [null, '""'],
    ];
    const bad = [];
    for (const [input, want] of cases) {
      const out = vm.runInContext(`csvCell(${JSON.stringify(input)})`, ctx);
      if (out !== want) bad.push(`${JSON.stringify(input)} -> ${out}`);
    }
    bad.length ? fail(`csvCell: ${bad.join('; ')}`)
               : pass('csvCell keeps formulas as text and quotes commas and quotes');
  } catch (e) {
    fail(`csvCell could not be exercised: ${e.message}`);
  }
  const handRolled = files.filter(f => f !== 'js/utils.js')
    .filter(f => /replace\(\/"\/g, ?'""'\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  handRolled.length ? fail(`hand-rolled CSV quoting (use csvCell) in: ${handRolled.join(', ')}`)
                    : pass('every CSV export quotes through csvCell');
}

// ------------------------------------------------ 11. a chat is who sent it, not what it is labelled
// messages.conversation_key is a label; sender_id is the fact (the database only lets you send as
// yourself). A thread grouped or loaded by the label would put a message from student C, labelled
// with the key of A's chat with B, on B's side of that chat — "It's B, send the deposit here".
// So the chat list groups by sender/receiver, and messages.js never groups, loads or matches a
// thread by the label. (Its realtime subscription may still FILTER by it; the handler then checks
// the sender.) Added 2026-09-27 (security audit, H3).
if (ran) {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002',
        C = 'cccccccc-0000-4000-8000-000000000003', LABEL_AB = [A, B].sort().join(':');
  ctx.__msgs = [   // newest first, as renderConvos() fetches them
    { id: 'm3', sender_id: C, receiver_id: A, conversation_key: LABEL_AB, content: "It's B — send it here", created_at: '2026-09-27T12:02:00Z', seen_at: null, listing_id: null, book_id: null },
    { id: 'm2', sender_id: B, receiver_id: A, conversation_key: LABEL_AB, content: 'Is it still free?',    created_at: '2026-09-27T12:01:00Z', seen_at: null, listing_id: null, book_id: null },
    { id: 'm1', sender_id: A, receiver_id: B, conversation_key: LABEL_AB, content: 'Hi!',                  created_at: '2026-09-27T12:00:00Z', seen_at: null, listing_id: null, book_id: null },
  ];
  try {
    const out = vm.runInContext(`convoSummaries(__msgs, ${JSON.stringify(A)})`, ctx);
    const withB = out.find(c => c.otherId === B), withC = out.find(c => c.otherId === C);
    const problems = [
      out.length !== 2                          && `expected 2 chats, got ${out.length}`,
      !withC                                    && "C's message did not get a chat of its own",
      withB && withB.last.sender_id !== B       && "the chat with B shows C's message as its latest",
      withB && withB.unread !== 1               && `the chat with B counts ${withB?.unread} unread, expected 1`,
    ].filter(Boolean);
    problems.length ? fail(`convoSummaries: ${problems.join('; ')}`)
                    : pass("a message labelled with another chat's key stays with its real sender");
  } catch (e) {
    fail(`convoSummaries could not be exercised: ${e.message}`);
  }
  const src = fs.readFileSync(path.join(ROOT, 'js/messages.js'), 'utf8');
  const byLabel = [/\.eq\(\s*'conversation_key'/, /\b(m|msg|c)\.conversation_key\b/, /\.select\(\s*'conversation_key'/]
    .filter(re => re.test(src)).map(String);
  byLabel.length ? fail(`js/messages.js still trusts the conversation_key label: ${byLabel.join(', ')}`)
                 : pass('js/messages.js groups and loads chats by sender and receiver, never by the label');
}

// ------------------------------------------------ 12. a profile's colour and photo stay harmless
// profiles.color and profiles.avatar_url are plain text a student can set to anything. Inside
// style="background:…", escAttr() stops a colour leaving the attribute but not adding CSS of its
// own — "#888;background-image:url(https://…)" logs the IP of everyone who views that profile,
// and position:fixed can cover the screen. An avatar_url on another website does the same. So
// safeColor() lets through only a real #rgb / #rrggbb code, and safeAvatarUrl() only our own
// storage (plus the page's own blob: previews). Added 2026-09-27 (security audit, M5).
if (ran) {
  try {
    const store = vm.runInContext('SUPABASE_URL', ctx) + '/storage/v1/object/public/listing-photos/u1/avatar-1.jpg';
    const bad = [];
    const expect = (expr, want) => { const got = vm.runInContext(expr, ctx); if (got !== want) bad.push(`${expr} -> ${JSON.stringify(got)}`); };
    expect(`safeColor('#2d6148')`, '#2d6148');
    expect(`safeColor('#ABC')`, '#ABC');
    expect(`safeColor('#888;background-image:url(https://evil.example/x)')`, '#888');
    expect(`safeColor('red;position:fixed', '#3B5BA5')`, '#3B5BA5');
    expect(`safeColor(null)`, '#888');
    expect(`safeAvatarUrl(${JSON.stringify(store)})`, store);
    expect(`safeAvatarUrl('https://evil.example/listing-photos/x.jpg')`, '');
    expect(`safeAvatarUrl('javascript:alert(1)')`, '');
    expect(`safeAvatarUrl('blob:http://localhost/abc')`, 'blob:http://localhost/abc');
    ctx.__hostileProfile = { name: 'X', initials: 'X', color: '#888;position:fixed;inset:0', avatar_url: 'https://evil.example/track.jpg' };
    const html = vm.runInContext('avatarHTML(__hostileProfile, 40)', ctx);
    if (/evil\.example|position:fixed/.test(html)) bad.push(`avatarHTML let it through: ${html.slice(0, 120)}`);
    bad.length ? fail(`profile colour / photo: ${bad.join('; ')}`)
               : pass("a profile's colour and photo can only be a real colour and our own storage");
  } catch (e) {
    fail(`safeColor / safeAvatarUrl / avatarHTML could not be exercised: ${e.message}`);
  }
}

// ------------------------------------------------ 13. "Official" cannot be claimed by typing an email
// Official posts carry a marker poster_email — but the posting browser writes that field, so a
// student could set it on their own listing and get the Official badge, the official name, and no
// Report or Message buttons. poster_id cannot be faked (the database lets you post only as
// yourself), so a listing is official only when both match. Added 2026-09-27 (security audit, H2).
if (ran) {
  try {
    const admin = vm.runInContext('SUPER_ADMIN_ID', ctx), marker = vm.runInContext('OFFICIAL_POSTER_EMAIL', ctx);
    const student = 'dddddddd-0000-4000-8000-000000000004';
    ctx.__forged  = { poster_id: student, poster_email: marker, poster_name: 'Nestrel Housing Office', poster_initials: 'NH', poster_color: '#7c3aed' };
    ctx.__genuine = { poster_id: admin,   poster_email: marker, poster_name: 'Nestrel', poster_initials: 'CN', poster_color: '#7c3aed' };
    ctx.__prof    = { display_name: 'Sam', first_name: 'Sam', last_name: 'Doe', initials: 'SD', color: '#2d6148' };
    const forgedWithProfile = vm.runInContext('posterFromRow(__forged, __prof)', ctx);
    const forgedNoProfile   = vm.runInContext('posterFromRow(__forged, undefined)', ctx);
    const genuine           = vm.runInContext('posterFromRow(__genuine, undefined)', ctx);
    const problems = [
      forgedWithProfile.official && 'a student listing carrying the marker email is shown as Official',
      forgedWithProfile.name !== 'Sam' && `a forged "official" listing shows "${forgedWithProfile.name}" instead of the poster's real name`,
      forgedNoProfile.official && 'a forged row is Official even without its profile',
      !genuine.official && "the admin's own official post lost its badge",
    ].filter(Boolean);
    problems.length ? fail(`official badge: ${problems.join('; ')}`)
                    : pass('the Official badge needs the admin account, not just the marker email');
  } catch (e) {
    fail(`posterFromRow could not be exercised: ${e.message}`);
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
