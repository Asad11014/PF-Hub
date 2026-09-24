// ─── server/reports/base.js ───────────────────────────────────────────────────
// Shared utilities used by every report.
// Import this in each report file rather than duplicating logic.

const { mintsoftGet } = require('../mintsoft');
const { resolveScope } = require('../scope');

const PAGE_LIMIT = 100;  // Mintsoft hard cap
const ITEM_BATCH = 10;   // Concurrent order item fetches

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmt(date) {
  return date.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

// Fetch all stock levels for a warehouse + client
async function fetchStock(apiKey, warehouseId, clientId) {
  let path = `/api/Product/StockLevels?WarehouseId=${encodeURIComponent(warehouseId)}`;
  if (clientId) path += `&ClientId=${encodeURIComponent(clientId)}`;

  const result = await mintsoftGet(path, apiKey);
  if (result.status !== 200) throw new Error(`Stock API error: ${result.status}`);

  const all = Array.isArray(result.body) ? result.body : [];
  return clientId ? all.filter(i => String(i.ClientId) === String(clientId)) : all;
}

// Fetch all orders (with items) for a date range, streaming progress via onProgress
async function fetchOrders(apiKey, warehouseId, clientId, fromDate, toDate, onProgress) {
  const allOrders = [];
  let pageNo = 1;
  const clientParam = clientId ? `&ClientId=${encodeURIComponent(clientId)}` : '';

  // Paginate through order headers
  while (true) {
    const path = `/api/Order/List?WarehouseId=${encodeURIComponent(warehouseId)}&SinceOrderDate=${fromDate}T00:00:00&ToDate=${toDate}T23:59:59&Limit=${PAGE_LIMIT}&PageNo=${pageNo}${clientParam}`;
    const result = await mintsoftGet(path, apiKey);
    if (result.status !== 200) throw new Error(`Orders API error: ${result.status} on page ${pageNo}`);

    const batch = Array.isArray(result.body) ? result.body : [];
    allOrders.push(...batch);

    if (onProgress) onProgress({ stage: 'orders', page: pageNo, total: allOrders.length });
    if (batch.length < PAGE_LIMIT) break;
    pageNo++;
    if (pageNo > 200) break;
  }

  // Fetch order items in batches
  for (let i = 0; i < allOrders.length; i += ITEM_BATCH) {
    const batch = allOrders.slice(i, i + ITEM_BATCH);
    await Promise.all(batch.map(async (order) => {
      const id = order.ID || order.Id;
      if (!id) return;
      const r = await mintsoftGet(`/api/Order/${id}`, apiKey);
      if (r.status === 200 && r.body.OrderItems) order.OrderItems = r.body.OrderItems;
    }));
    if (onProgress) onProgress({ stage: 'items', done: Math.min(i + ITEM_BATCH, allOrders.length), total: allOrders.length });
  }

  return allOrders;
}

// ── SKU aggregation ───────────────────────────────────────────────────────────

// Build a map of { sku → totalUnitsSold } from an orders array
function buildSkuSales(orders) {
  const sales = {};
  for (const order of orders) {
    for (const item of (order.OrderItems || [])) {
      const sku = item.SKU || item.Sku || '';
      const qty = item.Quantity || 0;
      if (sku && qty) sales[sku] = (sales[sku] || 0) + qty;
    }
  }
  return sales;
}

// Build a map of { sku → [ { date, qty } ] } for time-series analysis
function buildSkuDailySales(orders) {
  const daily = {};
  for (const order of orders) {
    const date = (order.DespatchDate || order.OrderDate || '').slice(0, 10);
    for (const item of (order.OrderItems || [])) {
      const sku = item.SKU || item.Sku || '';
      const qty = item.Quantity || 0;
      if (!sku || !qty || !date) continue;
      if (!daily[sku]) daily[sku] = {};
      daily[sku][date] = (daily[sku][date] || 0) + qty;
    }
  }
  return daily;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

// Start an SSE response and return a send() helper
function startSSE(res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Parse common report query params from a URL. Client scope comes from
// resolveScope: a client session can never read another client's data.
function parseReportParams(url, session) {
  const scope = resolveScope(session, url);
  if (!scope.ok) throw new Error(scope.error);
  return {
    warehouseId: url.searchParams.get('warehouseId'),
    clientId:    scope.clientId ? String(scope.clientId) : null,
    // Multi-client: comma-separated Mintsoft client IDs; takes priority over single clientId
    clientIds:   scope.clientIds.map(String),
    // Status filter: comma-separated status strings
    statuses:    (url.searchParams.get('statuses')  || '').split(',').filter(Boolean),
    dateFrom:    url.searchParams.get('dateFrom'),
    dateTo:      url.searchParams.get('dateTo'),
    days:        parseInt(url.searchParams.get('days') || '30'),
  };
}

// Fetch product name map { sku → name } from the product catalogue.
// clientId=null fetches across all clients (warehouse context).
async function fetchProductNames(apiKey, warehouseId, clientId) {
  const names = {};
  let pageNo = 1;
  const clientParam = clientId ? `&ClientId=${encodeURIComponent(clientId)}` : '';

  while (true) {
    const path = `/api/Product/List?WarehouseId=${encodeURIComponent(warehouseId)}&PageNo=${pageNo}&Limit=${PAGE_LIMIT}${clientParam}`;
    const result = await mintsoftGet(path, apiKey);
    if (result.status !== 200) break;

    const batch = Array.isArray(result.body) ? result.body : [];
    if (!batch.length) break;

    for (const p of batch) {
      const sku  = p.SKU || p.Sku || '';
      const name = p.Name || p.Description || '';
      if (sku && name) names[sku] = name;
    }

    if (batch.length < PAGE_LIMIT) break;
    pageNo++;
    if (pageNo > 200) break;
  }

  return names;
}

// Fetch unconfirmed invoice summary for a single client (current period accruals)
async function fetchUnconfirmedInvoiceSummary(apiKey, clientId, fromDate, toDate) {
  const path = `/api/Account/Invoice/GetUnconfirmedInvoiceSummary?clientID=${encodeURIComponent(clientId)}&fromDate=${fromDate}&toDate=${toDate}`;
  try {
    const result = await mintsoftGet(path, apiKey);
    console.log(`  [accruals] client=${clientId} status=${result.status} body=${JSON.stringify(result.body || null).substring(0, 500)}`);
    return result.status === 200 ? result.body : null;
  } catch (e) {
    console.log(`  [accruals] client=${clientId} error: ${e.message}`);
    return null;
  }
}

// Fetch the list of confirmed invoices for a client
async function fetchInvoiceList(apiKey, clientId) {
  const path = `/api/Accounting/Invoice/List?clientID=${encodeURIComponent(clientId)}`;
  try {
    const result = await mintsoftGet(path, apiKey);
    console.log(`  fetchInvoiceList: status=${result.status} body=${JSON.stringify(result.body).substring(0, 400)}`);
    if (result.status !== 200) return [];
    return Array.isArray(result.body) ? result.body
      : (result.body?.Data || result.body?.Items || result.body?.Invoices || []);
  } catch (e) {
    console.log(`  fetchInvoiceList error: ${e.message}`);
    return [];
  }
}

// Fetch ASN (Advanced Shipping Notice) records from Mintsoft /api/ASN/List.
async function fetchGoodsIn(apiKey, warehouseId, clientId, fromDate, toDate) {
  const records     = [];
  let   pageNo      = 1;
  const clientParam = clientId ? `&ClientId=${encodeURIComponent(clientId)}` : '';
  const fromParam   = fromDate ? `&SinceDate=${encodeURIComponent(fromDate + 'T00:00:00')}` : '';
  const toParam     = toDate   ? `&ToDate=${encodeURIComponent(toDate   + 'T23:59:59')}`   : '';

  while (true) {
    const path   = `/api/ASN/List?WarehouseId=${encodeURIComponent(warehouseId)}&Limit=${PAGE_LIMIT}&PageNo=${pageNo}${clientParam}${fromParam}${toParam}`;
    const result = await mintsoftGet(path, apiKey);

    if (result.status !== 200) {
      console.log(`[asn] /api/ASN/List status ${result.status} on page ${pageNo}`);
      break;
    }

    const batch = Array.isArray(result.body)
      ? result.body
      : (result.body?.Data || result.body?.Items || result.body?.ASNs || []);

    if (pageNo === 1) {
      console.log(`[asn] page 1: ${batch.length} records`);
    }

    records.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    pageNo++;
    if (pageNo > 100) break;
  }

  return records;
}

// Fetch a single confirmed invoice by ID
async function fetchInvoiceById(apiKey, invoiceId) {
  const path = `/api/Accounting/Invoice/${invoiceId}`;
  try {
    const result = await mintsoftGet(path, apiKey);
    console.log(`  fetchInvoiceById ${invoiceId}: status=${result.status} keys=${Object.keys(result.body || {}).join(', ')}`);
    console.log(`  fetchInvoiceById body: ${JSON.stringify(result.body).substring(0, 600)}`);
    return result.status === 200 ? result.body : null;
  } catch (e) {
    console.log(`  fetchInvoiceById error: ${e.message}`);
    return null;
  }
}

// Map a confirmed invoice detail object to our standard breakdown shape.
// Logs all keys on first call so we can adjust field names if needed.
function mapInvoiceToBreakdown(inv) {
  if (!inv) return null;

  // Try flat totals first, then fall back to summing line items
  const pick = (obj, ...keys) => {
    for (const k of keys) { if (obj[k] != null) return Number(obj[k]); }
    return 0;
  };

  const picking  = pick(inv, 'PickingCost', 'PickingTotal', 'Picking');
  const postage  = pick(inv, 'PostageCost', 'PostageTotal', 'Postage') +
                   pick(inv, 'VatFreePostageCost', 'VatFreePostage');
  const storage  = pick(inv, 'StorageCost', 'StorageTotal', 'Storage');
  const goodsIn  = pick(inv, 'GoodsInCost', 'GoodsInTotal', 'GoodsIn');
  const returns  = pick(inv, 'ReturnsCost', 'ReturnsTotal', 'Returns');
  const other    = pick(inv, 'ReworkCost', 'Rework') +
                   pick(inv, 'PackagingCost', 'Packaging') +
                   pick(inv, 'GenericInvoiceItemsCost', 'GenericItems') +
                   pick(inv, 'CollectionsCost', 'Collections') +
                   pick(inv, 'AdminFee', 'Admin') +
                   pick(inv, 'OtherCost', 'OtherTotal', 'Other');

  const serviceFees = picking + storage + goodsIn + returns + other;
  const total       = serviceFees + postage;

  if (total === 0) {
    console.log(`  mapInvoiceToBreakdown: all zeros — invoice keys: ${Object.keys(inv).join(', ')}`);
    console.log(`  mapInvoiceToBreakdown: full body: ${JSON.stringify(inv).substring(0, 800)}`);
  }

  return { picking, postage, storage, goodsIn, returns, other, serviceFees, total };
}

// Fetch invoice summary for a period.
// Current month (fromDate's month) → unconfirmed accruals (no confirmed invoice exists yet).
// Past month → confirmed invoice list matched by fromDate's year-month.
// Using fromDate (not toDate) for the current-month check so custom ranges work correctly:
// e.g. "Apr 1–Apr 30" stays in past-month path even if toDate happens to be near current month.
async function fetchInvoiceSummary(apiKey, clientId, fromDate, toDate) {
  const today     = new Date();
  const todayYYMM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const fromYYMM  = fromDate.substring(0, 7);

  if (fromYYMM >= todayYYMM) {
    return fetchUnconfirmedInvoiceSummary(apiKey, clientId, fromDate, toDate);
  }

  // Past month — find the confirmed invoice whose Date falls in the same year-month as fromDate.
  // Mintsoft's invoice Date field is the end-of-month timestamp (e.g. 2026-04-30T23:59:00).
  const invoices = await fetchInvoiceList(apiKey, clientId);
  if (!invoices.length) return null;

  const match = invoices.find(inv => {
    const d = new Date(inv.Date || inv.InvoiceDate || 0);
    const yymm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return yymm === fromYYMM;
  });

  if (!match) {
    console.log(`  fetchInvoiceSummary: no confirmed invoice for ${fromYYMM}. Available: ${invoices.map(i => { const d = new Date(i.Date||0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }).join(', ')}`);
    return null;
  }

  return match;
}

// Fetch order headers only (no per-order item detail) — faster, used for dashboard counts
async function fetchOrderHeaders(apiKey, warehouseId, clientId, fromDate, toDate, onProgress) {
  const allOrders = [];
  let pageNo = 1;
  const clientParam = clientId ? `&ClientId=${encodeURIComponent(clientId)}` : '';
  const to = toDate || new Date().toISOString().split('T')[0];

  while (true) {
    const path = `/api/Order/List?WarehouseId=${encodeURIComponent(warehouseId)}&SinceOrderDate=${fromDate}T00:00:00&ToDate=${to}T23:59:59&Limit=${PAGE_LIMIT}&PageNo=${pageNo}${clientParam}`;
    const result = await mintsoftGet(path, apiKey);
    if (result.status !== 200) throw new Error(`Orders API error: ${result.status} on page ${pageNo}`);

    const batch = Array.isArray(result.body) ? result.body : [];
    allOrders.push(...batch);
    if (onProgress) onProgress({ page: pageNo, total: allOrders.length });
    if (batch.length < PAGE_LIMIT) break;
    pageNo++;
    if (pageNo > 200) break;
  }

  return allOrders;
}

module.exports = {
  fmt, daysAgo,
  fetchStock, fetchOrders, fetchOrderHeaders, fetchGoodsIn,
  fetchProductNames, fetchUnconfirmedInvoiceSummary, fetchInvoiceList, fetchInvoiceById, fetchInvoiceSummary,
  buildSkuSales, buildSkuDailySales,
  startSSE, parseReportParams
};
