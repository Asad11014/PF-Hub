// ─── server/audit-checks.js ───────────────────────────────────────────────────
// Invoice Audit stage I3 checks (pure functions, used by server/audit-engine.js):
//   B7  goods-in charges against the client's rate card
//   C11 the owner's own audit rules
//   D14 postage that differs from the usual flat rate of its service
//
// Goods-in (verified on 2026 lines, 2026-11-04): Mintsoft charges
//   per unit  = GoodsInCostUnit × units      per SKU = GoodsInCostSku × SKUs
//   admin     = AdminChargePerASN + hours logged on the ASN × HourRateChargeForASN
//   delivery  = one of the card's delivery-size costs (carton, pallet, container)
// Rate cards are only known from the day we first captured them. A line billed
// before that is compared with that first card only where most of the client's
// other goods-in within ±45 days were charged at its rate (the rate was in use
// then); otherwise that part of the line is not checked (expected.unchecked).

const { evaluateRule } = require('./audit-rules');

const EPS = 0.005;
const r2 = v => Math.round(v * 100) / 100;
const num = v => (v == null || v === '' ? null : Number(v));
const gbp = v => `£${Number(v).toFixed(2)}`;
const plural = (n, w) => `${n.toLocaleString('en-GB')} ${w}${n === 1 ? '' : 's'}`;
const NEARBY_MS = 45 * 864e5;

const DELIVERY_FIELDS = {
  GoodsInCostCarton: 'carton', GoodsInCostPallet: 'pallet', GoodsInCost20ftContainer: '20ft container',
  GoodsInCost40ftContainer: '40ft container', GoodsInCost40ftContainerHC: '40ft HC container',
  GoodsInCost45ftContainer: '45ft container', GoodsInCost45ftContainerHC: '45ft HC container',
};

// The snapshot in effect when a line was billed: the latest one captured before
// it, else the earliest we have (today's card; known = false).
function cardAt(cards, at) {
  if (!cards.length) return null;
  const t = at ? new Date(at).getTime() : Date.now();
  const before = cards.filter(c => new Date(c.capturedAt).getTime() <= t).pop();
  return before ? { card: before.card, known: true } : { card: cards[0].card, known: false };
}

// Expected goods-in components for one line against one card.
function goodsInExpected(line, card) {
  const p = line.payload || {};
  const hours = Number(line.hours) || 0;
  const delivery = Object.entries(DELIVERY_FIELDS).map(([k, name]) => ({ name, cost: num(card[k]) })).filter(d => d.cost > 0);
  return {
    units: Number(p.NumberOfUnits) || 0, skus: Number(p.NumberOfSkus) || 0,
    unit: { billed: num(p.UnitCost) ?? 0, card: num(card.GoodsInCostUnit) ?? 0 },
    sku: { billed: num(p.SkuCost) ?? 0, card: num(card.GoodsInCostSku) ?? 0 },
    admin: { billed: num(p.AdminCost) ?? 0, base: num(card.AdminChargePerASN) ?? 0, hours, hourly: num(card.HourRateChargeForASN) ?? 0,
      expected: r2((num(card.AdminChargePerASN) ?? 0) + hours * (num(card.HourRateChargeForASN) ?? 0)) },
    delivery: { billed: num(p.DeliverySizeCost) ?? 0, quantity: Number(p.Quantity) || 0, onCard: delivery },
  };
}

const matches = {
  unit: e => Math.abs(e.unit.billed - e.unit.card) < EPS,
  sku: e => Math.abs(e.sku.billed - e.sku.card) < EPS,
  admin: e => Math.abs(e.admin.billed - e.admin.expected) < EPS,
  delivery: e => e.delivery.billed === 0 || e.delivery.onCard.some(d => Math.abs(d.cost - e.delivery.billed) < EPS),
};

