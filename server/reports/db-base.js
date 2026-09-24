// ─── server/reports/db-base.js ────────────────────────────────────────────────
// DB-backed data fetchers for reports. Single-tenant: Mintsoft IDs are PKs.
// All functions return Mintsoft-shaped objects so report computations run unchanged.

const { query, queryOne } = require('../db');

// ── ID resolution ─────────────────────────────────────────────────────────────

// Resolve URL params to integer IDs. No DB lookup needed — Mintsoft IDs are PKs.
// Client sessions are always pinned to their own clientId (see server/scope.js);
// a client session without one throws rather than widening to every client.
function resolveIds(session, msWarehouseId, msClientId) {
  const warehouseId = msWarehouseId ? parseInt(msWarehouseId) : null;
  if (!session.isWarehouse) {
    const own = session.clientId ? parseInt(session.clientId) : null;
    if (!own) throw new Error('Your login is not linked to a client account. Please contact the warehouse.');
    if (msClientId && parseInt(msClientId) !== own) throw new Error('Not permitted for this client');
    return { warehouseId, clientId: own };
  }
  const clientId = msClientId ? parseInt(msClientId) : null;
  return { warehouseId, clientId };
}

// Convert Mintsoft client ID strings to integers.
function resolveClientDbIds(msClientIds) {
  if (!msClientIds?.length) return [];
  return msClientIds.map(Number).filter(Boolean);
}

// ── Stock ─────────────────────────────────────────────────────────────────────

async function getStock(warehouseId, clientId) {
  const conditions = [];
  const p = [];
  if (warehouseId) conditions.push(`sl.warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)    conditions.push(`sl.client_id = $${p.push(clientId)}`);

  const sql = `
    SELECT sl.sku       AS "SKU",
           sl.qty_on_hand AS "Level",
           p.name       AS "ProductName",
           sl.client_id AS "ClientId"
    FROM product_stock_levels sl
    LEFT JOIN products p ON sl.product_id = p.id
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}`;
  return query(sql, p);
}

// ── Orders ────────────────────────────────────────────────────────────────────

async function getOrders(warehouseId, clientId, fromDate, toDate, opts = {}) {
  const { clientIds, statuses } = opts;
  const conditions = [];
  const p = [];
  if (warehouseId)       conditions.push(`o.warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)          conditions.push(`o.client_id = $${p.push(clientId)}`);
  if (clientIds?.length) conditions.push(`o.client_id = ANY($${p.push(clientIds)})`);
  if (fromDate)          conditions.push(`o.order_date::date >= $${p.push(fromDate)}`);
  if (toDate)            conditions.push(`o.order_date::date <= $${p.push(toDate)}`);
  if (statuses?.length)  conditions.push(`o.status_name = ANY($${p.push(statuses)})`);

  const sql = `
    SELECT o.id              AS "OrderId",
           o.order_date::text    AS "OrderDate",
           o.despatch_date::text AS "DespatchDate",
           o.status_name        AS "Status",
           o.client_id          AS "ClientId",
           COALESCE(
             json_agg(json_build_object('SKU', oi.sku, 'Quantity', oi.quantity))
               FILTER (WHERE oi.id IS NOT NULL),
             '[]'
           ) AS "OrderItems"
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    GROUP BY o.id
    ORDER BY o.order_date DESC NULLS LAST`;
  return query(sql, p);
}

