// Invoice Audit — overview: every confirmed invoice in the period with its
// integrity check (header vs lines) and flags, plus the coverage checks
// (unbilled, double-billed, billed while cancelled/undespatched, zero/noted).
import { useState, useEffect, useCallback, Fragment } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useSession } from '../../context/SessionContext'
import StatusBar from '../../components/StatusBar'
import StatCard  from '../../components/StatCard'
import { downloadCsv } from '../../lib/reportUtils'
import { gbp, signedGbp, isZero, fmtDate, REVIEW_META, INVOICE_STATUS } from './format'
import { Chip, ReviewControl } from './Review'

const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const monthsAgo = k => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); return ym(d) }

function Section({ title, count, tone = 'ink', hint, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="bg-brand-surface border border-brand-border rounded-lg">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <div>
          <span className="font-sans font-bold text-sm text-ink">{title}</span>
          {hint && <span className="ml-2 font-mono text-[11px] text-ink-muted">{hint}</span>}
        </div>
        <span className={`font-mono text-xs font-bold ${count ? `text-${tone}` : 'text-success'}`}>{count ? count.toLocaleString('en-GB') : '✓ none'} {open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="border-t border-brand-border px-5 py-3 overflow-x-auto">{children}</div>}
    </section>
  )
}

const Th = ({ children, right }) => <th className={`py-1.5 pr-3 font-medium ${right ? 'text-right' : ''}`}>{children}</th>
const headRow = 'font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border'

