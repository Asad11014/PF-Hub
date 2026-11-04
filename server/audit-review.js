// ─── server/audit-review.js ───────────────────────────────────────────────────
// Invoice Audit stage I3: the review workflow.
//   · Every finding (a flag on an order line, goods-in line, invoice or unbilled
//     order) can be marked OK / to credit / to charge with a note and amount.
//   · An invoice moves not reviewed → in review → signed off. A signed-off
//     invoice is locked: its findings cannot change until it is reopened.
//   · The owner's audit rules (C11) are created and edited here.
// Every change is written to audit_events in the same transaction, so the trail
// is complete by construction. Nothing here reads from or writes to Mintsoft.

const { pool, query, queryOne } = require('./db');
const { SUPPORTED_FIELDS, OPERATORS } = require('./audit-rules');
const { RULE_CATEGORIES, EXPECTATIONS } = require('./audit-checks');

const REVIEW_STATUSES = ['ok', 'credit', 'charge'];
const INVOICE_STATUSES = ['not_reviewed', 'in_review', 'signed_off'];
const NO_VALUE_OPERATORS = new Set(['Empty', 'IsNotEmpty']);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn((text, params) => c.query(text, params).then(x => x.rows));
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { c.release(); }
}

const event = (q, e) => q(
  `INSERT INTO audit_events (actor, action, client_id, invoice_id, subject, check_code, before, after, note)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, at`,
  [e.actor, e.action, e.clientId ?? null, e.invoiceId ?? null, e.subject ?? null, e.check ?? null,
    e.before == null ? null : JSON.stringify(e.before), e.after == null ? null : JSON.stringify(e.after), e.note ?? null]);

// ── Findings ─────────────────────────────────────────────────────────────────

// 'line:12' | 'order:34' | 'invoice:56' | 'extra:goods_in:78' → parts, else null.
function parseSubject(s) {
  const m = String(s || '').match(/^(line|order|invoice):(\d{1,12})$/) || String(s || '').match(/^(extra):(goods_in|returns|collections|other):(\d{1,12})$/);
  if (!m) return null;
  return m[1] === 'extra' ? { kind: 'extra', extraKind: m[2], id: Number(m[3]) } : { kind: m[1], id: Number(m[2]) };
}

// Pure validation of a review request. → { error } | { subject, check, status, note, amount }
function validateReview(b) {
  const subject = parseSubject(b?.subject);
  if (!subject) return { error: 'subject is not a finding' };
  const check = String(b.check || '');
  if (!/^[a-z_]{2,40}(:\d{1,12})?$/.test(check)) return { error: 'check is not a finding code' };
  const status = String(b.status || '');
  if (status !== 'open' && !REVIEW_STATUSES.includes(status)) return { error: 'status must be ok, credit, charge or open' };
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  let amount = null;
  if (b.amount != null && b.amount !== '') {
    amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e6) return { error: 'amount must be a positive number of pounds' };
    amount = Math.round(amount * 100) / 100;
  }
  if ((status === 'credit' || status === 'charge') && !note) return { error: 'Add a note saying why' };
  return { subject: b.subject, parsed: subject, check, status, note, amount };
}

// Which client and invoice a finding belongs to, from our own tables.
async function locate(parsed, q = query) {
  const one = async (sql, p) => (await q(sql, p))[0] || null;
  if (parsed.kind === 'line') return one(`SELECT client_id, invoice_id FROM invoice_orders WHERE id = $1`, [parsed.id]);
  if (parsed.kind === 'extra') return one(`SELECT client_id, invoice_id FROM invoice_extra_lines WHERE id = $1 AND kind = $2`, [parsed.id, parsed.extraKind]);
  if (parsed.kind === 'invoice') return one(`SELECT client_id, id AS invoice_id FROM invoices WHERE id = $1`, [parsed.id]);
  if (parsed.kind === 'order') return one(`SELECT client_id, NULL::int AS invoice_id FROM orders WHERE id = $1`, [parsed.id]);
  return null;
}

const signedOffError = { status: 409, error: 'This invoice is signed off. Reopen it to change its findings.' };

