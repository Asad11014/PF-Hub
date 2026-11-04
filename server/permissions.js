// ─── server/permissions.js ────────────────────────────────────────────────────
// Per-user permissions for internal staff tools (separate from client modules in
// server/entitlements.js). A permission is held by a Mintsoft username.
//
//   Owners (app_settings.invoice_audit_owners) always hold every permission and
//   are the only users who can grant or revoke. Only warehouse sessions can ever
//   hold a permission; client users are refused even if a grant row exists.
//
// Enforcement is central: checkAccess() runs for every /api request in index.js.

const { query, queryOne } = require('./db');

const PERMISSIONS = {
  invoice_audit: { name: 'Invoice Audit', paths: ['/api/audit/'] },
  // Review findings, sign off invoices, confirm prices and edit audit rules.
  // Without it a user with invoice_audit can only view. Checked in server/audit.js.
  invoice_audit_review: { name: 'Invoice Audit reviewing', paths: [] },
};
const PERMISSION_KEYS = Object.keys(PERMISSIONS);
const OWNERS_KEY = 'invoice_audit_owners';
const DEFAULT_OWNERS = ['arizvi@premiumfulfilment.co.uk'];

const normalize = u => String(u || '').trim().toLowerCase();

function permissionForPath(pathname) {
  for (const [key, p] of Object.entries(PERMISSIONS)) if (p.paths.some(prefix => pathname.startsWith(prefix))) return key;
  return null;
}

// Owners: the database setting, plus INVOICE_AUDIT_OWNERS for local QA only
// (the QA launcher sets it and refuses to run in production).
async function owners() {
  const row = await queryOne(`SELECT value FROM app_settings WHERE key = $1`, [OWNERS_KEY]);
  const fromDb = Array.isArray(row?.value) ? row.value : DEFAULT_OWNERS;
  const fromEnv = (process.env.INVOICE_AUDIT_OWNERS || '').split(',').map(normalize).filter(Boolean);
  return [...new Set([...fromDb.map(normalize), ...fromEnv])];
}

const CACHE_MS = 60_000;
const cache = new Map(); // username → { at, perms: Set, owner }

async function resolve(session) {
  if (!session || !session.isWarehouse || session.demo) return { perms: new Set(), owner: false };
  const user = normalize(session.username);
  if (!user) return { perms: new Set(), owner: false };
  const hit = cache.get(user);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const owner = (await owners()).includes(user);
  const perms = owner
    ? new Set(PERMISSION_KEYS)
    : new Set((await query(`SELECT permission FROM user_permissions WHERE username = $1`, [user])).map(r => r.permission));
  const entry = { at: Date.now(), perms, owner };
  cache.set(user, entry);
  return entry;
}

async function sessionPermissions(session) {
  const { perms, owner } = await resolve(session);
  return { permissions: [...perms], isOwner: owner };
}

// For index.js: null when allowed (or the path needs no permission), else the 403 body.
async function checkAccess(session, pathname) {
  const needed = permissionForPath(pathname);
  if (!needed || !session) return null; // routes answer 401 for anonymous requests
  const { perms } = await resolve(session);
  if (perms.has(needed)) return null;
  return { error: `${PERMISSIONS[needed].name} is restricted. Ask the owner for access.`, code: 'permission_required', permission: needed };
}

async function isOwner(session) { return (await resolve(session)).owner; }
async function has(session, permission) { return (await resolve(session)).perms.has(permission); }

// ── Owner-only management ─────────────────────────────────────────────────────

async function ensurePermissions() {
  if (!(await queryOne(`SELECT 1 FROM app_settings WHERE key = $1`, [OWNERS_KEY]))) {
    await query(`INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, 'system') ON CONFLICT DO NOTHING`,
      [OWNERS_KEY, JSON.stringify(DEFAULT_OWNERS)]);
    await query(`INSERT INTO permission_events (actor, action, username, permission) VALUES ('system', 'seed', $1, 'invoice_audit')`,
      [DEFAULT_OWNERS.join(',')]);
  }
}

async function listAccess(permission = 'invoice_audit') {
  const [own, grants, events] = await Promise.all([
    owners(),
    query(`SELECT username, granted_by, granted_at FROM user_permissions WHERE permission = $1 ORDER BY username`, [permission]),
    query(`SELECT id, at, actor, action, username, permission FROM permission_events WHERE permission = $1 OR permission IS NULL ORDER BY id DESC LIMIT 50`, [permission]),
  ]);
  return { permission, owners: own, grants, events };
}

async function grant(username, permission, actor) {
  const user = normalize(username);
  if (!PERMISSION_KEYS.includes(permission)) return { error: 'Unknown permission' };
  if (!user || user.length > 200 || /\s/.test(user)) return { error: 'Enter the Mintsoft username (usually an email address)' };
  if ((await owners()).includes(user)) return { error: 'That user is an owner and already has access' };
  const r = await query(
    `INSERT INTO user_permissions (username, permission, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING username`,
    [user, permission, actor]
  );
  if (r.length) await query(`INSERT INTO permission_events (actor, action, username, permission) VALUES ($1, 'grant', $2, $3)`, [actor, user, permission]);
  cache.delete(user);
  return { ok: true, granted: r.length > 0 };
}

async function revoke(username, permission, actor) {
  const user = normalize(username);
  const r = await query(`DELETE FROM user_permissions WHERE username = $1 AND permission = $2 RETURNING username`, [user, permission]);
  if (r.length) await query(`INSERT INTO permission_events (actor, action, username, permission) VALUES ($1, 'revoke', $2, $3)`, [actor, user, permission]);
  cache.delete(user);
  return { ok: true, revoked: r.length > 0 };
}

module.exports = {
  PERMISSIONS, PERMISSION_KEYS, normalize, permissionForPath,
  ensurePermissions, sessionPermissions, checkAccess, isOwner, has, listAccess, grant, revoke,
};
