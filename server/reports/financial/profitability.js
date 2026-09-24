// Customer Profitability / Client Cost Breakdown
// Warehouse view: revenue per client from invoice data.
// Client view: own cost breakdown, split between 3PL service fees and courier costs.

const { resolveIds, getInvoiceForClient, getInvoicesForMonth, getAllClientInvoices } = require('../db-base');
const { startSSE, parseReportParams } = require('../base');
const { query } = require('../../db');
const { mintsoftGet } = require('../../mintsoft');

const meta = {
  title:       'Profitability',
  description: 'Warehouse: revenue breakdown per client. Client: your cost breakdown split by service type.',
  icon:        '💹',
  category:    'financial',
  params: []
};

async function run(req, res, url, session) {
  const { warehouseId: msWarehouseId } = parseReportParams(url, session);
  const from = url.searchParams.get('from') || null;
  const to   = url.searchParams.get('to')   || null;
  const mode = url.searchParams.get('mode') || null;
  const send = startSSE(res);

  try {
    const { clientId } = resolveIds(session, msWarehouseId, session.isWarehouse ? null : session.clientId);

    if (session.isWarehouse) {
      await runWarehouseView(send, session, from, to);
    } else if (mode === 'totals') {
      await runClientTotals(send, clientId, session);
    } else {
      await runClientView(send, clientId, session, from, to);
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
}

// ── Warehouse: revenue per client ─────────────────────────────────────────────

// Rows come from the invoices themselves (joined to the clients table for the
// name), not from session.clients — churned clients no longer returned by
// Mintsoft /api/Client still had revenue in past months.
async function runWarehouseView(send, session, fromParam, toParam) {
  const now  = new Date();
  const from = fromParam || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const to   = toParam   || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  send({ type: 'progress', message: 'Fetching billing data…' });
  const invRows = await getInvoicesForMonth(from);

  const ids = [...new Set(invRows.map(inv => inv.ClientId).filter(id => id != null))];
  const nameMap = {};
  if (ids.length) {
    const named = await query(`SELECT id, name FROM clients WHERE id = ANY($1)`, [ids]);
    named.forEach(c => { nameMap[c.id] = c.name; });
  }

  const rows = [];
  for (const inv of invRows) {
    const msClientId = inv.ClientId != null ? String(inv.ClientId) : null;
    const name       = msClientId
      ? (nameMap[inv.ClientId] || `Client #${msClientId}`)
      : 'Unassigned (no client)';

    const picking = inv.PickingCost  || 0;
    const postage = (inv.PostageCost || 0) + (inv.VatFreePostageCost || 0);
    const storage = inv.StorageCost  || 0;
    const goodsIn = inv.GoodsInCost  || 0;
    const returns = inv.ReturnsCost  || 0;
    const other   = (inv.ReworkCost || 0) + (inv.PackagingCost || 0) +
                    (inv.GenericInvoiceItemsCost || 0) + (inv.CollectionsCost || 0) + (inv.AdminFee || 0);
    const revenue = picking + postage + storage + goodsIn + returns + other;

    if (revenue === 0) continue;
    rows.push({ clientId: msClientId, name, picking, postage, storage, goodsIn, returns, other, revenue });
  }

  rows.sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  send({ type: 'done', viewType: 'warehouse', rows, meta: { totalRevenue, totalClients: rows.length, period: `${from} → ${to}` } });
}

// ── Client: own cost breakdown ────────────────────────────────────────────────

async function runClientView(send, clientId, session, fromParam, toParam) {
  if (!clientId) {
    send({ type: 'error', message: 'Could not determine your client account. Please contact your warehouse.' });
    return;
  }

  const now  = new Date();
  const from = fromParam || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const to   = toParam   || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  send({ type: 'progress', message: 'Fetching your billing data…' });
  const inv = await getInvoiceForClient(clientId, from);

  if (!inv) {
    send({ type: 'done', viewType: 'client', breakdown: null, meta: { period: `${from} → ${to}` } });
    return;
  }

  // Individual line items, matching the descriptions used on the client invoice.
  const lines = {
    pickingCost:      inv.PickingCost              || 0,
    postageCost:      inv.PostageCost              || 0,
    vatFreePostage:   inv.VatFreePostageCost       || 0,
    reworkCost:       inv.ReworkCost               || 0,
    packagingCost:    inv.PackagingCost            || 0,
    genericAdminCost: inv.GenericInvoiceItemsCost  || 0,
    invoiceAdminCost: inv.AdminFee                 || 0,
    goodsInCost:      inv.GoodsInCost              || 0,
    returnsCost:      inv.ReturnsCost              || 0,
    collectionsCost:  inv.CollectionsCost          || 0,
    storageCost:      inv.StorageCost              || 0,
  };

  const subtotal = Object.values(lines).reduce((s, v) => s + v, 0); // net
  const vat      = (subtotal - lines.vatFreePostage) * 0.20;        // VAT-free postage isn't VAT-rated
  const grand    = subtotal + vat;

  // Real per-order costs from the invoice (Mintsoft attributes picking/postage/
  // rework/packaging/admin per order; storage/goods-in/generic are account-level).
  send({ type: 'progress', message: 'Fetching per-order costs…' });
  const invIds = await query(
    `SELECT id FROM invoices WHERE client_id = $1 AND invoice_date::date >= $2 AND invoice_date::date <= $3`,
    [clientId, from, to]
  );
  const items = [];
  for (const { id } of invIds) {
    const r = await mintsoftGet(`/api/Accounting/Invoice/${id}/Orders`, process.env.MINTSOFT_ADMIN_KEY);
    if (r.status === 200 && Array.isArray(r.body)) items.push(...r.body);
  }

  // Join Mintsoft OrderId → our order header for number/date/customer.
  const orderIds = [...new Set(items.map(i => i.OrderId).filter(Boolean))];
  const orderMap = {};
  if (orderIds.length) {
    const od = await query(
      `SELECT id, order_number, to_char(despatch_date AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS date,
              NULLIF(TRIM(CONCAT_WS(' ', recipient_first_name, recipient_last_name)), '') AS customer,
              number_of_parcels
       FROM orders WHERE id = ANY($1)`,
      [orderIds]
    );
    od.forEach(o => { orderMap[o.id] = o; });
  }

  const orders = items.map(it => {
    const o = orderMap[it.OrderId] || {};
    const picking = it.TotalPickingCost || 0;
    const postage = it.TotalPostageCost || 0;
    const other   = (it.ReworkCost || 0) + (it.PackagingCost || 0) + (it.AdminFee || 0);
    const total   = it.TotalCost != null ? it.TotalCost : (picking + postage + other);
    return {
      orderNumber: o.order_number || String(it.OrderId),
      date:        o.date || null,
      customer:    o.customer || '—',
      parcels:     o.number_of_parcels || 0,
      picks:       it.NumberOfPicks || 0,
      picking, postage, other, total,
    };
  }).sort((a, b) => (a.date && b.date) ? new Date(a.date) - new Date(b.date) : 0);

  const perOrderTotal = Math.round(orders.reduce((s, o) => s + o.total, 0) * 100) / 100;
  const accountLevel  = Math.round((subtotal - perOrderTotal) * 100) / 100;

  send({
    type: 'done',
    viewType: 'client',
    breakdown: { ...lines, subtotal, vat, grand },
    orders,
    stats: { orderCount: orders.length, perOrderTotal, accountLevel },
    meta:  { subtotal, vat, grand, period: `${from} → ${to}` },
  });
}

// ── Client: all invoice totals for the billing periods table ─────────────────

async function runClientTotals(send, clientId, session) {
  if (!clientId) {
    send({ type: 'done', viewType: 'client-totals', totals: {} });
    return;
  }

  // Clients only see confirmed invoices — the unconfirmed current-month accrual
  // is deliberately excluded.
  const { confirmed } = await getAllClientInvoices(clientId);
  const totals = {};

  for (const inv of confirmed) {
    const d    = new Date(inv.Date);
    const yymm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    totals[yymm] = sumInvoice(inv);
  }

  send({ type: 'done', viewType: 'client-totals', totals });
}

function sumInvoice(inv) {
  return (inv.PickingCost || 0) + (inv.PostageCost || 0) + (inv.VatFreePostageCost || 0) +
         (inv.StorageCost || 0) + (inv.GoodsInCost || 0) + (inv.ReturnsCost || 0) +
         (inv.ReworkCost  || 0) + (inv.PackagingCost || 0) + (inv.GenericInvoiceItemsCost || 0) +
         (inv.CollectionsCost || 0) + (inv.AdminFee || 0);
}

module.exports = { meta, run };
