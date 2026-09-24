// ─── server/scope.js ──────────────────────────────────────────────────────────
// Tenant scope for every data route. The single place that decides which
// client(s) a request may see.
//
//   Warehouse sessions may pass ?clientId= / ?clientIds= freely.
//   Client sessions are pinned to session.clientId. Asking for any other id is
//   a 403, and a client session with no known clientId is a 403 on every data
//   route — never widen to the whole warehouse.

function toId(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Returns { ok: true, clientId, clientIds } or { ok: false, status: 403, error }.
function resolveScope(session, url) {
  const q        = url.searchParams;
  const reqId    = q.get('clientId');
  const reqIds   = (q.get('clientIds') || '').split(',').map(s => s.trim()).filter(Boolean);

  if (session.isWarehouse) {
    return { ok: true, clientId: toId(reqId), clientIds: reqIds.map(toId).filter(Boolean) };
  }

  const own = toId(session.clientId);
  if (!own) {
    return { ok: false, status: 403, error: 'Your login is not linked to a client account. Please contact the warehouse.' };
  }
  const requested = [reqId, ...reqIds].filter(v => v != null && v !== '');
  if (requested.some(v => toId(v) !== own)) {
    return { ok: false, status: 403, error: 'Not permitted for this client' };
  }
  return { ok: true, clientId: own, clientIds: [] };
}

// Route helper: writes the 403 and returns null when the scope is denied.
function requireScope(session, url, res) {
  const scope = resolveScope(session, url);
  if (!scope.ok) { res.json(scope.status, { error: scope.error }); return null; }
  return scope;
}

module.exports = { resolveScope, requireScope };