async function setReview(body, actor) {
  const v = validateReview(body);
  if (v.error) return { status: 400, error: v.error };
  return tx(async q => {
    const where = await locate(v.parsed, q);
    if (!where) return { status: 404, error: 'Finding not found' };
    if (where.invoice_id) {
      const st = (await q(`SELECT status FROM audit_invoice_reviews WHERE invoice_id = $1 FOR UPDATE`, [where.invoice_id]))[0];
      if (st?.status === 'signed_off') return signedOffError;
    }
    const before = (await q(`SELECT status, amount, note, updated_by, updated_at FROM audit_reviews WHERE subject = $1 AND check_code = $2`, [v.subject, v.check]))[0] || null;
    let after = null;
    if (v.status === 'open') {
      if (!before) return { ok: true, review: null, unchanged: true };
      await q(`DELETE FROM audit_reviews WHERE subject = $1 AND check_code = $2`, [v.subject, v.check]);
    } else {
      after = (await q(
        `INSERT INTO audit_reviews (subject, check_code, client_id, invoice_id, status, amount, note, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (subject, check_code) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, note = EXCLUDED.note,
           client_id = EXCLUDED.client_id, invoice_id = EXCLUDED.invoice_id, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING status, amount, note, updated_by, updated_at`,
        [v.subject, v.check, where.client_id, where.invoice_id, v.status, v.amount, v.note, actor]))[0];
      if (before && before.status === after.status && Number(before.amount) === Number(after.amount) && (before.note || null) === (after.note || null)) {
        return { ok: true, review: after, unchanged: true };
      }
    }
    // Moving a finding starts the invoice's review.
    if (where.invoice_id) {
      const started = await q(
        `INSERT INTO audit_invoice_reviews (invoice_id, status, updated_by) VALUES ($1, 'in_review', $2)
         ON CONFLICT (invoice_id) DO UPDATE SET status = 'in_review', updated_by = EXCLUDED.updated_by, updated_at = NOW()
           WHERE audit_invoice_reviews.status = 'not_reviewed'
         RETURNING status`, [where.invoice_id, actor]);
      if (started.length) await event(q, { actor, action: 'invoice_status', clientId: where.client_id, invoiceId: where.invoice_id, subject: `invoice:${where.invoice_id}`, before: { status: 'not_reviewed' }, after: { status: 'in_review' }, note: 'Review started' });
    }
    await event(q, { actor, action: 'review', clientId: where.client_id, invoiceId: where.invoice_id, subject: v.subject, check: v.check,
      before: before && { status: before.status, amount: before.amount == null ? null : Number(before.amount), note: before.note },
      after: after && { status: after.status, amount: after.amount == null ? null : Number(after.amount), note: after.note }, note: v.note });
    return { ok: true, review: after };
  });
}

// status: in_review | signed_off | not_reviewed (reopening a signed-off invoice → in_review).
// openFindings is recorded with a sign-off so the trail shows what was accepted.
async function setInvoiceStatus(invoiceId, body, actor, openFindings) {
  const status = String(body?.status || '');
  if (!INVOICE_STATUSES.includes(status)) return { status: 400, error: 'status must be not_reviewed, in_review or signed_off' };
  const note = body.note == null ? null : String(body.note).trim().slice(0, 500) || null;
  return tx(async q => {
    const inv = (await q(`SELECT id, client_id FROM invoices WHERE id = $1`, [invoiceId]))[0];
    if (!inv) return { status: 404, error: 'Invoice not found' };
    const before = (await q(`SELECT status, note, updated_by, updated_at FROM audit_invoice_reviews WHERE invoice_id = $1 FOR UPDATE`, [invoiceId]))[0] || { status: 'not_reviewed' };
    if (before.status === status) return { ok: true, review: before, unchanged: true };
    if (status === 'signed_off' && openFindings > 0 && !note) return { status: 400, error: `${openFindings} finding${openFindings === 1 ? ' is' : 's are'} still open. Add a note to sign off anyway.` };
    const after = (await q(
      `INSERT INTO audit_invoice_reviews (invoice_id, status, note, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (invoice_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING status, note, updated_by, updated_at`, [invoiceId, status, note, actor]))[0];
    await event(q, { actor, action: status === 'signed_off' ? 'sign_off' : before.status === 'signed_off' ? 'reopen' : 'invoice_status',
      clientId: inv.client_id, invoiceId, subject: `invoice:${invoiceId}`,
      before: { status: before.status }, after: { status, ...(status === 'signed_off' ? { openFindings } : {}) }, note });
    return { ok: true, review: after };
  });
}

