// ─── server/schema.js ─────────────────────────────────────────────────────────
// Single-tenant schema — one deployment per 3PL organisation.
// All CREATE/ALTER statements are idempotent — safe to run on every boot.

const { query } = require('./db');

async function ensureCoreSchema() {

  // ── Reference / Lookup tables ─────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS order_status_types (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS asn_status_types (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      colour    TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_channels (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      logo        TEXT,
      client_id   INTEGER,
      active      BOOLEAN DEFAULT TRUE,
      synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS couriers (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      active    BOOLEAN DEFAULT TRUE,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Core entities ─────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      code      TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS clients (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      short_name TEXT,
      active     BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMPTZ,
      synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Products ──────────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id                          INTEGER PRIMARY KEY,
      client_id                   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      sku                         TEXT NOT NULL,
      name                        TEXT,
      description                 TEXT,
      customs_description         TEXT,
      ean                         TEXT,
      upc                         TEXT,
      weight                      NUMERIC(10,4),
      height                      NUMERIC(10,4),
      width                       NUMERIC(10,4),
      depth                       NUMERIC(10,4),
      price                       NUMERIC(12,2),
      cost_price                  NUMERIC(12,2),
      vat_exempt                  BOOLEAN DEFAULT FALSE,
      back_order                  BOOLEAN DEFAULT FALSE,
      bundle                      BOOLEAN DEFAULT FALSE,
      discontinued                BOOLEAN DEFAULT FALSE,
      low_stock_alert_level       INTEGER,
      handling_time               INTEGER,
      units_per_parcel            INTEGER,
      additional_parcels_required INTEGER,
      has_batch_number            BOOLEAN DEFAULT FALSE,
      has_serial_number           BOOLEAN DEFAULT FALSE,
      has_expiry_date             BOOLEAN DEFAULT FALSE,
      best_before_warning_days    INTEGER,
      image_url                   TEXT,
      country_of_manufacture_id   INTEGER,
      commodity_code              TEXT,
      packing_instructions        TEXT,
      subscription                BOOLEAN DEFAULT FALSE,
      category                    TEXT,
      supplier                    TEXT,
      updated_at                  TIMESTAMPTZ,
      synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Backfill columns for existing deployments (no-op if already present).
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier TEXT`);

  await query(`
    CREATE TABLE IF NOT EXISTS product_stock_levels (
      product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      sku           TEXT NOT NULL,
      qty_on_hand   INTEGER NOT NULL DEFAULT 0,
      qty_allocated INTEGER NOT NULL DEFAULT 0,
      qty_available INTEGER NOT NULL DEFAULT 0,
      qty_pre_order INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (product_id, warehouse_id)
    )
  `);

  // ── Orders ────────────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                      INTEGER PRIMARY KEY,
      warehouse_id            INTEGER REFERENCES warehouses(id),
      client_id               INTEGER REFERENCES clients(id),
      order_number            TEXT,
      external_reference      TEXT,
      status_id               INTEGER,
      status_name             TEXT,
      channel_id              INTEGER,
      channel_name            TEXT,
      order_date              TIMESTAMPTZ,
      despatch_date           TIMESTAMPTZ,
      required_despatch_date  TIMESTAMPTZ,
      required_delivery_date  TIMESTAMPTZ,
      sla_warning_date        TIMESTAMPTZ,
      sla_despatch_date       TIMESTAMPTZ,
      recipient_title         TEXT,
      recipient_first_name    TEXT,
      recipient_last_name     TEXT,
      recipient_company       TEXT,
      address1                TEXT,
      address2                TEXT,
      address3                TEXT,
      town                    TEXT,
      county                  TEXT,
      postcode                TEXT,
      country_id              INTEGER,
      phone                   TEXT,
      mobile                  TEXT,
      email                   TEXT,
      courier_service_id      INTEGER,
      courier_service_name    TEXT,
      courier_service_type_id INTEGER,
      tracking_number         TEXT,
      tracking_url            TEXT,
      number_of_parcels       INTEGER DEFAULT 1,
      total_weight            NUMERIC(10,4),
      order_value             NUMERIC(12,2),
      shipping_net            NUMERIC(12,2),
      shipping_tax            NUMERIC(12,2),
      shipping_gross          NUMERIC(12,2),
      discount_net            NUMERIC(12,2),
      discount_tax            NUMERIC(12,2),
      discount_gross          NUMERIC(12,2),
      total_order_net         NUMERIC(12,2),
      total_order_tax         NUMERIC(12,2),
      total_order_gross       NUMERIC(12,2),
      total_vat               NUMERIC(12,2),
      currency_id             INTEGER,
      comments                TEXT,
      delivery_notes          TEXT,
      gift_messages           TEXT,
      vat_number              TEXT,
      source                  TEXT,
      order_lock              BOOLEAN DEFAULT FALSE,
      pii_removed             BOOLEAN DEFAULT FALSE,
      despatched_by_user      TEXT,
      part                    INTEGER DEFAULT 1,
      number_of_parts         INTEGER DEFAULT 1,
      updated_at              TIMESTAMPTZ,
      synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id            INTEGER PRIMARY KEY,
      order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
      sku           TEXT NOT NULL,
      quantity      INTEGER NOT NULL DEFAULT 0,
      allocated     INTEGER DEFAULT 0,
      committed     INTEGER DEFAULT 0,
      on_back_order INTEGER DEFAULT 0,
      price         NUMERIC(12,2),
      price_net     NUMERIC(12,2),
      vat           NUMERIC(12,2),
      discount      NUMERIC(12,2),
      updated_at    TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_shipments (
      id                 INTEGER PRIMARY KEY,
      order_id           INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      tracking_number    TEXT,
      courier_service_id INTEGER,
      despatched_at      TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ
    )
  `);

  // ── ASNs (Goods In / Advance Shipping Notices) ────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS asns (
      id                    INTEGER PRIMARY KEY,
      warehouse_id          INTEGER REFERENCES warehouses(id),
      client_id             INTEGER REFERENCES clients(id),
      po_reference          TEXT,
      supplier_name         TEXT,
      product_supplier_id   INTEGER,
      goods_in_type         TEXT,
      quantity              INTEGER,
      status_id             INTEGER,
      status_name           TEXT,
      estimated_delivery    TIMESTAMPTZ,
      warehouse_booked_date TIMESTAMPTZ,
      booked_in_date        TIMESTAMPTZ,
      comments              TEXT,
      shipped               BOOLEAN DEFAULT FALSE,
      hours_logged          NUMERIC(8,2) DEFAULT 0,
      updated_at            TIMESTAMPTZ,
      synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS asn_items (
      id           SERIAL PRIMARY KEY,
      asn_id       INTEGER NOT NULL REFERENCES asns(id) ON DELETE CASCADE,
      product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
      sku          TEXT,
      expected_qty INTEGER DEFAULT 0,
      received_qty INTEGER DEFAULT 0,
      updated_at   TIMESTAMPTZ
    )
  `);

  // ── Invoices / Accounting ─────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id                    INTEGER PRIMARY KEY,
      client_id             INTEGER REFERENCES clients(id),
      name                  TEXT,
      invoice_date          TIMESTAMPTZ,
      comments              TEXT,
      number_of_parcels     INTEGER DEFAULT 0,
      number_of_items       INTEGER DEFAULT 0,
      picking_cost          NUMERIC(12,2) DEFAULT 0,
      postage_cost          NUMERIC(12,2) DEFAULT 0,
      vat_free_postage_cost NUMERIC(12,2) DEFAULT 0,
      storage_cost          NUMERIC(12,2) DEFAULT 0,
      goods_in_cost         NUMERIC(12,2) DEFAULT 0,
      returns_cost          NUMERIC(12,2) DEFAULT 0,
      rework_cost           NUMERIC(12,2) DEFAULT 0,
      packaging_cost        NUMERIC(12,2) DEFAULT 0,
      generic_items_cost    NUMERIC(12,2) DEFAULT 0,
      collections_cost      NUMERIC(12,2) DEFAULT 0,
      admin_fee             NUMERIC(12,2) DEFAULT 0,
      updated_at            TIMESTAMPTZ,
      synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS invoice_accruals (
      client_id             INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      period_month          DATE NOT NULL,
      picking_cost          NUMERIC(12,2) DEFAULT 0,
      postage_cost          NUMERIC(12,2) DEFAULT 0,
      vat_free_postage_cost NUMERIC(12,2) DEFAULT 0,
      storage_cost          NUMERIC(12,2) DEFAULT 0,
      goods_in_cost         NUMERIC(12,2) DEFAULT 0,
      returns_cost          NUMERIC(12,2) DEFAULT 0,
      rework_cost           NUMERIC(12,2) DEFAULT 0,
      packaging_cost        NUMERIC(12,2) DEFAULT 0,
      generic_items_cost    NUMERIC(12,2) DEFAULT 0,
      collections_cost      NUMERIC(12,2) DEFAULT 0,
      admin_fee             NUMERIC(12,2) DEFAULT 0,
      number_of_parcels     INTEGER DEFAULT 0,
      number_of_items       INTEGER DEFAULT 0,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, period_month)
    )
  `);

  // ── Sync tracking ─────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id             SERIAL PRIMARY KEY,
      triggered_by   TEXT NOT NULL DEFAULT 'cron',
      trigger_key    TEXT,
      entity         TEXT NOT NULL DEFAULT 'full',
      status         TEXT NOT NULL DEFAULT 'running',
      records_synced INTEGER NOT NULL DEFAULT 0,
      current_step   TEXT,
      error          TEXT,
      started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ
    )
  `);

  // Sync engine (server/sync/): heartbeat for zombie detection, per-step
  // results and the Mintsoft call count of each run.
  await query(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`);
  await query(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS steps JSONB`);
  await query(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS api_calls INTEGER`);

  // Incremental cursors: an entity's cursor is the start time of the last run
  // in which that entity synced successfully.
  await query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      entity          TEXT PRIMARY KEY,
      cursor          TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_job_id     INTEGER,
      rows_last_run   INTEGER
    )
  `);

  // Mintsoft TotalStockLevel (physical, including allocated). qty_on_hand stays
  // Mintsoft "Level" (free stock), which is what the reports use.
  await query(`ALTER TABLE product_stock_levels ADD COLUMN IF NOT EXISTS qty_total INTEGER`);

  // Mirrored money/weight columns store Mintsoft's exact values (it keeps e.g.
  // item discounts to 3 dp), so drop the NUMERIC(p,s) limits. Widening only.
  const constrained = await query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND data_type = 'numeric' AND numeric_precision IS NOT NULL
       AND table_name = ANY($1)`,
    [['orders', 'order_items', 'products', 'asns', 'invoices', 'invoice_accruals']]
  );
  for (const { table_name, column_name } of constrained) {
    await query(`ALTER TABLE ${table_name} ALTER COLUMN ${column_name} TYPE NUMERIC`);
  }

  // ── Subscription modules (server/entitlements.js) ─────────────────────────
  // Catalogue of modules, per-client entitlements, an audit trail of every
  // change, and small app-wide settings (e.g. default modules for new clients).

  await query(`
    CREATE TABLE IF NOT EXISTS modules (
      key                 TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT,
      monthly_price_pence INTEGER,            -- NULL = price to be confirmed
      currency            TEXT NOT NULL DEFAULT 'GBP',
      is_core             BOOLEAN NOT NULL DEFAULT FALSE,
      sort                INTEGER NOT NULL DEFAULT 0,
      active              BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS client_subscriptions (
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      module_key  TEXT NOT NULL REFERENCES modules(key),
      status      TEXT NOT NULL DEFAULT 'active',   -- active | trial | suspended | cancelled
      starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at     TIMESTAMPTZ,                       -- NULL = open-ended
      price_pence INTEGER,                           -- per-client override; NULL = module price
      billing_ref TEXT,                              -- future payment-provider reference
      notes       TEXT,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, module_key)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS subscription_events (
      id         SERIAL PRIMARY KEY,
      at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      client_id  INTEGER,
      module_key TEXT,
      before     JSONB,
      after      JSONB
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── User sessions (cache per API key) ─────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      api_key       TEXT PRIMARY KEY,
      username      TEXT,
      is_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
      client_id     INTEGER,
      warehouse_ids INTEGER[],
      session_data  JSONB,
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      synced_at     TIMESTAMPTZ
    )
  `);

  // ── Calendar ──────────────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
      client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      description  TEXT,
      event_type   TEXT NOT NULL DEFAULT 'manual',
      start_date   DATE NOT NULL,
      start_time   TIME,
      end_date     DATE,
      end_time     TIME,
      colour       TEXT NOT NULL DEFAULT '#1f22ac',
      all_day      BOOLEAN NOT NULL DEFAULT TRUE,
      created_by   TEXT,
      external_id  INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calendar_event_shares (
      event_id  INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, client_id)
    )
  `);

  // ── Returns ───────────────────────────────────────────────────────────────
  // Shared workflow record: a client books a return, warehouse books the
  // collection. Status is the single source of truth for every user with access.
  // Client-submitted fields live in form_data; warehouse booking fields in
  // booking_data (exact fields are finalised in the UI, so they stay flexible).

  await query(`
    CREATE TABLE IF NOT EXISTS returns (
      id            SERIAL PRIMARY KEY,
      client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      reference     TEXT,                       -- promoted for listing/search (e.g. order no)
      customer_name TEXT,                        -- promoted for listing
      form_data     JSONB NOT NULL DEFAULT '{}', -- full client submission
      booking_data  JSONB NOT NULL DEFAULT '{}', -- warehouse booking details
      created_by    TEXT,                        -- client user who raised it
      booked_by     TEXT,                        -- warehouse user who actioned it
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Soft-delete: warehouse users can remove a return from history into a
  // "deleted returns" list that clients never see. NULL = live/visible.
  await query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS deleted_by TEXT`);

  // ── Indexes ───────────────────────────────────────────────────────────────

  await query(`CREATE INDEX IF NOT EXISTS returns_client_idx               ON returns (client_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS returns_status_idx               ON returns (status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS returns_deleted_idx              ON returns (deleted_at)`);
  await query(`CREATE INDEX IF NOT EXISTS orders_warehouse_order_date_idx   ON orders (warehouse_id, order_date DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS orders_warehouse_despatch_idx     ON orders (warehouse_id, despatch_date DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS orders_client_order_date_idx      ON orders (client_id, order_date DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS orders_client_despatch_idx        ON orders (client_id, despatch_date DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS orders_status_name_idx            ON orders (status_name)`);
  await query(`CREATE INDEX IF NOT EXISTS orders_updated_at_idx             ON orders (updated_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS order_items_order_idx             ON order_items (order_id)`);
  await query(`CREATE INDEX IF NOT EXISTS order_items_sku_idx               ON order_items (sku)`);
  await query(`CREATE INDEX IF NOT EXISTS order_items_product_idx           ON order_items (product_id)`);
  await query(`CREATE INDEX IF NOT EXISTS products_client_sku_idx           ON products (client_id, sku)`);
  await query(`CREATE INDEX IF NOT EXISTS products_updated_at_idx           ON products (updated_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS product_stock_client_wh_idx       ON product_stock_levels (client_id, warehouse_id)`);
  await query(`CREATE INDEX IF NOT EXISTS product_stock_sku_idx             ON product_stock_levels (sku)`);
  await query(`CREATE INDEX IF NOT EXISTS asns_warehouse_status_idx         ON asns (warehouse_id, status_id)`);
  await query(`CREATE INDEX IF NOT EXISTS asns_estimated_delivery_idx       ON asns (estimated_delivery)`);
  await query(`CREATE INDEX IF NOT EXISTS asns_updated_at_idx              ON asns (updated_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS invoices_client_date_idx          ON invoices (client_id, invoice_date DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS sync_jobs_started_at_idx          ON sync_jobs (started_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS asn_items_asn_idx                 ON asn_items (asn_id)`);
  await query(`CREATE INDEX IF NOT EXISTS invoices_date_idx                 ON invoices (invoice_date)`);

  // ── Forecasting / Inventory Planner ─────────────────────────────────────────
  // Per-client demand forecasting + reorder planning. See docs/forecasting-module-plan.html.

  // Layered configuration (scope: 'client' | 'category' | 'sku'). settings JSONB
  // holds only overrides; engine defaults fill the rest.
  await query(`
    CREATE TABLE IF NOT EXISTS forecast_config (
      id         SERIAL PRIMARY KEY,
      client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      scope      TEXT NOT NULL DEFAULT 'client',   -- client | category | sku
      scope_ref  TEXT,                              -- category name / sku (NULL for client scope)
      settings   JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, scope, scope_ref)
    )
  `);

  // Known demand events: promotions, scheduled trade/pallet orders, manual adjustments.
  await query(`
    CREATE TABLE IF NOT EXISTS demand_events (
      id         SERIAL PRIMARY KEY,
      client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      sku        TEXT,                              -- NULL = applies to category/all
      category   TEXT,
      type       TEXT NOT NULL,                     -- promo | trade_order | adjustment
      start_date DATE NOT NULL,
      end_date   DATE,
      factor     NUMERIC(8,3),                      -- uplift multiplier (promo)
      qty        INTEGER,                           -- known absolute units (trade order)
      note       TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Client-entered lead times. sku NULL = supplier default; sku set = override.
  await query(`
    CREATE TABLE IF NOT EXISTS supplier_lead_times (
      id             SERIAL PRIMARY KEY,
      client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      supplier       TEXT,
      sku            TEXT,
      lt_days        INTEGER NOT NULL,
      lt_spread_days INTEGER DEFAULT 0,             -- ± variability for safety stock
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (client_id, supplier, sku)
    )
  `);

  // One row per engine run.
  await query(`
    CREATE TABLE IF NOT EXISTS forecast_runs (
      id          SERIAL PRIMARY KEY,
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      status      TEXT NOT NULL DEFAULT 'running',  -- running | done | error
      stats       JSONB NOT NULL DEFAULT '{}',
      error       TEXT,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `);

  // Forecast time-series output (one row per sku per future bucket).
  await query(`
    CREATE TABLE IF NOT EXISTS forecast_results (
      id           SERIAL PRIMARY KEY,
      run_id       INTEGER NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
      client_id    INTEGER NOT NULL,
      sku          TEXT NOT NULL,
      grain        TEXT NOT NULL DEFAULT 'week',     -- week | month
      bucket_date  DATE NOT NULL,                    -- start of the forecast bucket
      yhat         NUMERIC(12,3) NOT NULL,
      yhat_lo      NUMERIC(12,3),
      yhat_hi      NUMERIC(12,3),
      method       TEXT
    )
  `);

  // Reorder recommendation (one row per sku per run — the planner overview).
  await query(`
    CREATE TABLE IF NOT EXISTS reorder_plan (
      id             SERIAL PRIMARY KEY,
      run_id         INTEGER NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
      client_id      INTEGER NOT NULL,
      sku            TEXT NOT NULL,
      name           TEXT,
      demand_class   TEXT,
      method         TEXT,
      weekly_demand  NUMERIC(12,3),
      on_hand        INTEGER,
      on_order       INTEGER,
      allocated      INTEGER,
      lead_days      INTEGER,
      safety_stock   NUMERIC(12,3),
      reorder_point  NUMERIC(12,3),
      order_qty      INTEGER,
      order_by_date  DATE,
      stockout_date  DATE,
      weeks_cover    NUMERIC(8,2),
      wmape          NUMERIC(8,3),
      flags          JSONB NOT NULL DEFAULT '[]'
    )
  `);
  // Transparency fields for the drill-down (added post-hoc; no-op if present).
  await query(`ALTER TABLE reorder_plan ADD COLUMN IF NOT EXISTS mase              NUMERIC(8,3)`);
  await query(`ALTER TABLE reorder_plan ADD COLUMN IF NOT EXISTS bias              NUMERIC(12,3)`);
  await query(`ALTER TABLE reorder_plan ADD COLUMN IF NOT EXISTS exceptional_units INTEGER`);
  await query(`ALTER TABLE reorder_plan ADD COLUMN IF NOT EXISTS trade_share       NUMERIC(5,2)`);
  await query(`ALTER TABLE reorder_plan ADD COLUMN IF NOT EXISTS price             NUMERIC(12,2)`);

  // Accuracy (backtest + live), one row per sku per evaluated period.
  await query(`
    CREATE TABLE IF NOT EXISTS forecast_accuracy (
      id         SERIAL PRIMARY KEY,
      client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      sku        TEXT NOT NULL,
      period     DATE NOT NULL,
      method     TEXT,
      actual     NUMERIC(12,3),
      forecast   NUMERIC(12,3),
      abs_err    NUMERIC(12,3),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS forecast_results_run_sku_idx  ON forecast_results (run_id, sku)`);
  await query(`CREATE INDEX IF NOT EXISTS reorder_plan_run_idx          ON reorder_plan (run_id)`);
  await query(`CREATE INDEX IF NOT EXISTS reorder_plan_client_idx       ON reorder_plan (client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS forecast_runs_client_idx      ON forecast_runs (client_id, started_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS forecast_accuracy_client_idx  ON forecast_accuracy (client_id, sku)`);
}

module.exports = { ensureCoreSchema };
