// ─── server/audit.js ──────────────────────────────────────────────────────────
// Invoice Audit (stage I1): what Premium Fulfilment billed, order by order, and
// the coverage / integrity checks that need no pricing knowledge:
//   A1 unbilled orders · A2 double-billed · A3 cancelled or undespatched billed ·
//   A4 zero-charge lines and manual notes · D13 postage below courier cost ·
//   E15 invoice header vs the sum of its lines.
// Routes: /api/audit/* (warehouse + 'invoice_audit' permission, enforced in index.js).
// Data: invoice_orders / invoice_extra_lines (server/sync/entities.js).

const { query, queryOne } = require('./db');
const permissions = require('./permissions');
const engine = require('./audit-engine');

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const n = v => (v == null ? null : Number(v));

const { parseComments, HAS_MANUAL_LINE_SQL, ZEROED } = require('./audit-comments');
// Mintsoft bills an order hours after despatch; orders despatched within this
// window before a client's latest billing run may land on the next invoice.
const CUTOFF_HOURS = 12;

// How Mintsoft builds each invoice category from its lines (verified across all
// 212 invoices): order-line fields sum into their category; goods-in, returns
// and collections lines into theirs; an "Other" line adds to the category of its
// charge type (Admin and Generic → other items). Storage is only partly itemised
// (Storage-type Other lines); daily storage charges are not listed by Mintsoft.
// Old invoices can have no order lines at all (Mintsoft no longer holds them).
const CATEGORIES = [
  { key: 'picking',     label: 'Picking',           header: 'picking_cost',          line: 'total_picking_cost', orderLevel: true },
  { key: 'postage',     label: 'Postage',           header: 'postage_cost',          line: 'postage_cost', orderLevel: true },
  { key: 'vatFree',     label: 'VAT-free postage',  header: 'vat_free_postage_cost', line: 'vat_free_postage_cost', orderLevel: true },
  { key: 'rework',      label: 'Rework',            header: 'rework_cost',           line: 'rework_cost', orderLevel: true },
  { key: 'packaging',   label: 'Packaging',         header: 'packaging_cost',        line: 'packaging_cost', orderLevel: true },
  { key: 'admin',       label: 'Admin (per order)', header: 'admin_fee',             line: 'admin_fee', orderLevel: true },
  { key: 'goodsIn',     label: 'Goods in',          header: 'goods_in_cost',         extra: 'goods_in' },
  { key: 'returns',     label: 'Returns',           header: 'returns_cost',          extra: 'returns' },
  { key: 'collections', label: 'Collections',       header: 'collections_cost',      extra: 'collections' },
  { key: 'generic',     label: 'Other items',       header: 'generic_items_cost' },
  { key: 'storage',     label: 'Storage',           header: 'storage_cost', partlyItemised: true },
];
const OTHER_TO_CATEGORY = {
  Picking: 'picking', Postage: 'postage', Rework: 'rework', Packaging: 'packaging',
  GoodsIn: 'goodsIn', Returns: 'returns', Collections: 'collections', Storage: 'storage',
};
const categoryOfOther = chargeType => OTHER_TO_CATEGORY[chargeType] || 'generic';
const ORDER_LEVEL_COLS = CATEGORIES.filter(c => c.orderLevel).map(c => c.header);

