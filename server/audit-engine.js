// ─── server/audit-engine.js ───────────────────────────────────────────────────
// Invoice Audit stage I2: what each billed order SHOULD have cost, from the
// client's Mintsoft order rules, rework prices and picking pattern, compared
// with what was billed.
//
// Mintsoft does not expose historical rate cards or rework item prices, so the
// engine learns them from the client's own billing, per month, and reports how
// well it reproduces that billing. Per-order flags are raised only where it can
// (confidence ≥ MIN_CONFIDENCE); elsewhere the screen says the pattern is not
// recognised instead of guessing.
//
//   Rework  — the client's AddReworkItem rules are re-run on every order
//             (server/audit-rules.js); prices per item per month are inferred
//             from billing unless a user confirmed one (audit_rework_prices).
//   Picking — each order is checked against the current rate card AND the
//             pattern learned for its month (per sales channel when there are
//             enough orders). SKUs the client is never charged for (inserts,
//             accessories) are learned from billing.
//   Admin   — the per-order admin fee usual for that client and month.

//
// Stage I3 adds goods-in rate checks, postage outliers and the owner's own audit
// rules (server/audit-checks.js), the order drill-down (explainOrder) and the
// month-to-date preview against Mintsoft's running total (previewClient).

const { query, queryOne } = require('./db');
const { expectedRework, explainRule, parseParam, CHARGING_ACTIONS } = require('./audit-rules');
const { parseComments, ZEROED } = require('./audit-comments');
const { goodsInChecks, postageOutliers, auditRuleOnLine, describeExpectation } = require('./audit-checks');

const MIN_CONFIDENCE = 0.9;
const MIN_SEGMENT = 15;   // orders needed to learn a channel's own pattern
const BULK_UNITS = 50;    // a bulk order charged below the per-unit rate is noted, not warned
const EPS = 0.005;
const r2 = v => Math.round(v * 100) / 100;
const num = v => (v == null ? null : Number(v));

function mode(values) {
  const counts = new Map();
  let best = null, bestN = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    const k = r2(v);
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    if (n > bestN) { best = k; bestN = n; }
  }
  return best == null ? null : { value: best, n: bestN, of: values.filter(v => v != null && Number.isFinite(v)).length };
}

// ── Loading ───────────────────────────────────────────────────────────────────

async function loadClient(clientId) {
  const hist = await queryOne(`SELECT MIN(order_date) AS t FROM orders`);
  const since = hist?.t || '1970-01-01';
  const [lines, ruleSnap, cards, confirmed, goodsIn, auditRules] = await Promise.all([
    query(
      `SELECT io.id AS line_id, io.invoice_id, i.name AS invoice_name, to_char(i.invoice_date AT TIME ZONE 'Europe/London', 'YYYY-MM') AS month,
              io.order_id, io.picking_cost, io.extra_picking_cost, io.total_picking_cost, io.rework_cost, io.packaging_cost,
              io.admin_fee, io.total_cost, io.comments, io.invoice_date AS billed_at, io.postage_cost, io.courier_service_id,
              o.id AS order_known, o.order_number, o.external_reference, o.recipient_first_name, o.recipient_company,
              o.address1, o.address2, o.town, o.county, o.postcode, o.phone, o.mobile, o.email, o.courier_service_name,
              o.channel_name, o.channel_id, o.warehouse_id, o.total_weight, o.order_value, o.number_of_parcels,
              o.gift_messages, o.delivery_notes, o.order_date
       FROM invoice_orders io JOIN invoices i ON i.id = io.invoice_id LEFT JOIN orders o ON o.id = io.order_id
       WHERE io.client_id = $1 AND i.invoice_date >= $2
       ORDER BY io.invoice_date`,
      [clientId, since]
    ),
    queryOne(`SELECT rules, captured_at FROM client_order_rules WHERE client_id = $1 ORDER BY captured_at DESC LIMIT 1`, [clientId]),
    query(`SELECT card, captured_at FROM client_rate_cards WHERE client_id = $1 ORDER BY captured_at`, [clientId]),
    query(`SELECT item_key, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, price, note, confirmed_by, confirmed_at
           FROM audit_rework_prices WHERE client_id = $1 ORDER BY effective_from`, [clientId]),
    query(`SELECT l.id, l.invoice_id, l.invoice_date AS billed_at, l.payload, a.hours_logged AS hours
           FROM invoice_extra_lines l LEFT JOIN asns a ON a.id = l.reference_id
           WHERE l.client_id = $1 AND l.kind = 'goods_in' AND l.invoice_date >= $2 ORDER BY l.invoice_date, l.id`, [clientId, since]),
    query(`SELECT * FROM audit_rules WHERE active AND (client_id = $1 OR client_id IS NULL) ORDER BY id`, [clientId]),
  ]);
  const cardSnap = cards[cards.length - 1];
  const orderIds = [...new Set(lines.filter(l => l.order_known).map(l => l.order_id))];
  const items = orderIds.length ? await query(
    `SELECT oi.order_id, oi.sku, oi.quantity, p.name, p.category, p.width, p.height, p.depth, p.updated_at AS product_updated
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1::int[])`,
    [orderIds]
  ) : [];
  const byOrder = new Map();
  for (const it of items) (byOrder.get(it.order_id) || byOrder.set(it.order_id, []).get(it.order_id)).push(it);
  return {
    lines, items: byOrder, rules: ruleSnap?.rules || [], rulesAt: ruleSnap?.captured_at, card: cardSnap?.card || {}, cardAt: cardSnap?.captured_at, confirmed,
    cards: cards.map(c => ({ card: c.card, capturedAt: c.captured_at })), goodsIn: goodsIn.map(g => ({ id: g.id, invoiceId: g.invoice_id, billedAt: g.billed_at, payload: g.payload, hours: g.hours })),
    auditRules,
  };
}

async function orderItems(orderId) {
  return query(
    `SELECT oi.order_id, oi.sku, oi.quantity, p.name, p.category, p.width, p.height, p.depth, p.updated_at AS product_updated
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.sku`, [orderId]);
}

