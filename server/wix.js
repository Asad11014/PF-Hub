// ─── server/wix.js ────────────────────────────────────────────────────────────
// Wix ↔ Mintsoft integration (a separate Cloudflare Worker) inside the PF Hub.
//
// The browser talks only to this server. Each /api/wix/* route below maps to one
// Worker /admin/* endpoint; anything not listed is a 404 (not a general proxy).
// The Worker credentials live in env vars and never reach the browser:
//   WIX_INTEGRATION_URL                    e.g. https://wix-integration.pf-integrations.workers.dev
//   WIX_INTEGRATION_TOKEN                  the Worker's ADMIN_TOKEN
//   WIX_INTEGRATION_ACCESS_CLIENT_ID /     Cloudflare Access service token, once Access
//   WIX_INTEGRATION_ACCESS_CLIENT_SECRET   protects the Worker's /admin (optional until then)
// Every call sends X-Actor: <hub username> so the Worker's audit log names the person.
//
// Access (server/permissions.js; warehouse users only):
//   'wix_integration'         view status, previews (dry runs), held orders, errors, settings
//   'wix_integration_manage'  switch writes, import, retry, create products, edit mappings,
//                             resolve errors, push despatches
//   owner                     add clients (Wix API key passes straight through) and manage access
// 'wix_integration' itself is enforced centrally in index.js (permissions.checkAccess).

const permissions = require('./permissions');

const MAX_BODY_BYTES = 64 * 1024;
// A product-import page calls Wix and Mintsoft many times; leave it room.
const TIMEOUT_MS = 60_000;
const SLUG = '([a-z0-9][a-z0-9-]{1,39})';

// level: 'view' | 'manage' | 'owner' | 'dryRun' (view when dryRun isn't "false", else manage)
const ROUTES = [
  { method: 'GET',  re: /^\/api\/wix\/state$/,                         to: () => '/admin/state',               level: 'view' },
  { method: 'PUT',  re: /^\/api\/wix\/settings\/writes$/,              to: () => '/admin/settings/writes',     level: 'manage', body: true },
  { method: 'GET',  re: /^\/api\/wix\/audit$/,                         to: () => '/admin/audit',               level: 'view',   query: ['limit'] },
  { method: 'GET',  re: /^\/api\/wix\/errors$/,                        to: () => '/admin/errors',              level: 'view',   query: ['unresolved', 'limit'] },
  { method: 'POST', re: /^\/api\/wix\/errors\/(\d{1,12})\/resolve$/,   to: m => `/admin/errors/${m[1]}/resolve`, level: 'manage' },
  { method: 'GET',  re: /^\/api\/wix\/clients$/,                       to: () => '/admin/clients',             level: 'view' },
  { method: 'POST', re: /^\/api\/wix\/clients$/,                       to: () => '/admin/clients',             level: 'owner',  body: true },
  { method: 'GET',  re: new RegExp(`^/api/wix/clients/${SLUG}/orders$`),          to: m => `/admin/clients/${m[1]}/orders`,          level: 'view',   query: ['status', 'limit'] },
  { method: 'GET',  re: new RegExp(`^/api/wix/clients/${SLUG}/courier-map$`),     to: m => `/admin/clients/${m[1]}/courier-map`,     level: 'view' },
  { method: 'PUT',  re: new RegExp(`^/api/wix/clients/${SLUG}/courier-map$`),     to: m => `/admin/clients/${m[1]}/courier-map`,     level: 'manage', body: true },
  { method: 'POST', re: new RegExp(`^/api/wix/clients/${SLUG}/run-import$`),      to: m => `/admin/clients/${m[1]}/run-import`,      level: 'dryRun', query: ['dryRun'] },
  { method: 'POST', re: new RegExp(`^/api/wix/clients/${SLUG}/import-products$`), to: m => `/admin/clients/${m[1]}/import-products`, level: 'dryRun', query: ['dryRun', 'cursor', 'maxCreates'] },
  { method: 'POST', re: new RegExp(`^/api/wix/clients/${SLUG}/orders/([A-Za-z0-9-]{1,40})/retry$`), to: m => `/admin/clients/${m[1]}/orders/${m[2]}/retry`, level: 'dryRun', query: ['dryRun', 'notify'] },
  { method: 'GET',  re: /^\/api\/wix\/carriers$/,                      to: () => '/admin/carriers',            level: 'view' },
  { method: 'PUT',  re: /^\/api\/wix\/carriers$/,                      to: () => '/admin/carriers',            level: 'manage', body: true },
  { method: 'POST', re: /^\/api\/wix\/reconcile$/,                     to: () => '/admin/reconcile',           level: 'manage' },
];

/** Finds the allowed route for a request. Returns null for anything not listed. */
function matchRoute(method, pathname, searchParams) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const qs = new URLSearchParams();
    for (const k of r.query || []) {
      const v = searchParams.get(k);
      if (v != null && v.length <= 2000) qs.set(k, v);
    }
    const level = r.level === 'dryRun' ? (searchParams.get('dryRun') === 'false' ? 'manage' : 'view') : r.level;
    const q = qs.toString();
    return { workerPath: r.to(m) + (q ? `?${q}` : ''), level, body: !!r.body || method === 'POST' };
  }
  return null;
}

function config() {
  const url = (process.env.WIX_INTEGRATION_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.WIX_INTEGRATION_TOKEN || '').trim();
  if (!/^https:\/\/[^\s/]+$/.test(url) || token.length < 32) return null;
  return {
    url,
    token,
    accessId: (process.env.WIX_INTEGRATION_ACCESS_CLIENT_ID || '').trim(),
    accessSecret: (process.env.WIX_INTEGRATION_ACCESS_CLIENT_SECRET || '').trim(),
  };
}