// One calculation for the overview and the invoice page.
//   orderSums: { total_picking_cost, postage_cost, … } summed over order lines
//   extraSums: { goods_in, returns, collections, 'other:<ChargeType>' } amounts
//   extraCounts: same keys, line counts
// Invoices older than the order history Mintsoft still holds can lack lines a
// category was charged for; that category is "not available", not a mismatch.
// For newer invoices a charge without lines is a real difference.
function buildCategories(inv, { orderSums = {}, orderLines = 0, extraSums = {}, extraCounts = {} }, beforeHistory) {
  return CATEGORIES.map(c => {
    const header = r2(inv[c.header]);
    let lines = (c.line ? Number(orderSums[c.line]) || 0 : 0) + (c.extra ? Number(extraSums[c.extra]) || 0 : 0);
    for (const [k, v] of Object.entries(extraSums)) {
      if (k.startsWith('other:') && categoryOfOther(k.slice(6) || null) === c.key) lines += Number(v) || 0;
    }
    lines = r2(lines);
    const count = c.orderLevel ? orderLines : c.extra ? (extraCounts[c.extra] || 0) : null;
    const unavailable = !!beforeHistory && count === 0 && Math.abs(header) > 0.01 && Math.abs(lines) < 0.005;
    const compared = !c.partlyItemised && !unavailable;
    return {
      key: c.key, label: c.label, header, lines: unavailable ? null : lines,
      difference: compared ? r2(header - lines) : null,
      partlyItemised: !!c.partlyItemised, unavailable,
      notItemisedRemainder: c.partlyItemised ? r2(header - lines) : null,
    };
  });
}
const integrityOf = cats => {
  const compared = cats.filter(c => c.difference != null);
  const header = r2(compared.reduce((s, c) => s + c.header, 0));
  const lines = r2(compared.reduce((s, c) => s + c.lines, 0));
  return { itemisedHeader: header, itemisedLines: lines, difference: r2(header - lines), unavailable: cats.filter(c => c.unavailable).map(c => c.key) };
};
const HEADER_COLS = CATEGORIES.map(c => c.header);
const headerTotal = i => r2(HEADER_COLS.reduce((s, c) => s + (Number(i[c]) || 0), 0));

// London month 'YYYY-MM' → first day; default range = last 12 months.
function monthRange(url) {
  const ym = s => (/^\d{4}-\d{2}$/.test(s || '') ? s : null);
  const now = new Date();
  const to = ym(url.searchParams.get('to')) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [ty, tm] = to.split('-').map(Number);
  const fromDefault = new Date(Date.UTC(ty, tm - 12, 1));
  const from = ym(url.searchParams.get('from')) || `${fromDefault.getUTCFullYear()}-${String(fromDefault.getUTCMonth() + 1).padStart(2, '0')}`;
  const toNext = new Date(Date.UTC(ty, tm, 1));
  return { from, to, fromDate: `${from}-01`, toDate: `${toNext.getUTCFullYear()}-${String(toNext.getUTCMonth() + 1).padStart(2, '0')}-01` };
}

async function historyStart() {
  const r = await queryOne(`SELECT MIN(order_date) AS t FROM orders`);
  return r?.t ? new Date(r.t) : null;
}

// ── Overview: every invoice in range with its integrity + flag counts ────────

