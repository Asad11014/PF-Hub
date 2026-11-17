// Calls the Hub's /api/wix/* routes (server/wix.js), which forward to the Wix
// integration Worker. Same-origin with the Hub session cookie; the Worker's
// credentials never reach the browser.

export class WixError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function wix(method, path, body) {
  const r = await fetch(`/api/wix${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let d = null
  try { d = await r.json() } catch { /* empty or not JSON */ }
  if (r.status === 401) throw new WixError('Your Hub session has expired. Sign in again.', 401, d)
  if (!r.ok) {
    const msg = d?.message || (d?.error === 'internal_error' ? 'The integration hit an unexpected error. Try again; if it keeps happening, check the Errors tab and the Worker logs.' : d?.error)
    throw new WixError(msg || `Request failed (HTTP ${r.status})`, r.status, d)
  }
  return d
}

const enc = encodeURIComponent
export const clientPath = (slug, rest = '') => `/clients/${enc(slug)}${rest}`

// Worker timestamps are UTC, either ISO or SQLite "YYYY-MM-DD HH:MM:SS".
export function parseTime(s) {
  if (!s) return null
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

export function ago(s) {
  const d = parseTime(s)
  if (!d) return '—'
  const sec = Math.round((Date.now() - d.getTime()) / 1000)
  if (sec < 60) return 'just now'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

export const minutesSince = s => {
  const d = parseTime(s)
  return d ? (Date.now() - d.getTime()) / 60000 : Infinity
}

export const fmtWhen = s => {
  const d = parseTime(s)
  return d ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
}

export const gbp = v => (v == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(v))
