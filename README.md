# Nestrel

A student-only marketplace and campus-life app for Caldwell University. Students sign up with their
`@caldwell.edu` Google account, then find housing, buy and sell books, clothing and tech, give things
away, message each other, follow clubs and go to events. Admins moderate everything from a dashboard
in the same app.

Live at [nestrel.org](https://nestrel.org).

## How it's built

- **No framework and no build step.** Plain HTML, CSS and JavaScript: the files in this repo are
  exactly the files your browser downloads.
- **[Supabase](https://supabase.com) is the backend:** the database, sign-in, photo storage and live
  chat. There is no server code of our own. The rules about who may read or change what live in the
  database itself, so nothing the browser decides is ever what keeps data safe.
- **Hosted on [Vercel](https://vercel.com)**, which serves the site and adds its security headers.

## Where things are

| Path | What it holds |
|---|---|
| `index.html` | Every screen of the app, student and admin. Markup only. |
| `styles.css` | All the styling. |
| `js/` | All the JavaScript, one file per feature (listings, messages, events, …). |
| `terms.html`, `privacy.html` | The Terms of Service and Privacy Policy. |
| `sql/` | The database: every change to its tables and rules, and the scripts that check those rules hold. Start with [`sql/README.md`](sql/README.md). |
| `tests/` | Checks you run on your own computer. See [`tests/README.md`](tests/README.md). |
| `courses.csv` | The Caldwell course list, in the same columns as the database's `courses` table (the course picker when posting a book). |
| `vercel.json` | The live site's security headers. |
| `.vercelignore` | The list of files that get published. Anything not on it never reaches the live site. |
| `SECURITY.md` | How to report a security problem. |

## Running it on your computer

From this folder:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## Before you change the JavaScript

- The files in `js/` are **plain scripts, not modules**. Every function is global, because the HTML
  calls them straight from `onclick="…"`. Don't add `type="module"` or `export`.
- **Order matters.** `index.html` loads them in a fixed order, and `js/boot.js` must stay last: it is
  the only file that runs anything rather than just defining it.
- After editing a JS or CSS file, **change its `?v=` marker** in `index.html`, or browsers keep the
  old copy.
- Then run `node tests/load-order.js` to check the app still starts.

## Security

Please don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Nestrel. All rights reserved.

The code is public so it can be read and reviewed. It is not licensed for copying or reuse.