async function invoiceReview(invoiceId) {
  return (await queryOne(`SELECT status, note, updated_by, updated_at FROM audit_invoice_reviews WHERE invoice_id = $1`, [invoiceId])) || { status: 'not_reviewed', note: null, updated_by: null, updated_at: null };
}

// Map 'subject|check' → review, for one invoice (or a list of subjects).
async function reviewsFor({ invoiceId, subjects }) {
  const rows = invoiceId != null
    ? await query(`SELECT * FROM audit_reviews WHERE invoice_id = $1`, [invoiceId])
    : subjects?.length ? await query(`SELECT * FROM audit_reviews WHERE subject = ANY($1::text[])`, [subjects]) : [];
  return new Map(rows.map(r => [`${r.subject}|${r.check_code}`, {
    status: r.status, amount: r.amount == null ? null : Number(r.amount), note: r.note, by: r.updated_by, at: r.updated_at,
  }]));
}

// For the overview: status and reviewed findings per invoice.
async function invoiceSummaries(invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const [st, rv] = await Promise.all([
    query(`SELECT invoice_id, status, updated_by, updated_at FROM audit_invoice_reviews WHERE invoice_id = ANY($1::int[])`, [invoiceIds]),
    query(`SELECT invoice_id, subject || '|' || check_code AS k, status FROM audit_reviews WHERE invoice_id = ANY($1::int[])`, [invoiceIds]),
  ]);
  const m = new Map(invoiceIds.map(id => [id, { status: 'not_reviewed', reviewed: new Map() }]));
  for (const s of st) Object.assign(m.get(s.invoice_id), { status: s.status, by: s.updated_by, at: s.updated_at });
  for (const r of rv) m.get(r.invoice_id).reviewed.set(r.k, r.status);
  return m;
}

async function events({ invoiceId, clientId, limit = 100 }) {
  const where = invoiceId != null ? 'invoice_id = $1' : clientId != null ? 'client_id = $1' : 'TRUE';
  const params = invoiceId != null ? [invoiceId] : clientId != null ? [clientId] : [];
  return query(`SELECT id, at, actor, action, client_id, invoice_id, subject, check_code, before, after, note
                FROM audit_events WHERE ${where} ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`, params);
}

async function logEvent(e) { return event(query, e); }

// ── The owner's audit rules (C11) ────────────────────────────────────────────

