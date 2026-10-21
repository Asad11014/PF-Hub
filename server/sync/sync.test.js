// Unit tests for the sync engine's pure parts. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMintsoftDate, toMintsoftParam, londonDate } = require('./time');
const E = require('./entities');
const { norm } = require('./reconcile');

test('parseMintsoftDate treats Mintsoft timestamps as Europe/London wall-clock time', () => {
  const cases = [
    ['2026-09-20T12:44:00', '2026-09-20T11:44:00.000Z'],       // BST
    ['2026-01-15T12:00:00', '2026-01-15T12:00:00.000Z'],       // GMT
    ['2026-09-30T23:59:00', '2026-09-30T22:59:00.000Z'],       // month-end invoice stays in September
    ['2026-03-29T00:30:00', '2026-03-29T00:30:00.000Z'],       // before the spring-forward switch
    ['2026-03-29T02:30:00', '2026-03-29T01:30:00.000Z'],       // after it
    ['2026-10-25T00:30:00', '2026-10-24T23:30:00.000Z'],       // before the autumn switch
    ['2026-10-25T03:00:00', '2026-10-25T03:00:00.000Z'],       // after it
    ['2026-10-21T14:36:36.07057', '2026-10-21T13:36:36.070Z'], // fractional seconds
    ['2026-10-21T14:36:36Z', '2026-10-21T14:36:36.000Z'],      // explicit offsets are honoured
    ['2026-05-01', '2026-04-30T23:00:00.000Z'],
    ['0001-01-01T00:00:00', null], ['', null], [null, null], ['garbage', null],
  ];
  for (const [input, expected] of cases) assert.equal(parseMintsoftDate(input), expected, String(input));
});

test('toMintsoftParam / londonDate format instants as London time', () => {
  assert.equal(toMintsoftParam(new Date('2026-09-30T22:59:00Z')), '2026-09-30T23:59:00');
  assert.equal(toMintsoftParam(new Date('2026-01-10T08:00:00Z')), '2026-01-10T08:00:00');
  assert.equal(londonDate(new Date('2026-09-30T23:30:00Z')), '2026-10-01');
});

const ctx = { orderStatus: { 4: 'DESPATCHED', 99: 'NEWCODE' }, asnStatus: { 4: 'BOOKEDIN' }, knownProducts: new Set([4173]) };

test('order mapper keeps readable status names and exact values', () => {
  const row = E.mapOrder({ ID: 1, OrderStatusId: 4, ClientId: 0, WarehouseId: 3, OrderValue: 0, NumberOfParcels: 0, OrderDate: '2026-09-20T12:44:00', Channel: { Name: 'Shopify' } }, ctx);
  const get = c => row[E.ORDER_COLS.indexOf(c)];
  assert.equal(get('status_name'), 'Despatched');
  assert.equal(get('client_id'), null);           // Mintsoft 0 = none
  assert.equal(get('order_value'), 0);            // 0 stays 0 (the old sync turned it into NULL)
  assert.equal(get('number_of_parcels'), 0);
  assert.equal(get('order_date'), '2026-09-20T11:44:00.000Z');
  assert.equal(get('channel_name'), 'Shopify');
  assert.equal(E.mapOrder({ ID: 2, OrderStatusId: 99 }, ctx)[E.ORDER_COLS.indexOf('status_name')], 'NEWCODE');
});

test('order item mapper nulls unknown products and keeps the SKU', () => {
  const known = E.mapOrderItem({ ID: 10, ProductId: 4173, SKU: 'A', Quantity: 2, Commited: 1 }, 1, ctx);
  const unknown = E.mapOrderItem({ ID: 11, ProductId: 999, SKU: 'B', Quantity: 1 }, 1, ctx);
  assert.deepEqual([known[2], known[3], known[4], known[6]], [4173, 'A', 2, 1]);
  assert.deepEqual([unknown[2], unknown[3]], [null, 'B']);
});

test('stock mapper stores free (Level) and physical (TotalStockLevel) stock', () => {
  const r = E.mapStock({ ProductId: 1077, WarehouseId: 3, ClientId: 10, SKU: 'X', Level: 0, TotalStockLevel: 18 }, 3);
  assert.deepEqual(r, [1077, 3, 10, 'X', 0, 18, 0, 0, 18]);
});

test('client mapper reads Mintsoft "Y" as active', () => {
  assert.equal(E.bool('Y'), true);
  assert.equal(E.bool('N'), false);
  assert.deepEqual(E.mapClient({ ID: 34, Name: '', ShortName: 'NEW' }, true).slice(0, 4), [34, 'NEW', 'NEW', true]);
});

test('ASN mapper uses booked quantity and readable status', () => {
  const a = E.mapAsn({ ID: 5, ASNStatusId: 4, ClientId: 33 }, ctx);
  assert.equal(a[E.ASN_COLS.indexOf('status_name')], 'Booked In');
  assert.deepEqual(E.mapAsnItem({ ProductId: 4173, SKU: 'S', QuantityExpected: 700, QuantityReceieved: 650, QuantityBooked: 640 }, 5, ctx).slice(0, 5), [5, 4173, 'S', 700, 640]);
});

test('reconcile normaliser compares database and API representations', () => {
  assert.equal(norm('12.50'), norm(12.5));
  assert.equal(norm(new Date('2026-09-20T11:44:00Z')), norm('2026-09-20T11:44:00.000Z'));
  assert.notEqual(norm('12.51'), norm(12.5));
  assert.equal(norm('1.2750'), norm(1.275));      // exact, not rounded to 2 dp
  assert.notEqual(norm('1.28'), norm(1.275));
  assert.equal(norm('5060680420012'), norm('5060680420012'));
  assert.equal(norm(null), norm(undefined));
});
