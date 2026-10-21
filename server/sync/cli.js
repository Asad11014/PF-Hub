#!/usr/bin/env node
// ─── server/sync/cli.js ───────────────────────────────────────────────────────
// Run a sync or a reconcile from the command line against DATABASE_URL.
//
//   node server/sync/cli.js hourly|nightly|full
//   node server/sync/cli.js reconcile [clients,products,stock,orders,asns,invoices,accruals] [--json=out.json]
//
// Exit code: 0 on success; 1 on sync error/partial, or reconcile drift/missing/extra.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const fs = require('fs');
const { pool } = require('../db');
const { ensureCoreSchema } = require('../schema');
const { runSync, runReconcile } = require('./runner');

const [mode = 'hourly', ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const only = rest.find(a => !a.startsWith('--'))?.split(',');

function printReport(r) {
  const rows = r.report.map(t => ({
    entity: t.entity, api: t.api, db: t.db, matched: t.matched, missingInDb: t.missingInDb,
    extraInDb: t.extraInDb, drift: t.drift, changedSinceSync: t.changed,
  }));
  console.table(rows);
  for (const t of r.report) {
    if (t.samples.length) console.log(`${t.entity} samples:`, JSON.stringify(t.samples));
    if (t.months) {
      const off = t.months.filter(m => m.diff);
      console.log(`orders per month: ${t.months.length} months, ${off.length} with a difference${off.length ? ' → ' + JSON.stringify(off) : ''}`);
    }
  }
  console.log(`reconcile API calls: ${r.apiCalls}`);
}

(async () => {
  await ensureCoreSchema();
  if (mode === 'reconcile') {
    const r = await runReconcile({ triggeredBy: 'cli', only });
    if (r.skipped) { console.log(r.reason); process.exitCode = 1; return; }
    printReport(r);
    if (flags.json) fs.writeFileSync(flags.json, JSON.stringify(r, null, 2));
    const bad = r.report.some(t => t.drift || t.missingInDb || t.extraInDb);
    process.exitCode = bad ? 1 : 0;
  } else {
    const r = await runSync(mode, { triggeredBy: 'cli' });
    process.exitCode = r.status === 'success' ? 0 : 1;
  }
})()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
