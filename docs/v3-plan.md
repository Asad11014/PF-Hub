# ARAnalytics v3 — Review findings and staged rebuild plan

Prepared 2026-09-23 by Claude (Fable 5.1) after a full code review, a database audit of the local snapshot, a read-only probe of the live Mintsoft API, and a Playwright walkthrough of every page as both a warehouse user and a client user. This document is the source of truth for the rebuild. It is executed **one stage per prompt**; a stage is finished only when every item in its Definition of Done (DoD) is checked and the owner has said "go" at the gate.

---

## 0. How to use this document

### 0.1 Gating rules

1. Each stage (S0 … S9) is started by pasting its **Stage prompt** (§5) into a fresh Claude session. The executing model reads §0, §4 and its own stage section, plus the files the stage lists. It does not read the whole plan unless it needs to.
2. The executor does only the work items of that stage, runs the DoD checks, appends a short entry to the **Stage log** (§6.C), and stops. It never rolls into the next stage.
3. A stage is closed by the owner at the **Gate** after reviewing the DoD evidence. The next stage's prompt is only issued after that.
4. Work happens on a branch named `v3/sN-short-name`. **`main` is production: every push to `main` deploys on Render.** Merging to `main` is always the last DoD item and only after the owner's explicit go.
5. Additive database migrations only (new tables/columns, backfills). Nothing destructive before S9. Every migration is idempotent and runs from `server/schema.js` on boot, as today.
6. Findings are referenced by ID (F-01 … F-40, §3). Every work item names the findings it closes, so §6.C can track closure.

### 0.2 Model routing (token discipline)

| Stage | Executor | Reviewer / second opinion | Sonnet subagents for |
|---|---|---|---|
| S0 Security lockdown + hotfixes | **Opus 5.5** | — | — |
| S1 Sync stop-the-bleed patch | **Opus 5.5** | — | — |
| S2 Harness, CI, metric spec, dead code | **Sonnet 5** | Opus 5.5 reviews `docs/metrics.md` only | — |
| S3 Sync engine v2 | **Opus 5.5** | Fable 5.1 design review at gate (optional) | entity mappers, unit tests, admin sync page |
| S4 Identity, sessions, tenancy | **Opus 5.5** | — | UI for "account not linked", admin client-user mapping table |
| S5 Reports & dashboards correctness | **Sonnet 5** | Opus 5.5 reviews parity table | — |
| S6 Financial module | **Sonnet 5** | Opus 5.5 reviews reconciliation | — |
| S7 Forecasting v2 | **Opus 5.5** (Fable 5.1 if budget allows for §4.7 design) | Fable 5.1 backtest review | UI, tests, explanations panel |
| S8 Operations, observability, deploy hygiene | **Sonnet 5** | — | — |
| S9 Independent audit & release | **Fable 5.1** | — | fix-ups |

Rules that keep token spend low:

- The stage prompt lists exactly which files to read. Do not re-read the whole codebase; `docs/v3-plan.md` §3 already contains the evidence.
- Mechanical, well-specified work (mappers, tests from a spec, UI tables) goes to Sonnet 5 subagents with the spec pasted verbatim. Judgement work (security boundaries, sync semantics, forecasting maths) stays with the executor.
- Run `node --check`, unit tests and the harness only at the points the DoD asks for, not after every edit.
- Do not run full Mintsoft syncs locally except where a DoD says so; use `tools/qa/api-probe.js` (about 15 calls) for API questions.

### 0.3 Immediate manual actions for the owner (before S0)

1. Optional hygiene only: `.claude/settings.json` (git-ignored) contains a Mintsoft key, the Render Postgres URL and a Neon URL inside permission allow-list entries. They are not exposed by the repo; S0 replaces the entries with wildcard patterns so the file stops carrying them. Rotation is at the owner's discretion.
2. Confirm which Mintsoft key `MINTSOFT_ADMIN_KEY` on Render is (it must be a permanent admin key, not a 24-hour session key; the nightly cron depends on it).
3. Decide whether a **Render Cron Job** (separate service, runs `node server/sync/cli.js`) is acceptable for S3; otherwise the in-process scheduler with a database lock is used (works, but a deploy in the middle of a sync interrupts it).
4. Optional but recommended: create a free Neon database as a **staging** `DATABASE_URL` for CI and for S3's first full v2 sync rehearsal.

---

## 1. What was reviewed and how

| Evidence | Method |
|---|---|
| Server (`server/**`, 4,900 lines) and client (`client/src/**`, 6,300 lines) | Read in full |
| Local database `pf_analytics` (snapshot last synced 2026-06-24) | `tools/qa/diag.sql` |
| Mintsoft API behaviour | `tools/qa/api-probe.js` (about 20 read-only GETs) against `docs/mintsoft-api-swagger.json` (163 paths) |
| Every page, both personas, desktop + mobile | `tools/qa/launcher.js` + `tools/qa/screens.js` (41 screenshots, 30 API checks) |
| Production | Response headers and the `/proxy` relay checked with anonymous GETs against hub.premiumfulfilment.co.uk |

Reference numbers from the local snapshot used for parity checks are in §6.B.

---

## 2. Architecture as found

- **Runtime**: single Node 22 process (`server/index.js`, hand-rolled router, no framework), serving the Vite/React SPA from `client/dist` and JSON/SSE APIs. Postgres via `pg`. Hosted on Render; Cloudflare in front. `render.yaml` in the repo describes only the public demo.
- **Auth**: `POST /api/login` forwards credentials to Mintsoft `/api/Auth`, keeps the returned Mintsoft key in an in-memory session map, and decides "warehouse vs client" by whether `/api/Client` returns 200. Sessions vanish on every deploy.
- **Data**: `server/sync.js` copies Mintsoft entities into Postgres (single-tenant schema in `server/schema.js`; `database/schema.sql` is an obsolete multi-tenant design). A full sync runs on first login; an "incremental" sync runs on every login, nightly at midnight, and on demand. Reports read the database through `server/reports/db-base.js`; three features (End-of-Day Despatch, Replen, Pick List) and the client cost-breakdown detail call Mintsoft live.
- **Forecasting**: `server/forecasting/*` builds weekly demand per SKU from `order_items`, classifies (ADI/CV²), picks a method by rolling one-step backtest, computes safety stock and reorder plans, and stores runs.

---

## 3. Findings register

Severity: **S1** must fix before anything else · **S2** fix in the rebuild · **S3** improvement.

