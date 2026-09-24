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
    await api(ctx, 'CLIENT PUT forecasting/config', '/api/forecasting/config', { method: 'PUT', data: { settings: { serviceLevel: 0.9 } } }, { status: [403] });
    await api(ctx, 'CLIENT dashboard clientId=6', '/api/dashboard?warehouseId=3&clientId=6', {}, { status: [200, 403] });
    await ctx.close();
  }

  // ── Unauthenticated ───────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext();
    await api(ctx, 'ANON /api/me', '/api/me', {}, { status: [401] });
    await api(ctx, 'ANON /proxy relay (must not exist)', '/proxy/api/Warehouse', { headers: { 'ms-apikey': 'bogus-key-000' } }, { status: [404] });
    await api(ctx, 'ANON /api/report/best-sellers', '/api/report/best-sellers?warehouseId=3', {}, { status: [401] });
    await api(ctx, 'ANON /api/sync/status', '/api/sync/status', {}, { status: [401] });
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