async function overview(req, res, url) {
  const range = monthRange(url);
  const clientId = parseInt(url.searchParams.get('clientId'), 10) || null;
  const params = [range.fromDate, range.toDate];
  const clientSql = clientId ? `AND i.client_id = $${params.push(clientId)}` : '';
  const [rows, hist, clients] = await Promise.all([
    query(
      `WITH inv AS (
         SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
         WHERE i.invoice_date >= $1::date AND i.invoice_date < $2::date ${clientSql}
       ),
       dup AS (SELECT order_id FROM invoice_orders GROUP BY 1 HAVING COUNT(*) > 1),
       lo AS (
         SELECT io.invoice_id, COUNT(*)::int AS lines, SUM(io.total_cost) AS order_total,
                json_build_object('total_picking_cost', SUM(io.total_picking_cost), 'postage_cost', SUM(io.postage_cost),
                  'vat_free_postage_cost', SUM(io.vat_free_postage_cost), 'rework_cost', SUM(io.rework_cost),
                  'packaging_cost', SUM(io.packaging_cost), 'admin_fee', SUM(io.admin_fee)) AS order_sums,
                -- Margin only where Mintsoft recorded the courier cost (0 = not recorded).
                SUM(io.postage_cost) FILTER (WHERE io.cost_postage_cost > 0) AS postage_charged,
                SUM(io.cost_postage_cost) FILTER (WHERE io.cost_postage_cost > 0) AS postage_cost,
                COUNT(*) FILTER (WHERE COALESCE(io.cost_postage_cost, 0) = 0 AND io.postage_cost > 0)::int AS cost_unknown,
                COUNT(*) FILTER (WHERE COALESCE(io.total_cost, 0) = 0)::int AS zero_lines,
                COUNT(*) FILTER (WHERE io.cost_postage_cost > 0 AND io.postage_cost < io.cost_postage_cost)::int AS below_cost,
                COUNT(*) FILTER (WHERE o.status_name = 'Cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE o.id IS NOT NULL AND o.despatch_date IS NULL AND o.status_name <> 'Cancelled')::int AS not_despatched,
                COUNT(*) FILTER (WHERE o.id IS NULL)::int AS order_missing,
                COUNT(*) FILTER (WHERE ${HAS_MANUAL_LINE_SQL('io.comments')})::int AS notes,
                COUNT(*) FILTER (WHERE io.order_id IN (SELECT order_id FROM dup))::int AS double_billed
         FROM invoice_orders io LEFT JOIN orders o ON o.id = io.order_id
         WHERE io.invoice_id IN (SELECT id FROM inv)
         GROUP BY io.invoice_id
       ),
       ex AS (SELECT invoice_id, json_object_agg(k, amt) AS extra_sums, json_object_agg(k, cnt) AS extra_counts, SUM(cnt)::int AS extra_lines
              FROM (SELECT invoice_id, CASE WHEN kind = 'other' THEN 'other:' || COALESCE(charge_type, '') ELSE kind END AS k,
                           SUM(amount) AS amt, COUNT(*) AS cnt
                    FROM invoice_extra_lines WHERE invoice_id IN (SELECT id FROM inv) GROUP BY 1, 2) x
              GROUP BY invoice_id)
       SELECT inv.*, lo.lines, lo.order_total, lo.order_sums, lo.postage_charged, lo.postage_cost AS postage_courier_cost, lo.cost_unknown, lo.zero_lines,
              lo.below_cost, lo.cancelled, lo.not_despatched, lo.order_missing, lo.notes, lo.double_billed,
              ex.extra_sums, ex.extra_counts, ex.extra_lines
       FROM inv LEFT JOIN lo ON lo.invoice_id = inv.id LEFT JOIN ex ON ex.invoice_id = inv.id
       ORDER BY inv.invoice_date DESC, inv.client_name`,
      params
    ),
    historyStart(),
    query(`SELECT DISTINCT c.id, c.name FROM invoices i JOIN clients c ON c.id = i.client_id ORDER BY c.name`),
  ]);

  const invoices = rows.map(i => {
    const total = headerTotal(i);
    const beforeHistory = !!(hist && i.invoice_date && new Date(i.invoice_date) < hist);
    const cats = buildCategories(i, { orderSums: i.order_sums || {}, orderLines: i.lines || 0, extraSums: i.extra_sums || {}, extraCounts: i.extra_counts || {} }, beforeHistory);
    const integ = integrityOf(cats);
    return {
      id: i.id, clientId: i.client_id, clientName: i.client_name, name: i.name, date: i.invoice_date,
      detailSynced: !!i.detail_synced_at, beforeHistory, linesNotAvailable: integ.unavailable,
      total, storage: r2(i.storage_cost), difference: integ.difference,
      orderLines: i.lines || 0, extraLines: i.extra_lines || 0,
      postage: { charged: r2(i.postage_charged), cost: r2(i.postage_courier_cost), margin: r2(Number(i.postage_charged || 0) - Number(i.postage_courier_cost || 0)), linesWithoutCost: i.cost_unknown || 0 },
      flags: {
        doubleBilled: i.double_billed || 0, cancelled: i.cancelled || 0, notDespatched: i.not_despatched || 0,
        orderMissing: beforeHistory ? 0 : (i.order_missing || 0), zeroCharge: i.zero_lines || 0,
        belowCost: i.below_cost || 0, notes: i.notes || 0,
      },
    };
  });
  // Expected-vs-billed checks (stage I2), per client, cached by the engine.
  for (const cid of [...new Set(invoices.map(i => i.clientId).filter(Boolean))]) {
    const ca = await engine.clientAudit(cid);
    for (const i of invoices.filter(x => x.clientId === cid)) i.expected = ca.byInvoice[i.id] || { warnings: 0, info: 0, under: 0, over: 0, codes: {} };
  }
  const unbilled = await unbilledOrders(range, clientId);
  return res.json(200, {
    range, clients, historyStart: hist, invoices,
    unbilledByClient: Object.values(unbilled.reduce((m, o) => {
      (m[o.clientId] = m[o.clientId] || { clientId: o.clientId, clientName: o.clientName, orders: 0 }).orders++;
      return m;
    }, {})),
  });
}

