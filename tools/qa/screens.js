// ─── tools/qa/screens.js ──────────────────────────────────────────────────────
// Playwright walkthrough of every page for both personas, plus API-level
// security and number checks. Requires tools/qa/launcher.js to be running.
//
//   cd tools/qa && npm install && npx playwright install chromium-headless-shell
//   node tools/qa/screens.js --order=IN85287 [--base=http://localhost:3111]
//
// Output: tools/qa/shots/*.png, tools/qa/results.json, and a PASS/FAIL summary
// of the security expectations (used as a Definition-of-Done check in the plan).
const path = require('path');
const fs   = require('fs');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));

const args   = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, true]; }));
const BASE   = args.base || 'http://localhost:3111';
const ORDER  = args.order || '';
const OUT    = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const results = { pages: [], api: [], consoleErrors: {}, failedRequests: {}, expectations: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitSettled(page, ms = 25000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const busy = await page.evaluate(() => /Loading…|Running…|Fetching|Refreshing…|Building…|Recalculating|Loading dashboard|Loading charges|Loading settings|Loading forecast|Checking stock/.test(document.body.innerText)).catch(() => false);
    if (!busy) break;
    await sleep(500);
  }
  await sleep(800);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '');
  results.pages.push({ name, url: page.url(), text });
  console.log(`  📸 ${name}`);
}

async function visit(page, name, url, { click, before, after } = {}) {
  try {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    if (before) await before(page);
    if (click) { const btn = page.getByRole('button', { name: click }).first(); if (await btn.count()) await btn.click(); }
    await waitSettled(page);
    if (after) await after(page);
    await shot(page, name);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
    results.pages.push({ name, url, error: e.message.split('\n')[0] });
    try { await page.screenshot({ path: path.join(OUT, `${name}-ERROR.png`), fullPage: true }); } catch {}
  }
}

function parseSSE(body) {
  const msgs = body.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return msgs.find(m => m.type === 'done') || msgs.find(m => m.type === 'error') || null;
}

// expect: { status: [codes] } → recorded as PASS/FAIL in the summary.
async function api(ctx, label, url, opts = {}, expect = null) {
  let status = 0, body = null;
  try {
    const res = await ctx.request.fetch(BASE + url, opts);
    status = res.status();
    const txt = await res.text();
    try { body = JSON.parse(txt); } catch { body = txt.includes('data: ') ? parseSSE(txt) : txt.slice(0, 300); }
  } catch (e) { body = { error: e.message }; }
  results.api.push({ label, url, status, body });
  if (expect) {
    const ok = expect.status.includes(status);
    results.expectations.push({ label, expected: expect.status, got: status, ok });
  }
  return { status, body };
}

async function login(ctx, username) {
  const res = await ctx.request.post(BASE + '/api/login', { data: { username, password: 'x' } });
  const j = await res.json();
  console.log(`login ${username}: ${res.status()} isWarehouse=${j.isWarehouse} clientId=${j.clientId} clients=${(j.clients || []).length}`);
  return j;
}

