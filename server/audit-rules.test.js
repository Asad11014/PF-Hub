// Unit tests for the Mintsoft order-rule evaluator. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCondition: ev, evaluateRule, parseParam, expectedRework } = require('./audit-rules');

const order = {
  orderNumber: 'IN86123', externalReference: 'EXT-1', firstName: 'Sam', companyName: 'Motel One London', address1: '1 High St',
  address2: '', town: 'Watford', county: '', postcode: 'WD3 4TG', phone: '0123', mobile: '', email: 'a@b.com',
  courierService: 'RM Tracked 48', channel: 'Bluepark SER', channelId: 34, warehouseId: 3,
  totalWeight: 2.5, orderValue: 40, orderVolume: 0.0057, parcels: 1, totalItems: 3, largestDimension: 30,
  giftMessages: '', deliveryNotes: 'Leave at door',
  skus: ['ser_neem-shield', 'SER-SPRAYHEAD-250ml'], names: ['Neem Shield Spray'], categories: ['BEDDING', 'PILLOWCASE'],
  orderDate: new Date('2026-10-27T10:00:00Z'),
};
const c = (Field, Operator, Value) => ({ Field, Operator, Value });

test('text operators ignore case and spaces', () => {
  assert.equal(ev(c('CompanyName', 'Contains', 'motel one'), order), true);
  assert.equal(ev(c('CompanyName', 'DoesNotContain', 'Radisson'), order), true);
  assert.equal(ev(c('PostCode', 'Equals', ' wd3 4tg '), order), true);
  assert.equal(ev(c('PostCode', 'NotEqual', 'WD3 4TG'), order), false);
  assert.equal(ev(c('Town', 'StartsWith', 'wat'), order), true);
  assert.equal(ev(c('Town', 'DoesNotStartWith', 'Lon'), order), true);
  assert.equal(ev(c('Address2', 'Empty', ''), order), true);
  assert.equal(ev(c('DeliveryNotes', 'IsNotEmpty', ''), order), true);
  assert.equal(ev(c('Channel', 'Equals', 'bluepark ser'), order), true);
});

test('numeric operators, including OrderVolume thresholds', () => {
  assert.equal(ev(c('OrderVolume', 'LessThan', '0.013'), order), true);
  assert.equal(ev(c('OrderVolume', 'GreaterThan', '0.013'), order), false);
  assert.equal(ev(c('TotalItems', 'EqualsOrGreaterThan', '3'), order), true);
  assert.equal(ev(c('TotalItems', 'EqualsOrLessThan', '2'), order), false);
  assert.equal(ev(c('TotalItems', 'Equals', '3'), order), true);
  assert.equal(ev(c('TotalItems', 'NotEqual', '13'), order), true);
  assert.equal(ev(c('TotalWeight', 'EqualsOrGreaterThan', '2'), order), true);
  assert.equal(ev(c('OrderValue', 'GreaterThan', 'abc'), order), null);   // unparseable value → unknown
});

test('list fields match when ANY item matches; negations need NO item to match', () => {
  assert.equal(ev(c('OrderItemProductCategory', 'Contains', 'bedding'), order), true);
  assert.equal(ev(c('OrderItemProductCategory', 'Equals', 'PILLOWCASE'), order), true);
  assert.equal(ev(c('OrderItemProductCategory', 'NotEqual', 'PILLOW'), order), true);
  assert.equal(ev(c('OrderItemProductCategory', 'NotEqual', 'BEDDING'), order), false);
  assert.equal(ev(c('OrderItemProductSKUS', 'DoesNotContain', 'OV1012'), order), true);
  assert.equal(ev(c('OrderItemProductSKUS', 'Contains', 'sprayhead'), order), true);
  assert.equal(ev(c('OrderItemProductSKUS', 'StartsWith', 'SER-'), order), true);
  assert.equal(ev(c('OrderItemProductSKUS', 'DoesNotStartWith', 'ser'), order), false);
  assert.equal(ev(c('OrderItemProductNames', 'IsNotEmpty', ''), order), true);
  assert.equal(ev(c('OrderItemProductNames', 'Empty', ''), { ...order, names: [] }), true);
  assert.equal(ev(c('OrderItemProductSKUS', 'GreaterThan', '1'), order), null);  // numeric op on a list
});