function features(l, items) {
  const its = items || [];
  const dims = its.map(i => [num(i.width), num(i.height), num(i.depth)]);
  const volumeComplete = its.length > 0 && dims.every(d => d.every(x => x > 0));
  return {
    orderNumber: l.order_number, externalReference: l.external_reference, firstName: l.recipient_first_name,
    companyName: l.recipient_company, address1: l.address1, address2: l.address2, town: l.town, county: l.county,
    postcode: l.postcode, phone: l.phone, mobile: l.mobile, email: l.email, courierService: l.courier_service_name,
    channel: l.channel_name, channelId: l.channel_id, warehouseId: l.warehouse_id,
    totalWeight: num(l.total_weight), orderValue: num(l.order_value), parcels: num(l.number_of_parcels),
    totalItems: its.reduce((s, i) => s + (i.quantity || 0), 0),
    orderVolume: its.reduce((s, i, k) => s + (dims[k][0] || 0) * (dims[k][1] || 0) * (dims[k][2] || 0) * (i.quantity || 0), 0) / 1e6,
    volumeComplete,
    largestDimension: Math.max(0, ...dims.flat().filter(Boolean)),
    giftMessages: l.gift_messages, deliveryNotes: l.delivery_notes,
    skus: its.map(i => i.sku), names: its.map(i => i.name).filter(Boolean),
    categories: its.flatMap(i => String(i.category || '').split(',').map(s => s.trim()).filter(Boolean)),
    orderDate: l.order_date ? new Date(l.order_date) : null,
    productChangedAfterBilling: its.some(i => i.product_updated && l.billed_at && new Date(i.product_updated) > new Date(l.billed_at)),
  };
}

// ── Picking ───────────────────────────────────────────────────────────────────

function counts(items, excluded) {
  const its = (items || []).filter(i => !excluded.has(i.sku));
  return { units: its.reduce((s, i) => s + (i.quantity || 0), 0), lines: its.length, skus: new Set(its.map(i => i.sku)).size };
}

const formula = {
  // standard + additional × max(0, count − included)
  byCount: (p, c) => r2(p.S + (p.A || 0) * Math.max(0, c[p.by] - p.N)),
  // standard per order + SKU cost × distinct SKUs + unit cost × units
  perSkuPerUnit: (p, c) => r2(p.S + p.K * c.skus + p.U * c.units),
};

function cardModel(card) {
  const N = card.NumberOfItemsIncludedInStandardPick ?? 1;
  const t = card.PickingCalculationType;
  if (t === 'PerOrderPerSkuPerUnit') return { source: 'rate card', kind: 'perSkuPerUnit', S: card.StandardPickingCost || 0, K: card.PickingSKUCost || 0, U: card.AdditionalPickingCostPerItem || 0 };
  if (t === 'PerItem' || t === 'PerOrderLine') return { source: 'rate card', kind: 'byCount', by: t === 'PerItem' ? 'units' : 'lines', S: card.StandardPickingCost || 0, A: card.AdditionalPickingCostPerItem || 0, N };
  return null;
}

// Learn one segment's pattern (same method family as the client's rate card).
function learnModel(rows, card) {
  const N = card.NumberOfItemsIncludedInStandardPick ?? 1;
  if (card.PickingCalculationType === 'PerOrderPerSkuPerUnit') {
    const S = mode(rows.map(r => r.pick))?.value;
    const one = mode(rows.filter(r => r.c.skus === 1 && r.c.units === 1).map(r => r.extra))?.value;
    const U = one == null ? null : mode(rows.filter(r => r.c.skus === 1 && r.c.units > 1).map(r => (r.extra - one) / (r.c.units - 1)))?.value;
    if (S == null || one == null || U == null) return null;
    return { source: 'learned', kind: 'perSkuPerUnit', S, K: r2(one - U), U };
  }
  let best = null;
  for (const by of ['units', 'lines']) {
    const S = mode(rows.filter(r => r.c[by] <= N).map(r => r.billed))?.value;
    if (S == null) continue;
    const extra = mode(rows.filter(r => r.c[by] > N).map(r => (r.billed - S) / (r.c[by] - N)));
    // nA = 0: no order had more than N, so the additional rate is not known (0 is a placeholder).
    const m = { source: 'learned', kind: 'byCount', by, S, A: extra?.value ?? 0, N, nA: extra?.n ?? 0 };
    const ok = rows.filter(r => Math.abs(formula.byCount(m, r.c) - r.billed) < EPS).length;
    if (!best || ok > best.ok) best = { ok, m };
  }
  return best?.m || null;
}

const expect = (m, c) => (m ? formula[m.kind](m, c) : null);

// Fit every month (and channel segment) with a given set of non-charged SKUs;
// returns per-month models and how many lines any candidate reproduces.
function fitPicking(rowsByMonth, card, excluded) {
  const cm = cardModel(card);
  let matched = 0, total = 0;
  const months = {};
  for (const [month, rs] of Object.entries(rowsByMonth)) {
    const rows = rs.map(r => ({ ...r, c: counts(r.items, excluded) }));
    const all = learnModel(rows, card);
    const channels = {};
    const byChannel = {};
    rows.forEach(r => { (byChannel[r.channel || '—'] = byChannel[r.channel || '—'] || []).push(r); });
    for (const [ch, list] of Object.entries(byChannel)) if (list.length >= MIN_SEGMENT) channels[ch] = learnModel(list, card);
    let ok = 0;
    for (const r of rows) {
      const cands = [channels[r.channel || '—'], all, cm].filter(Boolean);
      r.match = cands.find(m => Math.abs(expect(m, r.c) - r.billed) < EPS) || null;
      r.primary = channels[r.channel || '—'] || all || cm;
      if (r.match) ok++;
    }
    matched += ok; total += rows.length;
    months[month] = { rows, all, channels, card: cm, matched: ok, total: rows.length,
      cardMatched: cm ? rows.filter(r => Math.abs(expect(cm, r.c) - r.billed) < EPS).length : 0 };
  }
  return { months, matched, total };
}

// Non-charged SKUs: start from products the client's rules add (inserts), then
// add a frequent SKU only if excluding it lets clearly more orders match.
function learnPicking(rowsByMonth, card, ruleAdded) {
  const freq = new Map();
  Object.values(rowsByMonth).flat().forEach(r => new Set(r.items.map(i => i.sku)).forEach(s => freq.set(s, (freq.get(s) || 0) + 1)));
  const excluded = new Set([...ruleAdded].filter(s => freq.has(s)));
  // Candidates: SKUs common in the orders the current model fails to explain.
  const candidatesFor = fit => {
    const miss = new Map();
    Object.values(fit.months).forEach(m => m.rows.filter(r => !r.match).forEach(r => new Set(r.items.map(i => i.sku)).forEach(s => miss.set(s, (miss.get(s) || 0) + 1))));
    return [...miss].filter(([s, n]) => n >= 3 && (freq.get(s) || 0) >= 5).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([s]) => s);
  };
  let cur = fitPicking(rowsByMonth, card, excluded);
  if (excluded.size) {
    const without = fitPicking(rowsByMonth, card, new Set());
    if (without.matched >= cur.matched) { excluded.clear(); cur = without; }
  }
  for (let round = 0; round < 8; round++) {
    let bestSku = null, bestFit = cur;
    for (const s of candidatesFor(cur)) {
      if (excluded.has(s)) continue;
      excluded.add(s);
      const f = fitPicking(rowsByMonth, card, excluded);
      excluded.delete(s);
      if (f.matched > bestFit.matched) { bestFit = f; bestSku = s; }
    }
    if (!bestSku || bestFit.matched - cur.matched < Math.max(2, 0.005 * cur.total)) break;
    excluded.add(bestSku);
    cur = bestFit;
  }
  return { ...cur, excluded: [...excluded].sort() };
}

