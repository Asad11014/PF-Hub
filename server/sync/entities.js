// ─── server/sync/entities.js ──────────────────────────────────────────────────
// One function per Mintsoft entity. Each maps the API payload to rows that
// mirror Mintsoft exactly (every column rewritten on every sync), satisfies
// foreign keys first (unknown clients / products are fetched by id), writes a
// page at a time inside a transaction, and returns { fetched, upserted, deleted, note }.

const { query } = require('../db');
const { tx, bulkUpsert, bulkInsert } = require('./store');
const { parseMintsoftDate: ts, toMintsoftParam, londonParts } = require('./time');

// Writes outside a page transaction go straight to the connection pool.
const direct = { query: (...a) => query(...a) };

// ── Value helpers ─────────────────────────────────────────────────────────────

const str  = v => (v == null || v === '' ? null : String(v));
const num  = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int  = v => (num(v) == null ? null : Math.trunc(Number(v)));
const bool = v => v === true || v === 1 || v === 'Y' || v === 'y' || v === 'true';
const idOf = v => { const n = int(v); return n && n > 0 ? n : null; }; // Mintsoft uses 0 for "none"

// Readable status names used by every report and the existing data. Mintsoft's
// own lookup returns codes ("DESPATCHED", "INVOICEFAILED"), so it is only the
// fallback for ids not listed here.
const ORDER_STATUS = {
  1:'New', 2:'Printed', 3:'Cancelled', 4:'Despatched', 5:'Invoiced', 6:'Invoice Failed', 7:'Holding', 8:'Failed',
  9:'On Back Order', 10:'Awaiting Confirmation', 11:'Awaiting Documentation', 12:'Awaiting Payment', 13:'Query Raised',
  14:'Pack and Hold', 15:'Awaiting Picking', 16:'Picking Started', 17:'Picked', 18:'Fraud Risk', 19:'Picking Skipped',
  20:'Packed', 21:'Awaiting Replen', 22:'Processing', 23:'Rebinned',
};
const ASN_STATUS = {
  1:'New', 2:'Awaiting Approval', 3:'Awaiting Delivery', 4:'Booked In', 5:'Discrepancy', 6:'Complete',
  7:'Partially Booked', 8:'Booked In - Partial', 9:'Delivered', 10:'Shipped', 11:'Awaiting Delivery (Late)',
  12:'Awaiting Put Away', 13:'Robot Put Away',
};
const statusName = (lookup, readable, id) => (id == null ? null : readable[id] || lookup[id] || `Status ${id}`);

// ── Column lists and mappers ──────────────────────────────────────────────────

const CLIENT_COLS = ['id', 'name', 'short_name', 'active', 'updated_at'];
const mapClient = (c, active) => [c.ID, str(c.Name) || str(c.ShortName) || `Client #${c.ID}`, str(c.ShortName), active, ts(c.LastUpdated)];

const PRODUCT_COLS = [
  'id', 'client_id', 'sku', 'name', 'description', 'customs_description', 'ean', 'upc', 'weight', 'height', 'width', 'depth',
  'price', 'cost_price', 'vat_exempt', 'back_order', 'bundle', 'discontinued', 'low_stock_alert_level', 'handling_time',
  'units_per_parcel', 'additional_parcels_required', 'has_batch_number', 'has_serial_number', 'has_expiry_date',
  'best_before_warning_days', 'image_url', 'country_of_manufacture_id', 'commodity_code', 'packing_instructions',
  'subscription', 'category', 'supplier', 'updated_at',
];
function mapProduct(p) {
  const category = (p.ProductInCategories || []).map(c => c.ProductCategory?.Name).filter(Boolean).join(', ') || null;
  const supplier = (p.ProductSuppliers || []).map(s => s.ProductSupplier?.Name).filter(Boolean).join(', ') || null;
  return [
    p.ID, idOf(p.ClientId), str(p.SKU) || '', str(p.Name), str(p.Description), str(p.CustomsDescription),
    str(p.EAN), str(p.UPC), num(p.Weight), num(p.Height), num(p.Width), num(p.Depth),
    num(p.Price), num(p.CostPrice), bool(p.VatExempt), bool(p.BackOrder), bool(p.Bundle), bool(p.DisCont),
    int(p.LowStockAlertLevel), int(p.HandlingTime), int(p.UnitsPerParcel), int(p.AdditionalParcelsRequired),
    bool(p.HasBatchNumber), bool(p.HasSerialNumber), bool(p.HasExpiryDate), int(p.BestBeforeDateWarningPeriodDays),
    str(p.ImageURL), idOf(p.CountryOfManufactureId), str(p.CommodityCode?.Code), str(p.PackingInstructions),
    bool(p.Subscription), category, supplier, ts(p.LastUpdated),
  ];
}