// ── Coverage (A1–A4) ──────────────────────────────────────────────────────────

// Despatched, not cancelled, despatched before the client's latest billing run
// (minus CUTOFF_HOURS) and on no invoice line at all.
async function unbilledOrders(range, clientId) {
  const params = [range.fromDate, range.toDate, CUTOFF_HOURS];
  const rows = await query(
    `WITH cut AS (SELECT client_id, MAX(invoice_date) - make_interval(hours => $3) AS cutoff FROM invoice_orders GROUP BY 1)
     SELECT o.id, o.order_number, o.client_id, c.name AS client_name, o.order_date, o.despatch_date, o.status_name,
            o.courier_service_name, o.number_of_parcels
     FROM orders o JOIN cut ON cut.client_id = o.client_id LEFT JOIN clients c ON c.id = o.client_id
     WHERE o.despatch_date IS NOT NULL AND o.status_name <> 'Cancelled' AND o.despatch_date < cut.cutoff
       AND o.despatch_date >= $1::date AND o.despatch_date < $2::date
       ${clientId ? `AND o.client_id = $${params.push(clientId)}` : ''}
       AND NOT EXISTS (SELECT 1 FROM invoice_orders io WHERE io.order_id = o.id)
     ORDER BY o.despatch_date`,
    params
  );
  return rows.map(o => ({
    orderId: o.id, orderNumber: o.order_number, clientId: o.client_id, clientName: o.client_name,
    orderDate: o.order_date, despatchDate: o.despatch_date, status: o.status_name, courier: o.courier_service_name, parcels: o.number_of_parcels,
  }));
}

