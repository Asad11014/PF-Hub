// ─── tools/qa/launcher.js ─────────────────────────────────────────────────────
// Starts the REAL server (server/index.js) against DATABASE_URL from .env for
// local QA, with two test-only differences:
//   1. Mintsoft POST /api/Auth is stubbed for the synthetic usernames
//      "__wh__" (warehouse persona) and "__client__" (client persona, client id
//      TEST_CLIENT_ID, default 10). Any password works. Every other Mintsoft call
//      is real and uses MINTSOFT_ADMIN_KEY from .env.
//   2. Background syncs (login-triggered, cron, manual) are suppressed so a QA
//      run never starts a long Mintsoft crawl.
//
// Never run this in production. Usage:
//   node tools/qa/launcher.js            # listens on PORT (default 3111)
//   TEST_CLIENT_ID=6 node tools/qa/launcher.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
process.chdir(ROOT);
process.env.PORT = process.env.PORT || '3111';
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });

const ADMIN_KEY = process.env.MINTSOFT_ADMIN_KEY;
const TEST_CLIENT_ID = parseInt(process.env.TEST_CLIENT_ID || '10');
if (!ADMIN_KEY) { console.error('[qa] MINTSOFT_ADMIN_KEY missing from .env'); process.exit(1); }
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  console.error('[qa] refusing to run the QA launcher in a production environment');
  process.exit(1);
}

// ── (2) suppress background sync ────────────────────────────────────────────
const syncPath = require.resolve(path.join(ROOT, 'server/sync.js'));
const realSync = require(syncPath);
require.cache[syncPath].exports = {
  ...realSync,
  runFullSync:        async () => { console.log('[qa] runFullSync suppressed'); return { ok: true, stub: true }; },
  runIncrementalSync: async () => { console.log('[qa] runIncrementalSync suppressed'); return { ok: true, stub: true }; },
};

// ── (1) stub Mintsoft auth for synthetic usernames ──────────────────────────
const https = require('https');
const { EventEmitter } = require('events');
let persona = null; // 'warehouse' | 'client' — set by the most recent intercepted /api/Auth

function fakeResponse(status, bodyObj) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = { 'content-type': 'application/json' };
  setImmediate(() => { res.emit('data', JSON.stringify(bodyObj)); res.emit('end'); });
  return res;
}
function fakeRequest(cb, status, bodyObj) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => { setImmediate(() => cb(fakeResponse(status, bodyObj))); };
  return req;
}

const realRequest = https.request;
https.request = function (options, cb) {
  const host = typeof options === 'object' ? options.hostname : null;
  const p    = typeof options === 'object' ? options.path : '';
  if (host === 'api.mintsoft.co.uk') {
    if (p === '/api/Auth') {
      const req = new EventEmitter();
      let body = '';
      req.write = (chunk) => { body += chunk; };
      req.end = () => {
        let u = '';
        try { u = JSON.parse(body).Username; } catch {}
        if (u === '__wh__')          { persona = 'warehouse'; setImmediate(() => cb(fakeResponse(200, ADMIN_KEY))); }
        else if (u === '__client__') { persona = 'client';    setImmediate(() => cb(fakeResponse(200, ADMIN_KEY))); }
        else { persona = null; setImmediate(() => cb(fakeResponse(401, { Message: 'qa stub: unknown test user' }))); }
      };
      return req;
    }
    // Client persona: make the warehouse-detection call fail and supply a profile.
    if (persona === 'client' && p.startsWith('/api/Client?')) {
      return fakeRequest(cb, 401, { Message: 'Unauthorized (qa client persona)' });
    }
    if (persona === 'client' && p === '/api/ClientUser/Current') {
      return fakeRequest(cb, 200, { ClientId: TEST_CLIENT_ID, UserName: '__client__' });
    }
  }
  return realRequest.apply(this, arguments);
};

require(path.join(ROOT, 'server/index.js'));