// qty_on_hand keeps its existing meaning (Mintsoft "Level": free stock, used by
// every report); qty_total is Mintsoft "TotalStockLevel" (physical, incl. allocated).
const STOCK_COLS = ['product_id', 'warehouse_id', 'client_id', 'sku', 'qty_on_hand', 'qty_allocated', 'qty_available', 'qty_pre_order', 'qty_total'];
function mapStock(s, whId) {
  const level = int(s.Level) ?? 0;
  const total = int(s.TotalStockLevel) ?? level;
  return [s.ProductId, idOf(s.WarehouseId) || whId, idOf(s.ClientId), str(s.SKU) || '', level, Math.max(0, total - level), level, 0, total];
}

const ORDER_COLS = [
  'id', 'warehouse_id', 'client_id', 'order_number', 'external_reference', 'status_id', 'status_name', 'channel_id', 'channel_name',
  'order_date', 'despatch_date', 'required_despatch_date', 'required_delivery_date', 'sla_warning_date', 'sla_despatch_date',
  'recipient_title', 'recipient_first_name', 'recipient_last_name', 'recipient_company',
  'address1', 'address2', 'address3', 'town', 'county', 'postcode', 'country_id', 'phone', 'mobile', 'email',
  'courier_service_id', 'courier_service_name', 'courier_service_type_id', 'tracking_number', 'tracking_url',
  'number_of_parcels', 'total_weight', 'order_value', 'shipping_net', 'shipping_tax', 'shipping_gross',
  'discount_net', 'discount_tax', 'discount_gross', 'total_order_net', 'total_order_tax', 'total_order_gross', 'total_vat',
  'currency_id', 'comments', 'delivery_notes', 'gift_messages', 'vat_number', 'source', 'order_lock', 'pii_removed',
  'despatched_by_user', 'part', 'number_of_parts', 'updated_at',
];
function mapOrder(o, ctx) {
  const statusId = int(o.OrderStatusId);
  return [
    o.ID, idOf(o.WarehouseId), idOf(o.ClientId), str(o.OrderNumber) || str(o.ExternalOrderReference), str(o.ExternalOrderReference),
    statusId, statusName(ctx.orderStatus, ORDER_STATUS, statusId), idOf(o.ChannelId), str(o.Channel?.Name) || str(o.Source),
    ts(o.OrderDate), ts(o.DespatchDate), ts(o.RequiredDespatchDate), ts(o.RequiredDeliveryDate), ts(o.SLAWarningDate), ts(o.SLADespatchDate),
    str(o.Title), str(o.FirstName), str(o.LastName), str(o.CompanyName),
    str(o.Address1), str(o.Address2), str(o.Address3), str(o.Town), str(o.County), str(o.PostCode), idOf(o.CountryId),
    str(o.Phone), str(o.Mobile), str(o.Email),
    idOf(o.CourierServiceId), str(o.CourierServiceName), idOf(o.CourierServiceTypeId), str(o.TrackingNumber), str(o.TrackingURL),
    int(o.NumberOfParcels), num(o.TotalWeight), num(o.OrderValue), num(o.ShippingNet), num(o.ShippingTax), num(o.ShippingGross),
    num(o.DiscountNet), num(o.DiscountTax), num(o.DiscountGross), num(o.TotalOrderNet), num(o.TotalOrderTax), num(o.TotalOrderGross), num(o.TotalVat),
    idOf(o.CurrencyId), str(o.Comments), str(o.DeliveryNotes), str(o.GiftMessages), str(o.VATNumber), str(o.Source),
    bool(o.OrderLock), bool(o.PIIRemoved), str(o.DespatchedByUser), int(o.Part), int(o.NumberOfParts), ts(o.LastUpdated),
  ];
}