test('fields the audit cannot compute are unknown, never guessed', () => {
  assert.equal(ev(c('ShippingZone', 'Equals', 'UK'), order), null);
  assert.equal(ev(c('CountryName', 'Equals', 'UNITED KINGDOM'), order), null);
});

const rule = (over = {}) => ({ ID: 1, Action: 'AddReworkItem', Param: 'SW-BOX', Active: true, Priority: 100, ConditionType: 'AND',
  OverwriteExisting: true, ChannelId: 0, WarehouseId: 0, LastUpdated: '2025-08-04T13:34:13', OrderRuleConditions: [], ...over });

test('AND / OR / no conditions / inactive / channel filter / unknown', () => {
  assert.equal(evaluateRule(rule(), order).applies, true);  // no conditions: always
  assert.equal(evaluateRule(rule({ Active: false }), order).applies, false);
  assert.equal(evaluateRule(rule({ ChannelId: 99 }), order).applies, false);
  assert.equal(evaluateRule(rule({ ChannelId: 34 }), order).applies, true);
  const and = [c('OrderVolume', 'LessThan', '0.013'), c('TotalItems', 'LessThan', '3')];
  assert.equal(evaluateRule(rule({ OrderRuleConditions: and }), order).applies, false);
  assert.equal(evaluateRule(rule({ ConditionType: 'OR', OrderRuleConditions: and }), order).applies, true);
  const withUnknown = [c('ShippingZone', 'Equals', 'UK'), c('OrderVolume', 'LessThan', '0.013')];
  assert.equal(evaluateRule(rule({ OrderRuleConditions: withUnknown }), order).applies, null);         // AND: unknown + true
  assert.equal(evaluateRule(rule({ ConditionType: 'OR', OrderRuleConditions: withUnknown }), order).applies, true); // OR: one true is enough
  assert.deepEqual(evaluateRule(rule({ OrderRuleConditions: withUnknown }), order).unknownFields, ['ShippingZone']);
});

test('parameters, priorities, overwrite and rules edited after the order', () => {
  assert.deepEqual(parseParam('BEDDING;1'), { code: 'BEDDING', qty: 1 });
  assert.deepEqual(parseParam('SMALL-SUGAR;2'), { code: 'SMALL-SUGAR', qty: 2 });
  assert.deepEqual(parseParam('SW-BOX'), { code: 'SW-BOX', qty: 1 });
  const rules = [
    rule({ ID: 22, Param: 'SW-BOX', OrderRuleConditions: [c('OrderVolume', 'LessThan', '0.013')] }),
    rule({ ID: 24, Param: 'DW-BOX', Priority: 50, OrderRuleConditions: [c('OrderVolume', 'GreaterThan', '0.013')] }),
    rule({ ID: 30, Param: 'BEDDING;1', Priority: 100, OrderRuleConditions: [c('OrderItemProductCategory', 'Contains', 'BEDDING')] }),
    rule({ ID: 31, Param: 'BEDDING;1', Priority: 95, OrderRuleConditions: [c('OrderItemProductCategory', 'Contains', 'PILLOWCASE')] }),
    rule({ ID: 40, Action: 'ChangeCourierService', Param: 'APC Next Day' }),   // not a charge
  ];
  const r = expectedRework(rules, order);
  assert.deepEqual(r.items, [{ code: 'SW-BOX', qty: 1 }, { code: 'BEDDING', qty: 1 }]);   // overwrite: BEDDING stays 1
  const add = expectedRework(rules.map(x => ({ ...x, OverwriteExisting: false })), order);
  assert.deepEqual(add.items.find(i => i.code === 'BEDDING'), { code: 'BEDDING', qty: 2 });
  const early = expectedRework([rule({ LastUpdated: '2026-10-28T00:00:00' })], order);
  assert.deepEqual(early.editedAfterOrder, [1]);
});
