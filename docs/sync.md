# Mintsoft sync — runbook

The database is a copy of Mintsoft. Mintsoft is the source of truth, and the sync only **reads** from it (HTTP GET). It never creates, edits or deletes anything in Mintsoft. Code: `server/sync/`.

## What runs when (Europe/London)

| Run | When | What it does | Typical cost |
|---|---|---|---|
| hourly | every hour at :15 | clients, products changed since the last run, all stock, stock by location/batch, orders changed since the last run (with items), ASNs changed since the last run (with items), current-month accruals | ~35 API calls, < 1 min |
| nightly | 02:15 | hourly + reference data (statuses, channels, couriers, warehouses) + invoices dated in the last 120 days + **invoice detail** for new or edited invoices + client **rate cards and order rules** (a snapshot when they change) | ~80 calls, plus 5 per new or edited invoice |
| full | Sundays 03:15, and automatically on the first boot of this engine | everything from scratch; then removes rows Mintsoft has deleted | ~270 calls, ~2 min |
| reconcile | after the Sunday full | re-reads Mintsoft and compares every column with the database | ~250 calls, ~2 min |

- "Changed since the last run" uses Mintsoft `SinceLastUpdated`, starting 2 hours before the previous successful run (overlap, so nothing slips between runs).
- Only one run at a time (Postgres advisory lock). A run that finds another in progress is skipped, not queued.
- Each run is a row in `sync_jobs`. `steps` holds per-step counts, timings and API calls. `heartbeat_at` updates while it runs. A row left `running` by a killed process is marked `abandoned`.
- Clients missing from Mintsoft's client list (inactive or on stop) are fetched by id and kept with `active = false`, so no order, product, ASN or invoice ever has a missing client.
- Deletions only happen after a complete full crawl. If more than 2 % of a table would go (minimum 50 rows), nothing is deleted and the step reports it.

## Commands (any machine with DATABASE_URL and MINTSOFT_ADMIN_KEY)

```bash
node server/sync/cli.js hourly        # or nightly / full
node server/sync/cli.js reconcile     # prints the match table; exit 1 if anything differs
node server/sync/cli.js reconcile orders,invoices --json=out.json
psql "$DATABASE_URL" -f tools/qa/diag.sql
npm test                              # unit tests (dates, mappers)
```

On Render, run them from the service **Shell** tab.

## Reading a reconcile

| Column | Meaning |
|---|---|
| matched | identical in Mintsoft and the database, every column |
| changedSinceSync | Mintsoft edited or created it after the last sync started; the next hourly run picks it up |
| missingInDb / extraInDb / drift | real differences, which should be 0. Look at the printed samples |

The `clients` row shows more clients in the database than in Mintsoft's list. Those are inactive clients kept for their history.

## Field notes

- Timestamps: Mintsoft sends UK wall-clock time without an offset. It is stored as the correct instant (`server/sync/time.js`), and every database session uses `Europe/London`.
- Stock: `qty_on_hand` = Mintsoft `Level` (free stock, what the reports use), `qty_total` = `TotalStockLevel` (physical), `qty_allocated` = the difference.
- Status names are stored in readable form (`Despatched`, `Invoice Failed`). Mintsoft's own lookup returns codes (`DESPATCHED`).
- Money and weight columns are unrestricted `NUMERIC`, so values such as a 1.275 discount are kept exactly.

## Invoice detail (Invoice Audit)

- `invoice_orders`: one row per order line of every confirmed invoice (`/api/Accounting/Invoice/{id}/Orders`). `invoice_extra_lines`: goods-in, returns, other and collections lines.
- Fetched when an invoice is new or its `LastUpdated` changed. Full runs also re-read invoices from the last 100 days. If a boot finds invoices without detail (e.g. the first deploy), it runs the nightly steps straight away.
- `client_rate_cards` / `client_order_rules`: snapshots of each client's Mintsoft pricing fields and order rules, written only when they change (no contact or address data).
- Reconcile: `node server/sync/cli.js reconcile invoice_detail` (last 100 days, part of the weekly reconcile) or `invoice_detail_all` (every invoice, ~1,060 calls).
- Per-order detail only exists once Mintsoft confirms an invoice. The current month has totals only (accruals).
- `invoice_accruals.source_updated_at` is the accrual summary's `LastUpdated`: the time of Mintsoft's latest daily billing run that changed that client's running total (about 19:05 London). Invoice Audit's month-to-date preview uses it as the end of the window of orders in the running total. The summary has `ID` 0, so its order lines cannot be fetched until the invoice is confirmed.
