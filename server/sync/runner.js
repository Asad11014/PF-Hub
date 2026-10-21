// ─── server/sync/runner.js ────────────────────────────────────────────────────
// Runs a sync mode as one job: takes a Postgres advisory lock (one sync at a
// time across processes and deploys), records each step's result, API calls and
// a heartbeat on sync_jobs, and advances per-entity cursors only on success.
//
// Modes (all read-only against Mintsoft; writes go to our database only)
//   hourly     clients, products (changed), stock, orders (changed), ASNs (changed), accruals
//   nightly    hourly + reference data, invoices (last 120 days)
//   full       everything from scratch, then removes records Mintsoft has deleted
//   reconcile  re-crawls Mintsoft and compares every column with the database
//
// Schedule (Europe/London): hourly at :15, nightly at 02:15, full + reconcile Sundays 03:15.

const { pool, query, queryOne } = require('../db');
const { createContext } = require('./context');
const E = require('./entities');
const { londonParts } = require('./time');
const { reconcile } = require('./reconcile');

const LOCK_KEY = 'pf-hub-sync';
const OVERLAP_MS = 2 * 3600e3;       // re-read the 2 h before each cursor
const FIRST_RUN_LOOKBACK_MS = 3 * 864e5;

async function sinceFor(entity) {
  const row = await queryOne(`SELECT cursor FROM sync_state WHERE entity = $1`, [entity]);
  const base = row?.cursor ? new Date(row.cursor).getTime() : Date.now() - FIRST_RUN_LOOKBACK_MS + OVERLAP_MS;
  return new Date(base - OVERLAP_MS);
}

async function setCursor(entity, cursor, jobId, rows) {
  await query(
    `INSERT INTO sync_state (entity, cursor, last_success_at, last_job_id, rows_last_run)
     VALUES ($1, $2, NOW(), $3, $4)
     ON CONFLICT (entity) DO UPDATE SET cursor = EXCLUDED.cursor, last_success_at = NOW(),
       last_job_id = EXCLUDED.last_job_id, rows_last_run = EXCLUDED.rows_last_run`,
    [entity, cursor, jobId, rows]
  );
}

// Step = { name, cursor?: entity key, run(ctx, since) }
function stepsFor(mode) {
  const full = mode === 'full';
  const steps = [];
  if (mode !== 'hourly') steps.push({ name: 'Reference data', run: ctx => E.syncReference(ctx) });
  steps.push(
    { name: 'Clients', run: ctx => E.syncClients(ctx) },
    { name: 'Products', cursor: 'products', run: (ctx, since) => E.syncProducts(ctx, { since: full ? null : since }) },
    { name: 'Stock levels', run: ctx => E.syncStock(ctx) },
    { name: 'Orders', cursor: 'orders', run: (ctx, since) => (full ? E.syncOrdersFull(ctx) : E.syncOrdersSince(ctx, since)) },
    { name: 'ASNs', cursor: 'asns', run: (ctx, since) => E.syncAsns(ctx, { since: full ? null : since }) },
  );
  if (mode !== 'hourly') steps.push({ name: 'Invoices', run: ctx => E.syncInvoices(ctx, { days: full ? null : 120 }) });
  steps.push({ name: 'Accruals', run: ctx => E.syncAccruals(ctx) });
  return steps;
}

