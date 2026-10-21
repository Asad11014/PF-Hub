// ─── server/sync/time.js ──────────────────────────────────────────────────────
// Mintsoft returns timestamps as UK wall-clock time with no offset
// ("2026-09-20T12:44:00" means 12:44 Europe/London). Parse them as London time
// so the stored instant is the same whatever time zone the server runs in
// (Render is UTC, local dev is usually BST/GMT).

const TZ = 'Europe/London';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// { year, month, day, hour, minute, second, weekday } of an instant in London.
function londonParts(date = new Date()) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return p;
}

// London offset from UTC (ms) at a given UTC instant: +3600000 in BST, 0 in GMT.
function londonOffsetMs(utcMs) {
  const p = londonParts(new Date(utcMs));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Mintsoft timestamp → ISO string (UTC) or null.
function parseMintsoftDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  const s = String(v).trim();
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h = '0', mi = '0', se = '0', frac = ''] = m;
  if (+Y < 1900) return null; // 0001-01-01 placeholders
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  const wall = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se, ms);
  // Two passes so times next to a BST/GMT switch resolve to the right offset.
  let utc = wall - londonOffsetMs(wall);
  utc = wall - londonOffsetMs(utc);
  return new Date(utc).toISOString();
}

// Instant → London wall-clock "YYYY-MM-DDTHH:mm:ss" (the format Mintsoft expects
// for SinceDate / SinceLastUpdated / ToDate query parameters).
function toMintsoftParam(date) {
  const p = londonParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// Instant → London calendar date "YYYY-MM-DD".
function londonDate(date = new Date()) {
  const p = londonParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

module.exports = { TZ, londonParts, parseMintsoftDate, toMintsoftParam, londonDate };
