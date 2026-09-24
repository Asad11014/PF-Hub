# QA harness

Local-only tooling used by the v3 plan (`docs/v3-plan.md`) as the definition-of-done check for every stage. Nothing here is loaded by `npm start`.

## One-time setup

```bash
cd tools/qa
npm install
npm run install-browser      # downloads the headless Chromium that matches the Playwright version
```

`.env` at the repo root must contain `DATABASE_URL` and `MINTSOFT_ADMIN_KEY`.

## Run the app in QA mode

```bash
node tools/qa/launcher.js          # real server on http://localhost:3111
```

The launcher runs the real `server/index.js` with two test-only stubs: Mintsoft `POST /api/Auth` accepts the synthetic usernames `__wh__` (warehouse user) and `__client__` (client user, client id `TEST_CLIENT_ID`, default 10) with any password, and background syncs are suppressed so a QA session never starts a long Mintsoft crawl. All other Mintsoft calls are real and use the admin key.

## Walk every page and check security expectations

```bash
node tools/qa/screens.js --order=IN85287
```

Writes `shots/*.png` (one per page and persona), `results.json` (page text, API bodies, console errors, failed requests) and prints a PASS/FAIL table for the security expectations. Exit code 1 when any expectation fails.

## Other checks

```bash
node tools/qa/api-probe.js             # ~15 read-only Mintsoft calls: verifies which params are honoured
psql "$DATABASE_URL" -f tools/qa/diag.sql   # database health snapshot
```
