// ─── server/sync.js ───────────────────────────────────────────────────────────
// Pulls data from Mintsoft and persists to PostgreSQL.
// All writes use ON CONFLICT DO UPDATE — safe to re-run at any time.
// Single-tenant: one deployment = one 3PL organisation.

const { query, queryOne } = require('./db');
const { mintsoftGet }     = require('./mintsoft');

const PAGE = 100; // items per API page

// Mintsoft order status map (source: GET /api/Order/Statuses)
const ORDER_STATUS = {
  1:'New', 2:'Printed', 3:'Cancelled', 4:'Despatched', 5:'Invoiced',
  6:'Invoice Failed', 7:'Holding', 8:'Failed', 9:'On Back Order',
  10:'Awaiting Confirmation', 11:'Awaiting Documentation', 12:'Awaiting Payment',
  13:'Query Raised', 14:'Pack and Hold', 15:'Awaiting Picking',
  16:'Picking Started', 17:'Picked', 18:'Fraud Risk', 19:'Picking Skipped',
  20:'Packed', 21:'Awaiting Replen', 22:'Processing', 23:'Rebinned',
};

// ASN status map (source: GET /api/ASN/Statuses)
const ASN_STATUS = {
  1:'New', 2:'Awaiting Approval', 3:'Awaiting Delivery', 4:'Booked In',
  5:'Discrepancy', 6:'Complete', 7:'Partially Booked', 8:'Booked In - Partial',
  9:'Delivered', 10:'Shipped', 11:'Awaiting Delivery (Late)', 12:'Awaiting Put Away',
  13:'Robot Put Away',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(d) { return d ? d.split('T')[0] : null; }

function ts(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function paginate(path, apiKey, onPage) {
  let page = 1;
  let total = 0;
  let prevFirstId = null;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await mintsoftGet(`${path}${sep}Limit=${PAGE}&PageNo=${page}`, apiKey);
    if (res.status !== 200) throw new Error(`API ${res.status}: ${path}`);
    const batch = Array.isArray(res.body) ? res.body : [];
    if (batch.length === 0) break;

    // Guard: some Mintsoft endpoints ignore PageNo/Limit and return the full set
    // on every request. Detect the repeat (same first record as the previous page)
    // and stop, otherwise we'd reprocess the same data up to the page cap.
    const firstId = batch[0]?.ID ?? batch[0]?.Id ?? null;
    if (firstId !== null && firstId === prevFirstId) {
      console.warn(`[sync] ${path} ignores pagination — stopping after page ${page - 1}`);
      break;
    }
    prevFirstId = firstId;

    await onPage(batch);
    total += batch.length;
    if (batch.length < PAGE) break;
    page++;
    if (page > 500) break;
  }
  return total;
}

// ── Sync job tracking ─────────────────────────────────────────────────────────

async function startJob(entity, triggeredBy, triggerKey = null) {
  const row = await queryOne(
    `INSERT INTO sync_jobs (entity, triggered_by, trigger_key, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [entity, triggeredBy, triggerKey]
  );
  return row.id;
}

async function stepJob(jobId, step) {
  await query(`UPDATE sync_jobs SET current_step = $1 WHERE id = $2`, [step, jobId]).catch(() => {});
}

async function completeJob(jobId, count) {
  await query(
    `UPDATE sync_jobs SET status='success', records_synced=$1, current_step=NULL, completed_at=NOW() WHERE id=$2`,
    [count, jobId]
  );
}

async function partialJob(jobId, count, errors) {
  await query(
    `UPDATE sync_jobs SET status='partial', records_synced=$1, error=$2, current_step=NULL, completed_at=NOW() WHERE id=$3`,
    [count, errors.join(' | '), jobId]
  );
}

async function failJob(jobId, err) {
  await query(
    `UPDATE sync_jobs SET status='error', error=$1, current_step=NULL, completed_at=NOW() WHERE id=$2`,
    [err.message, jobId]
  );
}

// ── Reference / Lookup tables ─────────────────────────────────────────────────

async function syncOrderStatuses(apiKey) {
  const res = await mintsoftGet('/api/Order/Statuses', apiKey);
  if (res.status !== 200 || !Array.isArray(res.body)) return 0;
  for (const s of res.body) {
    await query(
      `INSERT INTO order_status_types (id, name, synced_at) VALUES ($1,$2,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, synced_at=NOW()`,
      [s.ID, s.Name]
    );
  }
  return res.body.length;
}

async function syncAsnStatuses(apiKey) {
  const res = await mintsoftGet('/api/ASN/Statuses', apiKey);
  if (res.status !== 200 || !Array.isArray(res.body)) return 0;
  for (const s of res.body) {
    await query(
      `INSERT INTO asn_status_types (id, name, colour, synced_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, colour=EXCLUDED.colour, synced_at=NOW()`,
      [s.ID, s.Name, s.Colour || null]
    );
  }
  return res.body.length;
}

async function syncChannels(apiKey) {
  const res = await mintsoftGet('/api/Order/Channels', apiKey);
  if (res.status !== 200 || !Array.isArray(res.body)) return 0;
  for (const c of res.body) {
    await query(
      `INSERT INTO order_channels (id, name, description, logo, client_id, active, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         logo=EXCLUDED.logo, client_id=EXCLUDED.client_id, active=EXCLUDED.active, synced_at=NOW()`,
      [c.ID, c.Name, c.Description || null, c.Logo || null, c.ClientId || null, c.Active !== false]
    );
  }
  return res.body.length;
}

async function syncCouriers(apiKey) {
  const res = await mintsoftGet('/api/Courier/Services', apiKey);
  if (res.status !== 200 || !Array.isArray(res.body)) return 0;
  for (const c of res.body) {
    await query(
      `INSERT INTO couriers (id, name, active, synced_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active, synced_at=NOW()`,
      [c.ID, c.Name, c.Active !== false]
    );
  }
  return res.body.length;
}

// ── Warehouses ────────────────────────────────────────────────────────────────

async function syncWarehouses(apiKey) {
  const res = await mintsoftGet('/api/Warehouse', apiKey);
  if (res.status !== 200 || !Array.isArray(res.body)) return {};
  const map = {};
  for (const w of res.body) {
    const id = w.ID || w.Id;
    if (!id) continue;
    await query(
      `INSERT INTO warehouses (id, name, code, synced_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code, synced_at=NOW()`,
      [id, w.Name || w.ShortName || String(id), w.Code || w.ShortName || null]
    );
    map[id] = id;
  }
  return map; // { msId: dbId }
}

// ── Clients ───────────────────────────────────────────────────────────────────

async function syncClients(apiKey) {
  const res = await mintsoftGet('/api/Client', apiKey);
  if (res.status !== 200) return 0;
  const list = Array.isArray(res.body) ? res.body : [];
  let count = 0;
  for (const c of list) {
    const id = c.ID || c.Id;
    if (!id) continue;
    await query(
      `INSERT INTO clients (id, name, short_name, active, updated_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, short_name=EXCLUDED.short_name,
         active=EXCLUDED.active, updated_at=EXCLUDED.updated_at, synced_at=NOW()`,
      [id, c.Name || c.ClientName || String(id), c.ShortName || null, c.Active !== false, ts(c.LastUpdated)]
    );
    count++;
  }
  return count;
}

// ── Products ──────────────────────────────────────────────────────────────────

async function syncProducts(apiKey, warehouseIds, updatedSince = null) {
  let count = 0;
  for (const whId of warehouseIds) {
    const path = updatedSince
      ? `/api/Product/UpdatedSince?WarehouseId=${whId}&UpdatedSince=${updatedSince}`
      : `/api/Product/List?WarehouseId=${whId}`;

    count += await paginate(path, apiKey, async (batch) => {
      for (const p of batch) {
        const id = p.ID || p.Id;
        if (!id) continue;
        const category = (p.ProductInCategories || []).map(c => c.ProductCategory?.Name).filter(Boolean).join(', ') || null;
        const supplier = (p.ProductSuppliers || []).map(sp => sp.ProductSupplier?.Name).filter(Boolean).join(', ') || null;
        await query(
          `INSERT INTO products (id, client_id, sku, name, description, customs_description,
             ean, upc, weight, height, width, depth, price, cost_price, vat_exempt,
             back_order, bundle, discontinued, low_stock_alert_level, handling_time,
             units_per_parcel, additional_parcels_required, has_batch_number, has_serial_number,
             has_expiry_date, best_before_warning_days, image_url, country_of_manufacture_id,
             commodity_code, packing_instructions, subscription, category, supplier, updated_at, synced_at)
           VALUES ($1,(SELECT id FROM clients WHERE id=$2 LIMIT 1),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                   $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,NOW())
           ON CONFLICT (id) DO UPDATE SET
             client_id=EXCLUDED.client_id, sku=EXCLUDED.sku, name=EXCLUDED.name,
             description=EXCLUDED.description, customs_description=EXCLUDED.customs_description,
             ean=EXCLUDED.ean, upc=EXCLUDED.upc, weight=EXCLUDED.weight, height=EXCLUDED.height,
             width=EXCLUDED.width, depth=EXCLUDED.depth, price=EXCLUDED.price,
             cost_price=EXCLUDED.cost_price, vat_exempt=EXCLUDED.vat_exempt,
             back_order=EXCLUDED.back_order, bundle=EXCLUDED.bundle,
             discontinued=EXCLUDED.discontinued, low_stock_alert_level=EXCLUDED.low_stock_alert_level,
             handling_time=EXCLUDED.handling_time, units_per_parcel=EXCLUDED.units_per_parcel,
             additional_parcels_required=EXCLUDED.additional_parcels_required,
             has_batch_number=EXCLUDED.has_batch_number, has_serial_number=EXCLUDED.has_serial_number,
             has_expiry_date=EXCLUDED.has_expiry_date, best_before_warning_days=EXCLUDED.best_before_warning_days,
             image_url=EXCLUDED.image_url, commodity_code=EXCLUDED.commodity_code,
             packing_instructions=EXCLUDED.packing_instructions, subscription=EXCLUDED.subscription,
             category=EXCLUDED.category, supplier=EXCLUDED.supplier,
             updated_at=EXCLUDED.updated_at, synced_at=NOW()`,
          [
            id, p.ClientId || null, p.SKU || '', p.Name || null, p.Description || null,
            p.CustomsDescription || null, p.EAN || null, p.UPC || null,
            p.Weight || null, p.Height || null, p.Width || null, p.Depth || null,
            p.Price || null, p.CostPrice || null, p.VatExempt || false,
            p.BackOrder || false, p.Bundle || false, p.DisCont || false,
            p.LowStockAlertLevel || null, p.HandlingTime || null,
            p.UnitsPerParcel || null, p.AdditionalParcelsRequired || null,
            p.HasBatchNumber || false, p.HasSerialNumber || false, p.HasExpiryDate || false,
            p.BestBeforeDateWarningPeriodDays || null, p.ImageURL || null,
            p.CountryOfManufactureId || null,
            p.CommodityCode?.Code || null, p.PackingInstructions || null,
            p.Subscription || false, category, supplier, ts(p.LastUpdated),
          ]
        );
      }
    });
  }
  return count;
}

// ── Stock levels ──────────────────────────────────────────────────────────────

async function syncStockLevels(apiKey, warehouseIds) {
  let count = 0;
  for (const whId of warehouseIds) {
    // Returns all stock in one call (no pagination)
    const res = await mintsoftGet(`/api/Product/StockLevels?WarehouseId=${whId}`, apiKey);
    if (res.status !== 200 || !Array.isArray(res.body)) continue;
    for (const s of res.body) {
      const productId = s.ProductId || s.ID;
      if (!productId) continue;
      const bd = s.Breakdown || {};
      await query(
        `INSERT INTO product_stock_levels
           (product_id, warehouse_id, client_id, sku, qty_on_hand, qty_allocated, qty_available, qty_pre_order, updated_at)
         VALUES ($1,$2,(SELECT id FROM clients WHERE id=$3 LIMIT 1),$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET
           client_id=EXCLUDED.client_id, sku=EXCLUDED.sku,
           qty_on_hand=EXCLUDED.qty_on_hand, qty_allocated=EXCLUDED.qty_allocated,
           qty_available=EXCLUDED.qty_available, qty_pre_order=EXCLUDED.qty_pre_order,
           updated_at=NOW()`,
        [
          productId, s.WarehouseId || whId, s.ClientId || null, s.SKU || '',
          s.Level ?? 0,
          bd.Allocated ?? bd.AllocatedStock ?? 0,
          bd.Available ?? bd.AvailableStock ?? (s.Level ?? 0),
          bd.PreOrder  ?? 0,
        ]
      );
      count++;
    }
  }
  return count;
}

// ── Orders ────────────────────────────────────────────────────────────────────

async function syncOrders(apiKey, warehouseIds, fromDate, toDate, withItems = false) {
  const to = toDate || new Date().toISOString().split('T')[0];
  let count = 0;

  for (const whId of warehouseIds) {
    const basePath = `/api/Order/List?WarehouseId=${whId}&SinceOrderDate=${fromDate}T00:00:00&ToDate=${to}T23:59:59`;

    count += await paginate(basePath, apiKey, async (batch) => {
      for (const o of batch) {
        const id = o.ID || o.Id;
        if (!id) continue;

        const statusId = o.OrderStatusId;
        const statusName = statusId != null ? (ORDER_STATUS[statusId] || `Status ${statusId}`) : null;

        await query(
          `INSERT INTO orders (
             id, warehouse_id, client_id, order_number, external_reference,
             status_id, status_name, channel_id, channel_name,
             order_date, despatch_date, required_despatch_date, required_delivery_date,
             sla_warning_date, sla_despatch_date,
             recipient_title, recipient_first_name, recipient_last_name, recipient_company,
             address1, address2, address3, town, county, postcode, country_id,
             phone, mobile, email,
             courier_service_id, courier_service_name, courier_service_type_id,
             tracking_number, tracking_url, number_of_parcels, total_weight,
             order_value, shipping_net, shipping_tax, shipping_gross,
             discount_net, discount_tax, discount_gross,
             total_order_net, total_order_tax, total_order_gross, total_vat,
             currency_id, comments, delivery_notes, gift_messages, vat_number,
             source, order_lock, pii_removed, despatched_by_user,
             part, number_of_parts, updated_at, synced_at
           ) VALUES (
             $1,$2,(SELECT id FROM clients WHERE id=$3 LIMIT 1),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,
             $44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58,$59,NOW()
           )
           ON CONFLICT (id) DO UPDATE SET
             status_id=EXCLUDED.status_id, status_name=EXCLUDED.status_name,
             despatch_date=EXCLUDED.despatch_date, tracking_number=EXCLUDED.tracking_number,
             tracking_url=EXCLUDED.tracking_url, courier_service_name=EXCLUDED.courier_service_name,
             order_lock=EXCLUDED.order_lock, pii_removed=EXCLUDED.pii_removed,
             updated_at=EXCLUDED.updated_at, synced_at=NOW()`,
          [
            id, o.WarehouseId || whId, o.ClientId || null,
            o.OrderNumber || o.ExternalOrderReference || null,
            o.ExternalOrderReference || null,
            statusId, statusName,
            o.ChannelId || null, o.Channel?.Name || o.Source || null,
            ts(o.OrderDate), ts(o.DespatchDate), ts(o.RequiredDespatchDate),
            ts(o.RequiredDeliveryDate), ts(o.SLAWarningDate), ts(o.SLADespatchDate),
            o.Title || null, o.FirstName || null, o.LastName || null, o.CompanyName || null,
            o.Address1 || null, o.Address2 || null, o.Address3 || null,
            o.Town || null, o.County || null, o.PostCode || null, o.CountryId || null,
            o.Phone || null, o.Mobile || null, o.Email || null,
            o.CourierServiceId || null, o.CourierServiceName || null,
            o.CourierServiceTypeId || null, o.TrackingNumber || null,
            o.TrackingURL || null, o.NumberOfParcels || 1, o.TotalWeight || null,
            o.OrderValue || null, o.ShippingNet || null, o.ShippingTax || null,
            o.ShippingGross || null, o.DiscountNet || null, o.DiscountTax || null,
            o.DiscountGross || null, o.TotalOrderNet || null, o.TotalOrderTax || null,
            o.TotalOrderGross || null, o.TotalVat || null, o.CurrencyId || null,
            o.Comments || null, o.DeliveryNotes || null, o.GiftMessages || null,
            o.VATNumber || null, o.Source || null,
            o.OrderLock || false, o.PIIRemoved || false, o.DespatchedByUser || null,
            o.Part || 1, o.NumberOfParts || 1, ts(o.LastUpdated),
          ]
        );

        // Fetch and store order items if requested
        if (withItems) {
          const itemRes = await mintsoftGet(`/api/Order/${id}/Items`, apiKey);
          if (itemRes.status === 200 && Array.isArray(itemRes.body)) {
            for (const item of itemRes.body) {
              const itemId = item.ID || item.Id;
              if (!itemId) continue;
              await query(
                `INSERT INTO order_items
                   (id, order_id, product_id, sku, quantity, allocated, committed, on_back_order,
                    price, price_net, vat, discount, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 ON CONFLICT (id) DO UPDATE SET
                   quantity=EXCLUDED.quantity, allocated=EXCLUDED.allocated,
                   committed=EXCLUDED.committed, on_back_order=EXCLUDED.on_back_order,
                   price=EXCLUDED.price, price_net=EXCLUDED.price_net,
                   vat=EXCLUDED.vat, discount=EXCLUDED.discount, updated_at=EXCLUDED.updated_at`,
                [
                  itemId, id, item.ProductId || null, item.SKU || '',
                  item.Quantity || 0, item.Allocated || 0, item.Commited || 0,
                  item.OnBackOrder || 0, item.Price || null, item.PriceNet || null,
                  item.Vat || null, item.Discount || null, ts(item.LastUpdated),
                ]
              );
            }
          }
        }
        count++;
      }
    });
  }
  return count;
}

// ── ASNs ──────────────────────────────────────────────────────────────────────

async function syncAsns(apiKey, warehouseIds, fromDate, toDate) {
  const to = toDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  let count = 0;

  for (const whId of warehouseIds) {
    // Fetch ASNs updated since fromDate, plus any future-dated ones
    const path = `/api/ASN/List?WarehouseId=${whId}`;
    count += await paginate(path, apiKey, async (batch) => {
      for (const a of batch) {
        const id = a.ID || a.Id;
        if (!id) continue;
        const statusId = a.ASNStatusId || a.ASNStatus?.ID;
        const statusName = statusId != null ? (ASN_STATUS[statusId] || `Status ${statusId}`) : null;

        await query(
          `INSERT INTO asns (id, warehouse_id, client_id, po_reference, supplier_name,
             product_supplier_id, goods_in_type, quantity, status_id, status_name,
             estimated_delivery, warehouse_booked_date, booked_in_date, comments,
             shipped, hours_logged, updated_at, synced_at)
           VALUES ($1,$2,(SELECT id FROM clients WHERE id=$3 LIMIT 1),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (id) DO UPDATE SET
             status_id=EXCLUDED.status_id, status_name=EXCLUDED.status_name,
             warehouse_booked_date=EXCLUDED.warehouse_booked_date,
             booked_in_date=EXCLUDED.booked_in_date, shipped=EXCLUDED.shipped,
             hours_logged=EXCLUDED.hours_logged, updated_at=EXCLUDED.updated_at, synced_at=NOW()`,
          [
            id, a.WarehouseId || whId, a.ClientId || null,
            a.POReference || null, a.ProductSupplier || a.Supplier || null,
            a.ProductSupplierId || null, a.GoodsInType || null, a.Quantity || null,
            statusId, statusName,
            ts(a.EstimatedDelivery), ts(a.WarehouseBookedDate), ts(a.BookedInDate),
            a.Comments || null, a.Shipped || false, a.HoursLogged || 0,
            ts(a.LastUpdated),
          ]
        );

        // Fetch items for this ASN
        const itemRes = await mintsoftGet(`/api/ASN/${id}`, apiKey);
        if (itemRes.status === 200 && Array.isArray(itemRes.body?.Items)) {
          await query(`DELETE FROM asn_items WHERE asn_id = $1`, [id]);
          for (const item of itemRes.body.Items) {
            await query(
              `INSERT INTO asn_items (asn_id, product_id, sku, expected_qty, received_qty, updated_at)
               VALUES ($1,(SELECT id FROM products WHERE id=$2 LIMIT 1),$3,$4,$5,$6)`,
              [
                id, item.ProductId || null, item.SKU || null,
                item.QuantityExpected || 0,
                // Units booked in (Mintsoft misspells the received field as "Receieved").
                item.QuantityBooked ?? item.QuantityReceieved ?? item.QuantityReceived ?? 0,
                ts(item.LastUpdated),
              ]
            );
          }
        }
        count++;
      }
    });
  }
  return count;
}

// ── Invoices ──────────────────────────────────────────────────────────────────

async function syncInvoices(apiKey) {
  let count = 0;
  count += await paginate('/api/Accounting/Invoice/List', apiKey, async (batch) => {
    for (const inv of batch) {
      const id = inv.ID || inv.Id;
      if (!id) continue;
      await query(
        `INSERT INTO invoices (id, client_id, name, invoice_date, comments,
           number_of_parcels, number_of_items, picking_cost, postage_cost,
           vat_free_postage_cost, storage_cost, goods_in_cost, returns_cost,
           rework_cost, packaging_cost, generic_items_cost, collections_cost,
           admin_fee, updated_at, synced_at)
         VALUES ($1,(SELECT id FROM clients WHERE id=$2 LIMIT 1),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, invoice_date=EXCLUDED.invoice_date, comments=EXCLUDED.comments,
           number_of_parcels=EXCLUDED.number_of_parcels, number_of_items=EXCLUDED.number_of_items,
           picking_cost=EXCLUDED.picking_cost, postage_cost=EXCLUDED.postage_cost,
           vat_free_postage_cost=EXCLUDED.vat_free_postage_cost, storage_cost=EXCLUDED.storage_cost,
           goods_in_cost=EXCLUDED.goods_in_cost, returns_cost=EXCLUDED.returns_cost,
           rework_cost=EXCLUDED.rework_cost, packaging_cost=EXCLUDED.packaging_cost,
           generic_items_cost=EXCLUDED.generic_items_cost, collections_cost=EXCLUDED.collections_cost,
           admin_fee=EXCLUDED.admin_fee, updated_at=EXCLUDED.updated_at, synced_at=NOW()`,
        [
          id, inv.ClientId || null, inv.Name || null, ts(inv.Date),
          inv.Comments || null, inv.NumberOfParcels || 0, inv.NumberOfItems || 0,
          inv.PickingCost || 0, inv.PostageCost || 0, inv.VatFreePostageCost || 0,
          inv.StorageCost || 0, inv.GoodsInCost || 0, inv.ReturnsCost || 0,
          inv.ReworkCost || 0, inv.PackagingCost || 0, inv.GenericInvoiceItemsCost || 0,
          inv.CollectionsCost || 0, inv.AdminFee || 0, ts(inv.LastUpdated),
        ]
      );
      count++;
    }
  });
  return count;
}

// ── Invoice accruals ──────────────────────────────────────────────────────────

async function syncAccruals(apiKey) {
  const now = new Date();
  const fromDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const toDate   = now.toISOString().split('T')[0];
  const periodMonth = fromDate;

  const clients = await query(`SELECT id FROM clients`);
  let count = 0;

  for (const { id: clientId } of clients) {
    const res = await mintsoftGet(
      `/api/Account/Invoice/GetUnconfirmedInvoiceSummary?clientID=${clientId}&fromDate=${fromDate}&toDate=${toDate}`,
      apiKey
    );
    if (res.status !== 200 || !res.body) continue;
    const item = res.body;
    await query(
      `INSERT INTO invoice_accruals
         (client_id, period_month, picking_cost, postage_cost, vat_free_postage_cost,
          storage_cost, goods_in_cost, returns_cost, rework_cost, packaging_cost,
          generic_items_cost, collections_cost, admin_fee, number_of_parcels,
          number_of_items, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (client_id, period_month) DO UPDATE SET
         picking_cost=EXCLUDED.picking_cost, postage_cost=EXCLUDED.postage_cost,
         vat_free_postage_cost=EXCLUDED.vat_free_postage_cost, storage_cost=EXCLUDED.storage_cost,
         goods_in_cost=EXCLUDED.goods_in_cost, returns_cost=EXCLUDED.returns_cost,
         rework_cost=EXCLUDED.rework_cost, packaging_cost=EXCLUDED.packaging_cost,
         generic_items_cost=EXCLUDED.generic_items_cost, collections_cost=EXCLUDED.collections_cost,
         admin_fee=EXCLUDED.admin_fee, number_of_parcels=EXCLUDED.number_of_parcels,
         number_of_items=EXCLUDED.number_of_items, updated_at=NOW()`,
      [
        clientId, periodMonth,
        item.PickingCost || 0, item.PostageCost || 0, item.VatFreePostageCost || 0,
        item.StorageCost || 0, item.GoodsInCost || 0, item.ReturnsCost || 0,
        item.ReworkCost || 0, item.PackagingCost || 0, item.GenericInvoiceItemsCost || 0,
        item.CollectionsCost || 0, item.AdminFee || 0,
        item.NumberOfParcels || 0, item.NumberOfItems || 0,
      ]
    );
    count++;
  }
  return count;
}

// ── Orchestrators ─────────────────────────────────────────────────────────────

async function runStep(label, fn, errors) {
  try {
    console.log(`[sync] ${label}…`);
    const n = await fn();
    console.log(`[sync]   ✓ ${n} records`);
    return n || 0;
  } catch (err) {
    console.error(`[sync] ${label} failed: ${err.message}`);
    errors.push(`${label}: ${err.message}`);
    return 0;
  }
}

// Full sync — fetches all historical data. Run once manually on first setup,
// then by login trigger if this is a new API key.
async function runFullSync({ apiKey, triggeredBy = 'manual' } = {}) {
  const key = apiKey || process.env.MINTSOFT_ADMIN_KEY;
  if (!key) throw new Error('No API key for sync');

  const jobId = await startJob('full', triggeredBy, key.slice(0, 8) + '…');
  const errors = [];
  let total = 0;

  try {
    console.log(`[sync] Full sync started`);

    await stepJob(jobId, 'Syncing reference data');
    total += await runStep('Order status types', () => syncOrderStatuses(key), errors);
    total += await runStep('ASN status types',   () => syncAsnStatuses(key),   errors);
    total += await runStep('Channels',           () => syncChannels(key),       errors);
    total += await runStep('Couriers',           () => syncCouriers(key),       errors);

    await stepJob(jobId, 'Syncing warehouses');
    const whMap = await syncWarehouses(key);
    const whIds = Object.keys(whMap).map(Number);
    console.log(`[sync] ${whIds.length} warehouse(s)`);

    await stepJob(jobId, 'Syncing clients');
    await runStep('Clients', () => syncClients(key), errors);

    await stepJob(jobId, 'Syncing products');
    total += await runStep('Products', () => syncProducts(key, whIds), errors);

    await stepJob(jobId, 'Syncing stock levels');
    total += await runStep('Stock levels', () => syncStockLevels(key, whIds), errors);

    // Orders — 24 months back by order date
    const from24m = (() => { const d = new Date(); d.setMonth(d.getMonth() - 24); return d.toISOString().split('T')[0]; })();
    await stepJob(jobId, `Syncing orders from ${from24m}`);
    // Headers only for 24 months (fast), then full items for last 60 days
    total += await runStep('Order headers (24m)', () => syncOrders(key, whIds, from24m, null, false), errors);
    // 120-day window by order date so the 90-day (despatch-based) dashboard has
    // complete item data even for orders with a long order→despatch lead time.
    const from120d = (() => { const d = new Date(); d.setDate(d.getDate() - 120); return d.toISOString().split('T')[0]; })();
    total += await runStep('Order items (120d)',  () => syncOrders(key, whIds, from120d, null, true),  errors);

    await stepJob(jobId, 'Syncing ASNs');
    total += await runStep('ASNs', () => syncAsns(key, whIds, from24m, null), errors);

    await stepJob(jobId, 'Syncing invoices');
    total += await runStep('Invoices', () => syncInvoices(key), errors);
    total += await runStep('Accruals', () => syncAccruals(key), errors);

    // Record sync time on session
    await query(
      `UPDATE user_sessions SET synced_at = NOW() WHERE api_key = $1`, [key]
    ).catch(() => {});

    if (errors.length) {
      await partialJob(jobId, total, errors);
    } else {
      await completeJob(jobId, total);
    }
    console.log(`[sync] Full sync done — ${total} records${errors.length ? ` (${errors.length} warnings)` : ''}`);
    return { ok: true, records: total, warnings: errors };

  } catch (err) {
    console.error('[sync] Fatal:', err.message);
    await failJob(jobId, err);
    return { ok: false, error: err.message };
  }
}

// Incremental sync — last 7 days + future ASNs. Used for daily cron and manual refresh.
async function runIncrementalSync({ apiKey, triggeredBy = 'cron' } = {}) {
  const key = apiKey || process.env.MINTSOFT_ADMIN_KEY;
  if (!key) throw new Error('No API key for sync');

  const jobId = await startJob('incremental', triggeredBy, key.slice(0, 8) + '…');
  const errors = [];
  let total = 0;

  try {
    console.log(`[sync] Incremental sync started`);

    const whMap = await syncWarehouses(key);
    const whIds = Object.keys(whMap).map(Number);

    const from7d = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().split('T')[0]; })();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    await stepJob(jobId, 'Syncing stock levels');
    total += await runStep('Stock levels', () => syncStockLevels(key, whIds), errors);

    await stepJob(jobId, 'Syncing recent products');
    total += await runStep('Products (updated)', async () => {
      try { return await syncProducts(key, whIds, since7d); }
      catch (e) {
        if (e.message.includes('400')) return await syncProducts(key, whIds);
        throw e;
      }
    }, errors);

    await stepJob(jobId, 'Syncing recent orders');
    total += await runStep('Orders (7d + items)', () => syncOrders(key, whIds, from7d, null, true), errors);

    await stepJob(jobId, 'Syncing ASNs');
    total += await runStep('ASNs', () => syncAsns(key, whIds, from7d, null), errors);

    await stepJob(jobId, 'Syncing invoices');
    total += await runStep('Invoices', () => syncInvoices(key), errors);

    await stepJob(jobId, 'Syncing accruals');
    total += await runStep('Accruals', () => syncAccruals(key), errors);

    await stepJob(jobId, 'Syncing channels & couriers');
    total += await runStep('Channels', () => syncChannels(key), errors);
    total += await runStep('Couriers', () => syncCouriers(key), errors);

    await query(`UPDATE user_sessions SET synced_at = NOW() WHERE api_key = $1`, [key]).catch(() => {});

    if (errors.length) {
      await partialJob(jobId, total, errors);
    } else {
      await completeJob(jobId, total);
    }
    console.log(`[sync] Incremental done — ${total} records`);
    return { ok: true, records: total, warnings: errors };

  } catch (err) {
    console.error('[sync] Fatal:', err.message);
    await failJob(jobId, err);
    return { ok: false, error: err.message };
  }
}

// Get the last sync time (for the sidebar status display)
async function getSyncStatus() {
  const job = await queryOne(
    `SELECT id, entity, triggered_by, status, records_synced, current_step, error, started_at, completed_at
     FROM sync_jobs ORDER BY started_at DESC LIMIT 1`
  );
  const last = await queryOne(
    `SELECT MAX(completed_at) AS completed_at FROM sync_jobs WHERE status IN ('success','partial')`
  );
  return { lastSyncAt: last?.completed_at ?? null, lastJob: job ?? null };
}

// On boot: any job still 'running' after 3 h is a zombie from a killed process
// (deploy/restart mid-sync). Close it so it stops blocking or confusing status.
async function abandonStaleJobs() {
  const rows = await query(
    `UPDATE sync_jobs SET status='error', error='abandoned', current_step=NULL, completed_at=NOW()
     WHERE status='running' AND started_at < NOW() - INTERVAL '3 hours'
     RETURNING id`
  );
  if (rows.length) console.log(`[sync] Marked ${rows.length} stale running job(s) as abandoned: ${rows.map(r => r.id).join(', ')}`);
  return rows.length;
}

module.exports = { runFullSync, runIncrementalSync, getSyncStatus, abandonStaleJobs, syncWarehouses, syncClients, syncOrders };
