// Unit tests for the stage I3 checks: goods-in, postage outliers, audit rules. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { goodsInChecks, postageOutliers, auditRuleOnLine, describeExpectation } = require('./audit-checks');

const card = { GoodsInCostUnit: 0.45, GoodsInCostSku: 0, AdminChargePerASN: 3.75, HourRateChargeForASN: 40, GoodsInCostCarton: 1, GoodsInCostPallet: 2.5, GoodsInCost40ftContainer: 495 };
const cards = [{ card, capturedAt: '2026-11-04T13:00:00Z' }];
const gi = (id, billedAt, p, hours = 0) => ({ id, billedAt, hours, payload: { NumberOfUnits: 100, NumberOfSkus: 2, UnitCost: 0.45, SkuCost: 0, AdminCost: 3.75, DeliverySizeCost: 1, Quantity: 3, ...p } });

test('goods-in at the rate card (admin includes logged hours) raises nothing', () => {
  const r = goodsInChecks([gi(1, '2026-11-05T19:05:00Z', {}), gi(2, '2026-11-05T19:05:00Z', { AdminCost: 7.75 }, 0.1)], cards);
  assert.deepEqual(r.get(1).flags, []);
  assert.deepEqual(r.get(2).flags, []);
  assert.equal(r.get(2).expected.admin.expected, 7.75);
  assert.equal(r.get(1).expected.cardKnown, true);
});

test('goods-in billed after the card was captured: differences are warnings with £ values', () => {
  const r = goodsInChecks([gi(1, '2026-11-05T19:05:00Z', { UnitCost: 0, AdminCost: 23.75 })], cards);
  const unit = r.get(1).flags.find(f => f.code === 'goods_in_unit');
  const admin = r.get(1).flags.find(f => f.code === 'goods_in_admin');
  assert.equal(unit.severity, 'warning'); assert.equal(unit.value, -45);
  assert.equal(admin.severity, 'warning'); assert.equal(admin.value, 20);
});

test('before the first captured card: checked only where most goods-in nearby were charged at that rate', () => {
  const alone = goodsInChecks([gi(1, '2026-03-10T19:05:00Z', { UnitCost: 0 })], cards);
  assert.deepEqual(alone.get(1).flags, []);
  assert.deepEqual(alone.get(1).expected.unchecked, ['unit', 'sku', 'admin', 'delivery']);
  const nearby = goodsInChecks([gi(1, '2026-03-10T19:05:00Z', { UnitCost: 0 }), gi(2, '2026-03-20T19:05:00Z', {})], cards);
  assert.equal(nearby.get(1).flags[0].code, 'goods_in_unit');
  assert.equal(nearby.get(1).flags[0].severity, 'warning');
  const farAway = goodsInChecks([gi(1, '2026-03-10T19:05:00Z', { UnitCost: 0 }), gi(2, '2026-07-20T19:05:00Z', {})], cards);
  assert.deepEqual(farAway.get(1).flags, []);
  // One line at the card rate among many that are not: the rate was not in use.
  const mostlyOther = goodsInChecks([gi(1, '2026-03-10T19:05:00Z', { UnitCost: 0 }), gi(2, '2026-03-11T19:05:00Z', { UnitCost: 0 }),
    gi(3, '2026-03-12T19:05:00Z', { UnitCost: 0 }), gi(4, '2026-03-13T19:05:00Z', {})], cards);
  assert.deepEqual(mostlyOther.get(1).flags, []);
});

test('zeroed goods-in is one note; delivery costs must be on the card', () => {
  const r = goodsInChecks([
    gi(1, '2026-11-05T19:05:00Z', { UnitCost: 0, AdminCost: 0, DeliverySizeCost: 0 }),
    gi(2, '2026-11-05T19:05:00Z', { DeliverySizeCost: 495, Quantity: 1 }),
    gi(3, '2026-11-05T19:05:00Z', { DeliverySizeCost: 250, Quantity: 1 }),
  ], cards);
  assert.deepEqual(r.get(1).flags.map(f => [f.code, f.severity]), [['goods_in_zeroed', 'info']]);
  assert.equal(r.get(1).flags[0].value, -48.75);
  assert.deepEqual(r.get(2).flags, []);
  assert.deepEqual(r.get(3).flags.map(f => [f.code, f.severity]), [['goods_in_delivery', 'info']]);
});

const post = (key, postage, extra = {}) => ({ key, month: '2026-10', serviceId: 7, service: 'RM 48', postage, parcels: 1, zeroed: false, ...extra });

