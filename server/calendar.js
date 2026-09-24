// ─── server/calendar.js ───────────────────────────────────────────────────────
// Calendar events: custom events + GoodsIn (from asns) + order volume.
// Schema lives in schema.js — ensureSchema() here is a no-op kept for compat.

const { query, queryOne } = require('./db');

async function ensureSchema() {
  // Tables are created by schema.js — nothing to do here.
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDate(val) {
  if (!val) return null;
  if (val instanceof Date) return `${val.getFullYear()}-${pad(val.getMonth()+1)}-${pad(val.getDate())}`;
  return String(val).split('T')[0];
}

function toEventShape(r) {
  return {
    id:          r.id,
    title:       r.title,
    description: r.description || '',
    type:        r.event_type,
    date:        fmtDate(r.start_date),
    time:        r.start_time || null,
    endDate:     fmtDate(r.end_date),
    endTime:     r.end_time || null,
    color:       r.colour,
    allDay:      r.all_day,
    createdBy:   r.created_by || null,
    isShared:    r.is_shared  || false,
  };
}

// ── Custom events CRUD ────────────────────────────────────────────────────────

async function listEvents(warehouseId, from, to, clientId) {
  // For warehouse users: all events in this warehouse
  // For client users: events shared to them (client_id match)
  const conditions = [`e.start_date >= $1`, `e.start_date <= $2`];
  const p = [from, to];

  if (warehouseId) conditions.push(`(e.warehouse_id = $${p.push(warehouseId)} OR e.warehouse_id IS NULL)`);
  if (clientId) {
    // Client sees events explicitly shared to them OR unscoped events for this client
    const sql = `
      SELECT e.*, false AS is_shared FROM calendar_events e
      WHERE ${conditions.join(' AND ')}
        AND e.client_id = $${p.push(clientId)}
      UNION
      SELECT e.*, true AS is_shared FROM calendar_events e
      JOIN calendar_event_shares s ON s.event_id = e.id AND s.client_id = $${p.push(clientId)}
      WHERE ${conditions.join(' AND ')}
      ORDER BY start_date, start_time NULLS LAST`;
    const rows = await query(sql, p);
    const seen = new Set();
    return rows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; })
               .map(toEventShape);
  }

  // Warehouse user: own events
  const sql = `
    SELECT e.*, false AS is_shared FROM calendar_events e
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.start_date, e.start_time NULLS LAST`;
  return (await query(sql, p)).map(toEventShape);
}

async function createEvent(warehouseId, clientId, username, body) {
  const { title, description, type, date, time, endDate, endTime, color, allDay, sharedClientIds } = body;
  if (!title?.trim()) throw new Error('title is required');
  if (!date)          throw new Error('date is required');

  const row = await queryOne(
    `INSERT INTO calendar_events
       (warehouse_id, client_id, title, description, event_type,
        start_date, start_time, end_date, end_time, colour, all_day, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      warehouseId || null,
      clientId    || null,
      title.trim(),
      description?.trim() || null,
      type || 'manual',
      date,
      time || null,
      endDate || null,
      endTime || null,
      color || '#1f22ac',
      allDay !== false,
      username,
    ]
  );

  // Share with additional clients (warehouse-created events)
  const confirmedShared = [];
  if (Array.isArray(sharedClientIds) && sharedClientIds.length > 0) {
    for (const msId of sharedClientIds) {
      const exists = await queryOne(`SELECT id FROM clients WHERE id = $1`, [parseInt(msId)]);
      if (exists) {
        await query(
          `INSERT INTO calendar_event_shares (event_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [row.id, parseInt(msId)]
        );
        confirmedShared.push(parseInt(msId));
      }
    }
  }

  return { ...toEventShape(row), sharedClientIds: confirmedShared };
}

// clientId set = client session: may only touch its own events.
async function updateEvent(warehouseId, eventId, body, clientId = null) {
  const { title, description, type, date, time, endDate, endTime, color, allDay } = body;
  const conditions = [`id = $1`];
  const p = [eventId];
  if (warehouseId) conditions.push(`warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)    conditions.push(`client_id = $${p.push(clientId)}`);

  const row = await queryOne(
    `UPDATE calendar_events SET
       title       = COALESCE($${p.push(title?.trim() || null)}, title),
       description = COALESCE($${p.push(description?.trim() || null)}, description),
       event_type  = COALESCE($${p.push(type || null)}, event_type),
       start_date  = COALESCE($${p.push(date || null)}, start_date),
       start_time  = COALESCE($${p.push(time || null)}::time, start_time),
       end_date    = COALESCE($${p.push(endDate || null)}, end_date),
       end_time    = COALESCE($${p.push(endTime || null)}::time, end_time),
       colour      = COALESCE($${p.push(color || null)}, colour),
       all_day     = COALESCE($${p.push(allDay != null ? allDay : null)}, all_day),
       updated_at  = NOW()
     WHERE ${conditions.join(' AND ')}
     RETURNING *`,
    p
  );
  if (!row) throw new Error('Event not found');
  return toEventShape(row);
}

async function deleteEvent(warehouseId, eventId, clientId = null) {
  const conditions = [`id = $1`];
  const p = [eventId];
  if (warehouseId) conditions.push(`warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)    conditions.push(`client_id = $${p.push(clientId)}`);
  const row = await queryOne(
    `DELETE FROM calendar_events WHERE ${conditions.join(' AND ')} RETURNING id`,
    p
  );
  if (!row) throw new Error('Event not found');
  return { deleted: true };
}