// ── Rework prices ─────────────────────────────────────────────────────────────

function priceLookup(learned, confirmed) {
  // learned: key → { 'YYYY-MM': {price, n} }; confirmed: [{item_key, effective_from, price}]
  return (key, month) => {
    const conf = confirmed.filter(c => c.item_key === key && c.effective_from.slice(0, 7) <= month).pop();
    if (conf) return { price: Number(conf.price), source: 'confirmed', before: null, after: null };
    const hist = learned[key] || {};
    const months = Object.keys(hist).sort();
    const earlier = months.filter(m => m < month).pop();
    const later = months.find(m => m > month);
    const own = hist[month];
    const primary = own ? own.price : earlier ? hist[earlier].price : later ? hist[later].price : null;
    // Prices either side: a price can change part-way through a month.
    const before = earlier ? hist[earlier].price : null, after = later ? hist[later].price : null;
    return { price: primary, source: primary == null ? null : 'inferred', before, after };
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function computeClient(clientId) {
  const data = await loadClient(clientId);
  const { lines, items, card } = data;
  const reworkRules = data.rules.filter(r => CHARGING_ACTIONS.has(r.Action));
  const ruleAdded = new Set(data.rules.filter(r => r.Action === 'AddProductToOrder' && r.Active)
    .map(r => String(r.Param || '').split(';')[0].trim()).filter(Boolean));

  // 1. Features, billed rework and the rules' expectation for every line.
  // hardUncertain: today's rules cannot be applied at all. A rule edited after the
  // order only matters if the order then disagrees with today's rules (step 6).
  const usesVolume = reworkRules.some(r => (r.OrderRuleConditions || []).some(c => c.Field === 'OrderVolume'));
  const L = lines.map(l => {
    const its = items.get(l.order_id) || [];
    const f = features(l, its);
    const billedItems = parseComments(l.comments);
    const rw = l.order_known ? expectedRework(reworkRules, f) : { items: [], fired: [], unknown: [], editedAfterOrder: [] };
    const hardUncertain = !l.order_known ? 'order not in Mintsoft'
      : rw.unknown.length ? `rule uses ${[...new Set(rw.unknown.flatMap(u => u.fields))].join(', ')}, which the audit cannot read`
      : usesVolume && !f.volumeComplete ? 'a product in the order has no dimensions' : null;
    return { l, f, items: its, billedItems, rw, hardUncertain, editedAfter: rw.editedAfterOrder.length > 0 };
  });

  // 2. Rule code → billed item name, from lines where exactly one item was expected and billed.
  const pair = {};
  for (const x of L) {
    if (x.hardUncertain || x.rw.items.length !== 1 || x.billedItems.reworkItems.length !== 1) continue;
    const code = x.rw.items[0].code, name = x.billedItems.reworkItems[0].item || '';
    (pair[code] = pair[code] || {})[name] = (pair[code][name] || 0) + 1;
  }
  const nameOf = {};
  for (const [code, names] of Object.entries(pair)) {
    const [name, n] = Object.entries(names).sort((a, b) => b[1] - a[1])[0];
    const total = Object.values(names).reduce((s, v) => s + v, 0);
    if (n >= 3 && n / total >= 0.6) nameOf[code] = name;
  }
  const mappedNames = new Set(Object.values(nameOf));

  // 3. Prices per item per month, from lines billed for a single item.
  const samples = {};
  const add = (key, month, price) => { ((samples[key] = samples[key] || {})[month] = samples[key][month] || []).push(price); };
  for (const x of L) {
    const rework = Number(x.l.rework_cost) || 0;
    if (rework <= 0) continue;
    const billed = x.billedItems.reworkItems;
    if (!x.hardUncertain && x.rw.items.length === 1 && billed.length <= 1) add(`rule:${x.rw.items[0].code}`, x.l.month, rework / x.rw.items[0].qty);
    else if (!x.rw.items.length && billed.length === 1 && !mappedNames.has(billed[0].item || '')) add(`name:${billed[0].item || ''}`, x.l.month, rework / billed[0].qty);
  }
  const learned = {};
  const summarise = () => {
    for (const [key, byMonth] of Object.entries(samples)) {
      learned[key] = {};
      for (const [month, prices] of Object.entries(byMonth)) {
        const m = mode(prices);
        if (m) learned[key][month] = { price: m.value, n: m.n, of: m.of };
      }
    }
  };
  summarise();
  // Second pass: items never billed alone (e.g. a check added alongside a box)
  // get billed amount minus the known price of the other items.
  const firstPass = priceLookup(learned, data.confirmed);
  for (const x of L) {
    const rework = Number(x.l.rework_cost) || 0;
    if (rework <= 0 || x.hardUncertain || x.rw.items.length < 2) continue;
    const priced = x.rw.items.map(i => ({ i, p: firstPass(`rule:${i.code}`, x.l.month).price }));
    const unknown = priced.filter(q => q.p == null);
    if (unknown.length !== 1) continue;
    const rest = r2(rework - priced.filter(q => q.p != null).reduce((s, q) => s + q.p * q.i.qty, 0));
    if (rest > 0) add(`rule:${unknown[0].i.code}`, x.l.month, rest / unknown[0].i.qty);
  }
  summarise();
  const price = priceLookup(learned, data.confirmed);

  // 4. Picking pattern per month.
  const pickRows = {};
  L.forEach((x, idx) => {
    if (!x.l.order_known || !(Number(x.l.total_cost) > 0) || !x.items.length) return;
    (pickRows[x.l.month] = pickRows[x.l.month] || []).push({
      idx, items: x.items, channel: x.l.channel_name, pick: Number(x.l.picking_cost) || 0, extra: Number(x.l.extra_picking_cost) || 0,
      billed: r2(Number(x.l.total_picking_cost) || 0),
    });
  });
  const picking = learnPicking(pickRows, card, ruleAdded);
  const pickByIdx = new Map();
  for (const [month, m] of Object.entries(picking.months)) {
    const conf = m.total ? m.matched / m.total : 0;
    for (const r of m.rows) pickByIdx.set(r.idx, { r, month, confidence: conf });
  }

  // 5. Admin fee usual per month.
  const adminByMonth = {};
  for (const x of L) if (x.l.order_known && Number(x.l.total_cost) > 0) (adminByMonth[x.l.month] = adminByMonth[x.l.month] || []).push(Number(x.l.admin_fee) || 0);
  const adminMode = Object.fromEntries(Object.entries(adminByMonth).map(([m, v]) => { const md = mode(v); return [m, md ? { value: md.value, share: md.n / md.of } : null]; }));

  // 5b. Postage outliers on flat-rate services (D14, notes only).
  const isZeroed = x => Number(x.l.total_cost) === 0 || x.billedItems.notes.some(t => ZEROED.test(t));
  const postage = postageOutliers(L.map((x, idx) => ({
    key: idx, month: x.l.month, serviceId: x.l.courier_service_id, service: x.l.courier_service_name,
    postage: num(x.l.postage_cost), parcels: num(x.l.number_of_parcels), zeroed: isZeroed(x),
  })));

  // 5c. The owner's audit rules (C11): usual price of a rework item by its billed name.
  const priceOfItem = month => item => {
    const want = String(item || '').trim().toLowerCase();
    const code = Object.keys(nameOf).find(c => nameOf[c].toLowerCase() === want) || Object.keys(nameOf).concat(reworkRules.map(r => parseParam(r.Param).code)).find(c => c.toLowerCase() === want);
    const p = code ? price(`rule:${code}`, month).price : null;
    if (p != null) return p;
    const key = Object.keys(learned).find(k => k.startsWith('name:') && k.slice(5).toLowerCase() === want);
    return key ? price(key, month).price : null;
  };
  const auditRuleStats = Object.fromEntries(data.auditRules.map(r => [r.id, { matched: 0, flagged: 0, unknown: 0 }]));

  // 6. Per-line expectation and flags.
  const out = new Map();
  // Rework accuracy counts only orders today's rules can speak for; orders placed
  // before a rule was last edited (or with unreadable fields) are "uncertain".
  const acc = { rework: { reproduced: 0, total: 0, uncertain: 0 }, picking: { matched: 0, total: 0 } };
  const ruleStats = Object.fromEntries(reworkRules.map(r => [r.ID, { fired: 0 }]));
  // Per invoice: warnings, notes, and the £ the warnings add up to
  // (negative value = charged less than expected, positive = more), and the
  // findings (warnings) by subject|check so reviews can be matched to them.
  const byInvoice = {};
  const tally = (invoiceId, subject, flags) => {
    const inv = (byInvoice[invoiceId] = byInvoice[invoiceId] || { warnings: 0, info: 0, under: 0, over: 0, codes: {}, findings: [] });
    for (const f of flags) {
      f.check = f.check || f.code;
      inv.codes[f.code] = (inv.codes[f.code] || 0) + 1;
      if (f.severity === 'warning') {
        inv.warnings++;
        inv.findings.push({ k: `${subject}|${f.check}`, v: f.value ?? null });
        if (f.value < 0) inv.under = r2(inv.under - f.value); else if (f.value > 0) inv.over = r2(inv.over + f.value);
      } else inv.info++;
    }
  };
  L.forEach((x, idx) => {
    const { l } = x;
    const flags = [];
    const notes = x.billedItems.notes;
    const zeroed = isZeroed(x);
    const billedRework = r2(Number(l.rework_cost) || 0);
    x.rw.fired.forEach(f => { if (ruleStats[f.ruleId]) ruleStats[f.ruleId].fired++; });

    // Rework
    const expItems = x.rw.items.map(i => {
      const p = price(`rule:${i.code}`, l.month);
      return { code: i.code, name: nameOf[i.code] ?? null, qty: i.qty, unitPrice: p.price, priceSource: p.source };
    });
    const expAmount = expItems.some(i => i.unitPrice == null) ? null : r2(expItems.reduce((s, i) => s + i.qty * i.unitPrice, 0));
    // Same items at the previous / next month's price (a price changed mid-month).
    const amountAt = side => expItems.length && expItems.every(i => (price(`rule:${i.code}`, l.month)[side] ?? i.unitPrice) != null)
      ? r2(expItems.reduce((s, i) => s + i.qty * (price(`rule:${i.code}`, l.month)[side] ?? i.unitPrice), 0)) : null;
    const exact = (expAmount != null && Math.abs(expAmount - billedRework) < EPS) || (!expItems.length && billedRework === 0);
    const atNeighbourPrice = !exact && [amountAt('before'), amountAt('after')].some(a => a != null && Math.abs(a - billedRework) < EPS);
    const reproduced = exact || atNeighbourPrice;
    const uncertain = x.hardUncertain || (!reproduced && x.editedAfter ? 'a rework rule was edited after this order was placed' : null);
    // Clients without rework rules add rework by hand: nothing to compare against,
    // only items charged £0.00 are checked (below).
    if (!reworkRules.length) { /* not applicable */ }
    else if (l.order_known && uncertain) acc.rework.uncertain++;
    else if (l.order_known) {
      acc.rework.total++;
      const bm = ((acc.rework.byMonth = acc.rework.byMonth || {})[l.month] = acc.rework.byMonth[l.month] || { reproduced: 0, total: 0 });
      bm.total++;
      if (reproduced) { acc.rework.reproduced++; bm.reproduced++; }
    }
    if (reworkRules.length && l.order_known && !uncertain && !reproduced) {
      if (expItems.length && expAmount > 0 && billedRework === 0) {
        flags.push(zeroed
          ? { code: 'rework_missing', severity: 'info', explained: 'manually zeroed', value: -expAmount, text: `Rules expect ${expItems.map(i => i.name || i.code).join(', ')} (£${expAmount.toFixed(2)}); the order was zeroed` }
          : { code: 'rework_missing', severity: 'warning', value: -expAmount, text: `Rules expect ${expItems.map(i => i.name || i.code).join(', ')} (£${expAmount.toFixed(2)}) but no rework was charged` });
      } else if (!expItems.length && billedRework > 0 && reworkRules.length) {
        flags.push({ code: 'rework_not_expected', severity: 'info', value: 0, text: `Rework £${billedRework.toFixed(2)} charged but no rule applies (added by hand?)` });
      } else if (expItems.length && expAmount != null && billedRework > 0 && Math.abs(expAmount - billedRework) >= EPS) {
        flags.push(x.f.productChangedAfterBilling
          ? { code: 'rework_differs', severity: 'info', explained: 'product edited after billing', value: r2(billedRework - expAmount), text: `Rework £${billedRework.toFixed(2)} vs £${expAmount.toFixed(2)} expected; a product in the order was edited after billing` }
          : { code: 'rework_differs', severity: 'warning', value: r2(billedRework - expAmount), text: `Rework £${billedRework.toFixed(2)} vs £${expAmount.toFixed(2)} expected` });
      }
    }
    if (x.billedItems.reworkItems.length && billedRework === 0) {
      const usual = x.billedItems.reworkItems.map(i => {
        const code = Object.keys(nameOf).find(c => nameOf[c] === (i.item || ''));
        return (code ? price(`rule:${code}`, l.month) : price(`name:${i.item || ''}`, l.month)).price;
      });
      const value = usual.every(v => v != null) ? -r2(usual.reduce((s, v, k) => s + v * x.billedItems.reworkItems[k].qty, 0)) : null;
      flags.push({ code: 'rework_unpriced', severity: zeroed ? 'info' : 'warning', explained: zeroed ? 'manually zeroed' : undefined, value,
        text: `${x.billedItems.reworkItems.map(i => i.item || 'rework item').join(', ')} charged £0.00${value ? ` (usually £${(-value).toFixed(2)})` : ''}` });
    }

    // Picking
    let pickExp = null;
    const p = pickByIdx.get(idx);
    if (p) {
      acc.picking.total++;
      if (p.r.match) acc.picking.matched++;
      const model = p.r.match || p.r.primary;
      pickExp = { amount: expect(model, p.r.c), source: model?.source || null, matched: !!p.r.match, confidence: r2(p.confidence) };
      if (!p.r.match && p.confidence >= MIN_CONFIDENCE && pickExp.amount != null) {
        const diff = r2(p.r.billed - pickExp.amount);
        const cap = diff < 0 && picking.months[p.month].rows.filter(o => !o.match && Math.abs(o.billed - p.r.billed) < EPS).length >= 2;
        const bulk = diff < 0 && p.r.c.units >= BULK_UNITS;
        flags.push(cap
          ? { code: 'picking_capped', severity: 'info', value: diff, text: `Charged a flat £${p.r.billed.toFixed(2)}; the usual rate gives £${pickExp.amount.toFixed(2)}` }
          : bulk
          ? { code: 'picking_bulk', severity: 'info', value: diff, text: `Bulk order (${p.r.c.units} units) charged £${p.r.billed.toFixed(2)}; the per-unit rate gives £${pickExp.amount.toFixed(2)}` }
          : { code: diff < 0 ? 'picking_below' : 'picking_above', severity: 'warning', value: diff,
            text: `Picking £${p.r.billed.toFixed(2)} vs £${pickExp.amount.toFixed(2)} at this client’s usual rate` });
      }
    }

    // Admin
    let adminExp = null;
    const am = adminMode[l.month];
    if (am && l.order_known && Number(l.total_cost) > 0) {
      adminExp = am.value;
      const billedAdmin = r2(Number(l.admin_fee) || 0);
      if (am.share >= MIN_CONFIDENCE && Math.abs(billedAdmin - am.value) >= EPS) {
        flags.push({ code: 'admin_differs', severity: 'warning', value: r2(billedAdmin - am.value), text: `Admin fee £${billedAdmin.toFixed(2)} vs the usual £${am.value.toFixed(2)}` });
      }
    }

    // Postage (notes only)
    if (postage.has(idx)) flags.push(postage.get(idx));

    // The owner's audit rules
    if (l.order_known) {
      for (const rule of data.auditRules) {
        const r = auditRuleOnLine(rule, l, x.f, x.billedItems, { zeroed, priceOf: priceOfItem(l.month) });
        const st = auditRuleStats[rule.id];
        if (r.applies == null) st.unknown++;
        else if (r.applies) st.matched++;
        if (r.flag) { st.flagged++; flags.push(r.flag); }
      }
    }

    tally(l.invoice_id, `line:${l.line_id}`, flags);
    out.set(l.line_id, {
      invoiceId: l.invoice_id, orderId: l.order_id,
      expected: {
        rework: { items: expItems, amount: expAmount, uncertain, reproduced, priceChangedInMonth: atNeighbourPrice, fired: x.rw.fired.map(f => f.ruleId) },
        picking: pickExp, admin: adminExp,
      },
      flags,
    });
  });

  // 6b. Goods-in lines against the rate card (B7).
  const extras = goodsInChecks(data.goodsIn, data.cards);
  for (const g of data.goodsIn) {
    const e = extras.get(g.id);
    if (e) { e.invoiceId = g.invoiceId; tally(g.invoiceId, `extra:goods_in:${g.id}`, e.flags); }
  }

  // 7. Summaries for the "Rates & rules" page.
  const reworkItems = Object.keys(learned).concat(data.confirmed.map(c => c.item_key)).filter((k, i, a) => a.indexOf(k) === i).map(key => ({
    key, code: key.startsWith('rule:') ? key.slice(5) : null, name: key.startsWith('rule:') ? (nameOf[key.slice(5)] ?? null) : key.slice(5),
    source: key.startsWith('rule:') ? 'rule' : 'added by hand',
    prices: Object.entries(learned[key] || {}).sort().map(([month, v]) => ({ month, ...v })),
    confirmed: data.confirmed.filter(c => c.item_key === key),
  }));
  for (const r of reworkRules) {
    const key = `rule:${String(r.Param || '').split(';')[0].trim()}`;
    if (!reworkItems.some(i => i.key === key)) reworkItems.push({ key, code: key.slice(5), name: null, source: 'rule', prices: [], confirmed: data.confirmed.filter(c => c.item_key === key) });
  }
  const months = Object.fromEntries(Object.entries(picking.months).sort().map(([m, v]) => [m, {
    orders: v.total, matched: v.matched, confidence: v.total ? r2(v.matched / v.total) : null, cardMatched: v.cardMatched,
    model: v.all, channels: v.channels,
    admin: adminMode[m],
  }]));
  return {
    clientId, computedAt: new Date().toISOString(), card, cardAt: data.cardAt, rulesAt: data.rulesAt,
    rules: data.rules.map(r => ({
      id: r.ID, action: r.Action, param: r.Param, active: r.Active, priority: r.Priority, conditionType: r.ConditionType,
      conditions: (r.OrderRuleConditions || []).map(c => ({ field: c.Field, operator: c.Operator, value: c.Value })),
      comments: r.Comments, lastUpdated: r.LastUpdated, charging: CHARGING_ACTIONS.has(r.Action),
      fired: ruleStats[r.ID]?.fired ?? null,
    })),
    reworkItems, nameOf, picking: { method: card.PickingCalculationType || null, excludedSkus: picking.excluded, months },
    accuracy: { ...acc, rework: reworkRules.length ? acc.rework : null }, hasReworkRules: reworkRules.length > 0,
    auditRules: data.auditRules.map(r => ({ id: r.id, global: r.client_id == null, stats: auditRuleStats[r.id] })),
    byInvoice, lines: out, extras,
    // For the order drill-down and the month-to-date preview; never sent as is.
    internal: {
      price, nameOf, reworkRules, adminMode, auditRules: data.auditRules, priceOfItem,
      excluded: new Set(picking.excluded),
      pickModels: Object.fromEntries(Object.entries(picking.months).map(([m, v]) => [m, {
        all: v.all, channels: v.channels, card: v.card, confidence: v.total ? v.matched / v.total : 0, orders: v.total,
        cardMatched: v.cardMatched, allMatched: v.all ? v.rows.filter(r => Math.abs(expect(v.all, r.c) - r.billed) < EPS).length : 0,
      }])),
      postageUsual: (() => {
        const u = {};
        for (const [idx, f] of postage) { const x = L[idx]; u[`${x.l.month}|${x.l.courier_service_id}`] = { usual: f.usual, share: f.share }; }
        return u;
      })(),
    },
  };
}

// ── Order drill-down ──────────────────────────────────────────────────────────

const describeModel = m => {
  if (!m) return null;
  if (m.kind === 'perSkuPerUnit') return `£${m.S.toFixed(2)} per order + £${m.K.toFixed(2)} per SKU + £${m.U.toFixed(2)} per unit`;
  const unit = m.by === 'units' ? 'unit' : 'order line';
  return `£${m.S.toFixed(2)} for the first ${m.N > 1 ? `${m.N} ${unit}s` : unit} + £${(m.A || 0).toFixed(2)} per additional ${unit}`;
};

// Everything the audit knows about one order: its items and the features the
// rules read, each rule's conditions with the order's values, and how each
// billed line's expected picking, rework and admin were worked out.
async function explainOrder(orderId) {
  const order = await queryOne(`SELECT o.*, c.name AS client_name FROM orders o LEFT JOIN clients c ON c.id = o.client_id WHERE o.id = $1`, [orderId]);
  const billed = await query(
    `SELECT io.*, i.name AS invoice_name, to_char(i.invoice_date AT TIME ZONE 'Europe/London', 'YYYY-MM') AS month
     FROM invoice_orders io JOIN invoices i ON i.id = io.invoice_id WHERE io.order_id = $1 ORDER BY io.invoice_date, io.id`, [orderId]);
  if (!order && !billed.length) return null;
  const clientId = order?.client_id ?? billed[0].client_id;
  const ca = await clientAudit(clientId);
  const { internal } = ca;
  const items = order ? await orderItems(orderId) : [];
  const base = { ...(order || {}), billed_at: billed[0]?.invoice_date || null };
  const f = features(base, items);
  const ruleExplain = rule => {
    const e = explainRule(rule, f);
    const { code, qty } = parseParam(rule.Param);
    return { id: rule.ID, param: rule.Param, code, qty, priority: rule.Priority, conditionType: rule.ConditionType || 'AND', comments: rule.Comments || null,
      lastUpdated: rule.LastUpdated, editedAfterOrder: !!(rule.LastUpdated && f.orderDate && f.orderDate < new Date(rule.LastUpdated)), ...e };
  };
  const lines = billed.map(l => {
    const e = ca.lines.get(l.id) || null;
    const pm = internal.pickModels[l.month];
    const c = counts(items, internal.excluded);
    const ch = order?.channel_name || '—';
    const cands = pm ? [
      pm.channels?.[ch] && { label: `learned for ${order?.channel_name || 'orders without a channel'} (${l.month})`, model: pm.channels[ch] },
      pm.all && { label: `learned for the client (${l.month})`, model: pm.all },
      pm.card && { label: 'rate card', model: pm.card },
    ].filter(Boolean) : [];
    const billedPick = r2(Number(l.total_picking_cost) || 0);
    return {
      lineId: l.id, invoiceId: l.invoice_id, invoiceName: l.invoice_name, month: l.month, billedAt: l.invoice_date,
      billed: {
        picking: num(l.picking_cost), extraPicking: num(l.extra_picking_cost), totalPicking: num(l.total_picking_cost), postage: num(l.postage_cost),
        postageCourierCost: Number(l.cost_postage_cost) > 0 ? num(l.cost_postage_cost) : null, vatFreePostage: num(l.vat_free_postage_cost),
        packaging: num(l.packaging_cost), rework: num(l.rework_cost), admin: num(l.admin_fee), total: num(l.total_cost),
      },
      comments: parseComments(l.comments),
      expected: e?.expected || null,
      flags: e?.flags || [],
      picking: {
        counts: c, excludedInOrder: [...new Set(items.filter(i => internal.excluded.has(i.sku)).map(i => i.sku))],
        confidence: pm ? r2(pm.confidence) : null,
        candidates: cands.map(x => ({ label: x.label, formula: describeModel(x.model), amount: expect(x.model, c), matches: Math.abs(expect(x.model, c) - billedPick) < EPS })),
      },
      admin: internal.adminMode[l.month] || null,
      postageUsual: internal.postageUsual[`${l.month}|${l.courier_service_id}`] || null,
      auditRules: internal.auditRules.map(r => {
        const out = auditRuleOnLine(r, { ...l, billed_at: l.invoice_date }, f, parseComments(l.comments), { zeroed: false, priceOf: internal.priceOfItem(l.month) });
        return { id: r.id, name: r.name, expectation: describeExpectation(r.expectation), applies: out.applies, flagged: !!out.flag };
      }),
    };
  });
  const month = billed[billed.length - 1]?.month || londonYm(new Date());
  return {
    clientId, clientName: order?.client_name || null, known: !!order,
    order: order ? {
      id: order.id, orderNumber: order.order_number, reference: order.external_reference, status: order.status_name, orderDate: order.order_date,
      despatchDate: order.despatch_date, channel: order.channel_name, courier: order.courier_service_name, parcels: order.number_of_parcels,
      weight: num(order.total_weight), value: num(order.order_value), company: order.recipient_company, town: order.town, postcode: order.postcode,
    } : null,
    items: items.map(i => ({ sku: i.sku, name: i.name, category: i.category, quantity: i.quantity, dims: [num(i.width), num(i.height), num(i.depth)],
      notCharged: internal.excluded.has(i.sku), editedAfterBilling: !!(i.product_updated && base.billed_at && new Date(i.product_updated) > new Date(base.billed_at)) })),
    features: {
      totalItems: f.totalItems, orderVolume: Math.round(f.orderVolume * 1e6) / 1e6, volumeComplete: f.volumeComplete, largestDimension: f.largestDimension,
      categories: [...new Set(f.categories)], totalWeight: f.totalWeight, orderValue: f.orderValue, channel: f.channel, courierService: f.courierService,
    },
    rules: internal.reworkRules.map(ruleExplain).map(r => ({ ...r, unitPrice: internal.price(`rule:${r.code}`, month).price, priceSource: internal.price(`rule:${r.code}`, month).source, itemName: internal.nameOf[r.code] ?? null })),
    lines,
  };
}

// ── Month-to-date preview against Mintsoft's running total ──────────────────
// Mintsoft bills once a day (about 19:05 London) and keeps a running total for
// the month (invoice_accruals, LastUpdated = its latest billing run). Orders
// despatched after the previous month's last run and up to that time are in the
// running total; the audit prices them with the latest month's pattern.

const londonYm = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }).slice(0, 7);

