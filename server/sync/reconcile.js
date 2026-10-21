// ─── server/sync/reconcile.js ─────────────────────────────────────────────────
// Proves the database mirrors Mintsoft. Re-crawls every entity independently of
// the sync (orders with no date filter at all), maps each record with the same
// mappers the sync uses, and compares every column with the database.
//
// Per entity: api / db counts, missingInDb, extraInDb, drift (same LastUpdated
// but different values = a real mismatch) and changed (Mintsoft edited the
// record after it was synced — expected between runs), with sample ids.

const { query } = require('../db');
const { createContext } = require('./context');
const E = require('./entities');
const { parseMintsoftDate: ts, londonParts } = require('./time');

const COLS = {
  clients:  ['id', 'name', 'short_name', 'active', 'updated_at'],
  products: ['id', 'client_id', 'sku', 'name', 'description', 'customs_description', 'ean', 'upc', 'weight', 'height', 'width', 'depth',
    'price', 'cost_price', 'vat_exempt', 'back_order', 'bundle', 'discontinued', 'low_stock_alert_level', 'handling_time',
    'units_per_parcel', 'additional_parcels_required', 'has_batch_number', 'has_serial_number', 'has_expiry_date',
    'best_before_warning_days', 'image_url', 'country_of_manufacture_id', 'commodity_code', 'packing_instructions',
    'subscription', 'category', 'supplier', 'updated_at'],
  stock: ['product_id', 'warehouse_id', 'client_id', 'sku', 'qty_on_hand', 'qty_allocated', 'qty_available', 'qty_pre_order', 'qty_total'],
  orders: ['id', 'warehouse_id', 'client_id', 'order_number', 'external_reference', 'status_id', 'status_name', 'channel_id', 'channel_name',
    'order_date', 'despatch_date', 'required_despatch_date', 'required_delivery_date', 'sla_warning_date', 'sla_despatch_date',
    'recipient_title', 'recipient_first_name', 'recipient_last_name', 'recipient_company',
    'address1', 'address2', 'address3', 'town', 'county', 'postcode', 'country_id', 'phone', 'mobile', 'email',
    'courier_service_id', 'courier_service_name', 'courier_service_type_id', 'tracking_number', 'tracking_url',
    'number_of_parcels', 'total_weight', 'order_value', 'shipping_net', 'shipping_tax', 'shipping_gross',
    'discount_net', 'discount_tax', 'discount_gross', 'total_order_net', 'total_order_tax', 'total_order_gross', 'total_vat',
    'currency_id', 'comments', 'delivery_notes', 'gift_messages', 'vat_number', 'source', 'order_lock', 'pii_removed',
    'despatched_by_user', 'part', 'number_of_parts', 'updated_at'],
  items: ['id', 'order_id', 'product_id', 'sku', 'quantity', 'allocated', 'committed', 'on_back_order', 'price', 'price_net', 'vat', 'discount', 'updated_at'],
  asns: ['id', 'warehouse_id', 'client_id', 'po_reference', 'supplier_name', 'product_supplier_id', 'goods_in_type', 'quantity',
    'status_id', 'status_name', 'estimated_delivery', 'warehouse_booked_date', 'booked_in_date', 'comments', 'shipped', 'hours_logged', 'updated_at'],
  invoices: ['id', 'client_id', 'name', 'invoice_date', 'comments', 'number_of_parcels', 'number_of_items',
    'picking_cost', 'postage_cost', 'vat_free_postage_cost', 'storage_cost', 'goods_in_cost', 'returns_cost',
    'rework_cost', 'packaging_cost', 'generic_items_cost', 'collections_cost', 'admin_fee', 'updated_at'],
  accruals: ['client_id', 'period_month', 'picking_cost', 'postage_cost', 'vat_free_postage_cost', 'storage_cost', 'goods_in_cost',
    'returns_cost', 'rework_cost', 'packaging_cost', 'generic_items_cost', 'collections_cost', 'admin_fee', 'number_of_parcels', 'number_of_items'],
};

