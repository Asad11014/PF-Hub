// Unit tests for the Invoice Audit maths and staff permissions. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseComments, buildCategories, integrityOf } = require('./audit');
const { normalize, permissionForPath } = require('./permissions');

test('order-line comments split into rework items and typed notes', () => {
  assert.deepEqual(parseComments('- X 1\r\n\r\n'), { reworkItems: [{ item: null, qty: 1 }], notes: [] });
  assert.deepEqual(parseComments('Shipping box - 30X20X10- X 1\r\nLL-SW-BOX- X 2\r\n').reworkItems,
    [{ item: 'Shipping box - 30X20X10', qty: 1 }, { item: 'LL-SW-BOX', qty: 2 }]);
  assert.deepEqual(parseComments('Zerod All Costs\r\n'), { reworkItems: [], notes: ['Zerod All Costs'] });
  assert.deepEqual(parseComments('Add Delivery Note Pouch- X 1\r\nShort shipped - 1 diffuser'), {
    reworkItems: [{ item: 'Add Delivery Note Pouch', qty: 1 }], notes: ['Short shipped - 1 diffuser'] });
  assert.deepEqual(parseComments(null), { reworkItems: [], notes: [] });
});

const inv = { picking_cost: 10, postage_cost: 5, vat_free_postage_cost: 0, rework_cost: 2, packaging_cost: 0, admin_fee: 0,
  goods_in_cost: 20, returns_cost: 3, collections_cost: 0, generic_items_cost: 50, storage_cost: 100 };
const lineData = {
  orderSums: { total_picking_cost: 10, postage_cost: 4, rework_cost: 2 }, orderLines: 3,
  extraSums: { goods_in: 15, 'other:GoodsIn': 5, returns: 3, 'other:Admin': 45, 'other:': 5, 'other:Postage': 1, 'other:Storage': 30 },
  extraCounts: { goods_in: 2, returns: 1, 'other:Admin': 2, 'other:': 1, 'other:Postage': 1, 'other:Storage': 1 },
};
const byKey = cats => Object.fromEntries(cats.map(c => [c.key, c]));

test('"Other" lines add to the category of their charge type; Admin/Generic/blank → other items', () => {
  const c = byKey(buildCategories(inv, lineData, false));
  assert.equal(c.postage.lines, 5);      // 4 from orders + 1 Postage-type other line
  assert.equal(c.goodsIn.lines, 20);     // 15 goods-in lines + 5 GoodsIn-type other line
  assert.equal(c.generic.lines, 50);     // Admin 45 + blank 5
  assert.equal(c.generic.difference, 0);
  assert.equal(integrityOf(Object.values(c)).difference, 0);
});

test('storage is only partly itemised: shown, never counted as a mismatch', () => {
  const c = byKey(buildCategories(inv, lineData, false));
  assert.equal(c.storage.difference, null);
  assert.equal(c.storage.lines, 30);
  assert.equal(c.storage.notItemisedRemainder, 70);
});

test('missing lines are "not available" only on invoices older than the order history', () => {
  const noOrders = { ...lineData, orderSums: {}, orderLines: 0 };
  const old = byKey(buildCategories(inv, noOrders, true));
  assert.equal(old.picking.unavailable, true);
  assert.equal(old.picking.difference, null);
  const recent = byKey(buildCategories(inv, noOrders, false));
  assert.equal(recent.picking.unavailable, false);
  assert.equal(recent.picking.difference, 10);   // a real difference on a current invoice
});

test('permission helpers: usernames are case/space-insensitive; only audit paths need the permission', () => {
  assert.equal(normalize('  ARizvi@PremiumFulfilment.co.uk '), 'arizvi@premiumfulfilment.co.uk');
  assert.equal(permissionForPath('/api/audit/overview'), 'invoice_audit');
  assert.equal(permissionForPath('/api/audit/invoices/337'), 'invoice_audit');
  assert.equal(permissionForPath('/api/report/best-sellers'), null);
  assert.equal(permissionForPath('/api/admin/subscriptions'), null);
});
