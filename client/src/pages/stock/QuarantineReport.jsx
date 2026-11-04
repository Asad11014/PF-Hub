// Quarantine report: every unit of stock held in quarantine, by batch and
// location, with value at cost where the product has a cost price. "Held as"
// separates quarantine status from stock sitting in a quarantine location.
// Data: /api/stock/quarantine.
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSession } from '../../context/SessionContext'
import StatusBar from '../../components/StatusBar'
import StatCard  from '../../components/StatCard'
import { downloadCsv, fmtAsOf, fmtDay } from '../../lib/reportUtils'

const HELD_AS = { status: 'Quarantine status', location: 'Quarantine location' }
const gbp = v => (v == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(v))
const ago = t => {
  if (!t) return '—'
  const days = Math.floor((Date.now() - new Date(t).getTime()) / 864e5)
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}

export default function QuarantineReport() {
  const { session, selectedClientId } = useSession()
  const [data, setData]     = useState(null)
  const [status, setStatus] = useState({ msg: '', type: null })
  const [search, setSearch] = useState('')

  const clientQs = session?.isWarehouse && selectedClientId ? `?clientId=${selectedClientId}` : ''
  const allClients = session?.isWarehouse && !selectedClientId

  const load = useCallback(async () => {
    setStatus({ msg: 'Loading…', type: 'loading' })
    try {
      const res = await fetch(`/api/stock/quarantine${clientQs}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to load the quarantine report')
      setData(d); setStatus({ msg: '', type: null })
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [clientQs])
  useEffect(() => { load() }, [load])

  const rows = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return q ? data.rows.filter(r => [r.sku, r.name, r.batch, r.location, r.clientName].some(v => (v || '').toLowerCase().includes(q))) : data.rows
  }, [data, search])

  function exportCsv() {
    downloadCsv(`quarantine-report-${new Date().toISOString().slice(0, 10)}.csv`,
      [...(allClients ? ['Client'] : []), 'SKU', 'Product', 'Batch', 'Best before', 'Location', 'Location type', 'Held as', 'Quantity', 'Cost price', 'Value at cost', 'Last moved'],
      rows.map(r => [...(allClients ? [r.clientName] : []), r.sku, r.name, r.batch, r.bestBefore, r.location, r.locationType, HELD_AS[r.heldAs], r.quantity,
        r.costPrice ?? '', r.costPrice == null ? '' : (r.quantity * r.costPrice).toFixed(2), r.lastMoved ? new Date(r.lastMoved).toISOString().slice(0, 10) : '']))
  }

  const s = data?.summary

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center justify-between sticky top-0 z-40 gap-2">
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">Quarantine Report</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">
            Stock held in quarantine{allClients ? ' · all clients' : ''}{data?.asOf ? ` · data as of ${fmtAsOf(data.asOf)}` : ''}
          </div>
        </div>
        {data && <button onClick={exportCsv} className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-gold hover:text-gold transition-colors">Export CSV</button>}
      </header>

      <div className="p-4 sm:p-7 space-y-5">
        <StatusBar message={status.msg} type={status.type} />

        {data && (
          <>
            <div className="flex flex-wrap gap-3">
              <StatCard label="Units in quarantine" value={s.units.toLocaleString('en-GB')} accent={s.units ? 'danger' : 'success'} />
              <StatCard label="SKUs" value={s.skus} />
              <StatCard label="Lines" value={s.lines} />
              <StatCard label="Value at cost" value={gbp(s.valueAtCost)} />
            </div>
            {s.units > 0 && (
              <div className="font-mono text-[11px] text-ink-muted">
                {s.unitsByStatus.toLocaleString('en-GB')} units have quarantine status · {s.unitsByLocation.toLocaleString('en-GB')} units are in a quarantine location
              </div>
            )}
            {s.linesWithoutCost > 0 && s.lines > 0 && (
              <div className="font-mono text-[11px] text-ink-muted">Value at cost excludes {s.linesWithoutCost} line{s.linesWithoutCost === 1 ? '' : 's'} whose product has no cost price in Mintsoft.</div>
            )}

            <div className="bg-brand-surface border border-brand-border rounded-lg px-4 py-3">
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU, product, batch, location…"
                className="w-full bg-brand-bg border border-brand-border rounded px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-primary" />
            </div>

            <div className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
              <table className="w-full text-left min-w-[760px]">
                <thead>
                  <tr className="border-b border-brand-border font-mono text-[9px] text-ink-dim uppercase tracking-widest">
                    {allClients && <th className="px-4 py-3">Client</th>}
                    <th className="px-4 py-3">SKU</th><th className="px-4 py-3">Product</th><th className="px-4 py-3">Batch</th>
                    <th className="px-4 py-3">Best before</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Held as</th>
                    <th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Value at cost</th><th className="px-4 py-3">Last moved</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={allClients ? 10 : 9} className="px-4 py-8 text-center font-mono text-xs text-ink-muted">
                      {data.rows.length ? 'Nothing matches this search.' : 'No stock is in quarantine.'}
                    </td></tr>
                  )}
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-brand-border/60 last:border-0">
                      {allClients && <td className="px-4 py-2.5 text-sm text-ink">{r.clientName}</td>}
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">{r.sku}</td>
                      <td className="px-4 py-2.5 text-sm text-ink">{r.name || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">{r.batch || '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink whitespace-nowrap">{fmtDay(r.bestBefore)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">{r.location}<span className="ml-1.5 text-[9px] text-ink-dim uppercase">{r.locationType}</span></td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted whitespace-nowrap">{HELD_AS[r.heldAs]}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-ink">{r.quantity.toLocaleString('en-GB')}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-ink">{r.costPrice == null ? '—' : gbp(r.quantity * r.costPrice)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-muted whitespace-nowrap" title={r.lastMoved ? new Date(r.lastMoved).toLocaleString('en-GB') : ''}>{ago(r.lastMoved)}</td>
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