async function coverage(req, res, url) {
  const range = monthRange(url);
  const clientId = parseInt(url.searchParams.get('clientId'), 10) || null;
  const p = () => {
    const params = [range.fromDate, range.toDate];
    return { params, client: clientId ? `AND io.client_id = $${params.push(clientId)}` : '' };
  };
  const q1 = p(), q2 = p(), q3 = p();
  const [unbilled, doubleBilled, wrongState, lines, awaiting] = await Promise.all([
    unbilledOrders(range, clientId),
    query(
      `SELECT io.order_id, o.order_number, io.client_id, c.name AS client_name,
              json_agg(json_build_object('invoiceId', io.invoice_id, 'invoiceName', i.name, 'lineId', io.id, 'total', io.total_cost) ORDER BY io.invoice_id) AS lines
       FROM invoice_orders io JOIN invoices i ON i.id = io.invoice_id
       LEFT JOIN orders o ON o.id = io.order_id LEFT JOIN clients c ON c.id = io.client_id
       WHERE io.order_id IN (SELECT order_id FROM invoice_orders GROUP BY 1 HAVING COUNT(*) > 1)
       GROUP BY io.order_id, o.order_number, io.client_id, c.name
       HAVING bool_or(i.invoice_date >= $1::date AND i.invoice_date < $2::date) ${q1.client}
       ORDER BY io.order_id`,
      q1.params
    ),
    query(
      `SELECT io.order_id, o.order_number, io.client_id, c.name AS client_name, io.invoice_id, i.name AS invoice_name,
              io.total_cost, o.status_name, o.despatch_date
       FROM invoice_orders io JOIN invoices i ON i.id = io.invoice_id JOIN orders o ON o.id = io.order_id
       LEFT JOIN clients c ON c.id = io.client_id
       WHERE i.invoice_date >= $1::date AND i.invoice_date < $2::date ${q2.client}
         AND (o.status_name = 'Cancelled' OR o.despatch_date IS NULL)
       ORDER BY io.invoice_id, io.order_id`,
      q2.params
    ),
    query(
      `SELECT io.order_id, o.order_number, io.client_id, c.name AS client_name, io.invoice_id, i.name AS invoice_name,
              io.total_cost, io.comments, (COALESCE(io.total_cost, 0) = 0) AS zero
       FROM invoice_orders io JOIN invoices i ON i.id = io.invoice_id
       LEFT JOIN orders o ON o.id = io.order_id LEFT JOIN clients c ON c.id = io.client_id
       WHERE i.invoice_date >= $1::date AND i.invoice_date < $2::date ${q3.client}
         AND (COALESCE(io.total_cost, 0) = 0 OR ${HAS_MANUAL_LINE_SQL('io.comments')})
       ORDER BY io.invoice_id, io.order_id`,
      q3.params
    ),
    query(
      `WITH cut AS (SELECT client_id, MAX(invoice_date) - make_interval(hours => $1) AS cutoff FROM invoice_orders GROUP BY 1)
       SELECT o.client_id, c.name AS client_name, COUNT(*)::int AS orders, MIN(o.despatch_date) AS since
       FROM orders o JOIN cut ON cut.client_id = o.client_id LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.despatch_date >= cut.cutoff AND o.status_name <> 'Cancelled'
         AND NOT EXISTS (SELECT 1 FROM invoice_orders io WHERE io.order_id = o.id)
       GROUP BY o.client_id, c.name ORDER BY c.name`,
      [CUTOFF_HOURS]
    ),
  ]);
  return res.json(200, {
    range, cutoffHours: CUTOFF_HOURS,
    unbilled,
    doubleBilled: doubleBilled.map(d => ({ orderId: d.order_id, orderNumber: d.order_number, clientId: d.client_id, clientName: d.client_name, lines: d.lines })),
    billedWrongState: wrongState.map(w => ({
      orderId: w.order_id, orderNumber: w.order_number, clientId: w.client_id, clientName: w.client_name, invoiceId: w.invoice_id,
      invoiceName: w.invoice_name, total: n(w.total_cost), status: w.status_name, reason: w.status_name === 'Cancelled' ? 'cancelled' : 'not despatched',
    })),
    zeroOrNoted: lines.map(l => {
      const { notes } = parseComments(l.comments);
      return {
        orderId: l.order_id, orderNumber: l.order_number, clientId: l.client_id, clientName: l.client_name, invoiceId: l.invoice_id,
        invoiceName: l.invoice_name, total: n(l.total_cost), comments: notes.join(' · ') || null, zero: l.zero,
        manualZeroing: notes.some(t => ZEROED.test(t)),
      };
    }),
    // Despatched after the client's latest billing run. When that started before
    // this month, last month's invoice has not been raised (or confirmed) yet.
    awaitingNextInvoice: awaiting.map(a => {
      const since = a.since ? new Date(a.since) : null;
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      return { clientId: a.client_id, clientName: a.client_name, orders: a.orders, since: a.since, previousMonthNotInvoiced: !!since && since < monthStart };
    }),
  });
}

// ── One invoice: header vs lines, every order line with its flags ────────────

