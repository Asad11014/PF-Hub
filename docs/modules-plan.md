# Subscription modules, BBE report, Quarantine report — staged plan

Prepared 2026-10-21. Same rules as `docs/v3-plan.md` §0: one stage per prompt, branch `v3/mN-short-name`, `main` deploys to production, merge only after the owner's go, additive migrations only.

## Decisions (owner, 2026-10-21)

| Topic | Decision |
|---|---|
| Rollout | **Grant all, change nothing.** Every existing client is granted Basic + Forecasting on day one. Access changes only when a warehouse user switches a module off. |
| Modules | **Basic** (all standard client features), **Forecasting** (Inventory Planner), **BBE report**, **Quarantine report**. More bespoke modules later, each with its own price. |
| Billing | **Manual.** Warehouse users grant and revoke per client on an admin page and invoice outside the app. Price and billing-reference fields exist for later online payments. |
| BBE window | **Bands:** Expired / < 30 / 30–60 / 60–90 / 90+ days. Default warning window 90 days, adjustable per client. |
| Warehouse users | Always have every module, for every client. |
| New paid modules (BBE, Quarantine) | Not granted to anyone by default. Clients see them in the menu as locked add-ons ("Available as an add-on — contact us"). Warehouse users can use them for any client. |
| Clients that appear later | Get Basic automatically (a setting on the admin page), so a new client is never locked out by surprise. |

## Design

### Entitlements
- `modules` (catalogue): `key` PK (`core`, `forecasting`, `bbe`, `quarantine`), `name`, `description`, `monthly_price_pence` (nullable = "price to be confirmed"), `currency`, `is_core`, `sort`, `active`. Seeded from `server/entitlements.js`; prices are edited in the app.
- `client_subscriptions`: (`client_id`, `module_key`) PK, `status` (`active` | `trial` | `suspended` | `cancelled`), `starts_at`, `ends_at` (nullable), `price_pence` (per-client override, nullable), `billing_ref` (future payment provider id), `notes`, `updated_by`, `updated_at`.
- `subscription_events`: an append-only audit of every change (who, when, before → after).
- `app_settings`: key/value JSONB (e.g. `default_modules_for_new_clients = ["core"]`).
- Access rule: a client user may use module M if the client has an entitlement for `core` **and** for M (M ≠ core) with status `active`, or `trial` with `ends_at` in the future. Warehouse users bypass. Resolved per request (60 s cache, cleared on change), so grants take effect without logging in again.
- Enforcement lives on the server, in one place (`server/entitlements.js`, wired next to `server/scope.js`): `core` gates every client data route; module routes add their own key. Denied → `403 { code: 'module_required', module }`.
- `/api/me` returns `modules: [...]` for the UI. Nav items carry `module: 'forecasting'` etc. A locked item shows a lock badge, and its route renders a "This is an add-on" page. A client without `core` sees a single "Subscription required" screen (Help and Sign out still work).
- Admin page (warehouse): **Client Subscriptions**, a grid of clients × modules with on/off, status, end date, price override and notes, plus the module price list and the audit trail.

### Stock batches (data for BBE and Quarantine)
- Source: `GET /api/Product/Inventory/Bulk?WarehouseId=&Breakdown=true` (16 pages for 1,550 stocked products, ~5 s). Each breakdown line has `Quantity`, `BatchNo`, `BestBefore` (`dd/MM/yyyy`), `Type` (`Allocation`, `Quarantine`, `Allocation_OffHand`). Product totals include `InQuarantine`.
- Locations: `GET /api/Reports/ProductsInLocationReport?warehouseId=&clientId=` adds the location name and type per line (PICK, BULK, …).
- New table `stock_batches` (one row per product × location × batch × type), fully replaced each hourly run like stock levels, and added to reconcile.
- Probe (2026-10-21): 219 lines carry a best-before date (Serendipity 107 products, Vending Warehouse 20); 151 units across 18 products in quarantine (7 clients).

### Reports
- **BBE report**: per client, every batch with a best-before date, grouped by band, with SKU, product, batch, location, quantity, best-before and days left. Summary tiles per band, a warning-window setting, CSV export.
- **Quarantine report**: per client, every quarantined line: SKU, product, batch, best-before, location, quantity, last updated. Totals, CSV export.
- Both: client users see their own client (scope + module check); warehouse users pick any client or all.

