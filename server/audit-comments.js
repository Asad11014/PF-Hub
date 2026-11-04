// ─── server/audit-comments.js ─────────────────────────────────────────────────
// Parsing of Mintsoft invoice order-line comments (shared by the audit modules).

// An order line's comments list the rework items Mintsoft charged, one per line,
// as "<item name>- X <qty>" (the name can be blank). Any other line was typed by
// a person, e.g. "Short Shipped - …", "Took us 3 Hours @ £40 per hour".
const REWORK_LINE = /^(.*?)\s*-\s*X\s*(\d+)\s*$/i;
const REWORK_LINE_SQL = '-\\s*X\\s*\\d+\\s*$';
const HAS_MANUAL_LINE_SQL = col => `EXISTS (SELECT 1 FROM regexp_split_to_table(COALESCE(${col}, ''), E'\\r?\\n') AS ln
                                           WHERE btrim(ln) <> '' AND ln !~* '${REWORK_LINE_SQL}')`;
const ZEROED = /zero|zerod|no charge|free of charge|waive/i;
// SQL twin of "a typed note mentions zeroing" (ZEROED on a non-rework line).
const ZEROED_LINE_SQL = col => `EXISTS (SELECT 1 FROM regexp_split_to_table(COALESCE(${col}, ''), E'\\r?\\n') AS ln
                                        WHERE btrim(ln) <> '' AND ln !~* '${REWORK_LINE_SQL}' AND ln ~* '${ZEROED.source}')`;

function parseComments(text) {
  const reworkItems = [], notes = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln) continue;
    const m = ln.match(REWORK_LINE);
    if (m) reworkItems.push({ item: m[1].trim() || null, qty: parseInt(m[2], 10) });
    else notes.push(ln);
  }
  return { reworkItems, notes };
}

module.exports = { parseComments, REWORK_LINE, REWORK_LINE_SQL, HAS_MANUAL_LINE_SQL, ZEROED_LINE_SQL, ZEROED };