async function runSync(mode = 'hourly', { triggeredBy = 'manual', apiKey = null } = {}) {
  if (!['hourly', 'nightly', 'full'].includes(mode)) throw new Error(`Unknown sync mode: ${mode}`);
  // The admin key is the one writer; a user key is only a fallback (local dev).
  const key = process.env.MINTSOFT_ADMIN_KEY || apiKey;
  if (!key) throw new Error('No Mintsoft API key for sync');

  return withLock(mode, async () => {
    const job = await queryOne(
      `INSERT INTO sync_jobs (entity, triggered_by, status, heartbeat_at, steps, api_calls)
       VALUES ($1, $2, 'running', NOW(), '[]', 0) RETURNING id, started_at`,
      [mode, triggeredBy]
    );
    const jobId = job.id;
    const t0 = Date.now();
    console.log(`[sync] ${mode} started (job ${jobId}, ${triggeredBy})`);

    let lastBeat = 0;
    const ctx = await createContext({
      apiKey: key,
      onPage: async () => {
        if (Date.now() - lastBeat < 10_000) return;
        lastBeat = Date.now();
        await query(`UPDATE sync_jobs SET heartbeat_at = NOW(), api_calls = $1 WHERE id = $2`, [ctx.apiCalls, jobId]).catch(() => {});
      },
    });

    const results = [];
    let records = 0;
    for (const step of stepsFor(mode)) {
      const s0 = Date.now();
      const stepStart = new Date();
      await query(`UPDATE sync_jobs SET current_step = $1, heartbeat_at = NOW(), api_calls = $2 WHERE id = $3`, [step.name, ctx.apiCalls, jobId]).catch(() => {});
      const since = step.cursor && mode !== 'full' ? await sinceFor(step.cursor) : null;
      const callsBefore = ctx.apiCalls;
      let r;
      try {
        r = { name: step.name, ...(await step.run(ctx, since)) };
        if (step.cursor) await setCursor(step.cursor, stepStart, jobId, r.upserted || 0);
      } catch (err) {
        r = { name: step.name, error: err.message };
        console.error(`[sync] ${step.name} failed: ${err.message}`);
      }
      r.ms = Date.now() - s0;
      r.apiCalls = ctx.apiCalls - callsBefore;
      if (since) r.since = since.toISOString();
      records += r.upserted || 0;
      results.push(r);
      console.log(`[sync]   ${step.name}: ${r.error ? `ERROR ${r.error}` : `${r.fetched ?? 0} fetched, ${r.upserted ?? 0} written${r.deleted ? `, ${r.deleted} deleted` : ''}`}${r.note ? ` — ${r.note}` : ''} (${r.ms} ms, ${r.apiCalls} calls)`);
      await query(`UPDATE sync_jobs SET steps = $1, heartbeat_at = NOW(), api_calls = $2 WHERE id = $3`, [JSON.stringify(results), ctx.apiCalls, jobId]).catch(() => {});
    }

    const errors = results.filter(r => r.error);
    const status = !errors.length ? 'success' : errors.length === results.length ? 'error' : 'partial';
    if (mode === 'full' && !errors.length) await setCursor('full', job.started_at, jobId, records);
    await query(
      `UPDATE sync_jobs SET status = $1, records_synced = $2, error = $3, current_step = NULL,
         completed_at = NOW(), heartbeat_at = NOW(), api_calls = $4, steps = $5 WHERE id = $6`,
      [status, records, errors.map(e => `${e.name}: ${e.error}`).join(' | ') || null, ctx.apiCalls, JSON.stringify(results), jobId]
    );
    console.log(`[sync] ${mode} ${status} — ${records} records, ${ctx.apiCalls} API calls, ${Math.round((Date.now() - t0) / 1000)} s`);
    return { ok: status !== 'error', jobId, status, records, apiCalls: ctx.apiCalls, ms: Date.now() - t0, steps: results };
  });
}

// One sync or reconcile at a time, across processes and overlapping deploys.
async function withLock(label, fn) {
  const lockConn = await pool.connect();
  let locked = false;
  try {
    locked = (await lockConn.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [LOCK_KEY])).rows[0].ok;
    if (!locked) {
      console.log(`[sync] ${label} skipped — another sync is running`);
      return { ok: false, skipped: true, reason: 'Another sync is already running' };
    }
    // We hold the lock, so any job still marked running died with its process.
    await query(`UPDATE sync_jobs SET status='error', error='abandoned', current_step=NULL, completed_at=NOW() WHERE status='running'`);
    return await fn();
  } finally {
    if (locked) await lockConn.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]).catch(() => {});
    lockConn.release();
  }
}

// Reconcile as a recorded job: the summary per entity goes into sync_jobs.steps.
// 'partial' means Mintsoft and the database disagree somewhere (see samples).
async function runReconcile({ triggeredBy = 'manual', only = null } = {}) {
  const key = process.env.MINTSOFT_ADMIN_KEY;
  if (!key) throw new Error('No Mintsoft API key for reconcile');
  return withLock('reconcile', async () => {
    const job = await queryOne(
      `INSERT INTO sync_jobs (entity, triggered_by, status, heartbeat_at, current_step) VALUES ('reconcile', $1, 'running', NOW(), 'Comparing with Mintsoft') RETURNING id`,
      [triggeredBy]
    );
    const t0 = Date.now();
    try {
      const r = await reconcile({ apiKey: key, only });
      const bad = r.report.filter(t => t.drift || t.missingInDb || t.extraInDb);
      const status = bad.length ? 'partial' : 'success';
      await query(
        `UPDATE sync_jobs SET status = $1, error = $2, steps = $3, api_calls = $4, current_step = NULL, completed_at = NOW(), heartbeat_at = NOW() WHERE id = $5`,
        [status, bad.map(t => `${t.entity}: drift ${t.drift}, missing ${t.missingInDb}, extra ${t.extraInDb}`).join(' | ') || null,
         JSON.stringify(r.report), r.apiCalls, job.id]
      );
      console.log(`[sync] reconcile ${status} — ${r.apiCalls} API calls, ${Math.round((Date.now() - t0) / 1000)} s${bad.length ? ` — ${bad.map(t => t.entity).join(', ')} differ` : ''}`);
      return { ok: true, jobId: job.id, status, ...r };
    } catch (err) {
      await query(`UPDATE sync_jobs SET status = 'error', error = $1, current_step = NULL, completed_at = NOW() WHERE id = $2`, [err.message, job.id]);
      throw err;
    }
  });
}

