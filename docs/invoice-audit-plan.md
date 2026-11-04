# Invoice Audit module — staged plan

Prepared 2026-11-04. Same rules as `docs/v3-plan.md` §0: one stage per prompt, branch `v3/iN-short-name`, `main` deploys to production, merge only after the owner's go, additive migrations only.

## Goal

For every order Premium Fulfilment invoices, show exactly what was charged, line by line. Work out independently what *should* have been charged, from the client's rate card and order rules, and flag every difference. In effect, this is an invoice-auditing product (the kind that could audit any 3PL's billing) built as one internal module of this app.

## Access (decided by the owner)

- Exclusive to **arizvi@premiumfulfilment.co.uk** (the owner), matched case-insensitively against the Mintsoft username used at login.
- The owner can grant or revoke access for other **warehouse** users by their Mintsoft username, on a "Who can see Invoice Audit" panel inside the module. Client users can never be granted it.
- Every grant and revoke is audited. The server enforces the check on every `/api/audit/*` request, and the menu item only appears for permitted users.
- This is separate from client modules. `server/entitlements.js` controls what *client* accounts can use; this is a per-user permission for staff.

## What Mintsoft gives us (probed 2026-11-04, read-only)

| Source | What it contains |
|---|---|
| `GET /api/Accounting/Invoice/{id}/Orders` | One line per order on a **confirmed** invoice: `PickingCost`, `ExtraPickingCost`, `PostageCost` (charged), **`CostPostageCost` (what the courier costs us)**, `VatFreePostageCost`, `PackagingCost`, `ReworkCost`, `AdminFee`, `NumberOfPicks` / carton / pallet picks, `TotalCost`, `Comments` (manual notes such as "Zerod costs for short ship"), `CourierServiceId`. Invoice 337 (Serendipity, Sep 2026) has 381 lines. |
| `…/{id}/GoodsIn`, `/Returns`, `/Other`, `/Collections` | Goods-in lines per ASN (units, unit cost, admin cost, SKU cost); returns; ad-hoc items incl. credits ("Credits for Bundle picks" −£20.67); collections. |
| `GET /api/Accounting/Invoice/Orders/{OrderId}` | The same line for one order. Returns `null` for the current (unconfirmed) month, so per-order billed detail only exists once an invoice is confirmed. |
| `GET /api/OrderRules?clientId=` | The client's real billing rules, e.g. Serendipity: *OrderVolume < 0.013 → AddReworkItem SW-BOX*, *OrderVolume > 0.013 → DW-BOX*. Conditions can use product category, SKUs, names, weight, value, volume, items, courier, channel, country/postcode, parcels and more (`/api/OrderRules/ConditionOptions`). Actions include `AddReworkItem`, `AddPackagingInstruction`, `ChangeNumberOfParcels`, … (`/Actions`). |
| `GET /api/Client/{id}` | The rate card: picking calculation type (per item / per order line), standard and additional picking cost, items included, carton/pallet picking, per-order admin fee, default packaging fee, returns first/additional item, goods-in costs (carton, pallet, containers, per unit, per SKU), admin per ASN, storage type and fees. |
| `GET /api/Account/Invoice/InvoiceItemTypes` | The catalogue of ad-hoc charge types and their rates (management fees, onboarding, shelf storage, courier handling fee, …). |
| Our database (already exact) | Orders with items, product categories, dimensions (for order volume) and weights, ASNs with items, invoices, accruals. |

**Not available from the API:** the price of each rework item (SW-BOX, DW-BOX, …). On Serendipity's September invoice, rework was billed at £0.14 on 363 orders and £2.15 on 16, matching the two box rules. The module infers each item's price from billed history and asks the owner to confirm it once.

## Checks the module runs

**A. Coverage, so nothing goes unbilled or double-billed**
1. Despatched orders in a closed month that appear on **no** invoice (revenue leakage).
2. Orders billed **twice** (on two lines or two invoices).
3. Orders billed that were **cancelled** or never despatched.
4. **Zero-charge** orders and **manual overrides** (lines whose comments show costs were zeroed or edited).