export default function AuditOverview() {
  const { session, hasPermission } = useSession()
  const canReview = hasPermission('invoice_audit_review')
  const navigate = useNavigate()
  const [openOrder, setOpenOrder] = useState(null)
  const [from, setFrom] = useState(monthsAgo(3))
  const [to, setTo] = useState(monthsAgo(0))
  const [clientId, setClientId] = useState('')
  const [data, setData] = useState(null)
  const [cov, setCov] = useState(null)
  const [status, setStatus] = useState({ msg: '', type: null })

  const load = useCallback(async () => {
    setStatus({ msg: 'Loading invoices…', type: 'loading' })
    const qs = new URLSearchParams({ from, to, ...(clientId ? { clientId } : {}) })
    try {
      const [a, b] = await Promise.all([fetch(`/api/audit/overview?${qs}`), fetch(`/api/audit/coverage?${qs}`)])
      const [da, db] = await Promise.all([a.json(), b.json()])
      if (!a.ok) throw new Error(da.error || 'Failed to load invoices')
      if (!b.ok) throw new Error(db.error || 'Failed to load coverage')
      setData(da); setCov(db); setStatus({ msg: '', type: null })
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [from, to, clientId])
  useEffect(() => { load() }, [load])

  const inv = data?.invoices || []
  const billed = inv.reduce((s, i) => s + i.total, 0)
  const mismatched = inv.filter(i => i.detailSynced && !isZero(i.difference)).length
  const margin = inv.reduce((s, i) => s + i.postage.margin, 0)
  const errorFlags = inv.reduce((s, i) => s + i.flags.doubleBilled + i.flags.cancelled + i.flags.notDespatched, 0)
  const under = inv.reduce((s, i) => s + (i.expected?.under || 0), 0)
  const over = inv.reduce((s, i) => s + (i.expected?.over || 0), 0)
  const openFindings = inv.reduce((s, i) => s + (i.review?.open || 0), 0)
  const signedOff = inv.filter(i => i.review?.status === 'signed_off').length
  const unbilledOpen = cov ? cov.unbilled.filter(o => !o.review).length : 0
  const findingsUrl = `/api/audit/findings.csv?${new URLSearchParams({ from, to, ...(clientId ? { clientId } : {}) })}`

  function exportCoverage() {
    const rows = [
      ...cov.unbilled.map(o => ['Unbilled', o.clientName, o.orderNumber, fmtDate(o.despatchDate), o.status, '', '']),
      ...cov.doubleBilled.map(d => ['Double-billed', d.clientName, d.orderNumber || d.orderId, '', '', d.lines.map(l => l.invoiceName || l.invoiceId).join(' / '), d.lines.map(l => l.total).join(' / ')]),
      ...cov.billedWrongState.map(w => [`Billed while ${w.reason}`, w.clientName, w.orderNumber, '', w.status, w.invoiceName, w.total]),
      ...cov.zeroOrNoted.map(z => [z.zero ? 'Zero charge' : 'Note on line', z.clientName, z.orderNumber || z.orderId, '', '', z.invoiceName, z.total, z.comments || '']),
    ]
    downloadCsv(`invoice-audit-coverage-${from}-to-${to}.csv`, ['Check', 'Client', 'Order', 'Despatched', 'Status', 'Invoice', 'Billed', 'Comments'], rows)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center justify-between sticky top-0 z-40 gap-2">
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">Invoice Audit</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">What we billed, order by order, and what doesn’t add up · confirmed invoices</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link to="/app/audit/preview" className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-primary hover:text-primary no-underline">This month so far</Link>
          {data && <a href={findingsUrl} download className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-gold hover:text-gold no-underline">Export findings CSV</a>}
          {cov && <button onClick={exportCoverage} className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-gold hover:text-gold">Export checks CSV</button>}
          {session?.isOwner && <Link to="/app/audit/access" className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-primary hover:text-primary no-underline">Access</Link>}
        </div>
      </header>

      <div className="p-4 sm:p-7 space-y-5">
        <div className="bg-brand-surface border border-brand-border rounded-lg px-4 py-3 flex flex-wrap items-end gap-3 font-mono text-[11px] text-ink-muted">
          <label className="flex flex-col gap-1">From<input type="month" value={from} onChange={e => setFrom(e.target.value)} className="bg-brand-bg border border-brand-border rounded px-2 py-1 text-ink" /></label>
          <label className="flex flex-col gap-1">To<input type="month" value={to} onChange={e => setTo(e.target.value)} className="bg-brand-bg border border-brand-border rounded px-2 py-1 text-ink" /></label>
          <label className="flex flex-col gap-1">Client
            <select value={clientId} onChange={e => setClientId(e.target.value)} className="bg-brand-bg border border-brand-border rounded px-2 py-1 text-ink min-w-[200px]">
              <option value="">All clients</option>
              {(data?.clients || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {data?.historyStart && <span className="ml-auto">Order data from {fmtDate(data.historyStart)}</span>}
        </div>

        <StatusBar message={status.msg} type={status.type} />

        {data && cov && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
              <StatCard label="Invoices" value={inv.length} />
              <StatCard label="Billed" value={gbp(billed)} />
              <StatCard label="Lines ≠ invoice" value={mismatched} accent={mismatched ? 'danger' : 'success'} />
              <StatCard label="Unbilled orders" value={cov.unbilled.length} accent={cov.unbilled.length ? 'danger' : 'success'} />
              <StatCard label="Billing errors" value={errorFlags} accent={errorFlags ? 'danger' : 'success'} />
              <StatCard label="Postage margin" value={gbp(margin)} accent={margin < 0 ? 'danger' : undefined} />
              <StatCard label="Possibly undercharged" value={gbp(under)} accent={under ? 'danger' : 'success'} />
              <StatCard label="Possibly overcharged" value={gbp(over)} accent={over ? 'warning' : 'success'} />
              <StatCard label="Findings to review" value={openFindings} accent={openFindings ? 'warning' : 'success'} />
              <StatCard label="Signed off" value={`${signedOff} / ${inv.length}`} accent={inv.length && signedOff === inv.length ? 'success' : undefined} />
            </div>

            <div className="space-y-3">
              <Section title="Despatched but never billed" count={unbilledOpen} tone="danger"
                hint={`despatched more than ${cov.cutoffHours} h before the client’s latest billing run and on no invoice${cov.unbilled.length > unbilledOpen ? ` · ${cov.unbilled.length - unbilledOpen} reviewed` : ''}`}>
                <table className="w-full text-left min-w-[720px]">
                  <thead><tr className={headRow}><Th>Client</Th><Th>Order</Th><Th>Ordered</Th><Th>Despatched</Th><Th>Status</Th><Th>Courier</Th><Th>Review</Th></tr></thead>
                  <tbody>{cov.unbilled.map(o => (
                    <Fragment key={o.orderId}>
                    <tr onClick={() => setOpenOrder(x => (x === o.orderId ? null : o.orderId))} className="border-b border-brand-border/60 font-mono text-[11px] text-ink cursor-pointer hover:bg-brand-bg">
                      <td className="py-1.5 pr-3 font-sans text-xs">{o.clientName}</td>
                      <td className="py-1.5 pr-3 font-bold"><Link to={`/app/audit/order/${o.orderId}`} onClick={e => e.stopPropagation()}>{o.orderNumber}</Link></td>
                      <td className="py-1.5 pr-3">{fmtDate(o.orderDate)}</td><td className="py-1.5 pr-3">{fmtDate(o.despatchDate)}</td>
                      <td className="py-1.5 pr-3">{o.status}</td><td className="py-1.5 pr-3 text-ink-muted">{o.courier}</td>
                      <td className="py-1.5 pr-3">{o.review ? <Chip cls={REVIEW_META[o.review.status]?.cls}>{REVIEW_META[o.review.status]?.label}</Chip> : <span className="text-ink-muted">open ▸</span>}</td>
                    </tr>
                    {openOrder === o.orderId && (
                      <tr className="border-b border-brand-border/60 bg-brand-bg/60"><td colSpan={7} className="py-1 px-2">
                        <ReviewControl f={{ code: 'unbilled', severity: 'error', subject: o.subject, check: o.check, review: o.review, text: `Despatched ${fmtDate(o.despatchDate)} and not on any invoice` }}
                          canReview={canReview} locked={false} onSaved={load} />
                      </td></tr>
                    )}
                    </Fragment>))}</tbody>
                </table>
              </Section>

              <Section title="Billed more than once" count={cov.doubleBilled.length} tone="danger">
                <table className="w-full text-left min-w-[560px]">
                  <thead><tr className={headRow}><Th>Client</Th><Th>Order</Th><Th>Billed on</Th></tr></thead>
                  <tbody>{cov.doubleBilled.map(d => (
                    <tr key={d.orderId} className="border-b border-brand-border/60 font-mono text-[11px] text-ink">
                      <td className="py-1.5 pr-3 font-sans text-xs">{d.clientName}</td><td className="py-1.5 pr-3 font-bold">{d.orderNumber || d.orderId}</td>
                      <td className="py-1.5 pr-3">{d.lines.map((l, i) => <Fragment key={l.lineId}>{i ? ' · ' : ''}<Link to={`/app/audit/invoice/${l.invoiceId}`}>{l.invoiceName || `#${l.invoiceId}`}</Link> {gbp(l.total)}</Fragment>)}</td>
                    </tr>))}</tbody>
                </table>
              </Section>

              <Section title="Billed while cancelled or not despatched" count={cov.billedWrongState.length} tone="danger">
                <table className="w-full text-left min-w-[560px]">
                  <thead><tr className={headRow}><Th>Client</Th><Th>Order</Th><Th>Why</Th><Th>Invoice</Th><Th right>Billed</Th></tr></thead>
                  <tbody>{cov.billedWrongState.map(w => (
                    <tr key={`${w.invoiceId}-${w.orderId}`} className="border-b border-brand-border/60 font-mono text-[11px] text-ink">
                      <td className="py-1.5 pr-3 font-sans text-xs">{w.clientName}</td><td className="py-1.5 pr-3 font-bold">{w.orderNumber}</td>
                      <td className="py-1.5 pr-3">{w.reason}</td><td className="py-1.5 pr-3"><Link to={`/app/audit/invoice/${w.invoiceId}`}>{w.invoiceName}</Link></td>
                      <td className="py-1.5 pr-3 text-right">{gbp(w.total)}</td>
                    </tr>))}</tbody>
                </table>
              </Section>

              <Section title="Zero-charge lines and manual notes" count={cov.zeroOrNoted.length} tone="warning">
                <table className="w-full text-left min-w-[640px]">
                  <thead><tr className={headRow}><Th>Client</Th><Th>Order</Th><Th>Invoice</Th><Th right>Billed</Th><Th>Comment</Th></tr></thead>
                  <tbody>{cov.zeroOrNoted.map(z => (
                    <tr key={`${z.invoiceId}-${z.orderId}`} className="border-b border-brand-border/60 font-mono text-[11px] text-ink">
                      <td className="py-1.5 pr-3 font-sans text-xs">{z.clientName}</td><td className="py-1.5 pr-3 font-bold">{z.orderNumber || z.orderId}</td>
                      <td className="py-1.5 pr-3"><Link to={`/app/audit/invoice/${z.invoiceId}`}>{z.invoiceName}</Link></td>
                      <td className={`py-1.5 pr-3 text-right ${z.zero ? 'text-warning font-bold' : ''}`}>{gbp(z.total)}</td>
                      <td className="py-1.5 pr-3 font-sans text-xs">{z.comments || '—'}{z.manualZeroing && <span className="ml-2 font-mono text-[9px] uppercase text-warning">manual zeroing</span>}</td>
                    </tr>))}</tbody>
                </table>
              </Section>

              {cov.awaitingNextInvoice.some(a => a.previousMonthNotInvoiced) && (
                <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 font-mono text-xs text-warning">
                  Last month not invoiced yet: {cov.awaitingNextInvoice.filter(a => a.previousMonthNotInvoiced).map(a => `${a.clientName} (${a.orders} orders since ${fmtDate(a.since)})`).join(' · ')}
                </div>
              )}
              {cov.awaitingNextInvoice.length > 0 && (
                <div className="font-mono text-[11px] text-ink-muted px-1">
                  Awaiting the next invoice (despatched after the latest billing run): {cov.awaitingNextInvoice.map(a => `${a.clientName} ${a.orders}`).join(' · ')}
                </div>
              )}
            </div>

            <div className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
              <table className="w-full text-left min-w-[1020px]">
                <thead>
                  <tr className="border-b border-brand-border font-mono text-[9px] text-ink-dim uppercase tracking-widest">
                    <th className="px-4 py-3">Invoice</th><th className="px-4 py-3">Client</th><th className="px-4 py-3 text-right">Orders</th>
                    <th className="px-4 py-3 text-right">Billed</th><th className="px-4 py-3 text-right">Lines vs invoice</th>
                    <th className="px-4 py-3 text-right">Postage margin</th><th className="px-4 py-3">Expected vs billed</th><th className="px-4 py-3">Flags</th>
                    <th className="px-4 py-3">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center font-mono text-xs text-ink-muted">No confirmed invoices in this period.</td></tr>}
                  {inv.map(i => {
                    const f = i.flags
                    const chips = [
                      f.doubleBilled && [`${f.doubleBilled} double`, 'text-danger'], f.cancelled && [`${f.cancelled} cancelled`, 'text-danger'],
                      f.notDespatched && [`${f.notDespatched} undespatched`, 'text-danger'], f.orderMissing && [`${f.orderMissing} missing order`, 'text-warning'],
                      f.belowCost && [`${f.belowCost} below cost`, 'text-warning'], f.zeroCharge && [`${f.zeroCharge} zero`, 'text-warning'],
                      f.notes && [`${f.notes} notes`, 'text-primary'],
                    ].filter(Boolean)
                    return (
                      <tr key={i.id} onClick={() => navigate(`/app/audit/invoice/${i.id}`)} className="border-b border-brand-border/60 last:border-0 cursor-pointer hover:bg-brand-bg">
                        <td className="px-4 py-2.5"><div className="font-sans text-sm text-ink">{i.name || `#${i.id}`}</div><div className="font-mono text-[10px] text-ink-muted">{fmtDate(i.date)} · #{i.id}</div></td>
                        <td className="px-4 py-2.5 text-sm text-ink">
                          <Link to={`/app/audit/client/${i.clientId}`} onClick={e => e.stopPropagation()} className="text-ink hover:text-primary no-underline">{i.clientName}</Link>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-ink">{i.orderLines}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-ink">{gbp(i.total)}</td>
                        <td className={`px-4 py-2.5 text-right font-mono text-xs ${!i.detailSynced ? 'text-ink-muted' : isZero(i.difference) ? 'text-success' : 'text-danger font-bold'}`}>
                          {!i.detailSynced ? 'not synced yet' : isZero(i.difference) ? '✓ matches' : signedGbp(i.difference)}
                          {i.linesNotAvailable?.length > 0 && <div className="text-[9px] text-ink-muted font-normal">some lines no longer held by Mintsoft</div>}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono text-xs ${i.postage.margin < 0 ? 'text-danger' : 'text-ink'}`}>
                          {gbp(i.postage.margin)}
                          {i.postage.linesWithoutCost > 0 && <div className="text-[9px] text-ink-muted">{i.postage.linesWithoutCost} without courier cost</div>}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px] whitespace-nowrap">
                          {!i.expected || i.beforeHistory ? <span className="text-ink-muted">—</span>
                            : i.expected.open ? <span className="text-warning">{i.expected.open} warning{i.expected.open === 1 ? '' : 's'}{i.expected.under ? ` · −${gbp(i.expected.under)}` : ''}{i.expected.over ? ` · +${gbp(i.expected.over)}` : ''}</span>
                            : i.expected.warnings ? <span className="text-success">✓ {i.expected.warnings} reviewed</span>
                            : <span className="text-success">✓{i.expected.info ? ` (${i.expected.info} explained)` : ''}</span>}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px]">{chips.length ? chips.map(([t, c]) => <span key={t} className={`mr-2 ${c}`}>{t}</span>) : <span className="text-success">✓</span>}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <Chip cls={(INVOICE_STATUS[i.review?.status] || INVOICE_STATUS.not_reviewed).cls}>{(INVOICE_STATUS[i.review?.status] || INVOICE_STATUS.not_reviewed).label}</Chip>
                          <div className={`font-mono text-[10px] mt-0.5 ${i.review?.open ? 'text-warning' : 'text-ink-muted'}`}>{i.review?.open ? `${i.review.open} open` : 'nothing open'}{i.review?.reviewed ? ` · ${i.review.reviewed} reviewed` : ''}</div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="font-mono text-[10px] text-ink-muted px-1">
              “Lines vs invoice” compares the invoice’s totals with the sum of its order, goods-in, returns, collections and other lines. Storage is excluded because Mintsoft only itemises part of it.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
