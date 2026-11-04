// ─── server/stockreports.js ───────────────────────────────────────────────────
// BBE (best-before / expiry) and Quarantine reports, read from stock_batches
// (a synced mirror of Mintsoft's Products-In-Location report).
//
// Routes are tenant-scoped in index.js (requireScopedSession → req.scope) and
// gated by the 'bbe' / 'quarantine' modules in server/entitlements.js.

const { query, queryOne } = require('./db');
const { londonDate } = require('./sync/time');

const DEFAULT_WARNING_DAYS = 90;
const BANDS = [
  { key: 'expired', label: 'Expired',    test: d => d < 0 },
  { key: 'lt30',    label: '< 30 days',  test: d => d >= 0 && d < 30 },
  { key: 'd30_60',  label: '30–60 days', test: d => d >= 30 && d < 60 },
  { key: 'd60_90',  label: '60–90 days', test: d => d >= 60 && d < 90 },
  { key: 'd90p',    label: '90+ days',   test: d => d >= 90 },
];
const bandOf = days => BANDS.find(b => b.test(days)).key;

async function asOf() {
  const r = await queryOne(`SELECT MAX(synced_at) AS t FROM stock_batches`);
  return r?.t ?? null;
}

async function warningDaysFor(clientIds) {
  if (!clientIds.length) return {};
  const rows = await query(`SELECT client_id, value FROM client_settings WHERE key = 'bbe_warning_days' AND client_id = ANY($1::int[])`, [clientIds]);
  return Object.fromEntries(rows.map(r => [r.client_id, Number(r.value)]));
}

// GET /api/stock/bbe[?clientId=]   (warehouse without clientId → all clients)
async function bbe(req, res, url, session) {
  const { clientId } = req.scope;
  const today = londonDate();
  const params = [today];
  const where = clientId ? `AND b.client_id = $${params.push(clientId)}` : '';

  const rows = await query(
    `SELECT b.client_id, c.name AS client_name, b.sku, COALESCE(p.name, b.product_name) AS name, b.batch_no,
            b.location, b.location_type, b.line_type, b.quantity, b.allocated_order,
            to_char(b.best_before, 'YYYY-MM-DD') AS best_before, (b.best_before - $1::date) AS days_left
     FROM stock_batches b
     LEFT JOIN products p ON p.id = b.product_id
     LEFT JOIN clients  c ON c.id = b.client_id
     WHERE b.best_before IS NOT NULL AND b.quantity > 0 ${where}
     ORDER BY b.best_before, b.sku, b.location`,
    params
  );

  // Expiry-tracked products holding stock with no best-before date recorded.
  const missing = await queryOne(
    `SELECT COUNT(*)::int AS lines, COALESCE(SUM(b.quantity), 0)::int AS units, COUNT(DISTINCT b.sku)::int AS skus
     FROM stock_batches b JOIN products p ON p.id = b.product_id
     WHERE p.has_expiry_date AND b.best_before IS NULL AND b.quantity > 0 ${clientId ? 'AND b.client_id = $1' : ''}`,
    clientId ? [clientId] : []
  );

  const settings = await warningDaysFor([...new Set(rows.map(r => r.client_id).concat(clientId ? [clientId] : []).filter(Boolean))]);
  const windowFor = id => settings[id] ?? DEFAULT_WARNING_DAYS;

  const out = rows.map(r => {
    const daysLeft = Number(r.days_left);
    return {
      clientId: r.client_id, clientName: r.client_name, sku: r.sku, name: r.name || '', batch: r.batch_no,
      location: r.location, locationType: r.location_type, lineType: r.line_type, quantity: r.quantity,
      allocatedOrder: r.allocated_order, bestBefore: r.best_before, daysLeft, band: bandOf(daysLeft),
      inWindow: daysLeft < windowFor(r.client_id),
    };
  });

  const bands = BANDS.map(b => {
    const rs = out.filter(r => r.band === b.key);
    return { key: b.key, label: b.label, lines: rs.length, units: rs.reduce((s, r) => s + r.quantity, 0), skus: new Set(rs.map(r => r.sku)).size };
  });

  return res.json(200, {
    asOf: await asOf(), today, clientId: clientId || null,
    warningDays: clientId ? windowFor(clientId) : DEFAULT_WARNING_DAYS,
    bands, missingDate: missing, rows: out,
  });
}

// PUT /api/stock/bbe/settings  { warningDays }   (needs a client: own, or ?clientId= for warehouse)
async function bbeSettings(req, res, url, session) {
  const { clientId } = req.scope;
  if (!clientId) return res.json(400, { error: 'Choose a client first' });
  const body = await req.json().catch(() => ({}));
  const days = parseInt(body.warningDays, 10);
  if (!Number.isInteger(days) || days < 1 || days > 730) return res.json(400, { error: 'warningDays must be between 1 and 730' });
  await query(
    `INSERT INTO client_settings (client_id, key, value, updated_by, updated_at) VALUES ($1, 'bbe_warning_days', $2, $3, NOW())
     ON CONFLICT (client_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [clientId, JSON.stringify(days), session.username || null]
  );
  return res.json(200, { ok: true, warningDays: days });
}

// GET /api/stock/quarantine[?clientId=]
// Mintsoft holds stock in quarantine two ways: lines with quarantine status
// (Type 'Quarantine', anywhere) and stock sitting in a QUARANTINE-type location
// (often off-hand). Both are listed; heldAs says which.
async function quarantine(req, res, url, session) {
  const { clientId } = req.scope;
  const rows = await query(
    `SELECT b.client_id, c.name AS client_name, b.sku, COALESCE(p.name, b.product_name) AS name, b.batch_no,
            to_char(b.best_before, 'YYYY-MM-DD') AS best_before, b.location, b.location_type, b.line_type, b.quantity,
            b.updated_at, p.cost_price
     FROM stock_batches b
     LEFT JOIN products p ON p.id = b.product_id
     LEFT JOIN clients  c ON c.id = b.client_id
     WHERE (b.line_type = 'Quarantine' OR upper(b.location_type) = 'QUARANTINE') AND b.quantity > 0
       ${clientId ? 'AND b.client_id = $1' : ''}
     ORDER BY b.updated_at DESC NULLS LAST, b.sku`,
    clientId ? [clientId] : []
  );
  const out = rows.map(r => ({
    clientId: r.client_id, clientName: r.client_name, sku: r.sku, name: r.name || '', batch: r.batch_no,
    bestBefore: r.best_before, location: r.location, locationType: r.location_type, quantity: r.quantity,
    heldAs: r.line_type === 'Quarantine' ? 'status' : 'location',
    lastMoved: r.updated_at, costPrice: r.cost_price == null ? null : Number(r.cost_price),
  }));
  const withCost = out.filter(r => r.costPrice != null);
  return res.json(200, {
    asOf: await asOf(), clientId: clientId || null,
    summary: {
      lines: out.length,
      units: out.reduce((s, r) => s + r.quantity, 0),
      skus: new Set(out.map(r => `${r.clientId}|${r.sku}`)).size,
      valueAtCost: withCost.length ? Math.round(withCost.reduce((s, r) => s + r.quantity * r.costPrice, 0) * 100) / 100 : null,
      linesWithoutCost: out.length - withCost.length,
      unitsByStatus: out.filter(r => r.heldAs === 'status').reduce((s, r) => s + r.quantity, 0),
      unitsByLocation: out.filter(r => r.heldAs === 'location').reduce((s, r) => s + r.quantity, 0),
    },
    rows: out,
  });
}

module.exports = { bbe, bbeSettings, quarantine, BANDS, bandOf };