async function getOrderHeaders(warehouseId, clientId, fromDate, toDate, opts = {}) {
  const { clientIds, statuses } = opts;
  const conditions = [];
  const p = [];
  if (warehouseId)       conditions.push(`o.warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)          conditions.push(`o.client_id = $${p.push(clientId)}`);
  if (clientIds?.length) conditions.push(`o.client_id = ANY($${p.push(clientIds)})`);
  if (fromDate)          conditions.push(`o.order_date::date >= $${p.push(fromDate)}`);
  if (toDate)            conditions.push(`o.order_date::date <= $${p.push(toDate)}`);
  if (statuses?.length)  conditions.push(`o.status_name = ANY($${p.push(statuses)})`);

  const sql = `
    SELECT o.id              AS "OrderId",
           o.order_date::text    AS "OrderDate",
           o.despatch_date::text AS "DespatchDate",
           o.status_name        AS "Status",
           o.client_id          AS "ClientId"
    FROM orders o
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY o.order_date DESC NULLS LAST`;
  return query(sql, p);
}

// ── SKU names ─────────────────────────────────────────────────────────────────

async function getSkuNames(warehouseId, clientId) {
  const conditions = ['p.name IS NOT NULL'];
  const p = [];
  if (warehouseId) conditions.push(`sl.warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)    conditions.push(`sl.client_id = $${p.push(clientId)}`);

  const sql = `
    SELECT DISTINCT ON (sl.sku) sl.sku, p.name AS product_name
    FROM product_stock_levels sl
    LEFT JOIN products p ON sl.product_id = p.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY sl.sku`;
  const rows = await query(sql, p);
  const map = {};
  for (const r of rows) if (r.product_name) map[r.sku] = r.product_name;
  return map;
}

// ── Invoices / accruals ───────────────────────────────────────────────────────

function toInvShape(r) {
  return {
    ClientId:                r.ClientId,
    PickingCost:             parseFloat(r.picking_cost           || 0),
    PostageCost:             parseFloat(r.postage_cost           || 0),
    VatFreePostageCost:      parseFloat(r.vat_free_postage_cost  || 0),
    StorageCost:             parseFloat(r.storage_cost           || 0),
    GoodsInCost:             parseFloat(r.goods_in_cost          || 0),
    ReturnsCost:             parseFloat(r.returns_cost           || 0),
    ReworkCost:              parseFloat(r.rework_cost            || 0),
    PackagingCost:           parseFloat(r.packaging_cost         || 0),
    GenericInvoiceItemsCost: parseFloat(r.generic_items_cost     || 0),
    CollectionsCost:         parseFloat(r.collections_cost       || 0),
    AdminFee:                parseFloat(r.admin_fee              || 0),
  };
}

function periodMonthStr(dateStr) {
  return dateStr.substring(0, 7) + '-01';
}

function isCurrentOrFutureMonth(dateStr) {
  const today   = new Date();
  const todayPM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  return periodMonthStr(dateStr) >= todayPM;
}

async function getInvoiceForClient(clientId, fromDate) {
  const pm = periodMonthStr(fromDate);

  if (isCurrentOrFutureMonth(fromDate)) {
    const row = await queryOne(
      `SELECT ia.*, ia.client_id AS "ClientId"
       FROM invoice_accruals ia WHERE ia.client_id = $1 AND ia.period_month = $2`,
      [clientId, pm]
    );
    return row ? toInvShape(row) : null;
  }

  const row = await queryOne(
    `SELECT
       i.client_id AS "ClientId",
       SUM(picking_cost)          AS picking_cost,
       SUM(postage_cost)          AS postage_cost,
       SUM(vat_free_postage_cost) AS vat_free_postage_cost,
       SUM(storage_cost)          AS storage_cost,
       SUM(goods_in_cost)         AS goods_in_cost,
       SUM(returns_cost)          AS returns_cost,
       SUM(rework_cost)           AS rework_cost,
       SUM(packaging_cost)        AS packaging_cost,
       SUM(generic_items_cost)    AS generic_items_cost,
       SUM(collections_cost)      AS collections_cost,
       SUM(admin_fee)             AS admin_fee
     FROM invoices i
     WHERE i.client_id = $1
       AND DATE_TRUNC('month', i.invoice_date)::DATE = $2::DATE
     GROUP BY i.client_id`,
    [clientId, pm]
  );
  return row ? toInvShape(row) : null;
}

