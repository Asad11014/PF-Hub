// ─── server/sync.js ───────────────────────────────────────────────────────────
// Entry point kept for existing callers (index.js, auth.js, tools/qa). The sync
// engine lives in server/sync/ — see server/sync/runner.js for modes and schedule.

const { runSync, runReconcile, getSyncStatus, abandonStaleJobs, startScheduler } = require('./sync/runner');

module.exports = {
  runSync,
  runReconcile,
  runFullSync:        (opts = {}) => runSync('full', opts),
  runIncrementalSync: (opts = {}) => runSync('hourly', opts),
  getSyncStatus,
  abandonStaleJobs,
  startScheduler,
};