test('postage: flat-rate services note orders charged differently, per parcel', () => {
  const rows = [...Array.from({ length: 12 }, (_, i) => post(i, 3.2)), post(20, 4.5), post(21, 6.4, { parcels: 2 }), post(22, 0, { zeroed: true })];
  const r = postageOutliers(rows);
  assert.equal(r.size, 2);
  assert.equal(r.get(20).value, 1.3);
  assert.equal(r.get(20).severity, 'info');
  assert.equal(r.get(22).explained, 'manually zeroed');
  assert.equal(r.has(21), false);   // 2 parcels at the flat rate
});

test('postage: weight-banded services and small samples are left alone', () => {
  const banded = [...Array.from({ length: 7 }, (_, i) => post(i, 3.2)), ...Array.from({ length: 5 }, (_, i) => post(10 + i, 5.1))];
  assert.equal(postageOutliers(banded).size, 0);
  const few = [...Array.from({ length: 8 }, (_, i) => post(i, 3.2)), post(9, 4.5)];
  assert.equal(postageOutliers(few).size, 0);
});

const f = { categories: ['GLASS', 'CANDLE'], skus: ['GL-1'], names: ['Glass jar'], totalItems: 2, channel: 'Shopify', orderVolume: 0.01 };
const rule = (expectation, over = {}) => ({ id: 9, name: 'Glass needs a double wall box', condition_type: 'AND',
  conditions: [{ field: 'OrderItemProductCategory', operator: 'Contains', value: 'glass' }], expectation, effective_from: null, ...over });
const line = (over = {}) => ({ billed_at: '2026-10-10T19:05:00Z', total_picking_cost: 1.75, postage_cost: 3.2, rework_cost: 0, packaging_cost: 0, admin_fee: 0.25, total_cost: 5.2, ...over });
const billed = items => ({ reworkItems: items.map(item => ({ item, qty: 1 })), notes: [] });

test('audit rule: expected rework item missing → warning with the usual price', () => {
  const r = auditRuleOnLine(rule({ type: 'rework_item', item: 'DW-BOX' }), line(), f, billed([]), { zeroed: false, priceOf: () => 0.65 });
  assert.equal(r.applies, true);
  assert.equal(r.flag.code, 'audit_rule');
  assert.equal(r.flag.check, 'audit_rule:9');
  assert.equal(r.flag.severity, 'warning');
  assert.equal(r.flag.value, -0.65);
  const ok = auditRuleOnLine(rule({ type: 'rework_item', item: 'dw-box' }), line(), f, billed(['DW-BOX']), { zeroed: false });
  assert.equal(ok.flag, null);
});

test('audit rule: minimum / maximum / no charge, zeroed orders and dates', () => {
  const min = auditRuleOnLine(rule({ type: 'min_charge', category: 'picking', amount: 2 }), line(), f, billed([]), { zeroed: false });
  assert.equal(min.flag.value, -0.25);
  const max = auditRuleOnLine(rule({ type: 'max_charge', category: 'postage', amount: 3 }), line(), f, billed([]), { zeroed: false });
  assert.equal(max.flag.value, 0.2);
  const none = auditRuleOnLine(rule({ type: 'no_charge', category: 'admin' }), line(), f, billed([]), { zeroed: false });
  assert.equal(none.flag.value, 0.25);
  const zeroed = auditRuleOnLine(rule({ type: 'min_charge', category: 'picking', amount: 2 }), line({ total_picking_cost: 0 }), f, billed([]), { zeroed: true });
  assert.equal(zeroed.flag.severity, 'info');
  const notYet = auditRuleOnLine(rule({ type: 'no_charge', category: 'admin' }, { effective_from: '2026-11-01' }), line(), f, billed([]), { zeroed: false });
  assert.equal(notYet.applies, false);
  const other = auditRuleOnLine(rule({ type: 'no_charge', category: 'admin' }, { conditions: [{ field: 'Channel', operator: 'Equals', value: 'Amazon' }] }), line(), f, billed([]), { zeroed: false });
  assert.equal(other.applies, false);
  const unknown = auditRuleOnLine(rule({ type: 'no_charge', category: 'admin' }, { conditions: [{ field: 'ShippingZone', operator: 'Equals', value: 'UK' }] }), line(), f, billed([]), { zeroed: false });
  assert.equal(unknown.applies, null);
  assert.equal(describeExpectation({ type: 'min_charge', category: 'picking', amount: 2 }), 'Picking is at least £2.00');
});