// Normalise a value so API-mapped and database values compare equal only when
// they are the same value (numerics exactly, e.g. '1.2750' = 1.275; timestamps
// to the millisecond).
function norm(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return String(Number(s));
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s)) return new Date(s).toISOString();
  return s;
}

function diffCols(cols, apiRow, dbRow) {
  const out = [];
  cols.forEach((c, i) => { if (norm(apiRow[i]) !== norm(dbRow[c])) out.push(c); });
  return out;
}

function tally(name) {
  return { entity: name, api: 0, db: 0, matched: 0, missingInDb: 0, extraInDb: 0, drift: 0, changed: 0, samples: [] };
}
function sample(t, kind, id, extra) { if (t.samples.length < 12) t.samples.push({ kind, id, ...(extra ? { detail: extra } : {}) }); }

// Compare a page of API rows (already mapped) with DB rows keyed by the same id.
// A row Mintsoft created or edited after the last sync started is "changed",
// not missing/drift: the next hourly run picks it up.
function comparePage(t, cols, apiRows, dbById, { keyOf = r => r[0], updatedIdx = cols.indexOf('updated_at'), syncedAt = null } = {}) {
  for (const row of apiRows) {
    const id = keyOf(row);
    const db = dbById.get(id);
    if (!db) {
      const newer = syncedAt && updatedIdx >= 0 && row[updatedIdx] && new Date(row[updatedIdx]) > syncedAt;
      if (newer) t.changed++; else { t.missingInDb++; sample(t, 'missing', id); }
      continue;
    }
    const cs = diffCols(cols, row, db);
    if (!cs.length) { t.matched++; continue; }
    const changed = updatedIdx >= 0 && norm(row[updatedIdx]) !== norm(db.updated_at);
    if (changed) t.changed++; else { t.drift++; sample(t, 'drift', id, cs.join(',')); }
  }
}

async function dbRows(sql, params, key = 'id') {
  const rows = await query(sql, params);
  return new Map(rows.map(r => [r[key], r]));
}

