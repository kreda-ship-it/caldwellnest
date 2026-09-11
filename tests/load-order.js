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

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