async function invoiceDetail(req, res, url, id) {
  const inv = await queryOne(`SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = $1`, [id]);
  if (!inv) return res.json(404, { error: 'Invoice not found' });
  const [lines, extras, hist] = await Promise.all([
    query(
      `SELECT io.*, o.order_number, o.external_reference, o.order_date, o.despatch_date, o.status_name, o.courier_service_name,
              o.number_of_parcels, o.total_weight, o.channel_name, (o.id IS NOT NULL) AS order_known,
              it.items, it.units, dup.others
       FROM invoice_orders io
       LEFT JOIN orders o ON o.id = io.order_id
       LEFT JOIN LATERAL (SELECT COUNT(*)::int AS items, SUM(quantity)::int AS units FROM order_items WHERE order_id = io.order_id) it ON TRUE
       LEFT JOIN LATERAL (SELECT json_agg(json_build_object('invoiceId', x.invoice_id, 'lineId', x.id)) AS others
                          FROM invoice_orders x WHERE x.order_id = io.order_id AND x.id <> io.id) dup ON TRUE
       WHERE io.invoice_id = $1
       ORDER BY o.despatch_date NULLS LAST, io.order_id`,
      [id]
    ),
    query(
      `SELECT l.kind, l.id, l.amount, l.item_type, l.charge_type, l.reference_id, l.quantity, l.comments, l.invoice_date,
              l.payload, a.po_reference
       FROM invoice_extra_lines l LEFT JOIN asns a ON l.kind = 'goods_in' AND a.id = l.reference_id
       WHERE l.invoice_id = $1 ORDER BY l.kind, l.invoice_date, l.id`,
      [id]
    ),
    historyStart(),
  ]);
  const beforeHistory = !!(hist && inv.invoice_date && new Date(inv.invoice_date) < hist);

  const orders = lines.map(l => {
    const flags = [];
    const { reworkItems, notes } = parseComments(l.comments);
    const note = notes.join(' · ') || null;
    if (l.others) flags.push({ code: 'double_billed', severity: 'error', text: `Also billed on invoice ${l.others.map(o => o.invoiceId).join(', ')}` });
    if (l.order_known && l.status_name === 'Cancelled') flags.push({ code: 'cancelled', severity: 'error', text: 'Order is cancelled' });
    if (l.order_known && !l.despatch_date && l.status_name !== 'Cancelled') flags.push({ code: 'not_despatched', severity: 'error', text: 'Order has not been despatched' });
    if (!l.order_known && !beforeHistory) flags.push({ code: 'order_missing', severity: 'warning', text: 'Order no longer exists in Mintsoft' });
    if (Number(l.cost_postage_cost) > 0 && Number(l.postage_cost) < Number(l.cost_postage_cost)) flags.push({ code: 'postage_below_cost', severity: 'warning', text: `Postage charged £${r2(l.postage_cost).toFixed(2)} is below courier cost £${r2(l.cost_postage_cost).toFixed(2)}` });
    if (!Number(l.total_cost)) flags.push({ code: 'zero_charge', severity: 'warning', text: 'Nothing charged for this order' });
    if (note) flags.push({ code: ZEROED.test(note) ? 'manual_zeroing' : 'manual_note', severity: ZEROED.test(note) ? 'warning' : 'info', text: note });
    return {
      lineId: l.id, orderId: l.order_id, orderNumber: l.order_number, reference: l.external_reference,
      orderDate: l.order_date, despatchDate: l.despatch_date, status: l.status_name, courier: l.courier_service_name,
      channel: l.channel_name, parcels: l.number_of_parcels, weight: n(l.total_weight), items: l.items, units: l.units,
      picks: l.number_of_picks, cartonPicks: l.number_of_carton_picks, palletPicks: l.number_of_pallet_picks,
      picking: n(l.picking_cost), extraPicking: n(l.extra_picking_cost), totalPicking: n(l.total_picking_cost),
      postage: n(l.postage_cost),
      // Mintsoft stores 0 when it does not know the courier cost: margin unknown.
      postageCourierCost: Number(l.cost_postage_cost) > 0 ? n(l.cost_postage_cost) : null,
      postageMargin: Number(l.cost_postage_cost) > 0 ? r2(Number(l.postage_cost || 0) - Number(l.cost_postage_cost)) : null,
      vatFreePostage: n(l.vat_free_postage_cost), packaging: n(l.packaging_cost), rework: n(l.rework_cost), admin: n(l.admin_fee),
      total: n(l.total_cost), billedAt: l.invoice_date, reworkItems, notes, flags,
    };
  });

  const ca = inv.client_id ? await engine.clientAudit(inv.client_id) : null;
  const month = inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }).slice(0, 7) : null;
  for (const o of orders) {
    const e = ca?.lines.get(o.lineId);
    o.expected = e?.expected || null;
    if (e) o.flags.push(...e.flags);
  }
  const sumLines = col => r2(lines.reduce((s, l) => s + (Number(l[col]) || 0), 0));
  const orderSums = Object.fromEntries(CATEGORIES.filter(c => c.line).map(c => [c.line, sumLines(c.line)]));
  const extraSums = {}, extraCounts = {};
  for (const e of extras) {
    const k = e.kind === 'other' ? `other:${e.charge_type || ''}` : e.kind;
    extraSums[k] = (extraSums[k] || 0) + (Number(e.amount) || 0);
    extraCounts[k] = (extraCounts[k] || 0) + 1;
  }
  const categories = buildCategories(inv, { orderSums, orderLines: lines.length, extraSums, extraCounts }, beforeHistory);
  const integ = integrityOf(categories);
  const engineSummary = ca ? {
    hasReworkRules: ca.hasReworkRules,
    picking: ca.picking.months[month] || null, pickingMethod: ca.picking.method, excludedSkus: ca.picking.excludedSkus,
    rework: ca.accuracy.rework?.byMonth?.[month] || null,
    totals: ca.byInvoice[inv.id] || { warnings: 0, info: 0, under: 0, over: 0, codes: {} },
    minConfidence: engine.MIN_CONFIDENCE,
  } : null;
  const flagCounts = {};
  orders.forEach(o => o.flags.forEach(f => { flagCounts[f.code] = (flagCounts[f.code] || 0) + 1; }));

  return res.json(200, {
    invoice: {
      id: inv.id, clientId: inv.client_id, clientName: inv.client_name, name: inv.name, date: inv.invoice_date,
      updatedAt: inv.updated_at, detailSyncedAt: inv.detail_synced_at, comments: inv.comments,
      parcels: inv.number_of_parcels, items: inv.number_of_items, total: headerTotal(inv), beforeHistory,
    },
    categories,
    integrity: { ...integ, orderDetailMissing: integ.unavailable.includes('picking') || integ.unavailable.includes('postage') },
    postage: (() => {
      const known = lines.filter(l => Number(l.cost_postage_cost) > 0);
      const charged = r2(known.reduce((s, l) => s + (Number(l.postage_cost) || 0), 0));
      const cost = r2(known.reduce((s, l) => s + Number(l.cost_postage_cost), 0));
      return {
        charged, courierCost: cost, margin: r2(charged - cost), totalCharged: sumLines('postage_cost'),
        linesWithoutCost: lines.filter(l => !(Number(l.cost_postage_cost) > 0) && Number(l.postage_cost) > 0).length,
        linesBelowCost: orders.filter(o => o.flags.some(f => f.code === 'postage_below_cost')).length,
      };
    })(),
    flagCounts,
    engine: engineSummary,
    orders,
    extras: extras.map(e => ({
      kind: e.kind, id: e.id, amount: n(e.amount), itemType: e.item_type, chargeType: e.charge_type, referenceId: e.reference_id,
      poReference: e.po_reference, quantity: n(e.quantity), comments: e.comments, date: e.invoice_date,
      detail: e.kind === 'goods_in' && e.payload ? {
        units: e.payload.NumberOfUnits, unitCost: e.payload.UnitCost, unitTotal: e.payload.TotalUnitCost, adminCost: e.payload.AdminCost,
        skus: e.payload.NumberOfSkus, skuCost: e.payload.SkuCost, deliverySizeCost: e.payload.DeliverySizeCost,
      } : null,
    })),
  });
}