const ITEM_COLS = ['id', 'order_id', 'product_id', 'sku', 'quantity', 'allocated', 'committed', 'on_back_order', 'price', 'price_net', 'vat', 'discount', 'updated_at'];
const mapOrderItem = (it, orderId, ctx) => [
  it.ID, orderId, ctx.knownProducts.has(it.ProductId) ? it.ProductId : null, str(it.SKU) || '',
  int(it.Quantity) ?? 0, int(it.Allocated) ?? 0, int(it.Commited) ?? 0, int(it.OnBackOrder) ?? 0,
  num(it.Price), num(it.PriceNet), num(it.Vat), num(it.Discount), ts(it.LastUpdated),
];

const ASN_COLS = [
  'id', 'warehouse_id', 'client_id', 'po_reference', 'supplier_name', 'product_supplier_id', 'goods_in_type', 'quantity',
  'status_id', 'status_name', 'estimated_delivery', 'warehouse_booked_date', 'booked_in_date', 'comments', 'shipped',
  'hours_logged', 'updated_at',
];
function mapAsn(a, ctx) {
  const statusId = int(a.ASNStatusId ?? a.ASNStatus?.ID);
  return [
    a.ID, idOf(a.WarehouseId), idOf(a.ClientId), str(a.POReference), str(a.ProductSupplier) || str(a.Supplier),
    idOf(a.ProductSupplierId), str(a.GoodsInType), int(a.Quantity), statusId, statusName(ctx.asnStatus, ASN_STATUS, statusId),
    ts(a.EstimatedDelivery), ts(a.WarehouseBookedDate), ts(a.BookedInDate), str(a.Comments), bool(a.Shipped),
    num(a.HoursLogged) ?? 0, ts(a.LastUpdated),
  ];
}

const ASN_ITEM_COLS = ['asn_id', 'product_id', 'sku', 'expected_qty', 'received_qty', 'updated_at'];
const mapAsnItem = (it, asnId, ctx) => [
  asnId, ctx.knownProducts.has(it.ProductId) ? it.ProductId : null, str(it.SKU), int(it.QuantityExpected) ?? 0,
  // Units booked in (Mintsoft misspells the received field as "Receieved").
  int(it.QuantityBooked ?? it.QuantityReceieved ?? it.QuantityReceived) ?? 0, ts(it.LastUpdated),
];

const COST_COLS = [
  'picking_cost', 'postage_cost', 'vat_free_postage_cost', 'storage_cost', 'goods_in_cost', 'returns_cost',
  'rework_cost', 'packaging_cost', 'generic_items_cost', 'collections_cost', 'admin_fee',
];
const costs = x => [
  num(x.PickingCost) ?? 0, num(x.PostageCost) ?? 0, num(x.VatFreePostageCost) ?? 0, num(x.StorageCost) ?? 0,
  num(x.GoodsInCost) ?? 0, num(x.ReturnsCost) ?? 0, num(x.ReworkCost) ?? 0, num(x.PackagingCost) ?? 0,
  num(x.GenericInvoiceItemsCost) ?? 0, num(x.CollectionsCost) ?? 0, num(x.AdminFee) ?? 0,
];

const INVOICE_COLS = ['id', 'client_id', 'name', 'invoice_date', 'comments', 'number_of_parcels', 'number_of_items', ...COST_COLS, 'updated_at'];
const mapInvoice = i => [
  i.ID, idOf(i.ClientId), str(i.Name), ts(i.Date), str(i.Comments), int(i.NumberOfParcels) ?? 0, int(i.NumberOfItems) ?? 0,
  ...costs(i), ts(i.LastUpdated),
];