### 3.1 Security

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F-01 | S1 | **Cross-tenant data access in every report.** A client user can read any other client's data by adding `clientId=<other>` to `/api/report/*`. `parseReportParams` trusts the URL value and `resolveIds` never checks it against the session. | Harness: logged in as client 10, `best-sellers?clientId=6` returned Mokee's 258 orders and SKUs; `fulfillment?clientId=6` likewise. |
| F-02 | S1 | `/api/orders/by-client` has no tenant scope: any client sees every client's name and order count. | Harness: client 10 received the full 14-row list. |
| F-03 | S1 | **Unauthenticated open relay** `/proxy/*` forwards any request with any `ms-apikey` header to Mintsoft. The SPA no longer uses it (dead code) but it is live in production. | Anonymous `GET /proxy/api/Warehouse` on production returns Mintsoft's 401, proving the relay works. |
| F-04 | S1 | Clients can start database syncs (`POST /api/sync` returns 200 for a client) and **every login (client or warehouse) starts a sync** with that user's key, writing into the shared tables and hammering the API. | `server/index.js:125`, `server/auth.js:244`, harness. |
| F-05 | S3 | Credentials embedded in `.claude/settings.json` allow-list entries (Mintsoft key, Render DB URL with password, Neon URL with password). Git-ignored, so not a repository leak; local hygiene only. | File inspection; `.claude/` is in `.gitignore`. |
| F-06 | S2 | Sessions in memory (lost on every deploy, single instance only); cookie lacks `Secure`; cookie parsed by regex; no rate limit on `/api/login` (credential-stuffing relay to Mintsoft); `Access-Control-Allow-Origin: *`; no HSTS/CSP/nosniff/frame headers. | `server/auth.js`, production headers. |
| F-07 | S1 | Client identity is guessed: `/api/ClientUser/Current` **does not exist** in the Mintsoft API (absent from the swagger), so `clientId` is inferred from the first stock row. When that fails `clientId` is null and several routes **widen to the whole warehouse** instead of denying (reports via `resolveIds`, `/api/products/overview`, `/api/orders/search`). | `server/auth.js:128-164`, `server/index.js:328-334, 371-377`. |
| F-08 | S3 | `/api/sync/status` exposes internal job details (key prefix, error strings) to clients. | Harness. |
| F-09 | S3 | Return label uploads are stored as base64 in JSONB (up to 5 MB each) and served inline; fine functionally, but it bloats the database and has no content-type validation. | `server/returns.js`, `ReturnsHub.jsx`. |
| F-10 | S2 | `mintsoftGet` has no timeout, retry or backoff; a hung socket hangs a sync forever. | `server/mintsoft.js`. |

