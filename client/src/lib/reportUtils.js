// Small helpers shared by the DB-backed stock reports (BBE, Quarantine).

// Download rows (arrays) as a CSV file. Every cell is quoted and escaped.
export function downloadCsv(filename, headers, rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// "21 Oct, 15:17" — when the data was last synced from Mintsoft.
export const fmtAsOf = t => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

// 'YYYY-MM-DD' → "31 Jul 2027" (no time-zone shift).
export const fmtDay = d => {
  if (!d) return '—'
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