// lines: [{ id, billedAt, payload, hours }]; cards: [{ card, capturedAt }] oldest first.
// → Map(id → { expected, flags })
function goodsInChecks(lines, cards) {
  const out = new Map();
  if (!cards.length) return out;
  // Lines billed before our first snapshot are compared with that snapshot.
  const first = cards[0].card;
  const zeroed = l => ['UnitCost', 'SkuCost', 'AdminCost', 'DeliverySizeCost'].every(k => !(Number(l.payload?.[k]) > 0));
  // Per component, which other lines were charged at that card's rate, for the
  // "rate was in use" test (most goods-in within ±45 days charged at it).
  const COMPONENTS = ['unit', 'sku', 'admin', 'delivery'];
  const charged = lines.filter(l => !zeroed(l)).map(l => {
    const e = goodsInExpected(l, first);
    return { id: l.id, t: new Date(l.billedAt).getTime(), ok: Object.fromEntries(COMPONENTS.map(k => [k, matches[k](e)])) };
  });
  for (const l of lines) {
    const at = cardAt(cards, l.billedAt);
    const e = goodsInExpected(l, at.card);
    const flags = [];
    const t = new Date(l.billedAt).getTime();
    const near = charged.filter(x => x.id !== l.id && Math.abs(x.t - t) <= NEARBY_MS);
    const inUse = k => near.length > 0 && near.filter(x => x.ok[k]).length / near.length >= 0.5;
    // Checked against the card in effect, or against today's card when most
    // goods-in around then were charged at today's rate. Otherwise not checked.
    const checked = k => at.known || inUse(k);
    const unchecked = COMPONENTS.filter(k => !checked(k));
    const expectedTotal = r2(e.unit.card * e.units + e.sku.card * e.skus + e.admin.expected);
    if (zeroed(l)) {
      if (expectedTotal > 0 && (checked('unit') || checked('admin'))) flags.push({ code: 'goods_in_zeroed', severity: 'info', explained: 'not charged', value: -expectedTotal,
        text: `Goods-in not charged; the rate card gives ${gbp(expectedTotal)} before delivery-size charges` });
    } else {
      if (!matches.unit(e) && checked('unit')) flags.push({ code: 'goods_in_unit', severity: 'warning', value: r2((e.unit.billed - e.unit.card) * e.units),
        text: `Per-unit goods-in ${gbp(e.unit.billed)} vs ${gbp(e.unit.card)} on the rate card (${plural(e.units, 'unit')})` });
      if (!matches.sku(e) && checked('sku')) flags.push({ code: 'goods_in_sku', severity: 'warning', value: r2((e.sku.billed - e.sku.card) * e.skus),
        text: `Per-SKU goods-in ${gbp(e.sku.billed)} vs ${gbp(e.sku.card)} on the rate card (${plural(e.skus, 'SKU')})` });
      if (!matches.admin(e) && checked('admin')) flags.push({ code: 'goods_in_admin', severity: 'warning', value: r2(e.admin.billed - e.admin.expected),
        text: `ASN admin ${gbp(e.admin.billed)} vs ${gbp(e.admin.expected)} expected (${gbp(e.admin.base)} per ASN${e.admin.hours ? ` + ${e.admin.hours} h logged × ${gbp(e.admin.hourly)}` : ', no hours logged'})` });
      if (!matches.delivery(e) && checked('delivery')) flags.push({ code: 'goods_in_delivery', severity: 'info', value: null,
        text: `Delivery charge ${gbp(e.delivery.billed)} each is not one of the rate card’s delivery-size costs${e.delivery.onCard.length ? ` (${e.delivery.onCard.map(d => `${d.name} ${gbp(d.cost)}`).join(', ')})` : ''}` });
    }
    out.set(l.id, { expected: { ...e, cardKnown: at.known, unchecked }, flags });
  }
  return out;
}