// Sidebar status: latest job + time of the last successful (or partial) run.
async function getSyncStatus() {
  const job = await queryOne(
    `SELECT id, entity, triggered_by, status, records_synced, current_step, error, started_at, completed_at, api_calls
     FROM sync_jobs WHERE entity <> 'reconcile' ORDER BY started_at DESC LIMIT 1`
  );
  const last = await queryOne(`SELECT MAX(completed_at) AS completed_at FROM sync_jobs WHERE status IN ('success','partial') AND entity <> 'reconcile'`);
  const rec = await queryOne(`SELECT id, status, error, started_at, completed_at, api_calls, steps AS report FROM sync_jobs WHERE entity = 'reconcile' AND completed_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`);
  return { lastSyncAt: last?.completed_at ?? null, lastJob: job ?? null, lastReconcile: rec ?? null };
}

// On boot: a running job with no heartbeat for 15 min died with its process.
async function abandonStaleJobs() {
  const rows = await query(
    `UPDATE sync_jobs SET status='error', error='abandoned', current_step=NULL, completed_at=NOW()
     WHERE status='running' AND COALESCE(heartbeat_at, started_at) < NOW() - INTERVAL '15 minutes'
     RETURNING id`
  );
  if (rows.length) console.log(`[sync] Marked ${rows.length} stale running job(s) as abandoned: ${rows.map(r => r.id).join(', ')}`);
  return rows.length;
}

function startScheduler() {
  if (!process.env.MINTSOFT_ADMIN_KEY) { console.log('[sync] MINTSOFT_ADMIN_KEY not set — scheduled sync disabled'); return; }
  if (process.env.DEMO_MODE || process.env.SYNC_SCHEDULER === 'off') { console.log('[sync] scheduled sync disabled'); return; }

  const slotOf = p => `${p.year}-${p.month}-${p.day}T${p.hour}`;
  const run = (mode, by) => runSync(mode, { triggeredBy: by }).catch(err => console.error(`[sync] ${mode} crashed: ${err.message}`));
  let lastSlot = slotOf(londonParts()); // the current hour is covered by the boot catch-up

  setInterval(() => {
    const p = londonParts();
    if (+p.minute < 15 || slotOf(p) === lastSlot) return;
    lastSlot = slotOf(p);
    const mode = p.weekday === 'Sun' && p.hour === '03' ? 'full' : p.hour === '02' ? 'nightly' : 'hourly';
    run(mode, 'schedule').then(r => {
      if (mode === 'full' && r?.status === 'success') return runReconcile({ triggeredBy: 'schedule' });
    }).catch(err => console.error(`[sync] reconcile crashed: ${err.message}`));
  }, 30_000);

  // Boot catch-up: the first deploy of this engine runs a full resync; after
  // that, a restart only runs an hourly sync if the last success is old.
  setTimeout(async () => {
    try {
      const full = await queryOne(`SELECT last_success_at FROM sync_state WHERE entity = 'full'`);
      if (!full) {
        const r = await run('full', 'boot');
        if (r?.status === 'success') await runReconcile({ triggeredBy: 'boot' });
        return;
      }
      const last = await queryOne(`SELECT MAX(completed_at) AS t FROM sync_jobs WHERE status IN ('success','partial') AND entity <> 'reconcile'`);
      if (!last?.t || Date.now() - new Date(last.t).getTime() > 70 * 60e3) run('hourly', 'boot');
    } catch (err) { console.error(`[sync] boot catch-up failed: ${err.message}`); }
  }, 60_000);

  console.log('[sync] scheduler on: hourly at :15, nightly 02:15, full + reconcile Sundays 03:15 (Europe/London)');
}

module.exports = { runSync, runReconcile, getSyncStatus, abandonStaleJobs, startScheduler };
