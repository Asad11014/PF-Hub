// Unit tests for the Wix integration proxy (server/wix.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHandler, matchRoute, sanitize } = require('./wix');

const CFG = { url: 'https://wix.example.workers.dev', token: 't'.repeat(40), accessId: '', accessSecret: '' };

function fakeReq(method, body) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  r.method = method;
  return r;
}
function fakeRes() {
  return { status: null, body: null, json(s, d) { this.status = s; this.body = d; } };
}
function setup({ perms = ['wix_integration', 'wix_integration_manage'], owner = false, cfg = CFG, upstream } = {}) {
  const calls = [];
  const deps = {
    has: async (_s, p) => perms.includes(p),
    isOwner: async () => owner,
    listAccess: async p => ({ owners: ['arizvi@premiumfulfilment.co.uk'], grants: p === 'wix_integration' ? [{ username: 'a@pf.co.uk' }] : [], events: [{ id: 1, permission: p }] }),
    grant: async (u, p) => { calls.push(['grant', u, p]); return { ok: true, granted: true }; },
    revoke: async (u, p) => { calls.push(['revoke', u, p]); return { ok: true, revoked: true }; },
    config: () => cfg,
    fetch: async (url, init) => {
      calls.push(['fetch', url, init]);
      const u = upstream || { status: 200, body: { ok: true } };
      return new Response(typeof u.body === 'string' ? u.body : JSON.stringify(u.body), { status: u.status, headers: u.headers });
    },
  };
  return { handle: createHandler(deps), calls };
}
const session = { username: 'ARizvi@PremiumFulfilment.co.uk', isWarehouse: true };
const call = async (h, method, path, body) => {
  const res = fakeRes();
  await h.handle(fakeReq(method, body), res, new URL(`http://hub${path}`), session);
  return res;
};

test('only listed routes are forwarded; anything else is a 404 and never reaches the Worker', async () => {
  const h = setup();
  for (const [m, p] of [['GET', '/api/wix/../admin/state'], ['GET', '/api/wix/admin/state'], ['DELETE', '/api/wix/carriers'], ['GET', '/api/wix/mintsoft/courier-services'], ['POST', '/api/wix/clients/Bad Slug/run-import']]) {
    assert.equal((await call(h, m, p)).status, 404, `${m} ${p}`);
  }
  assert.equal(h.calls.filter(c => c[0] === 'fetch').length, 0);
});

test('maps routes to Worker paths and passes only whitelisted query params', () => {
  const q = s => new URLSearchParams(s);
  assert.deepEqual(matchRoute('GET', '/api/wix/state', q('')), { workerPath: '/admin/state', level: 'view', body: false });
  assert.equal(matchRoute('GET', '/api/wix/errors', q('unresolved=1&evil=x')).workerPath, '/admin/errors?unresolved=1');
  assert.equal(matchRoute('POST', '/api/wix/clients/wix-test/import-products', q('dryRun=false&cursor=abc%2B&maxCreates=1&x=1')).workerPath,
    '/admin/clients/wix-test/import-products?dryRun=false&cursor=abc%2B&maxCreates=1');
  assert.equal(matchRoute('POST', '/api/wix/clients/wix-test/orders/10005/retry', q('dryRun=true')).workerPath, '/admin/clients/wix-test/orders/10005/retry?dryRun=true');
});

test('previews (dry runs) need view; real runs need manage', () => {
  const q = s => new URLSearchParams(s);
  assert.equal(matchRoute('POST', '/api/wix/clients/wix-test/run-import', q('')).level, 'view');
  assert.equal(matchRoute('POST', '/api/wix/clients/wix-test/run-import', q('dryRun=true')).level, 'view');
  assert.equal(matchRoute('POST', '/api/wix/clients/wix-test/run-import', q('dryRun=false')).level, 'manage');
  assert.equal(matchRoute('PUT', '/api/wix/settings/writes', q('')).level, 'manage');
  assert.equal(matchRoute('POST', '/api/wix/clients', q('')).level, 'owner');
});

test('a viewer can preview but cannot switch writes or run a real import', async () => {
  const h = setup({ perms: ['wix_integration'] });
  assert.equal((await call(h, 'POST', '/api/wix/clients/wix-test/run-import?dryRun=true')).status, 200);
  const w = await call(h, 'PUT', '/api/wix/settings/writes', { enabled: true });
  assert.equal(w.status, 403);
  assert.equal(w.body.permission, 'wix_integration_manage');
  assert.equal((await call(h, 'POST', '/api/wix/clients/wix-test/run-import?dryRun=false')).status, 403);
  assert.equal(h.calls.filter(c => c[0] === 'fetch').length, 1); // only the preview went through
});