**B. Price correctness against the rate card**
5. Picking: expected from the client's picking method (per item / per order line, standard + additional, items included) and the order's items, vs `TotalPickingCost` / `ExtraPickingCost`.
6. Admin fee per order vs `PerOrderAdminFee`.
7. Goods-in lines vs goods-in rates and admin per ASN.
8. Rate-card changes over time (snapshots), so a mid-month price change explains a difference instead of looking like an error.

**C. Rules (packaging / rework)**
9. Re-run each client's Mintsoft **order rules** on every order (volume from product dimensions × quantity, categories, SKUs, weight, courier, …), giving the rework / packaging items the order should carry.
10. Expected rework and packaging charge (confirmed item prices) vs billed: **missing** (leakage), **extra** (possible overcharge), **wrong item**.
11. Owner-defined **audit rules** beyond Mintsoft's, using the same condition builder, e.g. "orders containing category Glass must carry DW-BOX".
12. Rule-engine accuracy per client (the share of orders where it reproduces the billed rework exactly), so you can trust the flags.

**D. Postage and margins**
13. Postage charged below courier cost (negative margin), and margin per client, courier service and month.
14. Outliers: the same service and similar weight, but an unusual price.

**E. Invoice integrity**
15. The invoice header equals the sum of its lines (orders + goods-in + returns + other + collections + storage).
16. Credits and ad-hoc items listed with their reason, per invoice.

## Screens

- **Audit overview**: months × clients, showing billed total, expected total, variance, flag counts by severity, and estimated leakage (£).
- **Invoice audit**: every order line with billed vs expected (picking, extra picking, postage charged / cost / margin, packaging, rework, admin, total), the variance, and the flags. Filter to flagged lines, export to CSV.
- **Order drill-down**: items, categories, volume and weight, which rules fired and why, the billed line, and the expected calculation step by step.
- **Rates and rules**: rate card per client (with history), Mintsoft order rules (read-only), rework item prices (inferred → confirmed), custom audit rules.
- **Review workflow**: each flag can be marked *OK / explained*, *To credit client*, or *To charge client*, with notes. Each invoice gets a status (Not reviewed → In review → Signed off), with a full audit trail.
- **Current month preview**: expected charges for orders despatched so far vs Mintsoft's unconfirmed accrual totals, to catch problems before the invoice is confirmed.
- **Access**: owner-only panel to grant and revoke users.

## Data model (additive)

| Table | Purpose |
|---|---|
| `user_permissions(username, permission, granted_by, granted_at)` | Staff permissions (`invoice_audit`); owner list in `app_settings.invoice_audit_owners` |
| `invoice_orders` | Mirror of `/Invoice/{id}/Orders` (all fields above), keyed by Mintsoft line `ID` |
| `invoice_extra_lines` | Mirror of GoodsIn / Returns / Other / Collections lines (`kind`, amount, comments, payload) |
| `invoices.detail_synced_at` | Detail is fetched once per invoice, and again when Mintsoft's `LastUpdated` changes (invoices are edited after month end) |
| `client_rate_cards(client_id, captured_at, card JSONB)` | Rate-card snapshots, written when the card changes |
| `client_order_rules(client_id, captured_at, rules JSONB)` | Order-rule snapshots, written when they change |
| `audit_rework_prices(client_id, item, price, source, confirmed_by)` | Rework item prices (inferred / confirmed) |
| `audit_rules(client_id NULL = every client, name, condition_type, conditions, expectation, effective_from, active)` | Owner-defined audit rules (I3) |
| `audit_reviews(subject, check_code, client_id, invoice_id, status, amount, note, updated_by)` | Review of one finding (I3; findings themselves are recomputed, not stored) |
| `audit_invoice_reviews(invoice_id, status, note, updated_by, updated_at)` | Invoice status: not reviewed, in review, signed off (I3) |
| `audit_events(at, actor, action, client_id, invoice_id, subject, check_code, before, after, note)` | Append-only audit trail (I3) |

Backfill: about 207 confirmed invoices × 5 detail calls ≈ 1,000 read-only calls, once (a few minutes). After that, about 120 calls a month when the new invoices land.

## Stages