function validateRule(b) {
  const name = String(b?.name || '').trim();
  if (!name || name.length > 80) return { error: 'Give the rule a name (up to 80 characters)' };
  const conditionType = b.conditionType === 'OR' ? 'OR' : 'AND';
  const conds = Array.isArray(b.conditions) ? b.conditions : [];
  if (!conds.length || conds.length > 10) return { error: 'Add between 1 and 10 conditions' };
  const conditions = [];
  for (const c of conds) {
    if (!SUPPORTED_FIELDS.includes(c?.field)) return { error: `Unknown field ${c?.field}` };
    if (!OPERATORS.includes(c?.operator)) return { error: `Unknown operator ${c?.operator}` };
    const value = NO_VALUE_OPERATORS.has(c.operator) ? '' : String(c.value ?? '').trim();
    if (!NO_VALUE_OPERATORS.has(c.operator) && !value) return { error: `Enter a value for ${c.field}` };
    if (value.length > 200) return { error: 'Condition values are limited to 200 characters' };
    conditions.push({ field: c.field, operator: c.operator, value });
  }
  const x = b.expectation || {};
  if (!EXPECTATIONS.includes(x.type)) return { error: 'Choose what the rule expects' };
  let expectation;
  if (x.type === 'rework_item') {
    const item = String(x.item || '').trim();
    if (!item || item.length > 80) return { error: 'Enter the rework item name' };
    expectation = { type: x.type, item };
  } else {
    if (!RULE_CATEGORIES[x.category]) return { error: 'Choose a charge category' };
    expectation = { type: x.type, category: x.category };
    if (x.type !== 'no_charge') {
      const amount = Number(x.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e5) return { error: 'Enter an amount in pounds' };
      expectation.amount = Math.round(amount * 100) / 100;
    }
  }
  const effectiveFrom = b.effectiveFrom ? String(b.effectiveFrom) : null;
  if (effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { error: 'effectiveFrom must be a date (YYYY-MM-DD)' };
  const clientId = b.clientId == null || b.clientId === '' ? null : Number(b.clientId);
  if (clientId != null && !Number.isInteger(clientId)) return { error: 'clientId must be a client id or empty for every client' };
  return { name, conditionType, conditions, expectation, effectiveFrom, clientId, active: b.active !== false };
}

// pg returns DATE as local midnight; keep the calendar date.
const ymd = d => (d == null ? null : d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
const ruleRow = r => r && ({
  id: r.id, clientId: r.client_id, name: r.name, conditionType: r.condition_type, conditions: r.conditions, expectation: r.expectation,
  effectiveFrom: ymd(r.effective_from), active: r.active,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function listRules(clientId) {
  const rows = await query(
    `SELECT * FROM audit_rules WHERE ${clientId == null ? 'TRUE' : '(client_id = $1 OR client_id IS NULL)'} ORDER BY client_id NULLS FIRST, id`,
    clientId == null ? [] : [clientId]);
  return rows.map(ruleRow);
}

async function saveRule(id, body, actor) {
  const v = validateRule(body);
  if (v.error) return { status: 400, error: v.error };
  return tx(async q => {
    if (v.clientId != null && !(await q(`SELECT 1 FROM clients WHERE id = $1`, [v.clientId])).length) return { status: 400, error: 'Client not found' };
    const before = id ? (await q(`SELECT * FROM audit_rules WHERE id = $1 FOR UPDATE`, [id]))[0] : null;
    if (id && !before) return { status: 404, error: 'Rule not found' };
    const params = [v.clientId, v.name, v.conditionType, JSON.stringify(v.conditions), JSON.stringify(v.expectation), v.effectiveFrom, v.active];
    const row = id
      ? (await q(`UPDATE audit_rules SET client_id = $1, name = $2, condition_type = $3, conditions = $4, expectation = $5, effective_from = $6, active = $7, updated_at = NOW()
                  WHERE id = $8 RETURNING *`, [...params, id]))[0]
      : (await q(`INSERT INTO audit_rules (client_id, name, condition_type, conditions, expectation, effective_from, active, created_by)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [...params, actor]))[0];
    await event(q, { actor, action: 'rule', clientId: row.client_id, subject: `rule:${row.id}`, before: before && ruleRow(before), after: ruleRow(row), note: id ? 'Rule changed' : 'Rule added' });
    return { ok: true, rule: ruleRow(row), clientsAffected: [before?.client_id, row.client_id] };
  });
}

async function deleteRule(id, actor) {
  return tx(async q => {
    const before = (await q(`DELETE FROM audit_rules WHERE id = $1 RETURNING *`, [id]))[0];
    if (!before) return { status: 404, error: 'Rule not found' };
    await event(q, { actor, action: 'rule', clientId: before.client_id, subject: `rule:${id}`, before: ruleRow(before), after: null, note: 'Rule deleted' });
    return { ok: true, clientsAffected: [before.client_id] };
  });
}

module.exports = {
  REVIEW_STATUSES, INVOICE_STATUSES, parseSubject, validateReview, validateRule,
  setReview, setInvoiceStatus, invoiceReview, reviewsFor, invoiceSummaries, events, logEvent,
  listRules, saveRule, deleteRule,
};