const ACCRUAL_COLS = ['client_id', 'period_month', ...COST_COLS, 'number_of_parcels', 'number_of_items'];

// ── Foreign-key helpers ───────────────────────────────────────────────────────

// Make sure every referenced client exists. Clients missing from /api/Client
// (inactive / on stop) are fetched by id; if even that fails a placeholder row
// is written so no synced record ever has a NULL or dangling client.
async function ensureClients(ctx, ids) {
  const missing = [...new Set(ids.map(idOf).filter(Boolean))].filter(id => !ctx.knownClients.has(id));
  if (!missing.length) return 0;
  const rows = [];
  for (const id of missing) {
    let c = null;
    try { c = await ctx.get(`/api/Client/${id}`); } catch { /* placeholder below */ }
    rows.push(c && c.ID ? mapClient(c, false) : [id, `Client #${id}`, null, false, null]);
  }
  await bulkUpsert(direct, 'clients', CLIENT_COLS, rows, { nowCol: 'synced_at' });
  missing.forEach(id => ctx.knownClients.add(id));
  return missing.length;
}

// Make sure every referenced product exists (fetch new ones by id). Products
// Mintsoft cannot return stay unknown and the referencing row stores NULL.
async function ensureProducts(ctx, ids) {
  const missing = [...new Set(ids.map(idOf).filter(Boolean))].filter(id => !ctx.knownProducts.has(id));
  if (!missing.length) return 0;
  const found = [];
  for (const id of missing) {
    try { const p = await ctx.get(`/api/Product/${id}`); if (p && p.ID) found.push(p); } catch { /* stays unknown */ }
  }
  if (found.length) {
    await ensureClients(ctx, found.map(p => p.ClientId));
    await bulkUpsert(direct, 'products', PRODUCT_COLS, found.map(mapProduct), { nowCol: 'synced_at' });
    found.forEach(p => ctx.knownProducts.add(p.ID));
  }
  return found.length;
}

// Delete rows that no longer exist in Mintsoft, after a complete crawl. A large
// gap usually means the crawl or the API misbehaved, so above the safety limit
// nothing is deleted and the step reports it instead.
async function sweep(table, seen, label) {
  const rows = await query(`SELECT id FROM ${table}`);
  const missing = rows.map(r => r.id).filter(id => !seen.has(id));
  if (!missing.length) return { deleted: 0 };
  const limit = Math.max(50, Math.ceil(seen.size * 0.02));
  if (missing.length > limit) {
    return { deleted: 0, note: `${missing.length} ${label} absent from Mintsoft exceeds safety limit ${limit}; not deleted (ids e.g. ${missing.slice(0, 5).join(',')})` };
  }
  await query(`DELETE FROM ${table} WHERE id = ANY($1::int[])`, [missing]);
  return { deleted: missing.length, note: `deleted ${label} no longer in Mintsoft: ${missing.slice(0, 10).join(',')}${missing.length > 10 ? '…' : ''}` };
}

// ── Reference data ────────────────────────────────────────────────────────────

