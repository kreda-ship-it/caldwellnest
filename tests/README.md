# Tests

Two safety nets. Both need a local server first:

```bash
python3 -m http.server 8000      # from the repo root
```

## `xss-test.html` — the escaping regression test
Open `http://localhost:8000/tests/xss-test.html`. It renders a listing whose title,
description, location and poster name are all live XSS payloads, drops them into a real DOM,
and prints **PASS** or **FAIL**.

Re-run it after touching any card, chat bubble, or admin-table template.
The rule it protects: **any `${...}` holding text a person typed needs `esc()`** — and
code-controlled values (labels, emoji, colors) must *not* be escaped, or the markup
double-escapes.

## `style-snapshot.js` — the "did I move a pixel?" check
For CSS refactors (moving inline `style="..."` into `styles.css`). It records the *computed*
style of all ~1,540 elements in `index.html` — including hidden modals and the whole admin
panel — so a change that only shows up on a screen you forgot to look at still gets caught.

```bash
# 1. BEFORE your change — capture the baseline
node tests/style-snapshot.js                     # writes _snap.html
#    load http://localhost:8000/_snap.html in a browser, copy the <pre id="SNAPSHOT"> JSON
#    (or use headless Chrome --dump-dom) and save it as baseline.json

# 2. make your CSS change

# 3. AFTER — regenerate and diff. Any differing computed value = something moved.
```

**It has already earned its keep.** It caught a refactor that redefined `.form-label` — a class
name that already existed — silently resizing every form label in the app. Nothing else would
have found that until a student noticed.

### Three traps it taught us
- **Web fonts make the geometry non-deterministic.** `index.html` pulls DM Sans from Google Fonts
  with `display=swap`, so whether the font has arrived by snapshot time varies *between runs*. That
  changes text metrics, which changes the width and height of nearly every element — and the diff
  fills up with hundreds of phantom "differences" that have nothing to do with your change. The
  harness now strips the font `<link>` so both runs measure the same fallback font. If you ever see
  a diff that is **only** width/height with no font-size/color/margin change, suspect this first.
- **`display:none` inline is load-bearing.** The JS does `el.style.display = ''` to *show*
  things. If `display:none` lived in a class, that reset would re-hide them. Leave those inline.
- **Check for class-name collisions before adding a rule.** Appending `.foo{...}` when `.foo`
  already exists silently overrides it everywhere, because later rules win.

---

## `load-order.js` — does the app still boot?

```bash
node tests/load-order.js     # exits 1 on failure, so it can gate a commit
```

Reads the `<script src="js/…">` tags out of `index.html`, concatenates those files **in that
order into one scope**, and runs them in a stubbed DOM. Then it checks the functions the app
navigates by are defined, and that every icon name asked for anywhere exists in `ICON`.

**Why the "one scope" part matters.** The `js/` files are plain scripts, not modules, so they
all share one global scope. Two files can each be perfectly valid alone and still break the app
together — a `const` declared in two files is a `SyntaxError`, and **the file that loses does
not execute at all**. `node --check` reads one file at a time and cannot see it.

**It has already earned its keep.** Adding `CATEGORY_ICON` to `config.js` when `listings.js`
already had one stopped `listings.js` from ever running, which removed `showPage`, `goHome` and
`renderListings`. The symptom was logging in and staying on the landing page. No error banner,
nothing in the UI — the student simply did not move. This finds it in about a second, and names
both files.

### What it will and will not catch
- **Will:** duplicate `const`/`let`/`class` across files, anything that throws at load, a core
  navigation function going missing, an `icon('name')` with no entry in the registry.
- **Will not:** anything that only happens on click, on data, or after a network round-trip. The
  DOM is a permissive stub — it answers every query with the same fake element. This proves the
  app *boots*, not that it *works*.

Run it after any change to `js/`, and always before a commit that adds a top-level `const`.

---

## `admin-orgs.js` — does the Organizations page tell the truth?

```bash
node tests/admin-orgs.js     # exits 1 on failure
```

Where `load-order.js` proves the files *run*, this one drives the admin **Organizations** tab
(`renderOrgs()` and friends in `js/orgs.js`) against a **fake database** and checks what the page
actually says and writes:

- a number it cannot know is drawn as **"—", never as 0** — a suspended club's followers, a roster
  the admin is not allowed to read, or a result Supabase cut off at its silent 1,000-row cap
- a club is flagged **Needs attention** only when its roster was really readable, so an admin
  without access is never told a healthy club has no officers
- suspending **requires a reason**, and the reason plus any note reaches the activity log
- a write that security rules silently filter to zero rows is **reported as refused**, not as done
- **Add a club** says plainly when the club was created but its first officer was not
- an organization name cannot inject markup

It loads every `js/` file except `boot.js` into one scope, like the browser, with a small fake page
that creates elements whenever `innerHTML` containing `id="…"` is assigned.

### What it will and will not catch
- **Will:** the page's logic — counts, flags, the suspend and create flows, what gets written.
- **Will not:** layout, CSS, or the real database's security rules. The fake database answers the
  way the rules are *written* to answer; whether Supabase actually enforces them is proven by the
  `sql/…_verify_*.sql` files, not here.