/** Removes things the browser must never see from Worker responses. */
function sanitize(workerPath, data) {
  if (data && typeof data === 'object' && workerPath.startsWith('/admin/clients') && 'webhooks' in data) {
    const { webhooks: _secretUrls, ...rest } = data;
    return rest;
  }
  return data;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const actorOf = session => permissions.normalize(session.username) || 'hub-user';

async function forward(cfg, method, workerPath, bodyText, actor, fetchImpl) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${cfg.token}`,
    'X-Actor': actor,
    'User-Agent': 'PF-Hub/1.0',
  };
  if (cfg.accessId && cfg.accessSecret) {
    headers['CF-Access-Client-Id'] = cfg.accessId;
    headers['CF-Access-Client-Secret'] = cfg.accessSecret;
  }
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetchImpl(cfg.url + workerPath, { method, headers, body: bodyText, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 502, data: { error: timedOut ? 'The Wix integration took too long to answer. Try again.' : 'Could not reach the Wix integration.', code: 'upstream_unreachable' } };
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  // Cloudflare Access redirects to its login page when the service token is missing/wrong.
  if (r.status >= 300 && r.status < 400) {
    return { status: 502, data: { error: 'Cloudflare Access blocked the Hub. Check the WIX_INTEGRATION_ACCESS_* service token.', code: 'upstream_access' } };
  }
  // The Worker rejecting OUR credentials is a configuration problem, not the user being logged out.
  if (r.status === 401) {
    return { status: 502, data: { error: 'The Wix integration rejected the Hub\'s credentials. Check WIX_INTEGRATION_TOKEN.', code: 'upstream_auth' } };
  }
  if (data === null) {
    return { status: 502, data: { error: `Unexpected response from the Wix integration (HTTP ${r.status}).`, code: 'upstream_invalid' } };
  }
  return { status: r.status, data: sanitize(workerPath, data) };
}

const LEVEL_PERMISSION = { view: 'wix_integration', manage: 'wix_integration_manage' };

/** Owner-only: who else can use the Wix Integration page (mirrors Invoice Audit's access page). */
async function access(req, res, url, session, deps) {
  if (!(await deps.isOwner(session))) return res.json(403, { error: 'Only the owner can manage access to the Wix Integration page' });
  const actor = actorOf(session);
  const which = p => (p === 'wix_integration_manage' ? 'wix_integration_manage' : 'wix_integration');
  if (req.method === 'GET') {
    const [view, manage] = await Promise.all([deps.listAccess('wix_integration'), deps.listAccess('wix_integration_manage')]);
    const seen = new Set();
    const events = [...view.events, ...manage.events]
      .filter(e => (e.permission === 'wix_integration' || e.permission === 'wix_integration_manage') && !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => b.id - a.id);
    return res.json(200, { owners: view.owners, grants: view.grants, managers: manage.grants.map(g => g.username), events });
  }
  if (req.method === 'POST') {
    let b;
    try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return res.json(400, { error: 'Invalid JSON' }); }
    const perm = which(b.permission);
    const r = await deps.grant(b.username, 'wix_integration', actor);
    if (r.error) return res.json(400, r);
    if (perm === 'wix_integration_manage') {
      const r2 = await deps.grant(b.username, perm, actor);
      if (r2.error) return res.json(400, r2);
      return res.json(200, { ok: true, granted: r.granted || r2.granted });
    }
    return res.json(200, r);
  }
  if (req.method === 'DELETE') {
    const user = url.searchParams.get('username') || '';
    const perm = which(url.searchParams.get('permission'));
    // Removing view access removes managing too.
    if (perm === 'wix_integration') await deps.revoke(user, 'wix_integration_manage', actor);
    return res.json(200, await deps.revoke(user, perm, actor));
  }
  return res.json(405, { error: 'Method not allowed' });
}

function createHandler(deps) {
  return async function handle(req, res, url, session) {
    const { pathname } = url;
    if (pathname === '/api/wix/access') return access(req, res, url, session, deps);

    const route = matchRoute(req.method, pathname, url.searchParams);
    if (!route) return res.json(404, { error: 'Not found' });

    if (route.level === 'owner') {
      if (!(await deps.isOwner(session))) return res.json(403, { error: 'Only the owner can add Wix clients', code: 'owner_required' });
    } else if (!(await deps.has(session, LEVEL_PERMISSION[route.level]))) {
      return res.json(403, route.level === 'manage'
        ? { error: 'You can view the Wix Integration but not change it. Ask the owner for managing access.', code: 'permission_required', permission: 'wix_integration_manage' }
        : { error: 'Wix Integration is restricted. Ask the owner for access.', code: 'permission_required', permission: 'wix_integration' });
    }

    const cfg = deps.config();
    if (!cfg) return res.json(503, { error: 'The Wix integration is not connected yet (WIX_INTEGRATION_URL / WIX_INTEGRATION_TOKEN are not set).', code: 'not_configured' });

    let bodyText;
    if (route.body && req.method !== 'GET') {
      try {
        const raw = await readBody(req);
        bodyText = raw ? JSON.stringify(JSON.parse(raw)) : undefined;
      } catch (err) {
        return res.json(err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
      }
    }
    const out = await forward(cfg, req.method, route.workerPath, bodyText, actorOf(session), deps.fetch);
    return res.json(out.status, out.data);
  };
}

const handle = createHandler({
  has: permissions.has,
  isOwner: permissions.isOwner,
  listAccess: permissions.listAccess,
  grant: permissions.grant,
  revoke: permissions.revoke,
  config,
  fetch: (...a) => fetch(...a),
});

module.exports = { handle, createHandler, matchRoute, sanitize, config, ROUTES };