async function syncReference(ctx) {
  const [statuses, asnStatuses, channels, couriers, warehouses] = await Promise.all([
    ctx.get('/api/Order/Statuses'), ctx.get('/api/ASN/Statuses'), ctx.get('/api/Order/Channels'),
    ctx.get('/api/Courier/Services'), ctx.get('/api/Warehouse'),
  ]);
  let n = 0;
  n += await bulkUpsert(direct, 'order_status_types', ['id', 'name'], statuses.map(s => [s.ID, str(s.Name) || `Status ${s.ID}`]), { nowCol: 'synced_at' });
  n += await bulkUpsert(direct, 'asn_status_types', ['id', 'name', 'colour'], asnStatuses.map(s => [s.ID, str(s.Name) || `Status ${s.ID}`, str(s.Colour)]), { nowCol: 'synced_at' });
  n += await bulkUpsert(direct, 'order_channels', ['id', 'name', 'description', 'logo', 'client_id', 'active'],
    channels.map(c => [c.ID, str(c.Name) || `Channel ${c.ID}`, str(c.Description), str(c.Logo), idOf(c.ClientId), c.Active !== false]), { nowCol: 'synced_at' });
  n += await bulkUpsert(direct, 'couriers', ['id', 'name', 'active'], couriers.map(c => [c.ID, str(c.Name) || `Courier ${c.ID}`, c.Active !== false]), { nowCol: 'synced_at' });
  n += await bulkUpsert(direct, 'warehouses', ['id', 'name', 'code'],
    warehouses.filter(w => w.ID).map(w => [w.ID, str(w.Name) || str(w.Details) || String(w.ID), str(w.Code)]), { nowCol: 'synced_at' });

  statuses.forEach(s => { ctx.orderStatus[s.ID] = s.Name; });
  asnStatuses.forEach(s => { ctx.asnStatus[s.ID] = s.Name; });
  ctx.warehouseIds = warehouses.filter(w => w.ID).map(w => w.ID).sort((a, b) => a - b);
  const all = statuses.length + asnStatuses.length + channels.length + couriers.length + warehouses.length;
  return { fetched: all, upserted: n };
}

// ── Clients ───────────────────────────────────────────────────────────────────

async function syncClients(ctx) {
  const list = [];
  await ctx.pages('/api/Client', async batch => { list.push(...batch.filter(c => c.ID)); });
  const ids = list.map(c => c.ID);
  const upserted = await bulkUpsert(direct, 'clients', CLIENT_COLS, list.map(c => mapClient(c, bool(c.Active ?? 'Y') && !c.OnStop)), { nowCol: 'synced_at' });
  list.forEach(c => ctx.knownClients.add(c.ID));
  // Clients that dropped off the list are kept (their history stays) but inactive.
  const off = await query(`UPDATE clients SET active = FALSE WHERE active AND NOT (id = ANY($1::int[])) RETURNING id`, [ids]);
  return { fetched: list.length, upserted, note: off.length ? `marked inactive: ${off.map(r => r.id).join(',')}` : undefined };
}

// ── Products ──────────────────────────────────────────────────────────────────

async function syncProducts(ctx, { since = null } = {}) {
  const path = since ? `/api/Product/List?SinceLastUpdated=${toMintsoftParam(since)}` : '/api/Product/List';
  const seen = new Set();
  let upserted = 0;
  const fetched = await ctx.pages(path, async batch => {
    const rows = batch.filter(p => p.ID);
    await ensureClients(ctx, rows.map(p => p.ClientId));
    upserted += await bulkUpsert(direct, 'products', PRODUCT_COLS, rows.map(mapProduct), { nowCol: 'synced_at' });
    rows.forEach(p => { seen.add(p.ID); ctx.knownProducts.add(p.ID); });
  });
  const out = { fetched, upserted };
  if (!since) Object.assign(out, await sweep('products', seen, 'products'));
  return out;
}

// ── Stock (full replace per warehouse; one call each) ─────────────────────────

async function syncStock(ctx) {
  let fetched = 0, upserted = 0, deleted = 0;
  const notes = [];
  for (const whId of ctx.warehouseIds) {
    const body = await ctx.get(`/api/Product/StockLevels?WarehouseId=${whId}`);
    const rows = (Array.isArray(body) ? body : []).filter(s => s.ProductId);
    fetched += rows.length;
    if (!rows.length) { notes.push(`warehouse ${whId}: API returned no stock rows; left unchanged`); continue; }
    await ensureClients(ctx, rows.map(s => s.ClientId));
    await ensureProducts(ctx, rows.map(s => s.ProductId));
    const usable = rows.filter(s => ctx.knownProducts.has(s.ProductId));
    if (usable.length < rows.length) notes.push(`warehouse ${whId}: ${rows.length - usable.length} rows for products Mintsoft could not return`);
    await tx(async db => {
      upserted += await bulkUpsert(db, 'product_stock_levels', STOCK_COLS, usable.map(s => mapStock(s, whId)),
        { conflict: ['product_id', 'warehouse_id'], nowCol: 'updated_at' });
      const del = await db.query(
        `DELETE FROM product_stock_levels WHERE warehouse_id = $1 AND NOT (product_id = ANY($2::int[]))`,
        [whId, usable.map(s => s.ProductId)]
      );
      deleted += del.rowCount;
    });
  }
  return { fetched, upserted, deleted, note: notes.join('; ') || undefined };
}