// ── Auto-events from DB ───────────────────────────────────────────────────────

async function getOrderEvents(warehouseId, from, to) {
  const conditions = [];
  const p = [];
  if (warehouseId) conditions.push(`o.warehouse_id = $${p.push(warehouseId)}`);
  conditions.push(`o.despatch_date::date >= $${p.push(from)}`);
  conditions.push(`o.despatch_date::date <= $${p.push(to)}`);

  const rows = await query(
    `SELECT
       o.despatch_date::date AS date,
       COUNT(*)              AS order_count,
       COUNT(DISTINCT o.client_id) AS client_count
     FROM orders o
     WHERE ${conditions.join(' AND ')}
     GROUP BY o.despatch_date::date
     HAVING COUNT(*) >= 5
     ORDER BY o.despatch_date::date`,
    p
  );
  return rows.map(r => ({
    id:          `order-${r.date}`,
    title:       `${r.order_count} orders despatched`,
    description: `${r.client_count} client(s)`,
    type:        'orders',
    date:        String(r.date).split('T')[0],
    time:        null, endDate: null, endTime: null,
    color:       'indigo',
    allDay:      true,
    createdBy:   null,
    auto:        true,
  }));
}

async function getGoodsInEvents(warehouseId, from, to, clientId) {
  const conditions = [];
  const p = [];
  if (warehouseId) conditions.push(`a.warehouse_id = $${p.push(warehouseId)}`);
  if (clientId)    conditions.push(`a.client_id = $${p.push(clientId)}`);
  conditions.push(`COALESCE(a.estimated_delivery, a.booked_in_date) >= $${p.push(from)}`);
  conditions.push(`COALESCE(a.estimated_delivery, a.booked_in_date) <= $${p.push(to)}`);

  const rows = await query(
    `SELECT a.id, a.po_reference, a.status_name, a.estimated_delivery, a.booked_in_date,
            a.quantity, a.comments, c.name AS client_name
     FROM asns a
     LEFT JOIN clients c ON c.id = a.client_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(a.estimated_delivery, a.booked_in_date)`,
    p
  );

  return rows.map(r => {
    const date    = fmtDate(r.estimated_delivery) || fmtDate(r.booked_in_date);
    const endDate = (r.booked_in_date && r.estimated_delivery
      && fmtDate(r.estimated_delivery) !== fmtDate(r.booked_in_date))
      ? fmtDate(r.booked_in_date) : null;

    const parts = [
      r.status_name ? `Status: ${r.status_name}` : null,
      r.quantity     ? `${r.quantity} units`       : null,
      r.comments     || null,
    ].filter(Boolean);

    return {
      id:          `goodsin-${r.id}`,
      title:       `Goods In — ${r.client_name || 'Unknown'}${r.po_reference ? ` (${r.po_reference})` : ''}`,
      description: parts.join(' · '),
      type:        'asn',
      date, endDate,
      time:        null, endTime: null,
      color:       'green',
      allDay:      true,
      createdBy:   null,
      auto:        true,
    };
  });
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function handle(req, res, url, session, method, eventId) {
  const warehouseId = session.warehouses?.[0]?.ID
    ? parseInt(session.warehouses[0].ID) : null;
  const clientId = session.isWarehouse
    ? null
    : (session.clientId ? parseInt(session.clientId) : null);

  if (method === 'GET') {
    const from = url.searchParams.get('from') || new Date().toISOString().split('T')[0];
    const to   = url.searchParams.get('to')   || from;

    const [custom, orders, goodsIn] = await Promise.all([
      listEvents(warehouseId, from, to, clientId),
      session.isWarehouse ? getOrderEvents(warehouseId, from, to) : [],
      getGoodsInEvents(warehouseId, from, to, clientId),
    ]);
    return res.json(200, { events: [...custom, ...orders, ...goodsIn] });
  }

  if (method === 'POST') {
    const body  = await req.json();
    const event = await createEvent(warehouseId, clientId, session.username, body);
    return res.json(201, event);
  }

  if (method === 'PUT' && eventId) {
    const body  = await req.json();
    const event = await updateEvent(warehouseId, parseInt(eventId), body, clientId);
    return res.json(200, event);
  }

  if (method === 'DELETE' && eventId) {
    const result = await deleteEvent(warehouseId, parseInt(eventId), clientId);
    return res.json(200, result);
  }

  return res.json(405, { error: 'Method not allowed' });
}

module.exports = { ensureSchema, handle };
