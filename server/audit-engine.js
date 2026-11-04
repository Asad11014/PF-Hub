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

const { query, queryOne } = require('./db');
const { expectedRework, CHARGING_ACTIONS } = require('./audit-rules');
const { parseComments, ZEROED } = require('./audit-comments');

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
  const [lines, ruleSnap, cardSnap, confirmed] = await Promise.all([
    query(
      `SELECT io.id AS line_id, io.invoice_id, i.name AS invoice_name, to_char(i.invoice_date AT TIME ZONE 'Europe/London', 'YYYY-MM') AS month,
              io.order_id, io.picking_cost, io.extra_picking_cost, io.total_picking_cost, io.rework_cost, io.packaging_cost,
              io.admin_fee, io.total_cost, io.comments, io.invoice_date AS billed_at,
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
    queryOne(`SELECT card, captured_at FROM client_rate_cards WHERE client_id = $1 ORDER BY captured_at DESC LIMIT 1`, [clientId]),
    query(`SELECT item_key, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, price, note, confirmed_by, confirmed_at
           FROM audit_rework_prices WHERE client_id = $1 ORDER BY effective_from`, [clientId]),
  ]);
  const orderIds = [...new Set(lines.filter(l => l.order_known).map(l => l.order_id))];
  const items = orderIds.length ? await query(
    `SELECT oi.order_id, oi.sku, oi.quantity, p.name, p.category, p.width, p.height, p.depth, p.updated_at AS product_updated
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1::int[])`,
    [orderIds]
  ) : [];
  const byOrder = new Map();
  for (const it of items) (byOrder.get(it.order_id) || byOrder.set(it.order_id, []).get(it.order_id)).push(it);
  return { lines, items: byOrder, rules: ruleSnap?.rules || [], rulesAt: ruleSnap?.captured_at, card: cardSnap?.card || {}, cardAt: cardSnap?.captured_at, confirmed };
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
    const A = mode(rows.filter(r => r.c[by] > N).map(r => (r.billed - S) / (r.c[by] - N)))?.value ?? 0;
    const m = { source: 'learned', kind: 'byCount', by, S, A, N };
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

  // 6. Per-line expectation and flags.
  const out = new Map();
  // Rework accuracy counts only orders today's rules can speak for; orders placed
  // before a rule was last edited (or with unreadable fields) are "uncertain".
  const acc = { rework: { reproduced: 0, total: 0, uncertain: 0 }, picking: { matched: 0, total: 0 } };
  const ruleStats = Object.fromEntries(reworkRules.map(r => [r.ID, { fired: 0 }]));
  // Per invoice: warnings, notes, and the £ the warnings add up to
  // (negative value = charged less than expected, positive = more).
  const byInvoice = {};
  L.forEach((x, idx) => {
    const { l } = x;
    const flags = [];
    const notes = x.billedItems.notes;
    const zeroed = Number(l.total_cost) === 0 || notes.some(t => ZEROED.test(t));
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

    const inv = (byInvoice[l.invoice_id] = byInvoice[l.invoice_id] || { warnings: 0, info: 0, under: 0, over: 0, codes: {} });
    for (const f of flags) {
      inv.codes[f.code] = (inv.codes[f.code] || 0) + 1;
      if (f.severity === 'warning') {
        inv.warnings++;
        if (f.value < 0) inv.under = r2(inv.under - f.value); else if (f.value > 0) inv.over = r2(inv.over + f.value);
      } else inv.info++;
    }
    out.set(l.line_id, {
      expected: {
        rework: { items: expItems, amount: expAmount, uncertain, reproduced, priceChangedInMonth: atNeighbourPrice, fired: x.rw.fired.map(f => f.ruleId) },
        picking: pickExp, admin: adminExp,
      },
      flags,
    });
  });

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
    accuracy: { ...acc, rework: reworkRules.length ? acc.rework : null }, hasReworkRules: reworkRules.length > 0, byInvoice, lines: out,
  };
}

// Cache per client until its invoice detail, rules, rate card or confirmed prices change.
const cache = new Map();
async function cacheKey(clientId) {
  const r = await queryOne(
    `SELECT (SELECT MAX(detail_synced_at) FROM invoices WHERE client_id = $1) AS d,
            (SELECT MAX(captured_at) FROM client_order_rules WHERE client_id = $1) AS r,
            (SELECT MAX(captured_at) FROM client_rate_cards WHERE client_id = $1) AS c,
            (SELECT MAX(confirmed_at) FROM audit_rework_prices WHERE client_id = $1) AS p`,
    [clientId]
  );
  return [r?.d, r?.r, r?.c, r?.p].map(v => (v ? new Date(v).toISOString() : '-')).join('|');
}

async function clientAudit(clientId) {
  const key = await cacheKey(clientId);
  const hit = cache.get(clientId);
  if (hit && hit.key === key) return hit.data;
  const data = await computeClient(clientId);
  cache.set(clientId, { key, data });
  return data;
}

function forget(clientId) { cache.delete(clientId); }

module.exports = { clientAudit, forget, MIN_CONFIDENCE, mode, learnModel, cardModel, formula, counts, fitPicking };