// ── Access (owner only) ──────────────────────────────────────────────────────

async function access(req, res, url, session) {
  if (!(await permissions.isOwner(session))) return res.json(403, { error: 'Only the owner can manage access to Invoice Audit' });
  const actor = session.username || 'owner';
  if (req.method === 'GET') return res.json(200, await permissions.listAccess('invoice_audit'));
  if (req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const r = await permissions.grant(b.username, 'invoice_audit', actor);
    return res.json(r.error ? 400 : 200, r);
  }
  if (req.method === 'DELETE') {
    const r = await permissions.revoke(url.searchParams.get('username'), 'invoice_audit', actor);
    return res.json(200, r);
  }
  return res.json(405, { error: 'Method not allowed' });
}

// ── Rates & rules for one client (stage I2) ──────────────────────────────────

async function clientRates(req, res, url, id) {
  const client = await queryOne(`SELECT id, name, active FROM clients WHERE id = $1`, [id]);
  if (!client) return res.json(404, { error: 'Client not found' });
  const ca = await engine.clientAudit(id);
  const { lines, byInvoice, ...rest } = ca;
  return res.json(200, { client, ...rest, minConfidence: engine.MIN_CONFIDENCE });
}

// Confirm (or correct) a rework item price from a date; DELETE removes one.
async function clientPrices(req, res, url, id, session) {
  if (req.method === 'PUT') {
    const b = await req.json().catch(() => ({}));
    const price = Number(b.price);
    if (!b.itemKey || !/^(rule|name):/.test(b.itemKey)) return res.json(400, { error: 'itemKey is required' });
    if (!Number.isFinite(price) || price < 0) return res.json(400, { error: 'price must be zero or more' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effectiveFrom || '')) return res.json(400, { error: 'effectiveFrom must be a date (YYYY-MM-DD)' });
    await query(
      `INSERT INTO audit_rework_prices (client_id, item_key, effective_from, price, note, confirmed_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (client_id, item_key, effective_from) DO UPDATE SET price = EXCLUDED.price, note = EXCLUDED.note,
         confirmed_by = EXCLUDED.confirmed_by, confirmed_at = NOW()`,
      [id, b.itemKey, b.effectiveFrom, price, b.note ? String(b.note).slice(0, 300) : null, session.username || 'user']
    );
    engine.forget(id);
    return res.json(200, { ok: true });
  }
  if (req.method === 'DELETE') {
    await query(`DELETE FROM audit_rework_prices WHERE client_id = $1 AND item_key = $2 AND effective_from = $3`,
      [id, url.searchParams.get('itemKey'), url.searchParams.get('effectiveFrom')]);
    engine.forget(id);
    return res.json(200, { ok: true });
  }
  return res.json(405, { error: 'Method not allowed' });
}

async function handle(req, res, url, session) {
  const { pathname } = url;
  const cm = pathname.match(/^\/api\/audit\/clients\/(\d+)$/);
  if (cm && req.method === 'GET') return clientRates(req, res, url, parseInt(cm[1], 10));
  const cp = pathname.match(/^\/api\/audit\/clients\/(\d+)\/prices$/);
  if (cp) return clientPrices(req, res, url, parseInt(cp[1], 10), session);
  if (pathname === '/api/audit/overview' && req.method === 'GET') return overview(req, res, url);
  if (pathname === '/api/audit/coverage' && req.method === 'GET') return coverage(req, res, url);
  const m = pathname.match(/^\/api\/audit\/invoices\/(\d+)$/);
  if (m && req.method === 'GET') return invoiceDetail(req, res, url, parseInt(m[1], 10));
  if (pathname === '/api/audit/access') return access(req, res, url, session);
  return res.json(404, { error: 'Not found' });
}

module.exports = { handle, CATEGORIES, headerTotal, monthRange, parseComments, buildCategories, integrityOf, HAS_MANUAL_LINE_SQL };