// ── Orders (+ items inline, replaced as a set) ────────────────────────────────

async function writeOrderPage(ctx, batch, seen) {
  const orders = batch.filter(o => o.ID);
  await ensureClients(ctx, orders.map(o => o.ClientId));
  await ensureProducts(ctx, orders.flatMap(o => (o.OrderItems || []).map(i => i.ProductId)));
  const withItems = orders.filter(o => Array.isArray(o.OrderItems));
  const items = withItems.flatMap(o => o.OrderItems.filter(i => i.ID).map(i => mapOrderItem(i, o.ID, ctx)));
  await tx(async db => {
    await bulkUpsert(db, 'orders', ORDER_COLS, orders.map(o => mapOrder(o, ctx)), { nowCol: 'synced_at' });
    if (withItems.length) {
      await db.query(
        `DELETE FROM order_items WHERE order_id = ANY($1::int[]) AND NOT (id = ANY($2::int[]))`,
        [withItems.map(o => o.ID), items.map(r => r[0])]
      );
      await bulkUpsert(db, 'order_items', ITEM_COLS, items);
    }
  });
  orders.forEach(o => seen.add(o.ID));
  return orders.length;
}

// Incremental: everything changed since the cursor.
async function syncOrdersSince(ctx, since) {
  const seen = new Set();
  let fetched = 0;
  for (const whId of ctx.warehouseIds) {
    fetched += await ctx.pages(
      `/api/Order/List?WarehouseId=${whId}&SinceLastUpdated=${toMintsoftParam(since)}&IncludeOrderItems=true&SortOldestFirst=true`,
      batch => writeOrderPage(ctx, batch, seen)
    );
  }
  return { fetched, upserted: seen.size };
}

// Full: every order, crawled in contiguous monthly windows (the last one open
// ended), then orders that no longer exist in Mintsoft are removed.
async function syncOrdersFull(ctx) {
  const seen = new Set();
  let fetched = 0;
  for (const whId of ctx.warehouseIds) {
    const first = await ctx.get(`/api/Order/List?WarehouseId=${whId}&SinceDate=2000-01-01T00:00:00&SortOldestFirst=true&Limit=1&PageNo=1`);
    if (!Array.isArray(first) || !first.length) continue;
    const start = londonParts(new Date(ts(first[0].OrderDate) || Date.now()));
    let y = +start.year, m = +start.month;
    const now = londonParts(new Date());
    while (y < +now.year || (y === +now.year && m <= +now.month)) {
      const from = `${y}-${String(m).padStart(2, '0')}-01T00:00:00`;
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      const isLast = ny > +now.year || (ny === +now.year && nm > +now.month);
      const to = isLast ? '' : `&ToDate=${ny}-${String(nm).padStart(2, '0')}-01T00:00:00`;
      fetched += await ctx.pages(
        `/api/Order/List?WarehouseId=${whId}&SinceDate=${from}${to}&IncludeOrderItems=true&SortOldestFirst=true`,
        batch => writeOrderPage(ctx, batch, seen)
      );
      y = ny; m = nm;
    }
  }
  return { fetched, upserted: seen.size, ...(await sweep('orders', seen, 'orders')) };
}

// ── ASNs (+ items inline, replaced as a set) ──────────────────────────────────