// ── D14 postage outliers ─────────────────────────────────────────────────────
// rows: [{ key, month, serviceId, service, postage, parcels, zeroed }]
// A service is flat-rate in a month when ≥ 80 % of at least 10 (non-zeroed)
// orders paid the same per parcel. Others on it are noted, never warned.
const FLAT_MIN = 10, FLAT_SHARE = 0.8;
function postageOutliers(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.serviceId == null || r.postage == null) continue;
    const k = `${r.month}|${r.serviceId}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const out = new Map();
  for (const list of groups.values()) {
    const per = r => r2(r.postage / Math.max(1, r.parcels || 1));
    const counted = list.filter(r => !r.zeroed);
    if (counted.length < FLAT_MIN) continue;
    const freq = new Map();
    counted.forEach(r => freq.set(per(r), (freq.get(per(r)) || 0) + 1));
    const [usual, n] = [...freq].sort((a, b) => b[1] - a[1])[0];
    if (n / counted.length < FLAT_SHARE) continue;
    for (const r of list) {
      if (Math.abs(per(r) - usual) < EPS) continue;
      const parcels = Math.max(1, r.parcels || 1);
      out.set(r.key, { code: 'postage_unusual', severity: 'info', explained: r.zeroed ? 'manually zeroed' : undefined,
        value: r2(r.postage - usual * parcels), usual, share: r2(n / counted.length),
        text: `Postage ${gbp(r.postage)}${parcels > 1 ? ` for ${parcels} parcels` : ''}; ${r.service || 'this service'} was ${gbp(usual)} per parcel on ${Math.round(100 * n / counted.length)} % of orders this month` });
    }
  }
  return out;
}

// ── C11 the owner's audit rules ──────────────────────────────────────────────
const RULE_CATEGORIES = {
  picking: { label: 'Picking', col: 'total_picking_cost' }, postage: { label: 'Postage', col: 'postage_cost' },
  rework: { label: 'Rework', col: 'rework_cost' }, packaging: { label: 'Packaging', col: 'packaging_cost' },
  admin: { label: 'Admin fee', col: 'admin_fee' }, total: { label: 'Order total', col: 'total_cost' },
};
const EXPECTATIONS = ['rework_item', 'min_charge', 'max_charge', 'no_charge'];

const asMintsoftRule = r => ({
  Active: true, ConditionType: r.condition_type === 'OR' ? 'OR' : 'AND',
  OrderRuleConditions: (r.conditions || []).map(c => ({ Field: c.field, Operator: c.operator, Value: c.value })),
});

function describeExpectation(x) {
  if (!x) return '';
  if (x.type === 'rework_item') return `rework item “${x.item}” is charged`;
  const label = RULE_CATEGORIES[x.category]?.label || x.category;
  if (x.type === 'min_charge') return `${label} is at least ${gbp(x.amount)}`;
  if (x.type === 'max_charge') return `${label} is at most ${gbp(x.amount)}`;
  if (x.type === 'no_charge') return `${label} is not charged`;
  return '';
}

// One rule on one billed order line.
//   line: invoice_orders row (+ billed_at); f: order features; billedItems: parsed comments
//   ctx: { zeroed, priceOf(itemName) → number | null }
// → { applies: true | false | null, flag: {...} | null }
function auditRuleOnLine(rule, line, f, billedItems, ctx) {
  if (rule.effective_from && line.billed_at && new Date(line.billed_at) < new Date(rule.effective_from)) return { applies: false, flag: null };
  const { applies } = evaluateRule(asMintsoftRule(rule), f);
  if (applies !== true) return { applies, flag: null };
  const x = rule.expectation || {};
  const label = `Your rule “${rule.name}”`;
  let flag = null;
  if (x.type === 'rework_item') {
    const want = String(x.item || '').trim().toLowerCase();
    const has = billedItems.reworkItems.some(i => String(i.item || '').toLowerCase().includes(want));
    if (want && !has) {
      const usual = ctx.priceOf ? ctx.priceOf(x.item) : null;
      flag = { value: usual != null ? -usual : null, under: true, text: `${label}: expected rework item “${x.item}”${usual != null ? ` (usually ${gbp(usual)})` : ''} but it was not charged` };
    }
  } else if (RULE_CATEGORIES[x.category]) {
    const billed = r2(Number(line[RULE_CATEGORIES[x.category].col]) || 0);
    const what = RULE_CATEGORIES[x.category].label;
    if (x.type === 'min_charge' && billed < Number(x.amount) - EPS) flag = { value: r2(billed - Number(x.amount)), under: true, text: `${label}: ${what} should be at least ${gbp(x.amount)}, charged ${gbp(billed)}` };
    if (x.type === 'max_charge' && billed > Number(x.amount) + EPS) flag = { value: r2(billed - Number(x.amount)), text: `${label}: ${what} should be at most ${gbp(x.amount)}, charged ${gbp(billed)}` };
    if (x.type === 'no_charge' && billed > EPS) flag = { value: billed, text: `${label}: ${what} should not be charged, charged ${gbp(billed)}` };
  }
  if (!flag) return { applies: true, flag: null };
  const explained = flag.under && ctx.zeroed ? 'manually zeroed' : undefined;
  return { applies: true, flag: { code: 'audit_rule', check: `audit_rule:${rule.id}`, ruleId: rule.id, severity: explained ? 'info' : 'warning', explained, value: flag.value, text: flag.text } };
}

module.exports = {
  goodsInChecks, goodsInExpected, cardAt, postageOutliers, auditRuleOnLine, asMintsoftRule, describeExpectation,
  RULE_CATEGORIES, EXPECTATIONS, DELIVERY_FIELDS,
};
