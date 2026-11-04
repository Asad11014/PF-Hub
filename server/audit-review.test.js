// Unit tests for the review workflow's validation. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSubject, validateReview, validateRule } = require('./audit-review');
const { csvCell } = require('./audit');

test('finding subjects', () => {
  assert.deepEqual(parseSubject('line:123'), { kind: 'line', id: 123 });
  assert.deepEqual(parseSubject('invoice:9'), { kind: 'invoice', id: 9 });
  assert.deepEqual(parseSubject('order:77'), { kind: 'order', id: 77 });
  assert.deepEqual(parseSubject('extra:goods_in:1005'), { kind: 'extra', extraKind: 'goods_in', id: 1005 });
  for (const bad of ['', 'line:', 'line:abc', 'extra:storage:1', 'invoice:1;DROP', 'line:1:2', null]) assert.equal(parseSubject(bad), null, String(bad));
});

test('a review needs a known status; credit and charge need a note', () => {
  assert.equal(validateReview({ subject: 'line:1', check: 'picking_below', status: 'ok' }).status, 'ok');
  assert.equal(validateReview({ subject: 'line:1', check: 'picking_below', status: 'open' }).status, 'open');
  assert.equal(validateReview({ subject: 'line:1', check: 'audit_rule:12', status: 'ok' }).check, 'audit_rule:12');
  assert.match(validateReview({ subject: 'line:1', check: 'picking_below', status: 'credit' }).error, /note/);
  assert.equal(validateReview({ subject: 'line:1', check: 'picking_below', status: 'credit', note: 'Over-charged', amount: '0.39' }).amount, 0.39);
  assert.match(validateReview({ subject: 'line:1', check: 'picking_below', status: 'charge', note: 'x', amount: -1 }).error, /amount/);
  assert.match(validateReview({ subject: 'line:1', check: 'picking_below', status: 'maybe' }).error, /status/);
  assert.match(validateReview({ subject: 'line:1', check: "x'; --", status: 'ok' }).error, /check/);
  assert.match(validateReview({ subject: 'nope', check: 'zero_charge', status: 'ok' }).error, /subject/);
  assert.equal(validateReview({ subject: 'line:1', check: 'zero_charge', status: 'ok', note: 'x'.repeat(900) }).note.length, 500);
});

test('audit rules are validated against the fields and operators the audit can evaluate', () => {
  const ok = validateRule({ name: ' Glass ', conditions: [{ field: 'OrderItemProductCategory', operator: 'Contains', value: 'GLASS' }], expectation: { type: 'rework_item', item: 'DW-BOX' } });
  assert.equal(ok.name, 'Glass');
  assert.equal(ok.conditionType, 'AND');
  assert.equal(ok.clientId, null);   // every client
  assert.match(validateRule({ name: 'x', conditions: [{ field: 'ShippingZone', operator: 'Equals', value: 'UK' }], expectation: { type: 'no_charge', category: 'admin' } }).error, /Unknown field/);
  assert.match(validateRule({ name: 'x', conditions: [], expectation: { type: 'no_charge', category: 'admin' } }).error, /conditions/);
  assert.match(validateRule({ name: 'x', conditions: [{ field: 'Channel', operator: 'Equals', value: '' }], expectation: { type: 'no_charge', category: 'admin' } }).error, /value/);
  const empty = validateRule({ name: 'x', clientId: 12, conditions: [{ field: 'DeliveryNotes', operator: 'IsNotEmpty', value: 'ignored' }], expectation: { type: 'min_charge', category: 'picking', amount: '1.5' } });
  assert.deepEqual(empty.conditions[0], { field: 'DeliveryNotes', operator: 'IsNotEmpty', value: '' });
  assert.deepEqual(empty.expectation, { type: 'min_charge', category: 'picking', amount: 1.5 });
  assert.equal(empty.clientId, 12);
  assert.match(validateRule({ name: 'x', conditions: [{ field: 'Channel', operator: 'Equals', value: 'A' }], expectation: { type: 'min_charge', category: 'storage', amount: 1 } }).error, /category/);
  assert.match(validateRule({ name: 'x', conditions: [{ field: 'Channel', operator: 'Equals', value: 'A' }], expectation: { type: 'min_charge', category: 'picking' } }).error, /amount/);
  assert.match(validateRule({ name: 'x', effectiveFrom: '1/11/2026', conditions: [{ field: 'Channel', operator: 'Equals', value: 'A' }], expectation: { type: 'no_charge', category: 'admin' } }).error, /effectiveFrom/);
});

test('CSV cells: quoted when needed, formulas neutralised, negative numbers kept', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, b'), '"a, b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-0.39'), '-0.39');
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(null), '');
});
