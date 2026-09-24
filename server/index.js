// ─── server/index.js ─────────────────────────────────────────────────────────
// Entry point. Responsible for routing only — no business logic lives here.

require('dotenv').config();

const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const auth      = require('./auth');
const { requireScope } = require('./scope');
const reports   = require('./reports/index');
const dashboard = require('./reports/dashboard');
const calendar    = require('./calendar');
const picklist    = require('./picklist');
const replen      = require('./replen');
const returns     = require('./returns');
const forecasting = require('./forecasting/api');
const storage     = require('./storage');
const { sendEmail } = require('./email');
const { ensureCoreSchema } = require('./schema');
const { runFullSync, runIncrementalSync, getSyncStatus, abandonStaleJobs } = require('./sync');
const { query, queryOne } = require('./db');
const { seedDemo } = require('./demo/seed-demo');

const DEMO_MODE = !!process.env.DEMO_MODE;

// Bootstrap schemas on startup; seed the demo dataset when running as a demo.
ensureCoreSchema()
  .then(() => Promise.all([
    calendar.ensureSchema(),
    abandonStaleJobs(),
  ]))
  .then(() => { if (DEMO_MODE) return seedDemo(); })
  .catch(e => console.error('[schema] Bootstrap error:', e.message));

// ── Midnight cron ─────────────────────────────────────────────────────────────
// Nightly sync using the admin API key — rolling 7-day window + 90-day ASN window.
function scheduleMidnightSync() {
  const adminKey = process.env.MINTSOFT_ADMIN_KEY;
  if (!adminKey) {
    console.log('[cron] MINTSOFT_ADMIN_KEY not set — nightly sync disabled');
    return;
  }

  function msUntilMidnight() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next - now;
  }

  function scheduleNext() {
    const delay = msUntilMidnight();
    console.log(`[cron] Next nightly sync in ${Math.round(delay / 60000)} minutes`);
    setTimeout(async () => {
      console.log('[cron] Running nightly incremental sync…');
      try {
        await runIncrementalSync({ apiKey: adminKey, triggeredBy: 'cron' });
      } catch (err) {
        console.error('[cron] Nightly sync error:', err.message);
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

scheduleMidnightSync();

const DIST_DIR = path.join(__dirname, '../client/dist');
const PORT     = process.env.PORT || 3001;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Security headers ──────────────────────────────────────────────────────
  // Same-origin only: no Access-Control-Allow-* headers, so browsers block
  // cross-origin reads. HSTS is ignored by browsers over plain http (local dev).
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Request helpers ───────────────────────────────────────────────────────
  req.json = () => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });

  res.json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    const { pathname } = url;

    // ── Auth routes ───────────────────────────────────────────────────────────
    if (pathname === '/api/login'      && req.method === 'POST') return auth.login(req, res);
    if (pathname === '/api/demo-login' && req.method === 'POST') return auth.demoLogin(req, res);
    if (pathname === '/api/logout'     && req.method === 'POST') return auth.logout(req, res);
    if (pathname === '/api/me'         && req.method === 'GET')  return auth.me(req, res);

    // ── Dashboard route ───────────────────────────────────────────────────────
    if (pathname === '/api/dashboard' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      return dashboard.run(req, res, url, session);
    }

    // ── Report list ───────────────────────────────────────────────────────────
    if (pathname === '/api/reports' && req.method === 'GET') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      return res.json(200, reports.listReports());
    }

    // ── Report data routes ────────────────────────────────────────────────────
    if (pathname.startsWith('/api/report/') && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      return reports.handleReport(req, res, url, session);
    }

    // ── Sync routes ───────────────────────────────────────────────────────────
    if (pathname === '/api/sync' && req.method === 'POST') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      if (session.demo) return res.json(200, { ok: true, demo: true, message: 'Sync is disabled in the demo' });
      if (!session.isWarehouse) return res.json(403, { error: 'Warehouse users only' });
      const body = await req.json().catch(() => ({}));
      const full = body.full !== false;
      res.json(200, { ok: true, message: full ? 'Full sync started' : 'Incremental sync started' });
      setImmediate(async () => {
        const fn = full ? runFullSync : runIncrementalSync;
        await fn({ apiKey: session.apiKey, triggeredBy: 'manual' });
      });
      return;
    }

    if (pathname === '/api/sync/status' && req.method === 'GET') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      if (!session.isWarehouse) return res.json(403, { error: 'Warehouse users only' });
      const status = await getSyncStatus();
      return res.json(200, status);
    }

    // ── Orders by client (for dashboard panel) ────────────────────────────────
    if (pathname === '/api/orders/by-client' && req.method === 'GET') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      if (!session.isWarehouse) return res.json(403, { error: 'Warehouse users only' });

      const msWarehouseId = url.searchParams.get('warehouseId');
      const dateFrom      = url.searchParams.get('dateFrom');
      const dateTo        = url.searchParams.get('dateTo');
      const statusParam   = url.searchParams.get('statuses') || '';
      const statuses      = statusParam.split(',').filter(Boolean);

      let sql = `
        SELECT o.client_id, c.name AS client_name, COUNT(*)::int AS order_count
        FROM orders o
        JOIN clients c ON o.client_id = c.id
        WHERE 1=1`;
      const p = [];

      if (msWarehouseId) sql += ` AND o.warehouse_id = $${p.push(parseInt(msWarehouseId))}`;
      if (dateFrom)      sql += ` AND o.order_date::date >= $${p.push(dateFrom)}`;
      if (dateTo)        sql += ` AND o.order_date::date <= $${p.push(dateTo)}`;
      if (statuses.length) sql += ` AND o.status_name = ANY($${p.push(statuses)})`;

      sql += ` GROUP BY o.client_id, c.name ORDER BY order_count DESC`;
      const rows = await query(sql, p);
      return res.json(200, { rows: rows.map(r => ({ ...r, client_id: r.client_id })) });
    }

    // ── Order statuses from DB ────────────────────────────────────────────────
    if (pathname === '/api/orders/statuses' && req.method === 'GET') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      const rows = await query(
        `SELECT DISTINCT status_name FROM orders
         WHERE status_name IS NOT NULL
         ORDER BY status_name`
      );
      return res.json(200, { statuses: rows.map(r => r.status_name) });
    }

    // ── Calendar ASN sync (warehouse only, fast) ──────────────────────────────
    if (pathname === '/api/calendar/sync-asn' && req.method === 'POST') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      if (session.demo) return res.json(200, { ok: true, demo: true, message: 'Sync is disabled in the demo' });
      if (!session.isWarehouse) return res.json(403, { error: 'Warehouse users only' });
      res.json(200, { ok: true, message: 'ASN sync started' });
      setImmediate(() =>
        runIncrementalSync({ apiKey: session.apiKey, triggeredBy: 'calendar-asn' })
          .catch(err => console.error('[calendar-asn sync]', err.message))
      );
      return;
    }

    // ── Calendar routes ───────────────────────────────────────────────────────
    if (pathname === '/api/calendar' && (req.method === 'GET' || req.method === 'POST')) {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (blockDemoWrite(session, req, res)) return;
      return calendar.handle(req, res, url, session, req.method, null);
    }
    const calEventMatch = pathname.match(/^\/api\/calendar\/(\d+)$/);
    if (calEventMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (blockDemoWrite(session, req, res)) return;
      return calendar.handle(req, res, url, session, req.method, calEventMatch[1]);
    }


    // ── Pick list (warehouse only) ────────────────────────────────────────────
    if (pathname === '/api/picklist' && req.method === 'GET') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      try {
        return await picklist.handle(req, res, url, session);
      } catch (err) {
        return res.json(500, { error: err.message });
      }
    }

    // ── Replenishment list (warehouse only) ───────────────────────────────────
    if (pathname === '/api/replen' && req.method === 'GET') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      try {
        return await replen.handle(req, res, url, session);
      } catch (err) {
        return res.json(500, { error: err.message });
      }
    }

    // ── Forecasting / Inventory Planner ───────────────────────────────────────
    if (pathname === '/api/forecasting/plan' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await forecasting.plan(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/forecast' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await forecasting.forecast(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/run' && req.method === 'POST') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await forecasting.run(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/config' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await forecasting.getConfig(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/config' && req.method === 'PUT') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await forecasting.putConfig(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/lead-time' && req.method === 'POST') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await forecasting.saveLeadTime(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/lead-time' && req.method === 'DELETE') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await forecasting.deleteLeadTime(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/event' && req.method === 'POST') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await forecasting.saveEvent(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/forecasting/event' && req.method === 'DELETE') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await forecasting.deleteEvent(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }

    // ── Storage calculator + Excess stock (client-facing, DB-backed) ──────────
    if (pathname === '/api/storage' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await storage.storageBreakdown(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/excess' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await storage.excessStock(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/storage/cost' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await storage.storageCost(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }

    // ── Product overview (all of a client's products + on-hand stock) ──────────
    if (pathname === '/api/products/overview' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;

      // Clients see their own products; warehouse users can scope by clientId.
      const { clientId } = req.scope;

      const params = [];
      let where = '';
      if (clientId) { params.push(clientId); where = `WHERE p.client_id = $1`; }

      const rows = await query(
        `SELECT p.sku, p.name, p.bundle, p.discontinued, p.category, p.supplier,
                st.qty AS qty_on_hand,
                (st.product_id IS NOT NULL) AS has_stock_record
         FROM products p
         LEFT JOIN (
           SELECT product_id, SUM(qty_on_hand)::int AS qty
           FROM product_stock_levels GROUP BY product_id
         ) st ON st.product_id = p.id
         ${where}
         ORDER BY p.sku`,
        params
      );

      return res.json(200, {
        products: rows.map(r => ({
          sku:           r.sku,
          name:          r.name || '',
          type:          r.bundle ? 'Bundle' : 'Product',
          supplier:      r.supplier || '',
          category:      r.category || '',
          discontinued:  r.discontinued,
          // null inventory → never stocked (no stock record at all)
          inventory:     r.has_stock_record ? (r.qty_on_hand ?? 0) : null,
        })),
      });
    }

    // ── Order search (for Book a Return — find the order to return) ────────────
    if (pathname === '/api/orders/search' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return res.json(200, { orders: [] });

      const { clientId } = req.scope;

      const params = [`%${q}%`];
      let where = `WHERE (o.order_number ILIKE $1 OR o.external_reference ILIKE $1)`;
      if (clientId) where += ` AND o.client_id = $${params.push(clientId)}`;

      const rows = await query(
        `SELECT o.id, o.order_number, o.external_reference, o.order_date::date AS order_date,
                o.status_name, o.recipient_first_name, o.recipient_last_name, o.town, o.postcode
         FROM orders o ${where}
         ORDER BY o.order_date DESC LIMIT 25`,
        params
      );
      return res.json(200, {
        orders: rows.map(o => ({
          id: o.id, orderNumber: o.order_number, reference: o.external_reference,
          orderDate: o.order_date, status: o.status_name,
          customerName: [o.recipient_first_name, o.recipient_last_name].filter(Boolean).join(' '),
          location: [o.town, o.postcode].filter(Boolean).join(', '),
        })),
      });
    }

    // ── Order detail for a return (recipient, address, items) ──────────────────
    if (pathname === '/api/orders/return-detail' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      const id = parseInt(url.searchParams.get('id'));
      if (!id) return res.json(400, { error: 'id is required' });

      const o = await queryOne(`SELECT * FROM orders WHERE id = $1`, [id]);
      if (!o) return res.json(404, { error: 'Order not found' });
      // Clients may only view their own orders.
      if (!session.isWarehouse && String(o.client_id) !== String(session.clientId)) {
        return res.json(403, { error: 'Not your order' });
      }

      const items = await query(
        `SELECT oi.sku, oi.quantity, p.name
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1 ORDER BY oi.sku`,
        [id]
      );
      return res.json(200, {
        order: {
          id: o.id, orderNumber: o.order_number, reference: o.external_reference,
          orderDate: o.order_date, status: o.status_name,
          customerName: [o.recipient_title, o.recipient_first_name, o.recipient_last_name].filter(Boolean).join(' '),
          company: o.recipient_company,
          address: { line1: o.address1, line2: o.address2, line3: o.address3, town: o.town, county: o.county, postcode: o.postcode },
          email: o.email, phone: o.phone || o.mobile,
        },
        items: items.map(i => ({ sku: i.sku, name: i.name || '', quantity: i.quantity })),
      });
    }

    // ── Returns ───────────────────────────────────────────────────────────────
    if (pathname === '/api/returns' && req.method === 'POST') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await returns.create(req, res, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (pathname === '/api/returns' && req.method === 'GET') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      try { return await returns.list(req, res, url, session); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    const returnMatch = pathname.match(/^\/api\/returns\/(\d+)$/);
    if (returnMatch && req.method === 'PATCH') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await returns.update(req, res, session, returnMatch[1]); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    if (returnMatch && req.method === 'DELETE') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await returns.remove(req, res, session, returnMatch[1]); }
      catch (err) { return res.json(500, { error: err.message }); }
    }
    const returnRestoreMatch = pathname.match(/^\/api\/returns\/(\d+)\/restore$/);
    if (returnRestoreMatch && req.method === 'POST') {
      const session = requireScopedSession(req, res, url);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      try { return await returns.restore(req, res, session, returnRestoreMatch[1]); }
      catch (err) { return res.json(500, { error: err.message }); }
    }

    // ── Website SEO — register interest ───────────────────────────────────────
    if (pathname === '/api/seo-interest' && req.method === 'POST') {
      const session = auth.requireSession(req, res);
      if (!session) return;
      if (session.demo) return res.json(403, { error: 'Disabled in demo' });
      const body = await req.json().catch(() => ({}));
      const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const recipients = (process.env.SEO_NOTIFY_EMAILS || 'arizvi@premiumfulfilment.co.uk')
        .split(',').map(s => s.trim()).filter(Boolean);
      const html = `
        <div style="font-family:Arial,sans-serif;color:#1a1c2e;max-width:600px">
          <h2 style="color:#2D4270">New Website SEO enquiry</h2>
          <table style="border-collapse:collapse;font-size:14px">
            <tr><td style="padding:4px 10px;color:#6b7280">Package</td><td style="padding:4px 10px;font-weight:bold">${esc(body.package || '—')}</td></tr>
            <tr><td style="padding:4px 10px;color:#6b7280">Name</td><td style="padding:4px 10px">${esc(body.name || '—')}</td></tr>
            <tr><td style="padding:4px 10px;color:#6b7280">Email</td><td style="padding:4px 10px">${esc(body.email || '—')}</td></tr>
            <tr><td style="padding:4px 10px;color:#6b7280">Company</td><td style="padding:4px 10px">${esc(body.company || '—')}</td></tr>
            <tr><td style="padding:4px 10px;color:#6b7280">Submitted by</td><td style="padding:4px 10px">${esc(session.username || '—')}</td></tr>
          </table>
          ${body.message ? `<p style="margin-top:12px"><strong>Message:</strong> ${esc(body.message)}</p>` : ''}
        </div>`;
      try {
        await sendEmail({
          to: recipients,
          subject: `Website SEO enquiry${body.package ? ` — ${body.package}` : ''} (${body.name || session.username})`,
          html, replyTo: body.email || undefined,
        });
        return res.json(200, { ok: true });
      } catch (err) {
        return res.json(500, { error: err.message });
      }
    }

    // ── SPA static serving (production build) ─────────────────────────────────
    // Unknown API paths (and the removed /proxy relay) are a JSON 404, never the SPA shell.
    if (req.method === 'GET' && !/^\/(api|proxy)(\/|$)/.test(pathname)) {
      const assetPath = path.join(DIST_DIR, pathname);
      if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        const ext  = path.extname(pathname);
        const mime = {
          '.js': 'application/javascript', '.css': 'text/css',
          '.html': 'text/html', '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon', '.png': 'image/png',
          '.woff2': 'font/woff2', '.woff': 'font/woff',
        }[ext] || 'application/octet-stream';
        return serveFile(res, assetPath, mime);
      }
      const indexPath = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(indexPath)) return serveFile(res, indexPath, 'text/html');
    }

    res.json(404, { error: 'Not found' });

  } catch (err) {
    console.error('Unhandled error:', err.message);
    res.json(500, { error: err.message });
  }
});

// Session + tenant scope for data routes (server/scope.js). Writes 401/403 and
// returns null when denied; otherwise sets req.scope and returns the session.
function requireScopedSession(req, res, url) {
  const session = auth.requireSession(req, res);
  if (!session) return null;
  const scope = requireScope(session, url, res);
  if (!scope) return null;
  req.scope = scope;
  return session;
}

// Reject mutating requests for demo sessions. Returns true if the request was
// handled (blocked), false otherwise. GETs always pass through (read-only demo).
function blockDemoWrite(session, req, res) {
  if (session.demo && req.method !== 'GET') {
    res.json(403, { error: 'This is a read-only demo — changes are disabled.', demo: true });
    return true;
  }
  return false;
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`\n✓ PF Forecaster running at http://localhost:${PORT}`);
  console.log(`  Login: http://localhost:${PORT}/\n`);
});