async function billingWindow(month) {
  const prev = await queryOne(
    `SELECT MAX(invoice_date) AS t FROM invoice_orders
     WHERE invoice_date < ($1::date::timestamp AT TIME ZONE 'Europe/London') AND invoice_date >= ($1::date::timestamp AT TIME ZONE 'Europe/London') - INTERVAL '36 hours'`,
    [`${month}-01`]);
  if (prev?.t) return { start: new Date(prev.t), estimated: false };
  // Previous month's last run not synced yet: 19:00 London on its last day.
  const r = await queryOne(`SELECT (($1::date - 1)::timestamp + TIME '19:00') AT TIME ZONE 'Europe/London' AS t`, [`${month}-01`]);
  return { start: new Date(r.t), estimated: true };
}

async function previewClient(clientId, now = new Date()) {
  const month = londonYm(now);
  const ca = await clientAudit(clientId);
  const { internal } = ca;
  const [acc, win] = await Promise.all([
    queryOne(`SELECT * FROM invoice_accruals WHERE client_id = $1 AND period_month = $2::date`, [clientId, `${month}-01`]),
    billingWindow(month),
  ]);
  // No running total yet (or synced before its billing time was recorded): nothing to compare.
  const end = acc?.source_updated_at ? new Date(acc.source_updated_at) : null;
  const orders = end ? await query(
    `SELECT * FROM orders WHERE client_id = $1 AND despatch_date > $2 AND despatch_date <= $3 AND status_name <> 'Cancelled' ORDER BY despatch_date`,
    [clientId, win.start, end]) : [];
  const later = await queryOne(
    `SELECT COUNT(*)::int AS n FROM orders WHERE client_id = $1 AND despatch_date > $2 AND status_name <> 'Cancelled'`, [clientId, end || win.start]);
  const itemRows = orders.length ? await query(
    `SELECT oi.order_id, oi.sku, oi.quantity, p.name, p.category, p.width, p.height, p.depth, p.updated_at AS product_updated
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1::int[])`, [orders.map(o => o.id)]) : [];
  const itemsOf = new Map();
  for (const it of itemRows) (itemsOf.get(it.order_id) || itemsOf.set(it.order_id, []).get(it.order_id)).push(it);

  // Reference month for picking: the latest month with enough orders to have
  // learned a pattern (else the latest month). Within it, the rate card is used
  // when it reproduces at least as many orders as the learned pattern, and in
  // place of a learned pattern whose extra-item rate was never seen.
  const before = Object.keys(internal.pickModels).filter(m => m < month).sort();
  const pickMonth = before.filter(m => internal.pickModels[m].orders >= MIN_SEGMENT).pop() || before.pop() || null;
  const pm = pickMonth ? internal.pickModels[pickMonth] : null;
  const cm = cardModel(ca.card);
  const cardFirst = !!(pm && pm.card && pm.cardMatched >= pm.allMatched);
  const usable = m => (m && !(m.source === 'learned' && m.kind === 'byCount' && !m.nA && cm) ? m : null);
  const modelFor = channel => (!pm ? cm : cardFirst ? pm.card : usable(pm.channels?.[channel || '—']) || usable(pm.all) || pm.card || cm);
  const adminMonth = Object.keys(internal.adminMode).filter(m => m < month && internal.adminMode[m]).sort().pop() || null;
  const admin = adminMonth ? internal.adminMode[adminMonth] : null;

  const sum = { picking: 0, rework: 0, admin: 0 };
  const unpriced = { picking: 0, rework: 0 };
  const bulk = { orders: 0, units: 0, atRate: 0 };
  const unpricedItems = new Map();   // rework code → qty
  const reworkUncertain = [];
  let units = 0;
  for (const o of orders) {
    const its = itemsOf.get(o.id) || [];
    const f = features({ ...o, billed_at: null }, its);
    // Picking: bulk orders are kept apart (often charged a flat rate by hand).
    const c = counts(its, internal.excluded);
    units += its.reduce((t, i) => t + (i.quantity || 0), 0);
    const pick = its.length ? expect(modelFor(o.channel_name), c) : null;
    if (pick == null) unpriced.picking++;
    else if (c.units >= BULK_UNITS) { bulk.orders++; bulk.units += c.units; bulk.atRate = r2(bulk.atRate + pick); }
    else sum.picking += pick;
    // Rework
    if (internal.reworkRules.length) {
      const rw = expectedRework(internal.reworkRules, f);
      let known = 0, missing = false;
      for (const i of rw.items) {
        const p = internal.price(`rule:${i.code}`, month).price;
        if (p == null) { missing = true; unpricedItems.set(i.code, (unpricedItems.get(i.code) || 0) + i.qty); } else known += p * i.qty;
      }
      if (rw.unknown.length || (rw.items.length && f.volumeComplete === false && internal.reworkRules.some(r => (r.OrderRuleConditions || []).some(x => x.Field === 'OrderVolume')))) {
        unpriced.rework++; reworkUncertain.push(o.order_number);
      } else if (missing) unpriced.rework++;
      sum.rework += known;
    }
    // Admin
    if (admin) sum.admin += admin.value;
  }
  const a = col => r2(Number(acc?.[col]) || 0);
  const modelled = (key, label, col, value, notes) => {
    const accrual = a(col);
    const expected = end ? value : null;
    const difference = expected == null ? null : r2(accrual - expected);
    return { key, label, accrual, expected: expected == null ? null : r2(expected), difference, modelled: true, notes: notes.filter(Boolean) };
  };
  const n = orders.length;
  const gbp = v => `£${Number(v).toFixed(2)}`;
  const pickHow = !pm ? 'the rate card' : cardFirst ? `the rate card (it reproduced ${pm.cardMatched} of ${pm.orders} orders in ${pickMonth})`
    : `the ${pickMonth} pattern (${Math.round(100 * pm.confidence)} % of that month’s ${pm.orders} orders reproduced)`;
  const categories = [
    modelled('picking', 'Picking', 'picking_cost', pm || cm ? sum.picking + bulk.atRate : null, [
      `${n - unpriced.picking} orders priced with ${pickHow}`,
      unpriced.picking ? `${unpriced.picking} orders without items could not be priced` : null,
    ]),
    modelled('rework', 'Rework', 'rework_cost', internal.reworkRules.length ? sum.rework : null, internal.reworkRules.length ? [
      'Today’s rework rules and each item’s latest price',
      reworkUncertain.length ? `${reworkUncertain.length} orders could not be checked (rule fields the audit cannot read, or products without dimensions)` : null,
    ] : ['This client has no rework rules; rework is added by hand, so only Mintsoft’s total is shown']),
    modelled('admin', 'Admin (per order)', 'admin_fee', admin ? sum.admin : null, [admin ? `${n} orders × ${gbp(admin.value)} (usual fee in ${adminMonth})` : 'No usual admin fee learned yet']),
    ...[['postage', 'Postage', 'postage_cost'], ['vatFree', 'VAT-free postage', 'vat_free_postage_cost'], ['packaging', 'Packaging', 'packaging_cost'],
      ['goodsIn', 'Goods in', 'goods_in_cost'], ['returns', 'Returns', 'returns_cost'], ['collections', 'Collections', 'collections_cost'],
      ['generic', 'Other items', 'generic_items_cost'], ['storage', 'Storage', 'storage_cost']]
      .map(([key, label, col]) => ({ key, label, accrual: a(col), expected: null, difference: null, modelled: false, notes: [] })),
  ];
  // Explain each modelled difference with what the audit can see before the
  // invoice exists (Mintsoft gives only the running totals, not its lines).
  const itemsBilled = acc?.number_of_items == null ? null : Number(acc.number_of_items);
  for (const cat of categories.filter(c => c.modelled && c.difference != null)) {
    const d = cat.difference;
    if (Math.abs(d) < 0.01) { cat.status = 'matches'; continue; }
    const implied = r2(cat.accrual - sum.picking);
    if (cat.key === 'picking' && bulk.orders && implied > -0.005) {
      // Bulk orders are often charged a flat rate by hand: what standard orders
      // do not account for is what the bulk orders were charged.
      cat.status = 'explained';
      cat.bulk = { ...bulk, implied };
      cat.notes.push(`${bulk.orders} bulk order${bulk.orders === 1 ? '' : 's'} (${bulk.units} units, 50 or more each) would be ${gbp(bulk.atRate)} at the usual per-unit rate, but such orders are often charged a flat rate by hand. Assuming the other ${n - bulk.orders - unpriced.picking} orders were charged at the usual rate, Mintsoft’s total leaves ${gbp(implied)} for them (${gbp(implied / bulk.orders)} each)`);
      if (itemsBilled != null && itemsBilled !== units) cat.notes.push(`Mintsoft counts ${itemsBilled} items so far against ${units} units in these orders`);
      continue;
    }
    if (cat.key === 'rework' && unpricedItems.size && d > 0) {
      const list = [...unpricedItems].map(([code, q]) => `${internal.nameOf[code] || code} × ${q}`).join(', ');
      const qty = [...unpricedItems.values()].reduce((t, q) => t + q, 0);
      cat.status = 'explained';
      cat.unpricedItems = [...unpricedItems].map(([code, qty]) => ({ code, name: internal.nameOf[code] || null, qty }));
      cat.notes.push(`${list} ${qty === 1 ? 'has' : 'have'} no known price yet (never billed before): Mintsoft’s ${gbp(d)} for them is about ${gbp(d / qty)} each. Confirm the price under Rates & rules`);
      continue;
    }
    if (cat.key === 'picking' && pm && !cardFirst && pm.confidence < MIN_CONFIDENCE) {
      cat.status = 'low_confidence';
      cat.notes.push(`The ${pickMonth} pattern reproduces only ${Math.round(100 * pm.confidence)} % of orders (below ${Math.round(100 * MIN_CONFIDENCE)} %), so a difference of ${gbp(Math.abs(d))} (${gbp(Math.abs(d) / Math.max(1, n))} an order) is within what the audit can tell`);
      continue;
    }
    const perOrder = n ? Math.abs(d) / n : 0;
    cat.status = Math.abs(d) <= Math.max(1, 0.02 * Math.abs(cat.accrual)) ? 'close' : 'differs';
    cat.notes.push(d > 0
      ? `Mintsoft is ${gbp(d)} higher (about ${gbp(perOrder)} an order): extra charges added by hand, or orders billed at a different rate`
      : `Mintsoft is ${gbp(-d)} lower (about ${gbp(perOrder)} an order): orders zeroed or reduced by hand, or billed at a different rate`);
    if (cat.key === 'picking' && itemsBilled != null && itemsBilled !== units) cat.notes.push(`Mintsoft counts ${itemsBilled} items so far against ${units} units in these orders`);
  }
  const modelledCats = categories.filter(c => c.expected != null);
  return {
    clientId, month, now: now.toISOString(),
    window: { start: win.start, end, startEstimated: win.estimated },
    accrualFound: !!acc, accrualUpdatedAt: end, syncedAt: acc?.updated_at || null,
    orders: n, units, itemsBilled, ordersAfterLastRun: later?.n || 0,
    pickingMonth: pickMonth, pickingConfidence: pm ? r2(pm.confidence) : null, minConfidence: MIN_CONFIDENCE,
    reworkUncertain: reworkUncertain.slice(0, 20),
    categories,
    totals: {
      accrual: r2(categories.reduce((s, c) => s + c.accrual, 0)),
      modelledAccrual: r2(modelledCats.reduce((s, c) => s + c.accrual, 0)),
      modelledExpected: r2(modelledCats.reduce((s, c) => s + c.expected, 0)),
      modelledDifference: r2(modelledCats.reduce((s, c) => s + c.difference, 0)),
    },
  };
}

