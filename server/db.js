const { Pool } = require('pg');

// Enable SSL for any remote host (Neon, Render, etc.); skip it only for a
// local Postgres. Managed hosts like Neon require SSL even from local dev.
const DB_URL   = process.env.DATABASE_URL || '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);

const pool = new Pool({
  connectionString: DB_URL,
  ssl: IS_LOCAL ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  // Bucket dates by UK days (Mintsoft's and the business's calendar), whatever
  // time zone the database server defaults to (Render: UTC). Runs before the
  // connection is handed out.
  onConnect: (client) => client.query(`SET TIME ZONE 'Europe/London'`),
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

// Convenience wrapper — returns rows directly
async function query(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// Single-row convenience — returns first row or null
async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

module.exports = { pool, query, queryOne };