function attachLogging(page, persona) {
  results.consoleErrors[persona] = [];
  results.failedRequests[persona] = [];
  page.on('console', m => { if (m.type() === 'error') results.consoleErrors[persona].push(`${page.url()} :: ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 400) results.failedRequests[persona].push(`${r.status()} ${r.url()}`); });
}

(async () => {
  const browser = await chromium.launch();

  // ── Warehouse persona ─────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await login(ctx, '__wh__');
    const page = await ctx.newPage();
    attachLogging(page, 'warehouse');
    await visit(page, 'wh-01-dashboard', '/app');
    await visit(page, 'wh-02-dashboard-client', '/app', { before: async p => { await p.selectOption('aside select', String(process.env.TEST_CLIENT_ID || '10')); await sleep(1500); } });
    await visit(page, 'wh-03-calendar', '/app/calendar');
    await visit(page, 'wh-04-fulfillment', '/app/operations/fulfillment', { click: /Run Report/ });
    await visit(page, 'wh-05-eod-despatch', '/app/operations/eod-despatch');
    await visit(page, 'wh-06-picklist', '/app/operations/pick-list', { before: async p => { if (ORDER) { await p.getByPlaceholder(/IN84815/).fill(ORDER); await p.getByRole('button', { name: /Build Pick List/ }).click(); } } });
    await visit(page, 'wh-07-replen', '/app/operations/replen');
    await visit(page, 'wh-08-inventory-planner', '/app/stock/inventory-planner', {
      before: async p => { await p.selectOption('aside select', String(process.env.TEST_CLIENT_ID || '10')); await sleep(2500); },
      after:  async p => { const row = p.locator('tbody tr').first(); if (await row.count()) { await row.click(); await sleep(2500); } },
    });
    await visit(page, 'wh-09-health-score', '/app/inventory/health-score', { click: /Run Report/ });
    await visit(page, 'wh-10-snapshot', '/app/inventory/snapshot', { click: /Run Report/ });
    await visit(page, 'wh-11-aging', '/app/inventory/aging', { click: /Run Report/ });
    await visit(page, 'wh-12-velocity', '/app/inventory/velocity', { click: /Run Report/ });
    await visit(page, 'wh-13-revenue-current', '/app/financial/profitability', { click: /Load Report/ });
    await visit(page, 'wh-14-revenue-may2026', '/app/financial/profitability', { before: async p => { await p.selectOption('main select', { label: 'May 2026' }).catch(() => {}); }, click: /Load Report/ });
    await visit(page, 'wh-15-best-sellers', '/app/analytics/best-sellers', { click: /Run Report/ });
    await visit(page, 'wh-16-sales-trend', '/app/analytics/sales-trend', { click: /Run Report/ });
    await visit(page, 'wh-17-returns-hub', '/app/operations/returns-hub');
    await visit(page, 'wh-18-help', '/app/help');
    const mpage = await ctx.newPage(); await mpage.setViewportSize({ width: 390, height: 844 });
    await visit(mpage, 'wh-19-mobile-dashboard', '/app');

    await api(ctx, 'wh dashboard (default 30d)', '/api/dashboard?warehouseId=3');
    await api(ctx, 'wh best-sellers May 2026 (all statuses)', '/api/report/best-sellers?warehouseId=3&dateFrom=2026-05-01&dateTo=2026-05-31&days=31&limit=3');
    await api(ctx, 'wh fulfillment May 2026', '/api/report/fulfillment?warehouseId=3&dateFrom=2026-05-01&dateTo=2026-05-31&slaDays=2');
    await api(ctx, 'wh profitability May 2026', '/api/report/profitability?warehouseId=3&from=2026-05-01&to=2026-05-31');
    await api(ctx, 'wh profitability current month', '/api/report/profitability?warehouseId=3');
    await api(ctx, 'wh sync status', '/api/sync/status');
    await ctx.close();
  }

  // ── Client persona ────────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await login(ctx, '__client__');
    const page = await ctx.newPage();
    attachLogging(page, 'client');
    await visit(page, 'cl-01-dashboard', '/app');
    await visit(page, 'cl-02-dashboard-90d', '/app', { click: /90 Days/ });
    await visit(page, 'cl-03-product-overview', '/app/stock/product-overview');
    await visit(page, 'cl-04-inventory-planner', '/app/stock/inventory-planner', { after: async p => { const row = p.locator('tbody tr').first(); if (await row.count()) { await row.click(); await sleep(2500); } } });
    await visit(page, 'cl-05-excess-stock', '/app/stock/excess');
    await visit(page, 'cl-06-book-return', '/app/returns/book', { before: async p => { await p.getByPlaceholder(/Order number/).fill('IN'); await p.getByRole('button', { name: 'Search' }).click(); await sleep(1500); } });
    await visit(page, 'cl-07-return-history', '/app/returns/history');
    await visit(page, 'cl-08-cost-breakdown-periods', '/app/invoice/overview');
    await visit(page, 'cl-09-cost-breakdown-may2026', '/app/invoice/overview', { before: async p => { await sleep(2500); const btn = p.locator('tr', { hasText: 'May 2026' }).getByRole('button', { name: /View/ }); if (await btn.count()) await btn.click(); } });
    await visit(page, 'cl-10-storage-calculator', '/app/invoice/storage');
    await visit(page, 'cl-11-health-score', '/app/inventory/health-score', { click: /Run Report/ });
    await visit(page, 'cl-12-best-sellers', '/app/analytics/best-sellers', { click: /Run Report/ });
    await visit(page, 'cl-13-help', '/app/help');
    await visit(page, 'cl-14-warehouse-route-blocked', '/app/operations/eod-despatch');

    // Security expectations (these FAIL on the v2 code and must PASS after Stage 0).
    await api(ctx, 'CLIENT orders/by-client', '/api/orders/by-client?warehouseId=3&dateFrom=2026-05-01&dateTo=2026-05-31', {}, { status: [403] });
    await api(ctx, 'CLIENT best-sellers clientId=6 (foreign tenant)', '/api/report/best-sellers?warehouseId=3&clientId=6&dateFrom=2026-05-01&dateTo=2026-05-31&days=31&limit=3', {}, { status: [403] });
    await api(ctx, 'CLIENT fulfillment clientId=6 (foreign tenant)', '/api/report/fulfillment?warehouseId=3&clientId=6&dateFrom=2026-05-01&dateTo=2026-05-31', {}, { status: [403] });
    await api(ctx, 'CLIENT best-sellers own', '/api/report/best-sellers?warehouseId=3&dateFrom=2026-05-01&dateTo=2026-05-31&days=31&limit=3', {}, { status: [200] });
    await api(ctx, 'CLIENT products/overview?clientId=6', '/api/products/overview?clientId=6', {}, { status: [200, 403] });
    await api(ctx, 'CLIENT sync/status', '/api/sync/status', {}, { status: [403] });
    await api(ctx, 'CLIENT POST sync', '/api/sync', { method: 'POST', data: { full: true } }, { status: [403] });
    await api(ctx, 'CLIENT POST sync/reconcile', '/api/sync/reconcile', { method: 'POST' }, { status: [403] });
    await api(ctx, 'CLIENT PUT forecasting/config', '/api/forecasting/config', { method: 'PUT', data: { settings: { serviceLevel: 0.9 } } }, { status: [403] });
    await api(ctx, 'CLIENT dashboard clientId=6', '/api/dashboard?warehouseId=3&clientId=6', {}, { status: [200, 403] });
    await ctx.close();
  }

  // ── Subscription modules ──────────────────────────────────────────────────
  // Switches modules off for the test client via the warehouse admin API,
  // checks the server blocks and the UI shows the add-on / subscription pages,
  // then restores the original entitlements.
  {
    const CID = parseInt(process.env.TEST_CLIENT_ID || '10');
    const wh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cl = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await login(wh, '__wh__');
    await login(cl, '__client__');
    // Case-insensitive: innerText follows CSS text-transform (e.g. uppercase tile labels).
    const expectText = (label, text, needle) => { const ok = text.toLowerCase().includes(needle.toLowerCase()); results.expectations.push({ label, expected: [`text "${needle}"`], got: ok ? 'present' : 'absent', ok }); };
    const pageText = async (ctx, name, url) => {
      const p = await ctx.newPage();
      await visit(p, name, url);
      const t = await p.evaluate(() => document.body.innerText).catch(() => '');
      await p.close();
      return t;
    };

    const overview = await api(wh, 'WH GET admin/subscriptions', '/api/admin/subscriptions', {}, { status: [200] });
    const clients = overview.body?.clients || [];
    // Seeded clients keep Basic + Forecasting; clients that appeared later get the default (Basic).
    const seeded = clients.filter(c => c.configured), later = clients.filter(c => !c.configured);
    const allGranted = seeded.length > 0 && seeded.every(c => c.effective.includes('core') && c.effective.includes('forecasting')) && later.every(c => c.effective.includes('core'));
    results.expectations.push({ label: `seeded clients have Basic + Forecasting (${seeded.length}); later clients have Basic (${later.length})`, expected: ['all'], got: allGranted ? 'all' : 'missing', ok: allGranted });
    const original = clients.find(c => c.id === CID)?.subscriptions || {};
    const put = (module, status) => api(wh, `WH set ${module}=${status}`, '/api/admin/subscriptions', { method: 'PUT', data: { clientId: CID, module, status } }, { status: [200] });

    await api(cl, 'CLIENT forecasting with module', '/api/forecasting/config', {}, { status: [200] });
    await api(cl, 'CLIENT PUT admin/subscriptions', '/api/admin/subscriptions', { method: 'PUT', data: { clientId: CID, module: 'bbe', status: 'active' } }, { status: [403] });
    await api(cl, 'CLIENT BBE without module', '/api/stock/bbe', {}, { status: [403] });

    await put('forecasting', 'cancelled');
    await api(cl, 'CLIENT forecasting after switch-off', '/api/forecasting/config', {}, { status: [403] });
    expectText('CLIENT Inventory Planner shows add-on page', await pageText(cl, 'cl-15-planner-locked', '/app/stock/inventory-planner'), 'is an add-on');

    await put('core', 'cancelled');
    await api(cl, 'CLIENT data route without Basic', '/api/report/best-sellers?warehouseId=3&dateFrom=2026-05-01&dateTo=2026-05-31', {}, { status: [403] });
    expectText('CLIENT without Basic sees subscription screen', await pageText(cl, 'cl-16-no-subscription', '/app'), 'Subscription required');

    for (const m of ['core', 'forecasting']) {
      const o = original[m] || { status: 'active' };
      await api(wh, `WH restore ${m}`, '/api/admin/subscriptions', { method: 'PUT', data: { clientId: CID, module: m, status: o.status, ends_at: o.ends_at, price_pence: o.price_pence, notes: o.notes } }, { status: [200] });
    }
    await api(cl, 'CLIENT forecasting after restore', '/api/forecasting/config', {}, { status: [200] });
    expectText('WH admin page lists clients', await pageText(wh, 'wh-20-client-subscriptions', '/app/admin/subscriptions'), 'Client Subscriptions');

    // BBE + Quarantine reports with the modules switched on for the test client.
    await put('bbe', 'active'); await put('quarantine', 'active');
    const bb = await api(cl, 'CLIENT BBE with module', '/api/stock/bbe', {}, { status: [200] });
    const bbRows = bb.body?.rows || [];
    results.expectations.push({ label: `CLIENT BBE rows are own client only (${bbRows.length} rows)`, expected: ['own'], got: bbRows.every(r => r.clientId === CID) ? 'own' : 'foreign', ok: bbRows.every(r => r.clientId === CID) });
    await api(cl, 'CLIENT BBE foreign client', '/api/stock/bbe?clientId=6', {}, { status: [403] });
    const qr = await api(cl, 'CLIENT quarantine with module', '/api/stock/quarantine', {}, { status: [200] });
    results.expectations.push({ label: `CLIENT quarantine rows are own client only (${(qr.body?.rows || []).length} rows)`, expected: ['own'], got: (qr.body?.rows || []).every(r => r.clientId === CID) ? 'own' : 'foreign', ok: (qr.body?.rows || []).every(r => r.clientId === CID) });
    await api(cl, 'CLIENT quarantine foreign client', '/api/stock/quarantine?clientId=6', {}, { status: [403] });
    const prevWindow = bb.body?.warningDays ?? 90;
    await api(cl, 'CLIENT BBE warning window save', '/api/stock/bbe/settings', { method: 'PUT', data: { warningDays: 120 } }, { status: [200] });
    expectText('CLIENT BBE page renders bands', await pageText(cl, 'cl-17-bbe', '/app/stock/bbe'), 'Expired');
    expectText('CLIENT quarantine page renders', await pageText(cl, 'cl-18-quarantine', '/app/stock/quarantine'), 'Units in quarantine');
    await api(cl, 'CLIENT BBE warning window restore', '/api/stock/bbe/settings', { method: 'PUT', data: { warningDays: prevWindow } }, { status: [200] });
    for (const m of ['bbe', 'quarantine']) {
      const o = original[m] || { status: 'cancelled' };
      await api(wh, `WH restore ${m}`, '/api/admin/subscriptions', { method: 'PUT', data: { clientId: CID, module: m, status: o.status, ends_at: o.ends_at, price_pence: o.price_pence, notes: o.notes } }, { status: [200] });
    }
    expectText('WH BBE page (all clients)', await pageText(wh, 'wh-22-bbe-all', '/app/stock/bbe'), 'all clients');
    expectText('WH quarantine page (all clients)', await pageText(wh, 'wh-23-quarantine-all', '/app/stock/quarantine'), 'all clients');

    // Pick list: product names filled, and a long order prints over several pages.
    const longOrder = process.env.LONG_ORDER || 'AM3372';
    const pl = await api(wh, `WH picklist ${longOrder}`, `/api/picklist?orderNumber=${encodeURIComponent(longOrder)}`, {}, { status: [200] });
    const plLines = pl.body?.lines || [];
    const named = plLines.filter(l => l.name).length;
    results.expectations.push({ label: `pick list names filled (${named}/${plLines.length})`, expected: ['all'], got: plLines.length && named === plLines.length ? 'all' : 'missing', ok: plLines.length > 0 && named === plLines.length });
    const pp = await wh.newPage();
    await pp.goto(BASE + '/app/operations/pick-list', { waitUntil: 'domcontentloaded' }); await sleep(1200);
    await pp.getByPlaceholder(/IN84815/).fill(longOrder); await pp.getByRole('button', { name: /Build Pick List/ }).click(); await waitSettled(pp);
    const pdf = await pp.pdf({ format: 'A4' });
    fs.writeFileSync(path.join(OUT, 'wh-21-picklist-print.pdf'), pdf);
    const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    results.expectations.push({ label: `pick list ${longOrder} prints on several pages (${plLines.length} lines)`, expected: ['>1 page'], got: `${pdfPages} pages`, ok: pdfPages > 1 });
    await pp.close();
    await wh.close(); await cl.close();
  }

  // ── Invoice Audit: owner-only staff permission ────────────────────────────
  {
    const own = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const wh  = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cl  = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await login(own, '__owner__'); await login(wh, '__wh__'); await login(cl, '__client__');
    const textOf = async (ctx, name, url) => { const p = await ctx.newPage(); await visit(p, name, url); const t = await p.evaluate(() => document.body.innerText).catch(() => ''); await p.close(); return t.toLowerCase(); };
    const expectIn = (label, text, needle, want = true) => { const has = text.includes(needle.toLowerCase()); results.expectations.push({ label, expected: [want ? `text "${needle}"` : `no "${needle}"`], got: has ? 'present' : 'absent', ok: has === want }); };

    const meO = await api(own, 'OWNER /api/me', '/api/me', {}, { status: [200] });
    results.expectations.push({ label: 'OWNER holds invoice_audit and is owner', expected: ['yes'], got: meO.body?.isOwner && meO.body?.permissions?.includes('invoice_audit') ? 'yes' : 'no', ok: !!(meO.body?.isOwner && meO.body?.permissions?.includes('invoice_audit')) });
    const ov = await api(own, 'OWNER audit overview', '/api/audit/overview?from=2026-08&to=2026-10', {}, { status: [200] });
    await api(own, 'OWNER audit coverage', '/api/audit/coverage?from=2026-08&to=2026-10', {}, { status: [200] });
    await api(own, 'OWNER audit access panel', '/api/audit/access', {}, { status: [200] });
    await api(wh, 'WH audit overview without grant', '/api/audit/overview', {}, { status: [403] });
    await api(wh, 'WH audit invoice without grant', '/api/audit/invoices/337', {}, { status: [403] });
    await api(wh, 'WH audit client rates without grant', '/api/audit/clients/10', {}, { status: [403] });
    expectIn('WH menu hides Invoice Audit without grant', await textOf(wh, 'wh-27-no-audit', '/app'), 'Invoice Audit', false);

    await api(own, 'OWNER grant __wh__', '/api/audit/access', { method: 'POST', data: { username: '__WH__ ' } }, { status: [200] });
    await api(wh, 'WH audit overview after grant', '/api/audit/overview', {}, { status: [200] });
    await api(wh, 'WH manage access after grant (owner only)', '/api/audit/access', {}, { status: [403] });
    await api(wh, 'WH grant others (owner only)', '/api/audit/access', { method: 'POST', data: { username: 'someone@example.com' } }, { status: [403] });
    expectIn('WH menu shows Invoice Audit after grant', await textOf(wh, 'wh-28-audit-granted', '/app'), 'Invoice Audit');

    await api(own, 'OWNER grant __client__', '/api/audit/access', { method: 'POST', data: { username: '__client__' } }, { status: [200] });
    await api(cl, 'CLIENT audit overview even with a grant row', '/api/audit/overview', {}, { status: [403] });
    await api(own, 'OWNER revoke __client__', '/api/audit/access?username=__client__', { method: 'DELETE' }, { status: [200] });

    const invId = (ov.body?.invoices || []).find(i => i.orderLines > 0)?.id || 337;
    // Expected-vs-billed (I2): rates page, price confirmation round trip.
    const rates = await api(own, 'OWNER client rates (Serendipity)', '/api/audit/clients/10', {}, { status: [200] });
    results.expectations.push({ label: `engine reproduces Serendipity picking ≥ 90% (${rates.body?.accuracy?.picking?.matched}/${rates.body?.accuracy?.picking?.total})`, expected: ['≥ 90%'],
      got: rates.body?.accuracy?.picking ? `${Math.round(100 * rates.body.accuracy.picking.matched / Math.max(1, rates.body.accuracy.picking.total))}%` : 'none',
      ok: !!rates.body?.accuracy?.picking && rates.body.accuracy.picking.matched / Math.max(1, rates.body.accuracy.picking.total) >= 0.9 });
    await api(own, 'OWNER confirm rework price', '/api/audit/clients/10/prices', { method: 'PUT', data: { itemKey: 'rule:SW-BOX', price: 0.14, effectiveFrom: '2099-01-01', note: 'qa' } }, { status: [200] });
    const after = await api(own, 'OWNER client rates after confirm', '/api/audit/clients/10', {}, { status: [200] });
    const sw = (after.body?.reworkItems || []).find(i => i.key === 'rule:SW-BOX');
    results.expectations.push({ label: 'confirmed price is listed', expected: ['yes'], got: sw?.confirmed?.some(c => c.effective_from === '2099-01-01') ? 'yes' : 'no', ok: !!sw?.confirmed?.some(c => c.effective_from === '2099-01-01') });
    await api(own, 'OWNER bad price rejected', '/api/audit/clients/10/prices', { method: 'PUT', data: { itemKey: 'rule:SW-BOX', price: -1, effectiveFrom: '2099-01-01' } }, { status: [400] });
    await api(own, 'OWNER remove confirmed price', '/api/audit/clients/10/prices?itemKey=rule:SW-BOX&effectiveFrom=2099-01-01', { method: 'DELETE' }, { status: [200] });
    expectIn('OWNER rates & rules page', await textOf(own, 'wh-29-audit-client', '/app/audit/client/10'), 'Rework items and prices');
    expectIn('OWNER audit overview page', await textOf(own, 'wh-24-audit-overview', '/app/audit'), 'Despatched but never billed');
    const invText = await textOf(own, 'wh-25-audit-invoice', `/app/audit/invoice/${invId}`);
    expectIn(`OWNER invoice audit page (#${invId})`, invText, 'Invoice totals vs its lines');
    expectIn('OWNER invoice page shows expected vs billed', invText, 'Possibly undercharged');
    expectIn('OWNER access page', await textOf(own, 'wh-26-audit-access', '/app/audit/access'), 'Who can see Invoice Audit');

    await api(own, 'OWNER revoke __wh__', '/api/audit/access?username=__wh__', { method: 'DELETE' }, { status: [200] });
    await api(wh, 'WH audit overview after revoke', '/api/audit/overview', {}, { status: [403] });
    await own.close(); await wh.close(); await cl.close();
  }

  // ── Unauthenticated ───────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext();
    await api(ctx, 'ANON /api/me', '/api/me', {}, { status: [401] });
    await api(ctx, 'ANON /proxy relay (must not exist)', '/proxy/api/Warehouse', { headers: { 'ms-apikey': 'bogus-key-000' } }, { status: [404] });
    await api(ctx, 'ANON /api/report/best-sellers', '/api/report/best-sellers?warehouseId=3', {}, { status: [401] });
    await api(ctx, 'ANON /api/sync/status', '/api/sync/status', {}, { status: [401] });
    await api(ctx, 'ANON POST /api/sync/reconcile', '/api/sync/reconcile', { method: 'POST' }, { status: [401] });
    await api(ctx, 'ANON GET /api/admin/subscriptions', '/api/admin/subscriptions', {}, { status: [401] });
    await api(ctx, 'ANON GET /api/audit/overview', '/api/audit/overview', {}, { status: [401] });
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));

  console.log('\n=== SECURITY EXPECTATIONS ===');
  let fails = 0;
  for (const e of results.expectations) { if (!e.ok) fails++; console.log(`${e.ok ? 'PASS' : 'FAIL'}  ${e.label}  expected ${e.expected.join('/')} got ${e.got}`); }
  console.log(`\npages: ${results.pages.length}  api checks: ${results.api.length}  console errors: ${Object.values(results.consoleErrors).flat().length}  expectation failures: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