async function syncAsns(ctx, { since = null } = {}) {
  const seen = new Set();
  let fetched = 0;
  for (const whId of ctx.warehouseIds) {
    const filter = since ? `&SinceLastUpdated=${toMintsoftParam(since)}` : '';
    fetched += await ctx.pages(`/api/ASN/List?WarehouseId=${whId}${filter}&IncludeASNItems=true`, async batch => {
      const asns = batch.filter(a => a.ID);
      await ensureClients(ctx, asns.map(a => a.ClientId));
      await ensureProducts(ctx, asns.flatMap(a => (a.Items || []).map(i => i.ProductId)));
      const withItems = asns.filter(a => Array.isArray(a.Items));
      await tx(async db => {
        await bulkUpsert(db, 'asns', ASN_COLS, asns.map(a => mapAsn(a, ctx)), { nowCol: 'synced_at' });
        if (withItems.length) {
          await db.query(`DELETE FROM asn_items WHERE asn_id = ANY($1::int[])`, [withItems.map(a => a.ID)]);
          await bulkInsert(db, 'asn_items', ASN_ITEM_COLS, withItems.flatMap(a => a.Items.map(i => mapAsnItem(i, a.ID, ctx))));
        }
      });
      asns.forEach(a => seen.add(a.ID));
    });
  }
  const out = { fetched, upserted: seen.size };
  if (!since) Object.assign(out, await sweep('asns', seen, 'ASNs'));
  return out;
}

// ── Invoices ──────────────────────────────────────────────────────────────────
// No SinceLastUpdated on this endpoint: recent runs re-read invoices dated in
// the last `days` days (they are edited after month end); full runs read all.

async function syncInvoices(ctx, { days = null } = {}) {
  const filter = days ? `?SinceDate=${toMintsoftParam(new Date(Date.now() - days * 864e5)).slice(0, 10)}T00:00:00` : '';
  const seen = new Set();
  const fetched = await ctx.pages(`/api/Accounting/Invoice/List${filter}`, async batch => {
    const rows = batch.filter(i => i.ID);
    await ensureClients(ctx, rows.map(i => i.ClientId));
    await bulkUpsert(direct, 'invoices', INVOICE_COLS, rows.map(mapInvoice), { nowCol: 'synced_at' });
    rows.forEach(i => seen.add(i.ID));
  });
  const out = { fetched, upserted: seen.size };
  if (!days) Object.assign(out, await sweep('invoices', seen, 'invoices'));
  return out;
}

// ── Accruals (current month, unconfirmed charges per client) ──────────────────
// Rows are keyed by month, so earlier months keep their final snapshot.

async function syncAccruals(ctx) {
  const p = londonParts(new Date());
  const from = `${p.year}-${p.month}-01`;
  const to = `${p.year}-${p.month}-${p.day}`;
  const clients = await query(`SELECT id FROM clients ORDER BY id`);
  const rows = [];
  const failed = [];
  for (const { id } of clients) {
    try {
      const s = await ctx.get(`/api/Account/Invoice/GetUnconfirmedInvoiceSummary?clientID=${id}&fromDate=${from}&toDate=${to}`);
      if (s && typeof s === 'object') rows.push([id, from, ...costs(s), int(s.NumberOfParcels) ?? 0, int(s.NumberOfItems) ?? 0]);
    } catch (err) { failed.push(`${id} (${err.status || err.code || 'error'})`); }
  }
  const upserted = await bulkUpsert(direct, 'invoice_accruals', ACCRUAL_COLS, rows, { conflict: ['client_id', 'period_month'], nowCol: 'updated_at' });
  if (failed.length === clients.length && clients.length) throw new Error(`accruals failed for every client: ${failed.slice(0, 3).join(', ')}`);
  return { fetched: rows.length, upserted, note: failed.length ? `failed for clients ${failed.join(', ')}` : undefined };
}

module.exports = {
  syncReference, syncClients, syncProducts, syncStock, syncOrdersSince, syncOrdersFull, syncAsns, syncInvoices, syncAccruals,
  // exported for the reconcile tool and tests
  ORDER_COLS, ASN_COLS, mapClient, mapProduct, mapStock, mapOrder, mapOrderItem, mapAsn, mapAsnItem, mapInvoice, costs,
  str, num, int, bool, idOf,
};
