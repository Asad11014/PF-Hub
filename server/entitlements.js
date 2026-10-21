// ─── server/entitlements.js ───────────────────────────────────────────────────
// Subscription modules: which client may use which part of the app.
//
// Rule: a client user may use module M when their client holds an entitlement
// for 'core' (Basic) AND for M, each with status 'active' or 'trial' and no
// end date in the past. Warehouse users always have every module.
// A client with no entitlement rows at all (e.g. new in Mintsoft) gets the
// default modules setting (Basic unless changed on the admin page).
//
// Enforcement is central: checkAccess() runs for every /api request in index.js
// and maps the path to the module it needs (PATH_MODULES below).

const { query, queryOne } = require('./db');

// Catalogue. Names/descriptions come from here on every boot; prices and the
// active flag are edited in the app and never overwritten.
const MODULES = [
  { key: 'core',        name: 'Basic',             sort: 0,  is_core: true,
    description: 'All standard client features: dashboard, stock analytics and reports, returns, invoice analysis, shipping, SEO and help guides.' },
  { key: 'forecasting', name: 'Forecasting',       sort: 10,
    description: 'Inventory Planner: demand forecasts, reorder points and purchase suggestions per SKU.' },
  { key: 'bbe',         name: 'BBE report',        sort: 20,
    description: 'Stock approaching its best-before / expiry date, by batch and location.' },
  { key: 'quarantine',  name: 'Quarantine report', sort: 30,
    description: 'Every unit of your stock currently held in quarantine, by batch and location.' },
];
const MODULE_KEYS = MODULES.map(m => m.key);

// API paths that need a module beyond Basic. Longest prefix wins.
const PATH_MODULES = [
  ['/api/forecasting/',     'forecasting'],
  ['/api/stock/bbe',        'bbe'],
  ['/api/stock/quarantine', 'quarantine'],
];
// Client-callable API paths that need no subscription (identity and session only).
const OPEN_PATHS = new Set(['/api/login', '/api/logout', '/api/me', '/api/demo-login']);

const STATUSES = ['active', 'trial', 'suspended', 'cancelled'];
const DEFAULT_MODULES_KEY = 'default_modules_for_new_clients';

function moduleForPath(pathname) {
  if (!pathname.startsWith('/api/') || OPEN_PATHS.has(pathname)) return null;
  const hit = PATH_MODULES.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix));
  return hit ? hit[1] : 'core';
}

function isEntitled(row, now = new Date()) {
  if (!row || !['active', 'trial'].includes(row.status)) return false;
  if (row.starts_at && new Date(row.starts_at) > now) return false;
  return !row.ends_at || new Date(row.ends_at) > now;
}

// Pure resolution: rows for one client (+ defaults) → Set of usable module keys.
function resolveModules(rows, defaults, now = new Date()) {
  const keys = rows.length ? rows.filter(r => isEntitled(r, now)).map(r => r.module_key) : defaults;
  const set = new Set(keys.filter(k => MODULE_KEYS.includes(k)));
  return set.has('core') ? set : new Set(); // nothing without Basic
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function getSetting(key, fallback) {
  const row = await queryOne(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return row ? row.value : fallback;
}

async function putSetting(key, value, actor) {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, JSON.stringify(value), actor]
  );
}

const defaultModules = () => getSetting(DEFAULT_MODULES_KEY, ['core']);

// ── Per-client resolution (cached 60 s; cleared on every change) ──────────────

const CACHE_MS = 60_000;
const cache = new Map(); // clientId → { at, modules: Set }

async function clientModules(clientId) {
  const id = parseInt(clientId, 10);
  if (!Number.isFinite(id) || id <= 0) return new Set();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.modules;
  const rows = await query(`SELECT module_key, status, starts_at, ends_at FROM client_subscriptions WHERE client_id = $1`, [id]);
  const modules = resolveModules(rows, rows.length ? [] : await defaultModules());
  cache.set(id, { at: Date.now(), modules });
  return modules;
}

async function sessionModules(session) {
  if (!session) return [];
  if (session.isWarehouse) return [...MODULE_KEYS];
  return [...(await clientModules(session.clientId))];
}