### I1 — Access + billed data
**Model**: Opus 5.5 (permission boundary, sync semantics).
**Work**: owner list + `user_permissions` + server check on `/api/audit/*` + `/api/me.permissions`; owner access panel; `invoice_orders` / `invoice_extra_lines` sync (backfill + nightly for new/edited invoices) + reconcile; rate-card and order-rule snapshots; the **Invoice audit** screen showing billed per-order breakdowns, postage margin, credits and coverage checks A1–A4, plus D13 and E15.
**DoD**
- [x] Only the owner sees the module; a granted warehouse user sees it within a minute; a revoked one loses it; a client user gets 403 even with a grant row (harness).
- [x] Reconcile: `invoice_orders` and `invoice_extra_lines` 0 missing / extra / drift for all confirmed invoices.
- [x] For three sampled invoices, the sum of the lines equals the invoice header (or the difference is shown and explained).
- [x] Coverage report for the last 3 closed months: unbilled / double-billed / cancelled-billed counts, with order numbers.

### I2 — Rate-card and rules engine
**Model**: Opus 5.5 (rule semantics).
**Work**: order-rule evaluator (all `ConditionOptions` fields we can compute; unsupported ones reported, never guessed); order volume/weight from product data; rework-price inference + confirmation screen; picking/admin/goods-in expected charges; checks B5–B8, C9–C12, D14; accuracy per client.
**DoD**
- [x] Unit tests for every operator and the fields used by current client rules.
- [x] Serendipity Sep + Oct 2026: the engine reproduces billed rework on ≥ 98 % of orders; every other order is listed with the reason.
- [x] Picking expectation matches billed picking on ≥ 98 % of orders for three clients with different picking methods.

### I3 — Review workflow, overview and preview
**Model**: Sonnet 5 (UI from this spec); Opus 5.5 reviews the permission checks and money maths.
**Work**: audit overview, findings review (statuses, notes, audit trail), invoice sign-off, custom audit rules builder, current-month preview vs accruals, CSV exports.
**DoD**
- [x] A flagged line can be marked and noted; an invoice can be signed off; all of it appears in the audit trail.
- [x] The current-month preview total is within the accrual summary or the difference is explained per category.
- [x] Harness 0 failures; screenshots of overview, invoice audit and order drill-down.

## Defaults (change any of these before I1 starts)

- Audits cover **all** confirmed invoices back to the start of the data, not just recent months.
- A difference of **£0.01** or less is treated as rounding.
- Findings are internal and never shown to client users.
- Rework item prices are **inferred, then confirmed** by the owner before they drive "missing / extra rework" flags.

## Stage log

| Stage | Date | Branch | Model | Evidence |
|---|---|---|---|---|
| I1 | 2026-11-04 | `v3/i1-invoice-audit` | Opus 5.5 | Backfill 212 invoices → 17,570 order lines + 1,666 other lines in 25–27 s (1,060 calls); reconcile `invoice_detail_all`: 0 missing / extra / drift on every line and all 212 invoice headers; integrity 211/212 invoices equal their lines to the penny (all since Jul 2025; the exception is a Feb 2025 "bulk adjustment" at −£0.02 rounding over 139 goods-in lines); coverage Aug–Oct 2026: 0 unbilled, 0 double-billed, 0 billed while cancelled/undespatched, 20 zero-charge or noted lines; `npm test` 18/18; harness 72/72 (22 new access checks) |
| I3 | 2026-11-04 | `v3/i3-review-workflow` | Opus 5.5 | Review round trip on invoice #348 (Lawful London, Oct 2026), all in the trail: a finding marked "to credit" with a note (open 3 → 2, invoice moved to "in review" by itself); sign-off with open findings refused without a note, then accepted with one (open count recorded); a change on the signed-off invoice refused (409); reopen and reset. View-only users get 403 on every change; a reviewer can mark findings. Preview vs Mintsoft's running total, 4 Nov: every one of 18 clients matches or is explained per category (picking, rework and admin to the penny for 12 of the 14 with order charges; Luff Sleep explained by 3 bulk store orders and 2 never-priced rework items; Amaura's pattern too weak to judge £2.46). Goods-in since Jul 2025: 45 warnings. `npm test` 42/42; harness 139/139 (57 new); screenshots `wh-34` overview, `wh-30` invoice audit, `wh-31` order drill-down, `wh-32` preview, `wh-33` rules |
| I2 | 2026-11-04 | `v3/i2-rules-engine` | Opus 5.5 | Serendipity rework Aug+Sep 2026 (Oct not yet invoiced): 801/810 reproduced (98.9 %), every other order listed with its reason (5 product edited after billing, 4 manually zeroed; 4 more uncertain, missing dimensions); since Feb 2026 6,356/6,375 (99.7 %). Picking Aug+Sep: Mexeco (per item) 141/141, Afida (per order + SKU + unit) 115/115, Serendipity (per order line) 810/810. `npm test` 30/30; harness 82/82 |