## Stages

### M1 — Entitlements infrastructure
**Model**: Opus 5.5 (security boundary).
**Work**: schema + seed (grant `core` + `forecasting` to every existing client; record the seed in `subscription_events`); `server/entitlements.js`; enforcement on all client data routes and `/api/forecasting/*`; `/api/me.modules`; UI gating (nav lock badges, locked-module page, subscription-required screen); warehouse admin page with grants, prices, audit and default-for-new-clients setting; new clients created by the sync get the default modules; harness checks; unit tests.
**DoD**
- [x] Unit tests: access rule (active / trial expiry / suspended / warehouse bypass / no core).
- [x] Harness: existing 15 checks still pass; new checks: a client without `forecasting` → 403 on `/api/forecasting/plan`, and the Inventory Planner shows the add-on page; a client without `core` → 403 on a data route and sees the subscription screen; warehouse unaffected.
- [x] Locally, after migration every existing client has `core` + `forecasting` active, and every page renders as before for the client persona (no new console errors).
- [x] Admin page screenshot; a toggle writes an audit row and takes effect within 60 s without logging in again.
- [ ] Merged after the owner's go; production smoke: client login still sees everything; the admin page lists all clients.

### M2 — Stock batches sync
**Model**: Sonnet 5 (follows the engine's existing patterns; spec above).
**Work**: `stock_batches` table and mapper (`BestBefore` dd/MM/yyyy → DATE); Inventory/Bulk crawl + location report, joined; hourly full replace; reconcile entity; diag lines.
**DoD**
- [ ] Reconcile: `stock_batches` 0 missing / extra / drift; the best-before line count and quarantine units match a fresh API crawl.
- [ ] Hourly run stays < 60 API calls and < 30 s.
- [ ] Unit test for the date parser (dd/MM/yyyy, blanks, invalid).

### M3 — BBE and Quarantine reports
**Model**: Sonnet 5 (UI + queries from the spec); Opus 5.5 reviews the module and scope checks only.
**Work**: `/api/stock/bbe` and `/api/stock/quarantine` (scope + module); client pages under Stock Analytics, warehouse pages under Figures; per-client BBE warning window (`client_settings`); CSV export; help-guide entries; harness pages + checks.
**DoD**
- [ ] Serendipity BBE and Amaura quarantine figures match Mintsoft (spot-check 3 SKUs each).
- [ ] Client without the module sees the add-on page; client with it sees only their own rows; foreign `clientId` → 403.
- [ ] Harness 0 failures; screenshots of both reports (client + warehouse).

### Later (not planned yet)
- Online payments (Stripe Checkout + webhooks → `client_subscriptions`), once prices are set.
- Further bespoke modules: each needs only a `modules` row, a route check and a nav `module` key.

## Stage log

| Stage | Date | Branch | Model | Evidence |
|---|---|---|---|---|
| M1 | 2026-10-21 | `v3/m1-entitlements` | Opus 5.5 | `npm test` 12/12 (4 new access-rule tests); harness 31/31 PASS (16 new), 36 pages, console errors 1 = baseline; seed granted Basic + Forecasting to all 22 local clients (44 rows); toggles audited in `subscription_events` and effective immediately (cache cleared on change); screenshots `wh-20-client-subscriptions`, `cl-15-planner-locked`, `cl-16-no-subscription` |

M1 notes
- Enforcement is one check in `server/index.js` for every `/api` request from a client session (`entitlements.checkAccess`). The path → module map is in `server/entitlements.js` (`PATH_MODULES`), so a new module needs one line there plus a `modules` catalogue entry.
- A client with no rows follows the "New clients" default (Basic). Switching a module for such a client first writes the defaults as explicit rows, so other modules are never lost by accident.
- A login whose client cannot be identified (no `clientId`) keeps the existing "not linked" behaviour instead of the subscription screen.
- BBE and Quarantine menu items and routes exist for clients (locked add-on page). Their content arrives in M3. Until then, a client granted the module sees a "coming soon" placeholder.