async function getInvoicesForMonth(fromDate) {
  const pm = periodMonthStr(fromDate);

  if (isCurrentOrFutureMonth(fromDate)) {
    const rows = await query(
      `SELECT ia.*, ia.client_id AS "ClientId" FROM invoice_accruals ia WHERE ia.period_month = $1`,
      [pm]
    );
    return rows.map(toInvShape);
  }

  const rows = await query(
    `SELECT
       i.client_id AS "ClientId",
       SUM(i.picking_cost)          AS picking_cost,
       SUM(i.postage_cost)          AS postage_cost,
       SUM(i.vat_free_postage_cost) AS vat_free_postage_cost,
       SUM(i.storage_cost)          AS storage_cost,
       SUM(i.goods_in_cost)         AS goods_in_cost,
       SUM(i.returns_cost)          AS returns_cost,
       SUM(i.rework_cost)           AS rework_cost,
       SUM(i.packaging_cost)        AS packaging_cost,
       SUM(i.generic_items_cost)    AS generic_items_cost,
       SUM(i.collections_cost)      AS collections_cost,
       SUM(i.admin_fee)             AS admin_fee
     FROM invoices i
     WHERE DATE_TRUNC('month', i.invoice_date)::DATE = $1::DATE
     GROUP BY i.client_id`,
    [pm]
  );
  return rows.map(toInvShape);
}

async function getAllClientInvoices(clientId) {
  const confirmed = await query(
    `SELECT
       DATE_TRUNC('month', i.invoice_date) AS "Date",
       i.client_id AS "ClientId",
       SUM(i.picking_cost)          AS picking_cost,
       SUM(i.postage_cost)          AS postage_cost,
       SUM(i.vat_free_postage_cost) AS vat_free_postage_cost,
       SUM(i.storage_cost)          AS storage_cost,
       SUM(i.goods_in_cost)         AS goods_in_cost,
       SUM(i.returns_cost)          AS returns_cost,
       SUM(i.rework_cost)           AS rework_cost,
       SUM(i.packaging_cost)        AS packaging_cost,
       SUM(i.generic_items_cost)    AS generic_items_cost,
       SUM(i.collections_cost)      AS collections_cost,
       SUM(i.admin_fee)             AS admin_fee
     FROM invoices i
     WHERE i.client_id = $1
     GROUP BY DATE_TRUNC('month', i.invoice_date), i.client_id
     ORDER BY DATE_TRUNC('month', i.invoice_date) DESC`,
    [clientId]
  );
  const accrual = await queryOne(
    `SELECT ia.*, ia.client_id AS "ClientId" FROM invoice_accruals ia WHERE ia.client_id = $1`,
    [clientId]
  );
  return {
    confirmed: confirmed.map(r => ({ ...toInvShape(r), Date: r.Date })),
    accrual:   accrual ? { ...toInvShape(accrual), period_month: accrual.period_month } : null,
  };
}

async function getCurrentAccrualsMap() {
  const today = new Date();
  const pm    = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;

  const rows = await query(
    `SELECT ia.*, ia.client_id AS "ClientId" FROM invoice_accruals ia WHERE ia.period_month = $1`,
    [pm]
  );
  if (rows.length > 0) {
    const map = {};
    for (const r of rows) map[String(r.ClientId)] = toInvShape(r);
    return { map, source: 'accrual' };
  }

  // Fallback: most recent confirmed invoice per client
  const fallback = await query(
    `SELECT DISTINCT ON (i.client_id)
       i.client_id AS "ClientId",
       i.picking_cost, i.postage_cost, i.vat_free_postage_cost,
       i.storage_cost, i.goods_in_cost, i.returns_cost,
       i.rework_cost, i.packaging_cost, i.generic_items_cost,
       i.collections_cost, i.admin_fee
     FROM invoices i
     ORDER BY i.client_id, i.invoice_date DESC`
  );
  const map = {};
  for (const r of fallback) map[String(r.ClientId)] = toInvShape(r);
  return { map, source: 'confirmed' };
}

module.exports = {
  resolveIds,
  resolveClientDbIds,
  getStock,
  getOrders,
  getOrderHeaders,
  getSkuNames,
  getInvoiceForClient,
  getInvoicesForMonth,
  getAllClientInvoices,
  getCurrentAccrualsMap,
};