test('without any Wix permission nothing is forwarded', async () => {
  const h = setup({ perms: [] });
  assert.equal((await call(h, 'GET', '/api/wix/state')).status, 403);
  assert.equal(h.calls.length, 0);
});

test('adding a client is owner-only, and the webhook URLs (with their secret token) never reach the browser', async () => {
  const notOwner = setup({ owner: false });
  assert.equal((await call(notOwner, 'POST', '/api/wix/clients', { slug: 'x' })).status, 403);
  const owner = setup({ owner: true, upstream: { status: 201, body: { client: { slug: 'x' }, mintsoft_client: { id: 38 }, webhooks: { despatch: 'https://w/webhooks/mintsoft/despatch/x?token=SECRET' } } } });
  const r = await call(owner, 'POST', '/api/wix/clients', { slug: 'x', wix_api_key: 'IST.key' });
  assert.equal(r.status, 201);
  assert.equal(JSON.stringify(r.body).includes('SECRET'), false);
  assert.deepEqual(r.body, { client: { slug: 'x' }, mintsoft_client: { id: 38 } });
  const sent = owner.calls.find(c => c[0] === 'fetch')[2];
  assert.equal(JSON.parse(sent.body).wix_api_key, 'IST.key'); // passed straight through
});

test('sends the token, X-Actor and (when set) the Access service token; never forwards browser headers', async () => {
  const h = setup({ cfg: { ...CFG, accessId: 'id.access', accessSecret: 'sek' } });
  await call(h, 'GET', '/api/wix/state');
  const [, url, init] = h.calls.find(c => c[0] === 'fetch');
  assert.equal(url, 'https://wix.example.workers.dev/admin/state');
  assert.equal(init.headers.Authorization, `Bearer ${CFG.token}`);
  assert.equal(init.headers['X-Actor'], 'arizvi@premiumfulfilment.co.uk');
  assert.equal(init.headers['CF-Access-Client-Id'], 'id.access');
  assert.equal(init.headers['CF-Access-Client-Secret'], 'sek');
  assert.equal(init.headers.Cookie, undefined);
  assert.equal(init.redirect, 'manual');
});

test('explains configuration problems instead of logging the user out', async () => {
  assert.equal((await call(setup({ cfg: null }), 'GET', '/api/wix/state')).body.code, 'not_configured');
  const badToken = await call(setup({ upstream: { status: 401, body: { error: 'unauthorized' } } }), 'GET', '/api/wix/state');
  assert.equal(badToken.status, 502);
  assert.equal(badToken.body.code, 'upstream_auth');
  const access = await call(setup({ upstream: { status: 302, body: '', headers: { Location: 'https://x.cloudflareaccess.com/login' } } }), 'GET', '/api/wix/state');
  assert.equal(access.body.code, 'upstream_access');
  const html = await call(setup({ upstream: { status: 200, body: '<html>' } }), 'GET', '/api/wix/state');
  assert.equal(html.body.code, 'upstream_invalid');
});

test('passes Worker errors through (e.g. writes master off)', async () => {
  const h = setup({ upstream: { status: 409, body: { error: 'master_off', message: 'locked' } } });
  const r = await call(h, 'PUT', '/api/wix/settings/writes', { enabled: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'master_off');
});

test('rejects invalid JSON and oversized bodies before forwarding', async () => {
  const h = setup();
  assert.equal((await call(h, 'PUT', '/api/wix/carriers', '{nope')).status, 400);
  assert.equal((await call(h, 'PUT', '/api/wix/carriers', 'x'.repeat(70 * 1024))).status, 413);
  assert.equal(h.calls.length, 0);
});

test('access management is owner-only; granting manage also grants view; removing view removes manage', async () => {
  assert.equal((await call(setup({ owner: false }), 'GET', '/api/wix/access')).status, 403);
  const h = setup({ owner: true });
  const list = await call(h, 'GET', '/api/wix/access');
  assert.deepEqual(list.body.owners, ['arizvi@premiumfulfilment.co.uk']);
  assert.deepEqual(list.body.grants, [{ username: 'a@pf.co.uk' }]);
  await call(h, 'POST', '/api/wix/access', { username: 'b@pf.co.uk', permission: 'wix_integration_manage' });
  assert.deepEqual(h.calls.filter(c => c[0] === 'grant').map(c => c[2]), ['wix_integration', 'wix_integration_manage']);
  await call(h, 'DELETE', '/api/wix/access?username=b%40pf.co.uk');
  assert.deepEqual(h.calls.filter(c => c[0] === 'revoke').map(c => c[2]), ['wix_integration_manage', 'wix_integration']);
});

test('sanitize leaves other responses alone', () => {
  assert.deepEqual(sanitize('/admin/state', { webhooks: 1 }), { webhooks: 1 });
});
