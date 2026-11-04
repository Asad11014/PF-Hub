// BBE report: stock with a best-before / expiry date, by batch and location,
// grouped into bands, with a per-client warning window. Data: /api/stock/bbe.
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSession } from '../../context/SessionContext'
import StatusBar from '../../components/StatusBar'
import { downloadCsv, fmtAsOf, fmtDay } from '../../lib/reportUtils'

const BAND_STYLE = {
  expired: 'bg-danger/15 text-danger border-danger/30',
  lt30:    'bg-danger/10 text-danger border-danger/20',
  d30_60:  'bg-warning/15 text-warning border-warning/30',
  d60_90:  'bg-gold/15 text-gold border-gold/30',
  d90p:    'bg-success/10 text-success border-success/20',
}
const daysText = d => (d < 0 ? `${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`)

export default function BbeReport() {
  const { session, selectedClientId } = useSession()
  const [data, setData]       = useState(null)
  const [status, setStatus]   = useState({ msg: '', type: null })
  const [filter, setFilter]   = useState('window')   // window | all | <band key>
  const [search, setSearch]   = useState('')
  const [windowDays, setWindowDays] = useState('')
  const [saving, setSaving]   = useState(false)

  const clientQs = session?.isWarehouse && selectedClientId ? `?clientId=${selectedClientId}` : ''
  const allClients = session?.isWarehouse && !selectedClientId

  const load = useCallback(async () => {
    setStatus({ msg: 'Loading…', type: 'loading' })
    try {
      const res = await fetch(`/api/stock/bbe${clientQs}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to load the BBE report')
      setData(d); setWindowDays(String(d.warningDays)); setStatus({ msg: '', type: null })
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [clientQs])
  useEffect(() => { load() }, [load])

  async function saveWindow() {
    setSaving(true)
    try {
      const res = await fetch(`/api/stock/bbe/settings${clientQs}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warningDays: Number(windowDays) }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Could not save')
      setStatus({ msg: `Warning window set to ${d.warningDays} days`, type: 'success' }); load()
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) } finally { setSaving(false) }
  }

  const rows = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.rows.filter(r => {
      if (filter === 'window' && !r.inWindow) return false
      if (filter !== 'window' && filter !== 'all' && r.band !== filter) return false
      if (q && ![r.sku, r.name, r.batch, r.location, r.clientName].some(v => (v || '').toLowerCase().includes(q))) return false
      return true
    })
  }, [data, filter, search])

  const inWindow = data ? data.rows.filter(r => r.inWindow) : []

  function exportCsv() {
    downloadCsv(`bbe-report-${data.today}.csv`,
      [...(allClients ? ['Client'] : []), 'Best before', 'Days left', 'Band', 'SKU', 'Product', 'Batch', 'Location', 'Location type', 'Quantity'],
      rows.map(r => [...(allClients ? [r.clientName] : []), r.bestBefore, r.daysLeft, data.bands.find(b => b.key === r.band)?.label, r.sku, r.name, r.batch, r.location, r.locationType, r.quantity]))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center justify-between sticky top-0 z-40 gap-2">
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">BBE Report</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">
            Stock with a best-before / expiry date{allClients ? ' · all clients' : ''}{data?.asOf ? ` · data as of ${fmtAsOf(data.asOf)}` : ''}
          </div>
        </div>
        {data && <button onClick={exportCsv} className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-gold hover:text-gold transition-colors">Export CSV</button>}
      </header>

      <div className="p-4 sm:p-7 space-y-5">
        <StatusBar message={status.msg} type={status.type} />

        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {data.bands.map(b => (
                <button key={b.key} onClick={() => setFilter(filter === b.key ? 'all' : b.key)}
                  className={`text-left rounded-lg border p-4 transition-colors ${filter === b.key ? 'ring-2 ring-primary/40' : ''} ${BAND_STYLE[b.key]}`}>
                  <div className="font-mono text-[10px] uppercase tracking-widest opacity-80">{b.label}</div>
                  <div className="font-sans font-extrabold text-2xl leading-tight mt-1">{b.units.toLocaleString('en-GB')}</div>
                  <div className="font-mono text-[10px] opacity-80">units · {b.skus} SKU{b.skus === 1 ? '' : 's'} · {b.lines} line{b.lines === 1 ? '' : 's'}</div>
                </button>
              ))}
            </div>

            {data.missingDate?.lines > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 font-mono text-xs text-warning">
                {data.missingDate.units.toLocaleString('en-GB')} units ({data.missingDate.skus} SKU{data.missingDate.skus === 1 ? '' : 's'}) of expiry-tracked products have no best-before date recorded in Mintsoft.
              </div>
            )}

            <div className="bg-brand-surface border border-brand-border rounded-lg px-4 py-3 flex flex-wrap items-center gap-3">
              <div className="flex rounded border border-brand-border overflow-hidden font-mono text-[11px]">
                {[['window', `Within ${data.warningDays} days (${inWindow.length})`], ['all', `All (${data.rows.length})`]].map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k)}
                    className={`px-3 py-1.5 ${filter === k ? 'bg-primary text-white' : 'bg-white text-ink-muted hover:text-ink'}`}>{label}</button>
                ))}
              </div>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU, product, batch, location…"
                className="flex-1 min-w-[200px] bg-brand-bg border border-brand-border rounded px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-primary" />
              {!allClients && (
                <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
                  <label htmlFor="bbe-window">Warning window</label>
                  <input id="bbe-window" type="number" min="1" max="730" value={windowDays} onChange={e => setWindowDays(e.target.value)}
                    className="w-16 bg-brand-bg border border-brand-border rounded px-2 py-1 text-ink" />
                  <span>days</span>
                  <button onClick={saveWindow} disabled={saving || Number(windowDays) === data.warningDays}
                    className="border border-primary text-primary rounded px-2.5 py-1 hover:bg-primary hover:text-white disabled:opacity-40">Save</button>
                </div>
              )}
            </div>

            <div className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
              <table className="w-full text-left min-w-[760px]">
                <thead>
                  <tr className="border-b border-brand-border font-mono text-[9px] text-ink-dim uppercase tracking-widest">
                    {allClients && <th className="px-4 py-3">Client</th>}
                    <th className="px-4 py-3">Best before</th><th className="px-4 py-3">Days left</th>
                    <th className="px-4 py-3">SKU</th><th className="px-4 py-3">Product</th><th className="px-4 py-3">Batch</th>
                    <th className="px-4 py-3">Location</th><th className="px-4 py-3 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={allClients ? 8 : 7} className="px-4 py-8 text-center font-mono text-xs text-ink-muted">
                      {data.rows.length ? 'Nothing matches this filter.' : 'No stock with a best-before date.'}
                    </td></tr>
                  )}
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-brand-border/60 last:border-0">
                      {allClients && <td className="px-4 py-2.5 text-sm text-ink">{r.clientName}</td>}
                      <td className="px-4 py-2.5 font-mono text-xs text-ink whitespace-nowrap">{fmtDay(r.bestBefore)}</td>
                      <td className="px-4 py-2.5"><span className={`font-mono text-[11px] border rounded px-2 py-0.5 whitespace-nowrap ${BAND_STYLE[r.band]}`}>{daysText(r.daysLeft)}</span></td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">{r.sku}</td>
                      <td className="px-4 py-2.5 text-sm text-ink">{r.name || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">{r.batch || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">{r.location}<span className="ml-1.5 text-[9px] text-ink-dim uppercase">{r.locationType}</span></td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-ink">{r.quantity.toLocaleString('en-GB')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
