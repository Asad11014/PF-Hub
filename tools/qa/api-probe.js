// ─── tools/qa/api-probe.js ────────────────────────────────────────────────────
// Read-only probe of the live Mintsoft API (about 20 GET calls) that verifies
// which query parameters are honoured. Prints shapes/counts only; never prints
// the key. Run: node tools/qa/api-probe.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });
const { mintsoftGet } = require(path.join(ROOT, 'server/mintsoft.js'));
const KEY = process.env.MINTSOFT_ADMIN_KEY;
if (!KEY) { console.log('no MINTSOFT_ADMIN_KEY'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function probe(label, p, fn) {
  const s = Date.now();
  try {
    const r = await mintsoftGet(p, KEY);
    const b = r.body;
    const arr = Array.isArray(b) ? b : null;
    const summary = arr ? `array(${arr.length})` : (b && typeof b === 'object' ? `object keys=[${Object.keys(b).slice(0, 10).join(',')}]` : String(b).slice(0, 120));
    console.log(`\n## ${label}\n   GET ${p}\n   status=${r.status} ${Date.now() - s}ms ${summary}`);
    if (fn) fn(b, r.status);
  } catch (e) { console.log(`\n## ${label}\n   ERROR ${e.message}`); }
}

(async () => {
  await probe('Clients', '/api/Client?limit=100', b => Array.isArray(b) && console.log('   ids:', b.map(c => c.ID).join(',')));
  await probe('Orders SinceOrderDate (undocumented — expect IGNORED)', `/api/Order/List?WarehouseId=3&SinceOrderDate=${daysAgo(3)}T00:00:00&Limit=5&PageNo=1&SortOldestFirst=true`,
    b => Array.isArray(b) && console.log('   OrderDates:', b.map(o => (o.OrderDate || '').slice(0, 10)).join(' ')));
  await probe('Orders SinceDate (documented)', `/api/Order/List?WarehouseId=3&SinceDate=${daysAgo(3)}T00:00:00&Limit=5&PageNo=1&SortOldestFirst=true`,
    b => Array.isArray(b) && console.log('   OrderDates:', b.map(o => (o.OrderDate || '').slice(0, 10)).join(' ')));
  await probe('Orders IncludeOrderItems', `/api/Order/List?WarehouseId=3&SinceDate=${daysAgo(2)}T00:00:00&IncludeOrderItems=true&Limit=2&PageNo=1`,
    b => Array.isArray(b) && b[0] && console.log('   OrderItems inline:', Array.isArray(b[0].OrderItems), 'count', b[0].OrderItems?.length));
  await probe('Orders SinceLastUpdated', `/api/Order/List?WarehouseId=3&SinceLastUpdated=${daysAgo(1)}T00:00:00&Limit=5&PageNo=1`,
    b => Array.isArray(b) && console.log('   LastUpdated:', b.map(o => (o.LastUpdated || '').slice(0, 16)).join(' ')));
  await probe('Invoices p1', '/api/Accounting/Invoice/List?Limit=100&PageNo=1', b => Array.isArray(b) && console.log('   first:', b[0]?.ID, b[0]?.Date, '| last:', b.at(-1)?.ID, b.at(-1)?.Date));
  await probe('Invoices p2', '/api/Accounting/Invoice/List?Limit=100&PageNo=2', b => Array.isArray(b) && console.log('   first:', b[0]?.ID, '| last:', b.at(-1)?.ID));
  await probe('Invoices SinceDate', `/api/Accounting/Invoice/List?Limit=100&PageNo=1&SinceDate=${daysAgo(60)}T00:00:00`,
    b => Array.isArray(b) && console.log('   ', b.map(i => `${i.ID}:${(i.Date || '').slice(0, 10)}:c${i.ClientId}`).join(' ')));
  await probe('Unconfirmed summary (client 10, MTD)', `/api/Account/Invoice/GetUnconfirmedInvoiceSummary?clientID=10&fromDate=${today.slice(0, 8)}01&toDate=${today}`,
    b => b && console.log('   PickingCost=', b.PickingCost, 'PostageCost=', b.PostageCost, 'StorageCost=', b.StorageCost));
  await probe('ASN SinceLastUpdated + items', `/api/ASN/List?WarehouseId=3&SinceLastUpdated=${daysAgo(30)}T00:00:00&IncludeASNItems=true&Limit=2&PageNo=1`,
    b => Array.isArray(b) && b[0] && console.log('   Items inline:', Array.isArray(b[0].Items), b[0].Items?.length));
  await probe('Product/List SinceLastUpdated', `/api/Product/List?Limit=2&PageNo=1&SinceLastUpdated=${daysAgo(7)}T00:00:00`);
  await probe('Product/UpdatedSince (as v2 code calls it — expect 400)', `/api/Product/UpdatedSince?WarehouseId=3&UpdatedSince=${daysAgo(7)}T00:00:00.000Z&Limit=100&PageNo=1`);
  await probe('StockLevels (full)', '/api/Product/StockLevels?WarehouseId=3', b => Array.isArray(b) && console.log('   rows:', b.length));
})();
