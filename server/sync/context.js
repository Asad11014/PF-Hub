// ─── server/sync/context.js ───────────────────────────────────────────────────
// Per-run state shared by every sync step: the Mintsoft client (with a call
// counter and pagination), the ids already present in the database (so foreign
// keys can be satisfied before a page is written), and lookup maps.

const { query } = require('../db');
const { mintsoftGet } = require('../mintsoft');

const PAGE = 100; // Mintsoft's maximum page size

async function createContext({ apiKey, onPage = () => {} }) {
  let apiCalls = 0;

  async function get(path) {
    apiCalls++;
    const r = await mintsoftGet(path, apiKey);
    if (r.status === 200) return r.body;
    const detail = r.body && typeof r.body === 'object' ? (r.body.Message || JSON.stringify(r.body)) : String(r.body);
    const err = new Error(`Mintsoft ${r.status} on ${path.split('?')[0]}: ${detail.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }

  // Walk every page of a list endpoint; onBatch(rows) is awaited per page.
  async function pages(path, onBatch) {
    const sep = path.includes('?') ? '&' : '?';
    let total = 0;
    let prevFirst = null;
    for (let page = 1; page <= 2000; page++) {
      const body = await get(`${path}${sep}Limit=${PAGE}&PageNo=${page}`);
      const batch = Array.isArray(body) ? body : [];
      if (!batch.length) break;
      // Some endpoints ignore paging and return the same rows forever.
      const first = batch[0]?.ID ?? null;
      if (first !== null && first === prevFirst) throw new Error(`${path.split('?')[0]} repeated page ${page - 1}; paging not honoured`);
      prevFirst = first;
      await onBatch(batch);
      total += batch.length;
      await onPage();
      if (batch.length < PAGE) break;
    }
    return total;
  }

  const [clients, products, warehouses, orderStatuses, asnStatuses] = await Promise.all([
    query(`SELECT id FROM clients`),
    query(`SELECT id FROM products`),
    query(`SELECT id FROM warehouses ORDER BY id`),
    query(`SELECT id, name FROM order_status_types`),
    query(`SELECT id, name FROM asn_status_types`),
  ]);

  return {
    apiKey, get, pages,
    get apiCalls() { return apiCalls; },
    knownClients:  new Set(clients.map(r => r.id)),
    knownProducts: new Set(products.map(r => r.id)),
    warehouseIds:  warehouses.map(r => r.id),
    orderStatus:   Object.fromEntries(orderStatuses.map(r => [r.id, r.name])),
    asnStatus:     Object.fromEntries(asnStatuses.map(r => [r.id, r.name])),
  };
}

module.exports = { createContext, PAGE };
