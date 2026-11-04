// Invoice Audit — this month so far: Mintsoft's running total for the month
// (updated at each daily billing run) against what the audit expects for the
// orders despatched in the same window, category by category.
import { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import StatusBar from '../../components/StatusBar'
import StatCard  from '../../components/StatCard'
import { gbp, signedGbp, isZero, fmtDateTime } from './format'
import { Chip } from './Review'

const STATUS = {
  matches:        { label: '✓ matches',      cls: 'bg-success/15 text-success border-success/30' },
  close:          { label: 'close',          cls: 'bg-success/10 text-success border-success/20' },
  explained:      { label: 'explained',      cls: 'bg-primary/10 text-primary border-primary/20' },
  low_confidence: { label: 'rough estimate', cls: 'bg-brand-bg text-ink-muted border-brand-border' },
  differs:        { label: 'differs',        cls: 'bg-danger/15 text-danger border-danger/30' },
}
const monthName = m => (m ? new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '')

export default function AuditPreview() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const clientId = params.get('clientId')
  const [list, setList] = useState(null)
  const [one, setOne] = useState(null)
  const [status, setStatus] = useState({ msg: 'Loading…', type: 'loading' })

  useEffect(() => {
    let alive = true
    setStatus({ msg: clientId ? 'Pricing this month’s orders…' : 'Loading running totals…', type: 'loading' })
    fetch(`/api/audit/preview${clientId ? `?clientId=${clientId}` : ''}`).then(async r => {
      const d = await r.json()
      if (!alive) return
      if (!r.ok) throw new Error(d.error || 'Failed to load')
      if (clientId) setOne(d); else setList(d)
      setStatus({ msg: '', type: null })
    }).catch(e => alive && setStatus({ msg: e.message, type: 'error' }))
    return () => { alive = false }
  }, [clientId])

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center gap-3 sticky top-0 z-40">
        <Link to={clientId ? '/app/audit/preview' : '/app/audit'} className="font-mono text-[11px] text-ink-muted hover:text-primary no-underline">← {clientId ? 'All clients' : 'Invoices'}</Link>
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">This month so far{one ? ` · ${one.client.name}` : ''}</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">Mintsoft’s running total for the month against what the audit expects, before the invoice is raised</div>
        </div>
      </header>

      <div className="p-4 sm:p-7 space-y-5">
        <StatusBar message={status.msg} type={status.type} />

        {!clientId && list && (
          <div className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
            <div className="px-5 py-3 border-b border-brand-border font-sans font-bold text-sm text-ink">{monthName(list.month)}</div>
            <table className="w-full text-left min-w-[760px]">
              <thead><tr className="border-b border-brand-border font-mono text-[9px] text-ink-dim uppercase tracking-widest">
                <th className="px-4 py-3">Client</th><th className="px-4 py-3 text-right">Running total</th><th className="px-4 py-3 text-right">Orders</th>
                <th className="px-4 py-3 text-right">Picking, rework, admin</th><th className="px-4 py-3 text-right">Expected</th><th className="px-4 py-3 text-right">Difference</th>
                <th className="px-4 py-3">Last billing run</th></tr></thead>
              <tbody>
                {!list.clients.length && <tr><td colSpan={7} className="px-4 py-8 text-center font-mono text-xs text-ink-muted">No running totals this month yet.</td></tr>}
                {list.clients.map(c => (
                  <tr key={c.clientId} onClick={() => navigate(`/app/audit/preview?clientId=${c.clientId}`)} className="border-b border-brand-border/60 last:border-0 cursor-pointer hover:bg-brand-bg font-mono text-xs text-ink">
                    <td className="px-4 py-2.5 font-sans text-sm">{c.clientName}</td>
                    <td className="px-4 py-2.5 text-right font-semibold">{gbp(c.accrual)}</td>
                    <td className="px-4 py-2.5 text-right">{c.orders}</td>
                    <td className="px-4 py-2.5 text-right">{gbp(c.modelledAccrual)}</td>
                    <td className="px-4 py-2.5 text-right">{gbp(c.modelledExpected)}</td>
                    <td className={`px-4 py-2.5 text-right ${isZero(c.modelledDifference) ? 'text-success' : c.differs.length ? 'text-danger font-bold' : 'text-ink-muted'}`}>
                      {isZero(c.modelledDifference) ? '✓' : signedGbp(c.modelledDifference)}
                      {!isZero(c.modelledDifference) && !c.differs.length && <div className="text-[9px] font-normal">explained</div>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted">{fmtDateTime(c.accrualUpdatedAt)}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        )}

        {one && (
          <>
            <div className="flex flex-wrap gap-3">
              <StatCard label="Mintsoft so far" value={gbp(one.totals.accrual)} />
              <StatCard label="Orders in the running total" value={one.orders} />
              <StatCard label="Picking, rework, admin: difference" value={isZero(one.totals.modelledDifference) ? '✓ match' : signedGbp(one.totals.modelledDifference)}
                accent={isZero(one.totals.modelledDifference) ? 'success' : one.categories.some(c => c.status === 'differs') ? 'danger' : undefined} />
              <StatCard label="Awaiting the next billing run" value={one.ordersAfterLastRun} />
            </div>
            <div className="font-mono text-[11px] text-ink-muted">
              {one.accrualFound && one.window.end
                ? <>Orders despatched from {fmtDateTime(one.window.start)}{one.window.startEstimated ? ' (estimated)' : ''} to Mintsoft’s last billing run at {fmtDateTime(one.window.end)}. Running total synced {fmtDateTime(one.syncedAt)}.</>
                : 'Mintsoft’s running total for this month has not been synced with its billing time yet; it updates every hour.'}
            </div>
            <section className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
              <table className="w-full text-left min-w-[760px]">
                <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
                  <th className="px-5 py-2 font-medium">Category</th><th className="px-5 py-2 font-medium text-right">Mintsoft so far</th>
                  <th className="px-5 py-2 font-medium text-right">Expected</th><th className="px-5 py-2 font-medium text-right">Difference</th>
                  <th className="px-5 py-2 font-medium">How it was worked out</th></tr></thead>
                <tbody>{one.categories.filter(c => c.modelled || !isZero(c.accrual)).map(c => (
                  <tr key={c.key} className="border-b border-brand-border/60 last:border-0 font-mono text-xs text-ink align-top">
                    <td className="px-5 py-2 font-sans text-sm">{c.label}</td>
                    <td className="px-5 py-2 text-right">{gbp(c.accrual)}</td>
                    <td className="px-5 py-2 text-right">{c.expected == null ? <span className="text-ink-muted">not modelled</span> : gbp(c.expected)}</td>
                    <td className="px-5 py-2 text-right">
                      {c.difference == null ? '—' : <>{isZero(c.difference) ? '' : signedGbp(c.difference)} {c.status && <Chip cls={STATUS[c.status]?.cls}>{STATUS[c.status]?.label}</Chip>}</>}
                    </td>
                    <td className="px-5 py-2 font-sans text-xs text-ink-muted max-w-[460px]">
                      {c.modelled ? c.notes.map((n, i) => <div key={i}>{n}</div>) : 'Mintsoft’s total only: checked line by line once the invoice is raised.'}
                    </td>
                  </tr>))}</tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