### 3.2 Sync and data integrity

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F-11 | S1 | **`SinceOrderDate` is not a Mintsoft parameter.** Mintsoft ignores it, so the "24-month" full sync, the "120-day items" pass and the "7-day" incremental **all fetch every order ever (13,690) and then call `/api/Order/{id}/Items` once per order.** This is why nightly jobs run 56–86 minutes and die with `ECONNRESET`, and why a login-triggered "incremental" synced 19,048 records in 29 minutes. The documented `SinceDate`, `SinceLastUpdated` and `IncludeOrderItems=true` all work. | `api-probe`: `SinceOrderDate=2026-09-20` returned orders from 2025-07-21; `SinceDate` returned only 2026-09-20+; `IncludeOrderItems` returned items inline. `sync_jobs` 46, 47, 48, 51. |
| F-12 | S1 | Because the orders step exhausts the connection, the later steps (**ASNs, accruals**) fail every night → current-month revenue accruals are stale or missing. This is the direct cause of "revenue breakdown not working for recent months". | `sync_jobs` 47/48/51 errors: `ASNs: read ECONNRESET \| Accruals: read ECONNRESET`. |
| F-13 | S1 | **Clients are only synced by a full sync.** Mintsoft now has 16 clients (ids 30–33 are new); the database has 14. Orders, invoices and products for unknown clients get `client_id = NULL` (the `(SELECT id FROM clients …)` subselect) and vanish from every per-client view. | 115 orders and 11 invoices (about £9.5k, Dec-2025 → Apr-2026) already have NULL client. |
| F-14 | S1 | **Churned clients disappear from Revenue Breakdown** because it iterates the live `session.clients` list. May 2026 shows £16,234.20 across 11 clients; the database holds 12 May invoices totalling £22,319.14 (Mokee's £6,084.94 is dropped because Mokee is no longer in `/api/Client`). | Harness vs `diag.sql`. |
| F-15 | S2 | Incremental step order is stock **before** products, so a new product's stock row violates the FK and **aborts the whole stock step**. | `sync_jobs` 49: `violates foreign key constraint "product_stock_levels_pro…"`. |
| F-16 | S2 | No job lock or heartbeat: login, cron and manual syncs run concurrently; 9 zombie jobs are stuck in `running` since June. `getSyncStatus` always returns `lastSyncAt: null` (nothing ever inserts into `user_sessions`), so the sidebar shows **"Initial Sync"** to every warehouse user, which triggers a *full* sync. | `diag.sql`; screenshot `wh-01-dashboard`. |
| F-17 | S2 | One SQL statement per record; one `GET /api/ASN/{id}` per ASN although `IncludeASNItems=true` exists; products fetched once per warehouse although `/api/Product/List` ignores `WarehouseId`; `Product/UpdatedSince` called with the wrong parameters → 400 → full catalogue re-pulled every night. | `api-probe` (400 reproduced); `server/sync.js`. |
| F-18 | S2 | No `SinceLastUpdated` usage, so status changes, despatches and cancellations on orders outside the crawl window are never refreshed (today they are, only by accident of F-11). | Design. |
| F-19 | S2 | Order items removed from an order are never deleted; orders deleted in Mintsoft are never removed; cancelled orders are counted as sales everywhere. | `db-base.getOrders` has no status default; May 2026: 13 cancelled orders / 28 units counted. |
| F-20 | S2 | **Time zones.** Mintsoft returns UK local time without an offset (`DespatchDate 12:44` when UTC was 11:44). `new Date(str)` parses it in the server's zone (UTC on Render, BST locally), so the same record differs by an hour between environments, `::date` bucketing drifts at midnight, and month-end invoices dated `23:59` sit one hour from the boundary. Local DB is Europe/London; Render is UTC. | `api-probe` timestamps vs production `Date` header; `sync.js ts()`. |
| F-21 | S2 | Invoices have no `period_month`; attribution is `DATE_TRUNC('month', invoice_date)` (TZ-sensitive). Nine invoices are dated the 1st, and ad-hoc invoices (e.g. ids 316/317 dated 17/18 Sep for client 30) land in whichever month they were raised. | `diag.sql` day-of-month distribution. |
| F-22 | S2 | `invoice_accruals` holds only the current month and is overwritten in place, so on the 1st of each month "last month" is blank until the confirmed invoice is synced (days later, and only if the invoice step succeeds). | `db-base.getInvoiceForClient`, `sync.syncAccruals`. |
| F-23 | S1 | **Data freshness is invisible.** Dashboards say "Data from just now" (cache time) while the data is months old, and every report silently shows zeros when the window has no synced data. | All dashboard screenshots on the June snapshot show 0 orders, 0 units, "146 dead SKUs". |

### 3.3 Report correctness

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F-24 | S2 | Mixed date bases on one screen: client KPI cards are despatch-based (`computeClientSummary`), the charts and Top 10 are order-date-based, weekly trend uses `DespatchDate \|\| OrderDate`. Cards and charts disagree by design. | `server/reports/dashboard.js`. |
| F-25 | S2 | Cancelled orders included in best-sellers, velocity, aging, snapshot, health, dashboard. | `best-sellers?statuses=Cancelled` returns 13 orders for May. |
| F-26 | S2 | Fulfillment: "same day" = floor of raw millisecond difference (23:00 → 09:00 next day counts as same day); no business days; window by order date so late-month orders despatched next month count as not despatched. | `server/reports/operations/fulfillment.js:65-74`. |
| F-27 | S3 | Product names come only from stock rows (`getSkuNames`), so SKUs without a stock row show blank names. | `db-base.getSkuNames`. |
| F-28 | S1 | Client Cost Breakdown shows **"Invalid Date"**: `despatch_date::date` serialises as an ISO datetime and the UI appends `T00:00:00`. | Screenshot `cl-10-cost-breakdown-may2026`. |
| F-29 | S2 | Client per-order costs are fetched live from Mintsoft on every view with the admin key (`/api/Accounting/Invoice/{id}/Orders`), never cached, and silently empty when the key is unset. | `server/reports/financial/profitability.js:127-135`. |
| F-30 | S3 | All aggregation happens in JavaScript over full order + item payloads (`json_agg` per order); the dashboard cache is per-process, 30 minutes, never invalidated by a sync. | `db-base.getOrders`, `dashboard.js`. |
| F-31 | S2 | Snapshot counts 1,836 of 2,472 SKUs "out of stock" (includes discontinued and never-stocked SKUs); health/aging/excess classify everything as dead when the sales window has no data. | Screenshots `wh-13-snapshot`, `cl-06-excess-stock`. |
| F-32 | S3 | Warehouse dashboard revenue panel silently falls back to "last confirmed invoice" per client when accruals are missing. | `db-base.getCurrentAccrualsMap`. |

### 3.4 Forecasting module

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F-33 | S2 | Headline "Forecast accuracy 87%" is `horizonWmapeWithEvents`, which treats de-peaked exceptional orders as *known* even when no demand events have been entered. The honest baseline number for the same run is 80% (client 10) / 75% (client 15). | `engine.js:230-238`, `InventoryPlanner.jsx:92`, `forecast_runs.stats`. |
| F-34 | S2 | No stockout censoring (plan §4.3 unimplemented): weeks with zero stock count as zero demand, so SKUs that stocked out are under-forecast and under-ordered. | `demand.js`. |
| F-35 | S2 | Bundle SKUs are forecast as their own SKU; component demand is not exploded, so components are under-forecast (102 bundles in catalogue). | `products.bundle`, `demand.js`. |
| F-36 | S2 | Method selection uses one-step-ahead WMAPE although decisions depend on the lead-time horizon; seasonal methods need 104 weeks so they never activate. | `select.js`. |
| F-37 | S2 | `forecast_accuracy` is wiped on every run, so there is no live (ex-post) accuracy; runs are manual only. | `engine.js:199`. |
| F-38 | S3 | Lead times are manual; ASN history (`warehouse_booked_date` → `booked_in_date`) is unused. | Schema. |
| F-39 | S3 | No stock history, so fill rate / service level (plan §8.3) and "weeks of cover over time" cannot be measured. | Schema. |

### 3.5 Code health and operations

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F-40 | S2 | Dead code and drift: `server/proxy.js`; `server/reports/{best-sellers,sales-trend,overstock,dead-stock,replenishment}.js`; `client/reports/*`; `client/app/index.html`; `client/login.html`; obsolete `database/schema.sql`; `client/dist` committed; hard-coded status maps duplicating synced lookup tables; no tests, lint or CI; `npm run build` installs dev dependencies in production; 1.02 MB JS bundle with no code-splitting; `.env.example` missing `RESEND_API_KEY`, `RETURNS_*`, `SEO_*`; no README/runbook; personal e-mail hard-coded as default notification recipient; push to `main` deploys with no smoke test. | Repo inspection, `vite build` output. |

Verified as working correctly: End-of-Day Despatch (live), Replen lists (live), Pick List (live), Storage Calculator, Product Overview, Returns flow, Calendar, forecasting run performance (306 SKUs in 0.2 s), anonymous access to APIs (401), demo login disabled when `DEMO_MODE` is off, warehouse-only routes redirect clients in the UI.

---

## 4. Target architecture (v3)

### 4.1 Principles

1. **Mintsoft is the source of truth; the database is a verified cache.** Every synced entity carries a cursor, a row count and a last-success time, and a weekly reconcile proves the cache matches the API.
2. **One key syncs.** Only the admin key writes to the database, on a schedule. User keys are used only to prove identity and for the three live tools.
3. **Tenancy is enforced in one place.** Every request resolves to a `scope` object; every query takes the scope; a client can never widen it.
4. **Every number has a definition** (`docs/metrics.md`) and every screen says which definition and which data timestamp it uses.
5. **Additive changes, feature flags, no destructive migrations** until the audit stage.

### 4.2 Sync engine v2 (`server/sync/`)

- `http.js` — Mintsoft client with 30 s timeout, retry with exponential backoff on 429/5xx/`ECONNRESET`, concurrency limiter (default 3), per-run call counter, structured request log.
- `state.js` — `sync_state(entity PK, cursor TIMESTAMPTZ, last_success_at, last_run_id, rows_last_run)`; `sync_jobs` gains `heartbeat_at`, `steps JSONB`, `api_calls INT`; jobs whose heartbeat is older than 10 min are marked `abandoned`; `pg_try_advisory_lock(hashtext('sync'))` guarantees one job at a time.
- Entity syncers, each `sync<Entity>(ctx)` returning `{ fetched, upserted, deleted, apiCalls }`:
  - **reference** (statuses, channels, couriers): nightly.
  - **warehouses, clients**: nightly; clients never deleted, `active=false` when absent from `/api/Client`; any unknown `ClientId` seen on an order/invoice/product gets a placeholder row (`name='Client #id'`, `active=false`) so nothing is ever NULL.
  - **products**: `GET /api/Product/List?SinceLastUpdated=<cursor−2h>` nightly, full catalogue weekly; bundle components via `/api/Product/{id}/Bundle` into `product_bundles`.
  - **stock**: `GET /api/Product/StockLevels?WarehouseId=` (one call, full replace) hourly; plus one row per product per day into `stock_snapshots(date, product_id, warehouse_id, client_id, on_hand, allocated, available)`.
  - **orders**: `GET /api/Order/List?WarehouseId=&SinceLastUpdated=<cursor−2h>&IncludeOrderItems=true&Limit=100&PageNo=n` hourly; items replaced as a set per order; bulk multi-row upserts (100 rows per statement) inside one transaction per page; full backfill by `SinceDate` month windows.
  - **ASNs**: `GET /api/ASN/List?WarehouseId=&SinceLastUpdated=&IncludeASNItems=true` hourly.
  - **invoices**: `GET /api/Accounting/Invoice/List?SinceDate=<cursor−7d>` nightly; `period_month` derived from `Name` ("May 2026") falling back to `Date` in Europe/London; `is_adhoc` when the date is not month-end; per-invoice detail (`/{id}/Orders`, `/{id}/GoodsIn`, `/{id}/Returns`, `/{id}/Other`, `/{id}/Collections`) fetched **once** when an invoice first appears into `invoice_orders` and `invoice_lines`.
  - **accruals**: `GetUnconfirmedInvoiceSummary` for **active** clients nightly into `invoice_accruals(client_id, period_month, …, snapshot_at)`; rows for past months are frozen (never overwritten) so "last month" always has a value; `GetUnconfirmedInvoiceStorageCosts` monthly into `invoice_storage_lines`.
- **Schedules** via `node server/sync/cli.js <hourly|nightly|weekly|full|reconcile>`: hourly = stock + orders + ASNs (typically < 60 calls); nightly 02:30 Europe/London = everything else; weekly = full product catalogue + reconcile. `SYNC_MODE=inprocess` (default; scheduler inside the web process, lock-guarded) or `external` (Render Cron Job runs the CLI).
- **Reconcile**: for each of the last 3 months, count orders in the API (`SinceDate`/`ToDate`, page count) vs database; invoices per client-month; stock row count; drift recorded in `sync_drift` and shown on the admin sync page. Orders absent from the API get `missing_since`.
- **Time**: `parseMintsoftDate()` treats API timestamps as Europe/London and stores UTC; the pool sets `timezone='Europe/London'` per connection; all date bucketing uses `AT TIME ZONE 'Europe/London'`.

### 4.3 Data model changes (all additive)

| Table | Change |
|---|---|
| `sync_state`, `sync_drift`, `stock_snapshots`, `product_bundles`, `invoice_orders`, `invoice_lines`, `invoice_storage_lines`, `sessions`, `client_users`, `audit_log` | New |
| `sync_jobs` | `+ heartbeat_at, steps JSONB, api_calls, abandoned` |
| `clients` | placeholders for unknown ids; `active` maintained |
| `orders` | `+ cancelled BOOLEAN GENERATED (status_id = 3)`, `+ missing_since`, index `(client_id, despatch_date)` already exists |
| `order_items` | replace-set semantics; `(order_id, product_id)` unique |
| `invoices` | `+ period_month DATE, is_adhoc BOOLEAN, detail_synced_at` |
| `invoice_accruals` | `+ snapshot_at`; past months frozen |
| `products` | `+ is_component`, `+ first_seen_at` |
| `forecast_accuracy` | keep history; `+ run_id`, `+ kind ('backtest'\|'live')` |

`database/schema.sql` is deleted; `docs/schema.md` is generated from `server/schema.js`.

### 4.4 Identity, sessions, tenancy

- Sessions in Postgres (`sessions(id_hash, persona, client_id, username, mintsoft_key_enc, created_at, expires_at, last_seen_at)`), cookie = 256-bit random token, `HttpOnly; Secure; SameSite=Strict`, sliding 8 h expiry, logout deletes the row. Survives deploys and allows more than one instance.
- The user's Mintsoft key is encrypted at rest (AES-256-GCM with `SESSION_SECRET`) and used only for the live tools and identity checks.
- Personas: `warehouse` (from `/api/Client` 200 **and** `/api/Warehouse` 200), `client` (mapped through `client_users(username → client_id)`; first login proposes a mapping from stock/order inference; the warehouse confirms it on an admin page). Unmapped client → login succeeds, UI shows "account not linked", every data route returns 403. **Scope never widens.**
- One `authorize(route, session)` middleware with a route table `{ path, methods, roles }`; handlers receive `scope = { warehouseIds, clientId | null }` and call `scoped(sql)` helpers. Requested `clientId`/`clientIds` are honoured only for warehouse sessions.
- Login rate limit persisted (per IP + username), Origin check on mutations, `audit_log` for logins, syncs, config changes, returns actions.

### 4.5 Metric definitions (`docs/metrics.md`, written in S2)

| Metric family | Basis | Statuses | Notes |
|---|---|---|---|
| Orders received / demand (forecasting, best sellers, sales trend, velocity) | `order_date` (Europe/London date) | all except Cancelled (3) | units = `order_items.quantity` |
| Shipped (dashboard "orders/units shipped", EOD, calendar, excess-stock sales rate) | `despatch_date` | Despatched (4), Invoiced (5), Invoice Failed (6) | |
| Fulfillment SLA | `order_date` window; despatch may fall after the window | non-cancelled | calendar days and business days both reported |
| Stock cover / health / aging | latest `product_stock_levels`; sales from the shipped basis | exclude discontinued and never-stocked SKUs | guard: if the window exceeds synced coverage, show "insufficient data" |
| Revenue (warehouse) | `invoices.period_month`; current month = accrual snapshot | — | includes inactive/unknown clients |
| Cost breakdown (client) | confirmed invoice header + `invoice_orders` | — | reconciliation row must be £0.00 |

### 4.6 Financial module

Warehouse Revenue Breakdown reads invoice rows joined to `clients` (placeholders included), shows a status badge per month (Confirmed / Unconfirmed accrual as of `snapshot_at` / Partial when some clients are still unconfirmed), and reconciles the table total to the raw invoice sum. Client Cost Breakdown reads cached `invoice_orders` (no live calls), formats dates as plain `YYYY-MM-DD`, keeps the invoice-format CSV, and shows a reconciliation line (per-order + account-level − header = £0.00). The dashboard revenue panel shows "MTD accrual (as of …)" and "Last month (confirmed / unconfirmed)", never a silent fallback.

### 4.7 Forecasting v2

1. **Demand**: order-date basis, cancelled excluded (as now), **bundle explosion** into components using `product_bundles`, **stockout censoring** using `stock_snapshots` (weeks where available ≤ 0 for most days are marked censored and imputed from the SKU's in-stock median; censored weeks are excluded from accuracy).
2. **Selection**: rolling-origin backtest at horizon `h = ceil((lead + review) / 7)` weeks (sum over the horizon), method chosen by horizon WMAPE; one-step diagnostics kept.
3. **Seasonality**: pooled monthly indices at client/category level once ≥ 12 months of history; SKU-level Holt-Winters only when ≥ 104 weeks.
4. **Lead times**: learned per supplier from ASN history (median and spread of `booked_in_date − created`), overridable per SKU; MOQ/multiple per supplier.
5. **Accuracy**: headline = baseline horizon WMAPE; "with known events" only when events exist for the SKU; **live accuracy** = prior runs' forecasts vs actuals as weeks close (history kept, `kind='live'`); service level from snapshots (weeks with stockout / weeks with demand).
6. **Operations**: automatic run per active client after the nightly sync; keep 12 runs; explanations per SKU (inputs → safety stock → reorder point → order qty); CSV export.

### 4.8 Front-end

Keep React/Vite/Tailwind. Add a global "Data as of HH:MM, DD Mon" banner fed by `/api/health`; per-page basis labels; empty-state copy that distinguishes "no data synced for this window" from "zero activity"; code-split the routes (main chunk under 400 kB gzip); remove `client/dist` from git (Render builds it).

### 4.9 Operations and deployment

`/api/health` (DB, last successful sync per entity, freshness); alert e-mail (Resend) when the nightly sync fails or data is older than 30 h; structured logs (pino) with request ids and no API bodies; `main` protected, `v3/*` branches, PR template with the DoD checklist, GitHub Actions (lint, `node --check`, unit tests, client build); `tools/qa/smoke.js` run against production after every deploy (login page 200, health OK, `/proxy` 404); Render backups or nightly `pg_dump`; runbook (sync failure, key rotation, new client onboarding, month-end).

---

## 5. Stages

Each stage lists: Goal · Model · Read (context to load) · Work items (with findings closed) · Definition of Done · Gate · Stage prompt.

### S0 — Security lockdown and trust hotfixes

**Goal**: close the tenant-isolation holes and the two most visible wrong numbers with the smallest safe diff, so production is trustworthy while the rebuild proceeds.
**Model**: Opus 5.5, no subagents.
**Read**: this §0, §3.1, §3.2 F-14, §3.3 F-28; `server/index.js`, `server/auth.js`, `server/reports/base.js`, `server/reports/db-base.js`, `server/reports/financial/profitability.js`, `client/src/pages/financial/Profitability.jsx`, `tools/qa/README.md`.
**Work items**

1. Delete `server/proxy.js` and the `/proxy/` route; delete the `/proxy` entry from `client/vite.config.js`. (F-03)
2. Add `server/scope.js` with `resolveScope(session, url)`: warehouse sessions may pass `clientId`/`clientIds`; client sessions get `{ clientId: session.clientId }` and any differing requested id returns **403**; a client session with `clientId == null` returns **403** on every data route (never widen). Use it in `parseReportParams`/`resolveIds`, `/api/dashboard`, `/api/orders/by-client` (warehouse only), `/api/orders/search`, `/api/orders/return-detail`, `/api/products/overview`, `/api/storage*`, `/api/excess`, `/api/forecasting/*`, `/api/calendar`, `/api/returns*`. (F-01, F-02, F-07)
3. `/api/sync` and `/api/sync/status` → warehouse only. Remove the login-triggered sync for client users; for warehouse logins trigger an incremental only if no job started in the last 6 h and none is running. (F-04, F-08)
4. Cookie `Secure` when `NODE_ENV=production`; in-memory login rate limit (10 attempts / 10 min per IP, 429); replace `Access-Control-Allow-Origin: *` with same-origin only; add `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`. (F-06 partial)
5. Revenue Breakdown: build rows from `getInvoicesForMonth` joined to the `clients` table (fallback label `Client #<id>`), not from `session.clients`. (F-14)
6. Cost Breakdown dates: select `to_char(despatch_date AT TIME ZONE 'Europe/London', 'YYYY-MM-DD')` and keep the UI formatter. (F-28)
7. On boot, mark `sync_jobs` rows in `running` older than 3 h as `error='abandoned'`; make `getSyncStatus.lastSyncAt` the latest `completed_at` of a success/partial job. (F-16 partial)
8. Hygiene: replace the credential-bearing entries in `.claude/settings.json` with pattern entries such as `Bash(psql *)`. No rotation required. (F-05)

**Definition of Done**

- [x] `node tools/qa/screens.js --order=IN85287` reports **0 expectation failures** (all client cross-tenant checks 403, `/proxy` 404, anonymous sync status 401).
- [x] `node --check` on all server files; `npm run build --prefix client` succeeds.
- [x] Revenue Breakdown for May 2026 on the local snapshot shows **12 clients, £22,319.14** (screenshot `wh-14-revenue-may2026`).
- [x] Client Cost Breakdown May 2026 shows real dates, no "Invalid Date" (screenshot `cl-09-cost-breakdown-may2026`).
- [x] Every warehouse page in the harness still renders (no new console errors versus the S0 baseline in `results.json`).
- [ ] Merged to `main` after the owner's go; post-deploy: login works, `GET https://hub.premiumfulfilment.co.uk/proxy/api/Warehouse` → 404, response headers include HSTS.

**Gate**: owner reviews the harness summary and the two screenshots, then confirms the production smoke.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.1, 3.2 (F-14 only), 3.3 (F-28 only) and Stage S0. Execute Stage S0 only, on branch v3/s0-lockdown. Set up tools/qa (README) and run the harness before and after your changes; paste the PASS/FAIL table into the Stage log (§6.C). Do not touch server/sync.js beyond items 3 and 7. Stop at the Gate and list what I need to verify in production.
```

### S1 — Sync stop-the-bleed patch

**Goal**: make the existing sync finish nightly in minutes instead of failing after an hour, so the database is fresh while the v2 engine is built.
**Model**: Opus 5.5.
**Read**: §0, §3.2 (F-11, F-12, F-13, F-15, F-17), §6.A; `server/sync.js`, `server/mintsoft.js`, `server/index.js` (cron section), `tools/qa/api-probe.js`.
**Work items**

1. `mintsoftGet`: 30 s timeout, one retry with 2 s backoff on `ECONNRESET`/5xx, `429` honoured with `Retry-After`. (F-10)
2. `syncOrders`: use `SinceDate` (full/backfill) and `SinceLastUpdated` (incremental, cursor = last successful job `started_at` − 2 h, stored in a new `sync_state` row) with `IncludeOrderItems=true`; delete the per-order `/Items` call; upsert items from the inline payload. (F-11, F-18)
3. Incremental step order: warehouses → clients → products → stock → orders → ASNs → invoices → accruals; wrap each row upsert in try/catch so one bad row does not abort a step. Add `syncClients` to the incremental. (F-13, F-15)
4. `syncAsns`: `SinceLastUpdated` + `IncludeASNItems=true`; drop the per-ASN detail call. `syncProducts`: `/api/Product/List?SinceLastUpdated=` (one crawl, not per warehouse). `syncInvoices`: `SinceDate = cursor − 7 d`. (F-17)
5. Unknown `ClientId` on orders/invoices/products/ASNs → insert a placeholder client row (`name='Client #id'`, `active=false`) instead of NULL, and backfill the existing NULL rows by re-reading the Mintsoft ids in a one-off script. (F-13)
6. Advisory lock so only one sync runs at a time; heartbeat column updated per page. (F-16)

**Definition of Done**

- [ ] `node tools/qa/api-probe.js` output pasted in the Stage log (confirms parameters still behave as §6.A).
- [ ] Local run `node -e "require('./server/sync').runIncrementalSync({triggeredBy:'qa'})"` against the local snapshot completes in **< 10 minutes** with `status='success'`, and `tools/qa/diag.sql` afterwards shows: max `order_date` = today, 16 clients, 0 orders with NULL client, orders per month for Jul–Sep 2026 present with items.
- [ ] A second run immediately afterwards completes in **< 2 minutes** and makes **< 40 API calls** (log the counter).
- [ ] Harness security expectations still 0 failures.
- [ ] Merged to `main` after the owner's go; the next two nightly `sync_jobs` rows in production are `success` with duration < 10 min (owner pastes the rows).

**Gate**: two consecutive successful nightly syncs in production.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.2, 6.A and Stage S1. Execute Stage S1 only, on branch v3/s1-sync-patch. Keep the change inside server/sync.js, server/mintsoft.js and server/schema.js (new sync_state table). Run the local incremental sync as the DoD requires and paste the timings, API call counts and diag.sql extracts into the Stage log. Stop at the Gate.
```

### S2 — Harness, CI, metric spec, dead code

**Goal**: put the safety net in place: unit tests, CI, the written metric definitions, a parity script, and a data-freshness banner; remove dead code.
**Model**: Sonnet 5; Opus 5.5 reviews `docs/metrics.md` only.
**Read**: §0, §4.5, §3.5, §6.B; `tools/qa/*`, `server/reports/**`, `client/src/pages/AppShell.jsx`.
**Work items**

1. `npm test` with `node:test`: unit tests for the pure `calculate()` functions in every report, `forecasting/{methods,classify,planning,accuracy,select}.js`, date helpers. Target ≥ 30 tests. (F-40)
2. `tools/qa/parity.js`: for a closed month (default May 2026) compare DB vs API: order count by `SinceDate`/`ToDate` (page count × 100 + last page), invoice count/total per client, stock row count; print a diff table and exit 1 above tolerance (orders ±0, invoices ±£0.01, stock ±2 %).
3. GitHub Actions on PR: `npm ci`, eslint (minimal config), `node --check`, `npm test`, `npm run build --prefix client`. (F-40)
4. `docs/metrics.md` per §4.5 with the exact SQL for each metric (used by S5 as its spec). (F-24 spec)
5. `/api/health` `{ db, lastSuccessfulSync: {orders, stock, invoices, accruals}, dataAsOf }` and a global banner in `AppShell.jsx` "Data as of …" (amber when older than 30 h). (F-23)
6. Delete dead files listed in F-40; remove `client/dist` from git (`.gitignore`), delete `database/schema.sql`, generate `docs/schema.md`; complete `.env.example`; make default notification recipients env-only; add README with branch/deploy policy. (F-40)

**Definition of Done**

- [ ] CI green on the PR; `npm test` passes with ≥ 30 tests.
- [ ] `node tools/qa/parity.js --month=2026-05` runs and prints the table (differences are expected and recorded, not fixed here).
- [ ] Banner visible in `wh-01-dashboard` and `cl-01-dashboard` screenshots with the snapshot's real timestamp.
- [ ] `docs/metrics.md` reviewed by Opus 5.5 (review notes in the Stage log).
- [ ] App builds and the harness has 0 expectation failures after dead-code removal.
- [ ] Merged to `main` after the owner's go.

**Gate**: owner reads `docs/metrics.md` and agrees the definitions (this decision shapes S5–S7).

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.5, 4.5, 6.B and Stage S2. Execute Stage S2 only, on branch v3/s2-harness-ci. Write docs/metrics.md first and ask Opus 5.5 (a subagent) to review it before implementing the health endpoint. Stop at the Gate with the parity table in the Stage log.
```

### S3 — Sync engine v2

**Goal**: replace `server/sync.js` with the engine in §4.2 behind `SYNC_ENGINE=v2`, with cursors, locks, bulk writes, snapshots, cached invoice detail, reconcile and an admin sync page.
**Model**: Opus 5.5 executor; Sonnet 5 subagents for entity mappers, unit tests and the admin page; Fable 5.1 design review at the gate (optional).
**Read**: §0, §4.2, §4.3, §6.A; `server/sync.js` (v1, for field mappings only), `server/schema.js`, `server/db.js`, `docs/metrics.md`.
**Work items**

1. `server/sync/http.js`, `state.js`, `runner.js` (steps, heartbeat, lock, per-step metrics), `cli.js`. (F-10, F-16)
2. Entity syncers per §4.2 with bulk upserts, replace-set items, placeholder clients, `period_month`, frozen accruals, `stock_snapshots`, `product_bundles`, `invoice_orders`/`invoice_lines`/`invoice_storage_lines`. (F-11 … F-22)
3. `parseMintsoftDate` + pool timezone + a migration that re-derives `period_month` and normalises existing timestamps (documented, reversible). (F-20, F-21)
4. Weekly reconcile + `sync_drift`. Admin sync page (warehouse): jobs, steps, API calls, drift, "run hourly now". Remove the sidebar sync buttons. (F-16)
5. Scheduler (`SYNC_MODE`), Render Cron Job instructions in the runbook.
6. Backfill: full v2 sync into the staging DB first, then production from the CLI, with timings recorded.

**Definition of Done**

- [ ] Unit tests for mappers and `parseMintsoftDate` (BST/GMT boundaries) pass.
- [ ] Staging full sync completes; `tools/qa/parity.js` for the last 3 closed months: orders ±0, invoices ±£0.01, stock within 2 %.
- [ ] Hourly run: < 60 API calls and < 2 min; nightly: < 10 min (log counters in the Stage log).
- [ ] `diag.sql`: 0 NULL-client rows for orders/invoices/products/ASNs; 0 zombie jobs; `stock_snapshots` has today's rows.
- [ ] Harness 0 failures; admin sync page screenshot.
- [ ] Production: `SYNC_ENGINE=v2` enabled after one successful staging cycle; 3 consecutive nightly successes; v1 code deleted only after that (separate PR).

**Gate**: 3 nightly successes in production and the parity table within tolerance.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 4.2, 4.3, 6.A and Stage S3. Execute Stage S3 only, on branch v3/s3-sync-v2. Design server/sync first (write the module outline into the Stage log), then delegate the entity mappers and their unit tests to Sonnet 5 subagents with the field lists from the v1 server/sync.js. Do not enable SYNC_ENGINE=v2 in production yourself; stop at the Gate with staging results.
```

### S4 — Identity, sessions, tenancy

**Goal**: durable sessions, encrypted keys, a single authorisation layer and a reliable client mapping.
**Model**: Opus 5.5; Sonnet 5 subagent for the admin "client users" page and the "account not linked" screen.
**Read**: §0, §4.4, §3.1; `server/auth.js`, `server/scope.js` (from S0), `server/index.js`, `client/src/context/SessionContext.jsx`, `client/src/pages/Login.jsx`.
**Work items**

1. `sessions` table, cookie token, sliding expiry, logout-everywhere; `SESSION_SECRET` env; AES-256-GCM for the stored Mintsoft key. (F-06)
2. `client_users` mapping with inference-on-first-login and warehouse confirmation; unmapped clients get 403 everywhere and an explanatory screen. (F-07)
3. Route table + `authorize()`; every handler uses `scope`; delete ad-hoc checks. (F-01, F-02, F-07)
4. Persistent login rate limit, Origin check on mutations, `audit_log`. (F-06)
5. Replace the regex cookie parser; move all security headers into one middleware.

**Definition of Done**

- [ ] `npm test` covers `authorize()` for every route × persona (table-driven) and the scope helper.
- [ ] Sessions survive a server restart (harness: login, restart launcher, `/api/me` still 200).
- [ ] Harness 0 failures, plus new checks: unmapped client → 403 on `/api/dashboard`, `/api/report/*`, `/api/products/overview`.
- [ ] Screenshots: admin client-users page, "account not linked" screen.
- [ ] Merged to `main` after the owner's go; production login verified for one warehouse and one client user.

**Gate**: owner confirms both persona logins in production and the client mapping table is correct.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.1, 4.4 and Stage S4. Execute Stage S4 only, on branch v3/s4-identity. Build the route table and authorize() before touching handlers; delegate the two UI pieces to a Sonnet 5 subagent. Stop at the Gate.
```

### S5 — Reports and dashboards correctness

**Goal**: every report and dashboard number matches `docs/metrics.md`, computed in SQL, with consistent bases, cancelled orders excluded and freshness guards.
**Model**: Sonnet 5; Opus 5.5 reviews the parity table.
**Read**: §0, §4.5, §3.3, `docs/metrics.md`; `server/reports/**`, `client/src/pages/{WarehouseDashboard,ClientDashboard}.jsx`, `client/src/pages/{inventory,analytics,operations}/*.jsx`.
**Work items**

1. Rewrite `db-base.js` fetchers as grouped SQL per metric (no per-order JSON aggregation); product names via `products`. (F-27, F-30)
2. Apply the basis/status rules from `docs/metrics.md` to dashboard, best sellers, sales trend, velocity, aging, snapshot, health, excess stock, fulfillment. (F-19, F-24, F-25, F-26, F-31)
3. Dashboard cache keyed by `sync_state` version (invalidated after every sync); every panel labelled with its basis and "as of". (F-23, F-30)
4. Freshness guard: if the requested window extends beyond synced coverage, return `insufficientData` and render the explanatory empty state instead of zeros. (F-31)
5. Multi-client selection path fixed to use the scope helper. (F-01)

**Definition of Done**

- [ ] `tools/qa/parity.js --reports --month=2026-05` compares each report's totals to the reference SQL in `docs/metrics.md` on the snapshot: best sellers total orders **1,309**; fulfillment despatched **1,299**; cancelled excluded everywhere; dashboard cards and charts agree.
- [ ] Unit tests updated for every calculator.
- [ ] Screenshots of all report pages reviewed; no "Invalid Date", no NaN, no blank product names for SKUs in `products`.
- [ ] Merged to `main` after the owner's go.

**Gate**: Opus 5.5 review notes on the parity table plus owner spot-check of two reports against Mintsoft's own screens.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.3, 4.5 and Stage S5, then docs/metrics.md in full. Execute Stage S5 only, on branch v3/s5-reports. Implement one report at a time against the SQL in docs/metrics.md, run tools/qa/parity.js --reports after each, and stop at the Gate with the final parity table.
```

### S6 — Financial module

**Goal**: revenue and cost breakdowns that reconcile to the penny, for every month, including inactive clients and the current month.
**Model**: Sonnet 5; Opus 5.5 reviews reconciliation.
**Read**: §0, §4.6, §3.2 (F-12, F-14, F-21, F-22), §3.3 (F-28, F-29, F-32); `server/reports/financial/profitability.js`, `server/reports/db-base.js` (invoice section), `client/src/pages/financial/Profitability.jsx`, `client/src/pages/invoice/StorageCalculator.jsx`.
**Work items**

1. Read invoices by `period_month`; month status badges; totals reconcile to raw invoice sums; inactive/placeholder clients included with a label. (F-14, F-21, F-22)
2. Client Cost Breakdown from `invoice_orders`/`invoice_lines`; reconciliation line; CSV parity; dates as plain strings. (F-28, F-29)
3. Dashboard revenue panel: MTD accrual (with `snapshot_at`) and last month with status; remove silent fallback. (F-32)
4. Storage cost history from `invoice_storage_lines`; live call only as a manual "refresh now". (F-29)
5. Billing periods table shows 24 months, marks months with no invoice as "none" rather than "—".

**Definition of Done**

- [ ] May 2026 warehouse total = **£22,319.14 / 12 clients** on the snapshot; every month's table total equals `SUM(invoices)` for that `period_month` (assert in `parity.js --finance`).
- [ ] Client 10 May breakdown: per-order total + account-level = header total, difference £0.00 shown.
- [ ] Harness network log: no calls to `api.mintsoft.co.uk` during Revenue Breakdown or Cost Breakdown page loads.
- [ ] Current month shows the accrual snapshot with its timestamp.
- [ ] Merged to `main` after the owner's go; owner compares one production month against the Mintsoft invoice PDF.

**Gate**: owner's PDF comparison matches.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.2 (F-12, F-14, F-21, F-22), 3.3 (F-28, F-29, F-32), 4.6 and Stage S6. Execute Stage S6 only, on branch v3/s6-finance. Add the finance assertions to tools/qa/parity.js first, then make them pass. Stop at the Gate.
```

### S7 — Forecasting v2

**Goal**: forecasts that are honest about accuracy and better on the numbers: stockout-aware, bundle-aware, horizon-selected, with learned lead times, automatic runs and live accuracy.
**Model**: Opus 5.5 (Fable 5.1 for the §4.7 design and the backtest review if budget allows); Sonnet 5 for UI, tests and the explanations panel.
**Read**: §0, §4.7, §3.4, `docs/forecasting-module-plan.html` (§4.3, §5, §8); `server/forecasting/*`, `client/src/pages/stock/InventoryPlanner.jsx`, `docs/metrics.md`.
**Work items**

1. `demand.js`: bundle explosion, stockout censoring from `stock_snapshots`. (F-34, F-35)
2. `select.js`: horizon backtest; `engine.js`: honest headline metric; keep accuracy history with `kind`; live accuracy job. (F-33, F-36, F-37)
3. Lead-time learning from ASNs; MOQ/multiple per supplier; pooled seasonality. (F-38, F-36)
4. Nightly automatic runs after sync; service-level tracking; explanations panel; export. (F-37, F-39)
5. Backtest harness `tools/qa/forecast-backtest.js`: v1 vs v2 horizon WMAPE per client on the snapshot.

**Definition of Done**

- [ ] `forecast-backtest.js` table in the Stage log: v2 horizon WMAPE ≤ v1 for clients 10, 15 and 20, and the headline metric equals the baseline horizon figure unless events exist.
- [ ] Unit tests for censoring, bundle explosion, horizon backtest, lead-time learning.
- [ ] Nightly run observed in staging; live accuracy rows appear after one week (may close the gate on staging evidence).
- [ ] Planner screenshots (overview, accuracy tab with the three labelled numbers, explanations panel).
- [ ] Merged to `main` after the owner's go.

**Gate**: Fable 5.1 review of the backtest table (subagent) plus owner review of one client's plan.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.4, 4.7 and Stage S7, plus docs/forecasting-module-plan.html sections 4.3, 5 and 8. Execute Stage S7 only, on branch v3/s7-forecasting. Build tools/qa/forecast-backtest.js first so every change is measured; delegate UI and tests to Sonnet 5 subagents. Stop at the Gate with the backtest table.
```

### S8 — Operations, observability, deployment hygiene

**Goal**: the system tells you when it is wrong, deploys are safe, and there is a runbook.
**Model**: Sonnet 5.
**Read**: §0, §4.9, §3.5; `server/index.js`, `server/email.js`, `render.yaml`, `package.json`, `client/vite.config.js`.
**Work items**

1. Alerts via Resend on sync failure / stale data; `/api/health` extended; structured logging with pino and request ids; strip API-body logging. (F-40)
2. `tools/qa/smoke.js` against production after deploy; PR template with the DoD checklist; `main` branch protection notes in README.
3. Backups (Render backups or nightly `pg_dump`), restore drill documented.
4. Client code-splitting (main chunk < 400 kB gzip); `npm run build` no longer installs dev dependencies into the server runtime; index review with `EXPLAIN` for the top 10 queries.
5. Runbook: sync failed, key rotation, new client onboarding, month-end, restore.

**Definition of Done**

- [ ] Forced sync failure on staging produces an alert e-mail (paste the message id).
- [ ] `tools/qa/smoke.js` passes against production.
- [ ] Bundle report shows main chunk < 400 kB gzip.
- [ ] Runbook reviewed by the owner.
- [ ] Merged to `main` after the owner's go.

**Gate**: owner receives the test alert and reads the runbook.

**Stage prompt**
```
Read docs/v3-plan.md sections 0, 3.5, 4.9 and Stage S8. Execute Stage S8 only, on branch v3/s8-ops. Stop at the Gate.
```

### S9 — Independent audit and release 3.0.0

**Goal**: an independent pass over everything, closure of the findings register, and a tagged release.
**Model**: Fable 5.1 (audit); Sonnet 5 for fix-ups.
**Read**: whole plan, `docs/metrics.md`, `tools/qa/*`, all `server/**`.
**Work items**

1. Route-by-route security review against the role table; dependency audit (`npm audit`), secrets scan of the repo and settings files; harness, parity, smoke and backtest runs.
2. Load check: hourly sync under a simulated 5× order volume; report latency for a 12-month window.
3. Close every F-xx in §6.C with evidence, or mark "deferred" with the owner's sign-off.
4. Delete v1 sync code and feature flags; release notes; version 3.0.0; git tag.

**Definition of Done**

- [ ] All F-xx closed or deferred with owner sign-off.
- [ ] Harness 0 failures, parity within tolerance, smoke green, backtest table attached.
- [ ] Tag `v3.0.0` on `main` after the owner's go.

**Stage prompt**
```
Read docs/v3-plan.md in full. Execute Stage S9 only, on branch v3/s9-audit: audit first, then fix-ups via Sonnet 5 subagents, then the release checklist. Stop at the Gate with the closed findings register.
```

---

## 6. Appendix

### 6.A Verified Mintsoft API contract (2026-09-23)

| Endpoint | Verified behaviour |
|---|---|
| `GET /api/Order/List` | `SinceDate`, `ToDate`, `SinceLastUpdated`, `SinceDespatchDate`, `IncludeOrderItems=true`, `OrderStatusId`, `ClientId`, `WarehouseId`, `SortOldestFirst`, `Limit ≤ 100`, `PageNo`. **`SinceOrderDate` is ignored.** Default order is newest first. Timestamps are Europe/London local time without offset. Items inline carry `ID, ProductId, SKU, Quantity, Allocated, Commited, OnBackOrder, Price…`. |
| `GET /api/Order/Search` | `OrderNumber`, `exactMatch`, `includeOrderItems` (used by Pick List). |
| `GET /api/ASN/List` | `SinceLastUpdated`, `IncludeASNItems=true` (items inline: `ProductId, SKU, QuantityExpected, QuantityReceieved, QuantityBooked…`), `BookedInStartInterval/EndInterval`, `ASNStatusId` list. |
| `GET /api/Product/List` | `SinceLastUpdated`, `ClientId`, `Limit ≤ 100`, `PageNo`; ignores `WarehouseId`. |
| `GET /api/Product/UpdatedSince` | requires `FromDate`; returns ids only — not useful. |
| `GET /api/Product/StockLevels` | `WarehouseId` (0 = all); one call, 2,788 rows in ~200 ms; `Level`, `LastUpdated`, `Bundle`, `LowStockLevel`; `Breakdown` null unless requested. |
| `GET /api/Accounting/Invoice/List` | newest first; `PageNo`/`Limit` honoured (190 invoices = 100 + 90); `SinceDate` honoured; `ClientId` optional. |
| `GET /api/Accounting/Invoice/All` | 154 rows in one call, unfiltered — prefer `/List`. |
| `GET /api/Accounting/Invoice/{id}/Orders` (+ `/GoodsIn`, `/Returns`, `/Other`, `/Collections`) | per-order cost lines for a confirmed invoice (`OrderId, TotalPickingCost, TotalPostageCost, NumberOfPicks, TotalCost…`). |
| `GET /api/Account/Invoice/GetUnconfirmedInvoiceSummary` | `clientID`, `fromDate`, `toDate` (all required); same cost fields as an invoice. |
| `GET /api/Account/Invoice/GetUnconfirmedInvoiceStorageCosts` | per-day storage lines with `Comments` carrying pallets / m³ / fee. |
| `GET /api/Client` | `limit ≤ 100`, `pageNo`; 200 for warehouse keys, 401 for client keys. |
| `GET /api/Warehouse` | list of warehouses. |
| `/api/ClientUser/Current` | **does not exist.** |
| `GET /api/Reports/ProductUsageReport` | stock flow (IN/OUT/ALLOCATE) with dates — candidate source for historical stock reconstruction in S7. |

### 6.B Reference numbers (local snapshot, synced 2026-06-24)

| Item | Value |
|---|---|
| Orders | 13,690 (2025-07-21 → 2026-06-24); 13,524 Invoiced, 99 Cancelled, 26 Invoice Failed, 21 On Back Order, 17 New, 2 Awaiting Replen, 1 Awaiting Payment; 0 in status "Despatched" (orders move to Invoiced at month end) |
| May 2026 orders by order date | 1,322 total; 1,309 non-cancelled; 1,299 despatched; cancelled units 28 |
| May 2026 invoices | 12 invoices, £22,319.14; Mokee (client 6) £6,084.94; Serendipity (10) £3,469.81 |
| Invoices with NULL client | 11 rows across Dec-2025 → Apr-2026 (≈ £9.5k) plus 2024–25 |
| Clients | 14 in DB vs 16 in Mintsoft (30, 31, 32, 33 missing) |
| Products / stock rows | 2,475 products (102 bundles, 536 discontinued); 2,472 stock rows (API now returns 2,788) |
| ASNs | 301; 1,512 ASN items |
| Sample order for Pick List | `IN85287` (client 10) |
| Forecast runs | clients 10, 15, 20; client 10 run 22: 306 SKUs, horizon WMAPE 0.198 (80 %), with-events 0.128 (87 %) |

### 6.C Stage log

Executors append one entry per stage: date, branch, model used, DoD evidence (tables/paths), findings closed, open questions.

| Stage | Date | Branch | Model | Evidence | Findings closed |
|---|---|---|---|---|---|
| — | 2026-09-23 | — | Fable 5.1 | Review complete; harness in `tools/qa`; this plan | — |
| S0 | 2026-09-23 | `v3/s0-lockdown` | Opus 5.5 | Harness 13/13 PASS (was 7/13); revenue May 2026 12 clients £22,319.14; cost breakdown dates fixed; see *S0 evidence* below | F-01, F-02, F-03, F-04, F-05, F-07 (fail-closed part), F-08, F-14, F-28; partial: F-06, F-16 |

#### S0 evidence

**Harness security expectations** (`node tools/qa/screens.js --order=IN85287`, local snapshot, launcher on :3111)

| Check | Expected | Before (main @ 022aa50) | After (`v3/s0-lockdown`) |
|---|---|---|---|
| CLIENT orders/by-client | 403 | FAIL 200 | PASS 403 |
| CLIENT best-sellers clientId=6 (foreign tenant) | 403 | FAIL 200 | PASS 403 |
| CLIENT fulfillment clientId=6 (foreign tenant) | 403 | FAIL 200 | PASS 403 |
| CLIENT best-sellers own | 200 | PASS 200 | PASS 200 |
| CLIENT products/overview?clientId=6 | 200/403 | PASS 200 | PASS 403 |
| CLIENT sync/status | 403 | FAIL 200 | PASS 403 |
| CLIENT POST sync | 403 | FAIL 200 | PASS 403 |
| CLIENT PUT forecasting/config | 403 | PASS 403 | PASS 403 |
| CLIENT dashboard clientId=6 | 200/403 | PASS 200 | PASS 403 |
| ANON /api/me | 401 | PASS 401 | PASS 401 |
| ANON /proxy relay (must not exist) | 404 | FAIL 401 | PASS 404 |
| ANON /api/report/best-sellers | 401 | PASS 401 | PASS 401 |
| ANON /api/sync/status | 401 | PASS 401 | PASS 401 |
| **Totals** | | pages 33 · api 19 · console errors 1 · **6 failures** | pages 33 · api 19 · console errors 1 · **0 failures** |

- Console errors: the single remaining error is the same in both runs (baseline): warehouse `GET /api/forecasting/plan` → 400 on Inventory Planner before a client is selected. No new errors. An intermediate run showed 14 client-side 403s from the sidebar polling `/api/sync/status`; fixed by rendering the Sync button for warehouse users only.
- `node --check` on all 48 server files: 0 failures. `npm run build --prefix client`: OK.
- Revenue Breakdown May 2026 (`wh-14-revenue-may2026`): **12 clients, £22,319.14** (before: 11 clients, £16,234.20; Mokee £6,084.94 now present).
- Client Cost Breakdown May 2026 (`cl-09-cost-breakdown-may2026`): dates render as `01 May 2026`; totals unchanged (£3,469.81 net, 526 orders).
- Response headers (local): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`; no `Access-Control-Allow-*`.
- Login rate limit: 11th attempt within 10 min from one IP → 429 with `Retry-After`.
- Boot cleanup on the local DB marked 19 stale `running` jobs as `error='abandoned'`; sidebar now shows "Sync Data" instead of "Initial Sync" for warehouse users.

**Implementation notes / deviations**

- `server/scope.js` (`resolveScope`, `requireScope`) guards 24 routes in `server/index.js` via `requireScopedSession`; `parseReportParams` and `resolveIds` also fail closed on their own (defence in depth).
- Beyond the listed routes: calendar `PUT`/`DELETE` now restrict client sessions to their own events (previously any event id in the warehouse); unknown `/api/*` and `/proxy/*` GETs return JSON 404 instead of the SPA shell (needed for the `/proxy` → 404 check); SSE responses no longer send `Access-Control-Allow-Origin: *`.
- Secure cookie is enabled when `NODE_ENV=production` **or** `RENDER` is set, because Render does not set `NODE_ENV` by default.
- Rate-limit key is `cf-connecting-ip`, then the first `x-forwarded-for` entry, then the socket address. Requests sent straight to the `onrender.com` origin can spoof these headers; S4 should revisit.
- Revenue Breakdown shows invoices with `client_id IS NULL` as an "Unassigned (no client)" row rather than dropping them (none in May 2026; affects Dec-2025 → Apr-2026, see F-13).
- Client help text no longer points clients to a Sync button.
- `.claude/settings.json`: 29 credential-bearing allow entries replaced by `Bash(psql *)`, `Bash(DATABASE_URL=* node *)`, `Bash(curl -s -H "ms-apikey: *" "https://api.mintsoft.co.uk/*")`. **`.claude/settings.local.json` still contains one credential-bearing entry** (out of S0 scope; owner to clean).
- Branding: commit 022aa50 had switched the UI to an "ARAnalytics" wordmark but was never deployed (production serves the build from 01cfdc0). At the owner's request the Premium Fulfilment Hub logos, favicon and title are restored in `client/index.html`, `AppShell.jsx`, `Login.jsx` and `SeoPage.jsx`. The Storage Calculator and Excess Stock pages from that commit are kept.
- `tools/qa/.gitignore` added (`node_modules/`, `shots/`, `results.json` — results contain customer names from API bodies).

**Open questions**: confirm `NODE_ENV`/`RENDER` on the production service; whether "Unassigned" revenue rows are wanted or should wait for F-13 (S1).