I1 notes: how Mintsoft builds an invoice (worked out from the data, not documented by Mintsoft)
- Order-line fields sum into their categories: picking = Σ `TotalPickingCost` (incl. extra picking), postage = Σ `PostageCost`, rework, packaging, admin, VAT-free postage likewise.
- Goods-in line = `TotalUnitCost + AdminCost + DeliverySizeCost × Quantity + TotalPerSkuCost`. The first version missed the quantity multiplier, which matched only 53 of 144 invoices with goods-in.
- An "Other" line adds to the category of its charge type (Picking, Postage, Rework, Packaging, GoodsIn, Returns, Storage). Only Admin and Generic types count as "other items". Treating every "Other" line as other items broke 62 invoices.
- Storage is only partly itemised (Storage-type Other lines). Daily storage charges are not listed, so storage is shown and never counted as a mismatch.
- Mintsoft no longer holds order and return lines for some invoices from before Jul 2025 (32 without order lines, plus 13 returns-only gaps for deleted clients 5, 9, 11). Those categories show as "not available" on old invoices only; on newer invoices a charge without lines is a real difference.
- Order-line `Comments` lists the rework items charged ("<item>- X <qty>", the name can be blank). Other lines are typed notes: 41 across all invoices, e.g. "Zerod All Costs", "Short Shipped …". One rework item is literally named "pricing need adding" (for I2's price review).
- `CostPostageCost` is 0 when Mintsoft does not know the courier cost (most APC Next Day, all pallet services, many FedEx). Margin is calculated only where it is known, and the rest are counted (462 orders Aug–Oct).
- A line's `InvoiceDate` is 2.5–9.5 h after despatch. Orders despatched within 12 h of a client's latest billing run count as "awaiting next invoice", not unbilled. On 4 Nov 2026, October was not yet invoiced for 14 clients.

I2 notes: what the data showed (and the engine now uses)
- Order volume = Σ width × height × depth × qty / 1,000,000 (Mintsoft dimensions are cm). It reproduces Serendipity's SW-BOX / DW-BOX choice on 98.9 % of Aug–Sep orders.
- List conditions (SKUs, names, categories) match when any item matches. This fits Luff Sleep's courier rules better (171/176 vs 170/176 for "joined list").
- Rules count from their last edit. An order placed before a rule was edited is uncertain only if it disagrees with today's rules: Luff Sleep's BEDDING and SMALL-SUGAR rules date from 16–26 Oct 2026, so their absence from the September invoice is not leakage.
- Rework prices are not in the API. They are learned per month from single-item orders (second pass: billed minus the other items' known price), and an item can change price mid-month (SW-BOX £0.18 → £0.14 in Feb 2026). Users can confirm a price from a date (`audit_rework_prices`).
- Picking: Mintsoft exposes only today's rate card, and rates have changed (Serendipity was billed £1.75 + £0.39 per extra unit until now; its card says £1.45 per order line, which is what its wholesale orders pay). Each order is checked against today's card and against the pattern learned for its month and channel. SKUs never charged are learned from billing (spray heads, pipette and spoon at Serendipity; rule-added leaflets at Ovviovita). Clients whose pattern is not reproduced (Ovviovita 49 %, Amaura 41 %) get no order-level picking flags.
- Bulk orders billed below the per-unit rate (e.g. Abbots FBA 230 units at £15.50 vs £88.29) and repeated flat charges (£15 / £15.50 caps) are notes, not warnings.
- Hand-added rework at £0.00 is flagged with the item's usual price (Lawful London: 15 lines).

Moved to I3: goods-in rate checks (B7), owner-defined audit rules (C11), postage outliers (D14), plus the review workflow already planned there.

I3 notes: review workflow, preview and the checks moved from I2
- A finding is identified by its subject and check: `line:<invoice line>`, `extra:goods_in:<line>`, `invoice:<id>` (header ≠ lines) or `order:<id>` (despatched, never billed), plus the flag code (`audit_rule:<id>` for your own rules). Errors and warnings need a review; notes can be reviewed but never count as open. Reviews live in `audit_reviews`; invoice status in `audit_invoice_reviews`. Planned `audit_findings` was not needed: findings are recomputed from the data, so a resync or a corrected rule updates them, and reviews attach by key.
- Statuses: a finding is OK, to credit or to charge (the last two need a note and can carry an amount). An invoice goes Not reviewed → In review (automatically, at its first review) → Signed off. Signing off with open findings needs a note, and the number left open is recorded. A signed-off invoice is locked (409) until it is reopened.
- Every review, invoice status change, price confirmation and audit-rule change is written to `audit_events` in the same transaction as the change, so the trail cannot miss one.
- Two levels of access: `invoice_audit` (view) and `invoice_audit_review` (review, sign off, confirm prices, edit audit rules). The owner holds both and sets them on the Access page. The server checks every change; the UI only hides the controls.
- Goods-in (B7), worked out from 2026 lines: admin = `AdminChargePerASN` + hours logged on the ASN × `HourRateChargeForASN` (Afida £8.45 = £4.45 + 0.1 h × £40; Rachel Winham £18.35 = £4.75 + 0.34 h × £40). Per unit and per SKU follow the card; the delivery charge must be one of the card's carton, pallet or container costs (the ASN's own type does not say which was billed). Mintsoft only exposes today's card. Lines billed before our first snapshot are checked only where most of the client's goods-in within ±45 days were charged at that card's rate; otherwise they are listed as "rate at the time unknown". The first version flagged any line near one card-rate line and raised 294 warnings; Mokee charged 9 of 10 ASNs in a month at £0 per unit against a £0.35 card. Since Jul 2025: 45 warnings (16 per-unit, 8 per-SKU, 21 admin, e.g. Mexeco container fees typed into admin) and 49 notes.
- Postage (D14): a service is flat-rate in a month when at least 80 % of 10 or more orders paid the same per parcel. Orders on it charged differently are notes, never warnings (230 since Jul 2025).
- Your own audit rules (C11) use the Mintsoft condition fields and operators the engine can evaluate, with four expectations: charges a rework item, charges at least £x, charges at most £x, or does not charge a category. They apply to one client or every client, optionally from an invoice date. Rules the audit cannot read are counted as "could not be read", never guessed.
- Month-to-date preview: Mintsoft bills once a day at about 19:05 London. The accrual summary's `LastUpdated` is the latest run that changed the client's total. The orders in the running total are those despatched after the previous month's last run, up to that time; for Luff Sleep on 4 Nov the 73 orders match the summary's 73 parcels. The summary has no ID, so Mintsoft offers no per-order lines before the invoice. Picking uses the latest month with at least 15 orders, and the rate card when it reproduces at least as many orders as the learned pattern (KiDSiE's September pattern came from one single-unit order and could not know the extra-unit rate).
- Preview vs Mintsoft, Nov 2026 (14 clients with a running total): picking, rework and admin match to the penny for 12. Luff Sleep is explained by 3 bulk store orders, which Mintsoft charges a flat rate by hand (in September £15–£30 each). Its BEDDING and SMALL-SUGAR rework items have never been invoiced, so their price is unknown (£12.62 for 25 items, about £0.50 each); confirm it under Rates & rules. Amaura's pattern reproduces only 79 % of orders, so its £2.46 difference is within the estimate.