// Cache per client until its invoice detail, rules, rate card, confirmed prices,
// ASN hours or the owner's audit rules change.
const cache = new Map();
async function cacheKey(clientId) {
  const r = await queryOne(
    `SELECT (SELECT MAX(detail_synced_at) FROM invoices WHERE client_id = $1) AS d,
            (SELECT MAX(captured_at) FROM client_order_rules WHERE client_id = $1) AS r,
            (SELECT MAX(captured_at) FROM client_rate_cards WHERE client_id = $1) AS c,
            (SELECT MAX(confirmed_at) FROM audit_rework_prices WHERE client_id = $1) AS p,
            (SELECT MAX(updated_at) FROM asns WHERE client_id = $1) AS a,
            (SELECT MAX(updated_at)::text || '#' || COUNT(*) FROM audit_rules WHERE client_id = $1 OR client_id IS NULL) AS u`,
    [clientId]
  );
  return [r?.d, r?.r, r?.c, r?.p, r?.a].map(v => (v ? new Date(v).toISOString() : '-')).concat(r?.u || '-').join('|');
}

async function clientAudit(clientId) {
  const key = await cacheKey(clientId);
  const hit = cache.get(clientId);
  if (hit && hit.key === key) return hit.data;
  const data = await computeClient(clientId);
  cache.set(clientId, { key, data });
  return data;
}

function forget(clientId) { if (clientId == null) cache.clear(); else cache.delete(clientId); }

module.exports = {
  clientAudit, forget, explainOrder, previewClient, billingWindow, describeModel,
  MIN_CONFIDENCE, mode, learnModel, cardModel, formula, counts, fitPicking,
};