// For index.js: null when allowed, otherwise the 403 body to send.
async function checkAccess(session, pathname) {
  if (!session || session.isWarehouse) return null;
  const needed = moduleForPath(pathname);
  if (!needed) return null;
  if (!session.clientId) return null; // scope.js answers "not linked to a client"
  const mods = await clientModules(session.clientId);
  const missing = !mods.has('core') ? 'core' : (needed !== 'core' && !mods.has(needed) ? needed : null);
  if (!missing) return null;
  const mod = MODULES.find(m => m.key === missing);
  return {
    error: missing === 'core'
      ? 'Your account does not have an active subscription. Please contact Premium Fulfilment.'
      : `${mod.name} is an add-on that is not active on your account. Please contact Premium Fulfilment to add it.`,
    code: 'module_required',
    module: missing,
  };
}

async function catalog() {
  return query(`SELECT key, name, description, monthly_price_pence, currency, is_core, sort, active FROM modules ORDER BY sort, key`);
}

// ── Boot: catalogue + one-off seed ────────────────────────────────────────────
// Seed (once): every client that exists at that moment gets Basic + Forecasting,
// so introducing subscriptions changes nothing for anyone.

async function ensureEntitlements() {
  for (const m of MODULES) {
    await query(
      `INSERT INTO modules (key, name, description, is_core, sort) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         is_core = EXCLUDED.is_core, sort = EXCLUDED.sort`,
      [m.key, m.name, m.description, !!m.is_core, m.sort]
    );
  }
  if (!(await queryOne(`SELECT 1 FROM app_settings WHERE key = $1`, [DEFAULT_MODULES_KEY]))) {
    await putSetting(DEFAULT_MODULES_KEY, ['core'], 'system');
  }
  if (await queryOne(`SELECT 1 FROM app_settings WHERE key = 'entitlements_seeded'`)) return;

  const seeded = await query(
    `INSERT INTO client_subscriptions (client_id, module_key, status, notes, updated_by)
     SELECT c.id, m.key, 'active', 'Granted when subscriptions were introduced (no change in access)', 'system'
     FROM clients c CROSS JOIN (VALUES ('core'), ('forecasting')) AS m(key)
     ON CONFLICT DO NOTHING
     RETURNING client_id, module_key`
  );
  for (const r of seeded) {
    await query(
      `INSERT INTO subscription_events (actor, action, client_id, module_key, after) VALUES ('system', 'seed', $1, $2, $3)`,
      [r.client_id, r.module_key, JSON.stringify({ status: 'active' })]
    );
  }
  await putSetting('entitlements_seeded', { at: new Date().toISOString(), rows: seeded.length }, 'system');
  console.log(`[entitlements] seeded Basic + Forecasting for ${new Set(seeded.map(r => r.client_id)).size} clients`);
}

// ── Admin (warehouse users) ───────────────────────────────────────────────────

async function adminOverview() {
  const [modules, clients, subs, events, defaults] = await Promise.all([
    catalog(),
    query(`SELECT id, name, short_name, active FROM clients ORDER BY active DESC, name`),
    query(`SELECT client_id, module_key, status, starts_at, ends_at, price_pence, billing_ref, notes, updated_by, updated_at FROM client_subscriptions`),
    query(`SELECT id, at, actor, action, client_id, module_key, before, after FROM subscription_events ORDER BY id DESC LIMIT 100`),
    defaultModules(),
  ]);
  const byClient = {};
  for (const s of subs) (byClient[s.client_id] = byClient[s.client_id] || {})[s.module_key] = s;
  return {
    modules,
    defaults,
    statuses: STATUSES,
    clients: clients.map(c => {
      const rows = Object.values(byClient[c.id] || {});
      return {
        ...c,
        configured: rows.length > 0,
        subscriptions: byClient[c.id] || {},
        effective: [...resolveModules(rows, rows.length ? [] : defaults)],
      };
    }),
    events,
  };
}

function validateChange({ status, ends_at, price_pence }) {
  if (!STATUSES.includes(status)) return `status must be one of ${STATUSES.join(', ')}`;
  if (ends_at != null && ends_at !== '' && isNaN(new Date(ends_at))) return 'ends_at must be a date';
  if (price_pence != null && price_pence !== '' && !(Number.isInteger(Number(price_pence)) && Number(price_pence) >= 0)) return 'price_pence must be a whole number of pence';
  return null;
}

