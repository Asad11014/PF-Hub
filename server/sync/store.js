// ─── server/sync/store.js ─────────────────────────────────────────────────────
// Bulk write helpers for the sync engine: multi-row upserts and transactions.

const { pool } = require('../db');

const MAX_PARAMS = 30_000; // stay well under Postgres' 65,535 bind-parameter limit

// Run fn(client) inside BEGIN/COMMIT on a dedicated connection.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// INSERT … ON CONFLICT DO UPDATE for many rows at once. Every listed column is
// overwritten on conflict, so a re-sync always leaves the row equal to the API.
//   cols     column names, rows are arrays in the same order
//   conflict conflict target columns (default ['id'])
//   nowCol   optional column set to NOW() on insert and update (e.g. synced_at)
// Rows with a duplicate conflict key keep the last occurrence.
async function bulkUpsert(db, table, cols, rows, { conflict = ['id'], nowCol = null } = {}) {
  if (!rows.length) return 0;
  const keyIdx = conflict.map(c => cols.indexOf(c));
  const byKey = new Map();
  for (const r of rows) byKey.set(keyIdx.map(i => r[i]).join('\u0001'), r);
  const unique = [...byKey.values()];

  const allCols = nowCol ? [...cols, nowCol] : cols;
  const updates = allCols.filter(c => !conflict.includes(c))
    .map(c => (c === nowCol ? `${c}=NOW()` : `${c}=EXCLUDED.${c}`));
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));

  for (let i = 0; i < unique.length; i += perChunk) {
    const chunk = unique.slice(i, i + perChunk);
    const params = [];
    const values = chunk.map(r => {
      const ph = r.map(v => `$${params.push(v)}`);
      if (nowCol) ph.push('NOW()');
      return `(${ph.join(',')})`;
    });
    await db.query(
      `INSERT INTO ${table} (${allCols.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (${conflict.join(',')}) DO ${updates.length ? `UPDATE SET ${updates.join(',')}` : 'NOTHING'}`,
      params
    );
  }
  return unique.length;
}

// Plain multi-row INSERT (for child rows replaced as a set, e.g. ASN items).
async function bulkInsert(db, table, cols, rows) {
  if (!rows.length) return 0;
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const params = [];
    const values = rows.slice(i, i + perChunk).map(r => `(${r.map(v => `$${params.push(v)}`).join(',')})`);
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
  }
  return rows.length;
}

module.exports = { tx, bulkUpsert, bulkInsert };