async function reconcile({ apiKey, only = null, log = () => {} } = {}) {
  const key = apiKey || process.env.MINTSOFT_ADMIN_KEY;
  const ctx = await createContext({ apiKey: key });
  const want = e => !only || only.includes(e);
  const last = await query(`SELECT MAX(started_at) AS t FROM sync_jobs WHERE status IN ('success','partial') AND entity <> 'reconcile'`);
  const syncedAt = last[0]?.t ? new Date(last[0].t) : null;
  const report = [];

  // ── Clients: every listed client present, named and active; nobody else active.
  if (want('clients')) {
    const t = tally('clients');
    const list = [];
    await ctx.pages('/api/Client', async b => { list.push(...b.filter(c => c.ID)); });
    const db = await dbRows(`SELECT * FROM clients`);
    t.api = list.length; t.db = db.size;
    comparePage(t, COLS.clients, list.map(c => E.mapClient(c, E.bool(c.Active ?? 'Y') && !c.OnStop)), db, { syncedAt });
    const listed = new Set(list.map(c => c.ID));
    for (const r of db.values()) if (r.active && !listed.has(r.id)) { t.drift++; sample(t, 'active-but-unlisted', r.id); }
    t.inactiveKept = [...db.values()].filter(r => !listed.has(r.id)).length;
    report.push(t); log(t);
  }

  // ── Products
  if (want('products')) {
    const t = tally('products');
    const seen = new Set();
    await ctx.pages('/api/Product/List', async b => {
      const rows = b.filter(p => p.ID).map(E.mapProduct);
      const db = await dbRows(`SELECT * FROM products WHERE id = ANY($1::int[])`, [rows.map(r => r[0])]);
      t.api += rows.length; rows.forEach(r => seen.add(r[0]));
      comparePage(t, COLS.products, rows, db, { syncedAt });
    });
    const all = await query(`SELECT id FROM products`);
    t.db = all.length;
    for (const { id } of all) if (!seen.has(id)) { t.extraInDb++; sample(t, 'extra', id); }
    report.push(t); log(t);
  }

  // ── Stock (moves constantly: run straight after a sync for a tight check)
  if (want('stock')) {
    const t = tally('stock');
    for (const whId of ctx.warehouseIds) {
      const body = await ctx.get(`/api/Product/StockLevels?WarehouseId=${whId}`);
      const rows = (Array.isArray(body) ? body : []).filter(s => s.ProductId).map(s => E.mapStock(s, whId));
      const db = await dbRows(`SELECT * FROM product_stock_levels WHERE warehouse_id = $1`, [whId], 'product_id');
      t.api += rows.length; t.db += db.size;
      comparePage(t, COLS.stock, rows, db, { updatedIdx: -1 });
      const seen = new Set(rows.map(r => r[0]));
      for (const id of db.keys()) if (!seen.has(id)) { t.extraInDb++; sample(t, 'extra', id); }
    }
    report.push(t); log(t);
  }

  // ── Orders + items, plus per-month counts (London order date)
  if (want('orders')) {
    const t = tally('orders');
    const ti = tally('order_items');
    const months = {};
    const bump = (m, k) => { months[m] = months[m] || { api: 0, db: 0 }; months[m][k]++; };
    const seen = new Set();
    for (const whId of ctx.warehouseIds) {
      await ctx.pages(`/api/Order/List?WarehouseId=${whId}&SortOldestFirst=true&IncludeOrderItems=true`, async b => {
        const orders = b.filter(o => o.ID && !seen.has(o.ID));
        orders.forEach(o => seen.add(o.ID));
        const ids = orders.map(o => o.ID);
        const db = await dbRows(`SELECT * FROM orders WHERE id = ANY($1::int[])`, [ids]);
        t.api += orders.length;
        comparePage(t, COLS.orders, orders.map(o => E.mapOrder(o, ctx)), db, { syncedAt });
        for (const o of orders) { const d = ts(o.OrderDate); if (d) { const p = londonParts(new Date(d)); bump(`${p.year}-${p.month}`, 'api'); } }

        const withItems = orders.filter(o => Array.isArray(o.OrderItems));
        const apiItems = withItems.flatMap(o => o.OrderItems.filter(i => i.ID).map(i => E.mapOrderItem(i, o.ID, ctx)));
        const dbItems = await dbRows(`SELECT * FROM order_items WHERE order_id = ANY($1::int[])`, [withItems.map(o => o.ID)]);
        ti.api += apiItems.length; ti.db += dbItems.size;
        comparePage(ti, COLS.items, apiItems, dbItems, { syncedAt });
        const apiItemIds = new Set(apiItems.map(r => r[0]));
        for (const id of dbItems.keys()) if (!apiItemIds.has(id)) { ti.extraInDb++; sample(ti, 'extra', id); }
      });
    }
    const all = await query(`SELECT id, to_char(order_date AT TIME ZONE 'Europe/London', 'YYYY-MM') AS m FROM orders`);
    t.db = all.length;
    for (const r of all) { if (r.m) bump(r.m, 'db'); if (!seen.has(r.id)) { t.extraInDb++; sample(t, 'extra', r.id); } }
    t.months = Object.entries(months).sort().map(([m, v]) => ({ month: m, ...v, diff: v.db - v.api }));
    report.push(t, ti); log(t); log(ti);
  }

  // ── ASNs + items (items compared as a multiset per ASN)
  if (want('asns')) {
    const t = tally('asns');
    const ti = tally('asn_items');
    const seen = new Set();
    for (const whId of ctx.warehouseIds) {
      await ctx.pages(`/api/ASN/List?WarehouseId=${whId}&IncludeASNItems=true`, async b => {
        const asns = b.filter(a => a.ID);
        asns.forEach(a => seen.add(a.ID));
        const db = await dbRows(`SELECT * FROM asns WHERE id = ANY($1::int[])`, [asns.map(a => a.ID)]);
        t.api += asns.length;
        comparePage(t, COLS.asns, asns.map(a => E.mapAsn(a, ctx)), db, { syncedAt });
        const dbItems = await query(`SELECT asn_id, product_id, sku, expected_qty, received_qty FROM asn_items WHERE asn_id = ANY($1::int[])`, [asns.map(a => a.ID)]);
        const sig = r => [r[0] ?? r.asn_id, r[1] ?? r.product_id, r[2] ?? r.sku, r[3] ?? r.expected_qty, r[4] ?? r.received_qty].join('|');
        for (const a of asns.filter(x => Array.isArray(x.Items))) {
          const apiSigs = a.Items.map(i => sig(E.mapAsnItem(i, a.ID, ctx))).sort();
          const dbSigs = dbItems.filter(r => r.asn_id === a.ID).map(r => [r.asn_id, r.product_id, r.sku, r.expected_qty, r.received_qty].join('|')).sort();
          ti.api += apiSigs.length; ti.db += dbSigs.length;
          if (apiSigs.join('\n') === dbSigs.join('\n')) ti.matched += apiSigs.length;
          else { ti.drift++; sample(ti, 'items-differ', a.ID, `api ${apiSigs.length} vs db ${dbSigs.length}`); }
        }
      });
    }
    const all = await query(`SELECT id FROM asns`);
    t.db = all.length;
    for (const { id } of all) if (!seen.has(id)) { t.extraInDb++; sample(t, 'extra', id); }
    report.push(t, ti); log(t); log(ti);
  }

  // ── Invoices
  if (want('invoices')) {
    const t = tally('invoices');
    const seen = new Set();
    await ctx.pages('/api/Accounting/Invoice/List', async b => {
      const rows = b.filter(i => i.ID).map(E.mapInvoice);
      rows.forEach(r => seen.add(r[0]));
      const db = await dbRows(`SELECT * FROM invoices WHERE id = ANY($1::int[])`, [rows.map(r => r[0])]);
      t.api += rows.length;
      comparePage(t, COLS.invoices, rows, db, { syncedAt });
    });
    const all = await query(`SELECT id FROM invoices`);
    t.db = all.length;
    for (const { id } of all) if (!seen.has(id)) { t.extraInDb++; sample(t, 'extra', id); }
    report.push(t); log(t);
  }

  // ── Accruals (current month; these move during the day)
  if (want('accruals')) {
    const t = tally('accruals');
    const p = londonParts();
    const from = `${p.year}-${p.month}-01`, to = `${p.year}-${p.month}-${p.day}`;
    const db = await dbRows(`SELECT *, to_char(period_month, 'YYYY-MM-DD') AS pm FROM invoice_accruals WHERE period_month = $1`, [from], 'client_id');
    const clients = await query(`SELECT id FROM clients ORDER BY id`);
    for (const { id } of clients) {
      let s;
      try { s = await ctx.get(`/api/Account/Invoice/GetUnconfirmedInvoiceSummary?clientID=${id}&fromDate=${from}&toDate=${to}`); } catch { continue; }
      t.api++;
      const row = [id, from, ...E.costs(s), E.int(s.NumberOfParcels) ?? 0, E.int(s.NumberOfItems) ?? 0];
      const d = db.get(id);
      if (!d) { t.missingInDb++; sample(t, 'missing', id); continue; }
      const cs = diffCols(COLS.accruals.slice(2), row.slice(2), d);
      if (cs.length) { t.changed++; sample(t, 'moved', id, cs.join(',')); } else t.matched++;
    }
    t.db = db.size;
    report.push(t); log(t);
  }

  return { at: new Date().toISOString(), syncedAt, apiCalls: ctx.apiCalls, report };
}

module.exports = { reconcile, norm };