async function setSubscription(clientId, moduleKey, change, actor) {
  const id = parseInt(clientId, 10);
  if (!MODULE_KEYS.includes(moduleKey)) return { error: 'Unknown module' };
  if (!(await queryOne(`SELECT 1 FROM clients WHERE id = $1`, [id]))) return { error: 'Unknown client' };
  const bad = validateChange(change);
  if (bad) return { error: bad };

  // A client still on defaults gets explicit rows first, so editing one module
  // never silently removes the others.
  const existing = await query(`SELECT module_key FROM client_subscriptions WHERE client_id = $1`, [id]);
  if (!existing.length) {
    for (const key of await defaultModules()) {
      await query(
        `INSERT INTO client_subscriptions (client_id, module_key, status, notes, updated_by) VALUES ($1, $2, 'active', 'From default modules', $3)
         ON CONFLICT DO NOTHING`, [id, key, actor]
      );
      await query(`INSERT INTO subscription_events (actor, action, client_id, module_key, after) VALUES ($1, 'apply-default', $2, $3, $4)`,
        [actor, id, key, JSON.stringify({ status: 'active' })]);
    }
  }

  const before = await queryOne(`SELECT status, ends_at, price_pence, notes FROM client_subscriptions WHERE client_id = $1 AND module_key = $2`, [id, moduleKey]);
  const after = {
    status: change.status,
    ends_at: change.ends_at ? new Date(change.ends_at).toISOString() : null,
    price_pence: change.price_pence === '' || change.price_pence == null ? null : Number(change.price_pence),
    notes: change.notes ? String(change.notes).slice(0, 500) : null,
  };
  await query(
    `INSERT INTO client_subscriptions (client_id, module_key, status, ends_at, price_pence, notes, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (client_id, module_key) DO UPDATE SET status = EXCLUDED.status, ends_at = EXCLUDED.ends_at,
       price_pence = EXCLUDED.price_pence, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [id, moduleKey, after.status, after.ends_at, after.price_pence, after.notes, actor]
  );
  await query(`INSERT INTO subscription_events (actor, action, client_id, module_key, before, after) VALUES ($1, 'set', $2, $3, $4, $5)`,
    [actor, id, moduleKey, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
  cache.delete(id);
  return { ok: true };
}

async function updateModule(key, change, actor) {
  if (!MODULE_KEYS.includes(key)) return { error: 'Unknown module' };
  const price = change.monthly_price_pence === '' || change.monthly_price_pence == null ? null : Number(change.monthly_price_pence);
  if (price != null && !(Number.isInteger(price) && price >= 0)) return { error: 'monthly_price_pence must be a whole number of pence' };
  const before = await queryOne(`SELECT monthly_price_pence FROM modules WHERE key = $1`, [key]);
  await query(`UPDATE modules SET monthly_price_pence = $2 WHERE key = $1`, [key, price]);
  await query(`INSERT INTO subscription_events (actor, action, module_key, before, after) VALUES ($1, 'price', $2, $3, $4)`,
    [actor, key, JSON.stringify(before), JSON.stringify({ monthly_price_pence: price })]);
  return { ok: true };
}

async function setDefaultModules(keys, actor) {
  const list = [...new Set((Array.isArray(keys) ? keys : []).filter(k => MODULE_KEYS.includes(k)))];
  if (list.length && !list.includes('core')) list.unshift('core');
  const before = await defaultModules();
  await putSetting(DEFAULT_MODULES_KEY, list, actor);
  await query(`INSERT INTO subscription_events (actor, action, before, after) VALUES ($1, 'defaults', $2, $3)`,
    [actor, JSON.stringify(before), JSON.stringify(list)]);
  cache.clear();
  return { ok: true };
}

module.exports = {
  MODULES, MODULE_KEYS, moduleForPath, isEntitled, resolveModules,
  ensureEntitlements, sessionModules, clientModules, checkAccess, catalog,
  adminOverview, setSubscription, updateModule, setDefaultModules,
};
