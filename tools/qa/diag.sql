-- tools/qa/diag.sql — database health snapshot. Run:
--   psql "$DATABASE_URL" -f tools/qa/diag.sql
\pset format aligned
\echo '=== row counts ==='
SELECT relname AS table, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY relname;

\echo '=== sync_jobs (last 15) ==='
SELECT id, entity, triggered_by, status, records_synced, current_step, left(error,120) AS error, started_at, completed_at, completed_at - started_at AS duration
FROM sync_jobs ORDER BY started_at DESC LIMIT 15;

\echo '=== clients ==='
SELECT id, name, short_name, active FROM clients ORDER BY id;

\echo '=== orders: range, status mix, per-month coverage ==='
SELECT COUNT(*) AS orders, MIN(order_date)::date AS min_order, MAX(order_date)::date AS max_order, MAX(despatch_date)::date AS max_desp, MAX(synced_at) AS last_synced FROM orders;
SELECT status_id, status_name, COUNT(*) FROM orders GROUP BY 1,2 ORDER BY 3 DESC;
SELECT to_char(date_trunc('month', order_date),'YYYY-MM') AS month, COUNT(*) AS orders,
       COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id)) AS with_items,
       COUNT(*) FILTER (WHERE despatch_date IS NOT NULL) AS despatched,
       COUNT(*) FILTER (WHERE status_name='Cancelled') AS cancelled,
       COUNT(*) FILTER (WHERE client_id IS NULL) AS null_client
FROM orders o GROUP BY 1 ORDER BY 1 DESC LIMIT 30;

\echo '=== products / stock ==='
SELECT COUNT(*) AS products, COUNT(client_id) AS with_client, COUNT(*) FILTER (WHERE bundle) AS bundles, COUNT(*) FILTER (WHERE discontinued) AS discontinued, MAX(synced_at) FROM products;
SELECT COUNT(*) AS stock_rows, COUNT(DISTINCT client_id) AS clients, SUM(qty_on_hand) AS on_hand, MAX(updated_at) FROM product_stock_levels;

\echo '=== invoices per month (incl. unlinked clients) ==='
SELECT to_char(date_trunc('month', invoice_date),'YYYY-MM') AS month, COUNT(*) AS invoices, COUNT(*) FILTER (WHERE client_id IS NULL) AS null_client,
       ROUND(SUM(picking_cost+postage_cost+vat_free_postage_cost+storage_cost+goods_in_cost+returns_cost+rework_cost+packaging_cost+generic_items_cost+collections_cost+admin_fee),2) AS total
FROM invoices GROUP BY 1 ORDER BY 1 DESC LIMIT 18;

\echo '=== accruals ==='
SELECT client_id, period_month, updated_at FROM invoice_accruals ORDER BY period_month DESC, client_id LIMIT 20;

\echo '=== asns ==='
SELECT COUNT(*) AS asns, MAX(booked_in_date)::date AS max_booked, MAX(synced_at), COUNT(*) FILTER (WHERE client_id IS NULL) AS null_client FROM asns;

\echo '=== forecast runs ==='
SELECT id, client_id, status, stats->>'skus' AS skus, stats->>'horizonWmape' AS horizon_wmape, started_at FROM forecast_runs ORDER BY id DESC LIMIT 5;

\echo '=== timezone / size ==='
SHOW timezone;
SELECT pg_size_pretty(pg_database_size(current_database()));
