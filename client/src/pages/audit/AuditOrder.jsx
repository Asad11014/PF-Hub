// Invoice Audit — one order: what the audit read from it, how each rule and the
// picking pattern were applied, and every billed line with its findings.
import { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../../context/SessionContext'
import StatusBar from '../../components/StatusBar'
import { gbp, isZero, fmtDate, fmtDateTime, INVOICE_STATUS } from './format'
import { Chip, FindingList } from './Review'

const OP = {
  Equals: '=', NotEqual: '≠', Contains: 'contains', DoesNotContain: 'does not contain', StartsWith: 'starts with', DoesNotStartWith: 'does not start with',
  Empty: 'is empty', IsNotEmpty: 'is not empty', GreaterThan: '>', LessThan: '<', EqualsOrGreaterThan: '≥', EqualsOrLessThan: '≤',
}
const show = v => (Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v == null || v === '' ? '(blank)' : String(v))
const Result = ({ r }) => (r === true ? <span className="text-success font-bold">✓ true</span> : r === false ? <span className="text-ink-muted">✗ false</span> : <span className="text-warning">? cannot read</span>)
const Box = ({ title, children, right }) => (
  <section className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
    <div className="px-5 py-3 border-b border-brand-border flex items-center justify-between gap-3">
      <span className="font-sans font-bold text-sm text-ink">{title}</span>{right}
    </div>
    <div className="px-5 py-3">{children}</div>
  </section>
)
const Row = ({ k, v }) => <div className="flex gap-3 font-mono text-[11px]"><span className="text-ink-muted w-36 flex-shrink-0">{k}</span><span className="text-ink">{v}</span></div>

export default function AuditOrder() {
  const { id } = useParams()
  const { hasPermission } = useSession()
  const canReview = hasPermission('invoice_audit_review')
  const [d, setD] = useState(null)
  const [status, setStatus] = useState({ msg: 'Loading order…', type: 'loading' })

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/audit/orders/${id}`)
      const x = await r.json()
      if (!r.ok) throw new Error(x.error || 'Failed to load order')
      setD(x); setStatus({ msg: '', type: null })
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [id])
  useEffect(() => { load() }, [load])

  if (!d) return <div className="p-4 sm:p-7"><StatusBar message={status.msg} type={status.type} /></div>
  const o = d.order
  const f = d.features

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center gap-3 sticky top-0 z-40">
        <Link to={d.lines[0] ? `/app/audit/invoice/${d.lines[0].invoiceId}` : '/app/audit'} className="font-mono text-[11px] text-ink-muted hover:text-primary no-underline">← {d.lines[0] ? 'Invoice' : 'Invoices'}</Link>
        <div className="min-w-0">
          <div className="font-sans font-bold text-[15px] text-ink truncate">Order {o?.orderNumber || `#${id}`} · {d.clientName || 'unknown client'}</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">
            {o ? `${o.status || '—'} · ordered ${fmtDate(o.orderDate)} · despatched ${fmtDate(o.despatchDate)} · ${o.channel || 'no channel'} · ${o.courier || 'no courier'}` : 'This order no longer exists in Mintsoft'}
          </div>
        </div>
        <Link to={`/app/audit/client/${d.clientId}`} className="ml-auto font-mono text-[11px] text-ink-muted hover:text-primary no-underline">Rates &amp; rules</Link>
      </header>

      <div className="p-4 sm:p-7 space-y-5">
        <StatusBar message={status.msg} type={status.type} />
        {!d.lines.length && <StatusBar message="This order is not on any invoice yet." type="loading" />}

        <div className="grid gap-5 lg:grid-cols-2">
          <Box title="Items">
            {!d.items.length ? <div className="font-mono text-[11px] text-ink-muted">No items held for this order.</div> : (
              <table className="w-full text-left min-w-[440px]">
                <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
                  <th className="py-1.5 pr-3 font-medium">SKU</th><th className="py-1.5 pr-3 font-medium">Product</th><th className="py-1.5 pr-3 font-medium text-right">Qty</th><th className="py-1.5 pr-3 font-medium">W×H×D cm</th></tr></thead>
                <tbody>{d.items.map((i, k) => (
                  <tr key={k} className="border-b border-brand-border/60 last:border-0 font-mono text-[11px] text-ink align-top">
                    <td className="py-1.5 pr-3">{i.sku}{i.notCharged && <div className="text-[9px] uppercase text-ink-muted">not charged for picking</div>}</td>
                    <td className="py-1.5 pr-3 font-sans text-xs">{i.name || '—'}{i.category && <div className="font-mono text-[10px] text-ink-muted">{i.category}</div>}
                      {i.editedAfterBilling && <div className="font-mono text-[9px] uppercase text-warning">product edited after billing</div>}</td>
                    <td className="py-1.5 pr-3 text-right">{i.quantity}</td>
                    <td className="py-1.5 pr-3">{i.dims.every(x => x > 0) ? i.dims.join(' × ') : <span className="text-warning">missing</span>}</td>
                  </tr>))}</tbody>
              </table>
            )}
          </Box>
          <Box title="What the rules read">
            <div className="space-y-1">
              <Row k="Total items" v={f.totalItems} />
              <Row k="Order volume" v={<>{f.orderVolume} m³{!f.volumeComplete && <span className="text-warning"> (a product has no dimensions)</span>}</>} />
              <Row k="Largest dimension" v={`${f.largestDimension} cm`} />
              <Row k="Categories" v={show(f.categories)} />
              <Row k="Weight · value" v={`${f.totalWeight ?? '—'} kg · ${gbp(f.orderValue)}`} />
              <Row k="Channel · courier" v={`${f.channel || '—'} · ${f.courierService || '—'}`} />
            </div>
          </Box>
        </div>

        <Box title="Mintsoft rework rules on this order" right={<span className="font-mono text-[10px] text-ink-muted">today’s rules, as captured from Mintsoft</span>}>
          {!d.rules.length ? <div className="font-mono text-[11px] text-ink-muted">This client has no rework rules in Mintsoft.</div> : (
            <div className="divide-y divide-brand-border/60">
              {d.rules.map(r => (
                <div key={r.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                    <span className={r.applies === true ? 'text-success font-bold' : r.applies === false ? 'text-ink-muted' : 'text-warning'}>
                      {r.applies === true ? '✓ applies' : r.applies === false ? '✗ does not apply' : '? cannot tell'}
                    </span>
                    <span className="text-ink font-semibold">#{r.id} adds {r.itemName || r.code}{r.qty > 1 ? ` × ${r.qty}` : ''}</span>
                    <span className="text-ink-muted">{r.unitPrice != null ? `${gbp(r.unitPrice)} each (${r.priceSource})` : 'price not known'}</span>
                    <span className="text-ink-muted">· {r.conditionType === 'OR' ? 'any condition' : 'all conditions'} · priority {r.priority}</span>
                    {r.editedAfterOrder && <span className="text-warning">· rule edited {fmtDate(r.lastUpdated)}, after this order</span>}
                    {r.channelMismatch && <span className="text-ink-muted">· for another channel</span>}
                  </div>
                  {r.comments && <div className="font-sans text-xs text-ink-muted">{r.comments}</div>}
                  {r.conditions.length > 0 && (
                    <table className="mt-1 text-left font-mono text-[11px]">
                      <tbody>{r.conditions.map((c, k) => (
                        <tr key={k} className="align-top"><td className="pr-3 text-ink">{c.field} {OP[c.operator] || c.operator} {['Empty', 'IsNotEmpty'].includes(c.operator) ? '' : `“${c.value}”`}</td>
                          <td className="pr-3 text-ink-muted">order: {show(c.actual)}</td><td><Result r={c.result} /></td></tr>))}</tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </Box>

        {d.lines.map(l => (
          <Box key={l.lineId} title={<>Billed on <Link to={`/app/audit/invoice/${l.invoiceId}`}>{l.invoiceName || `invoice #${l.invoiceId}`}</Link> · {fmtDateTime(l.billedAt)}</>}
            right={<Chip cls={(INVOICE_STATUS[l.invoiceStatus] || INVOICE_STATUS.not_reviewed).cls}>{(INVOICE_STATUS[l.invoiceStatus] || INVOICE_STATUS.not_reviewed).label}</Chip>}>
            <div className="grid gap-4 lg:grid-cols-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Billed</div>
                {[['Picking', l.billed.totalPicking], ['Postage', l.billed.postage], ['Courier cost', l.billed.postageCourierCost], ['Rework', l.billed.rework],
                  ['Packaging', l.billed.packaging], ['Admin', l.billed.admin], ['Total', l.billed.total]].map(([k, v]) => <Row key={k} k={k} v={v == null || isZero(v) ? '–' : gbp(v)} />)}
                {l.comments.reworkItems.length > 0 && <Row k="Rework items" v={l.comments.reworkItems.map(i => `${i.item || 'item'} × ${i.qty}`).join(', ')} />}
                {l.comments.notes.length > 0 && <Row k="Notes" v={l.comments.notes.join(' · ')} />}
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Picking for {l.month}</div>
                <Row k="Counted" v={`${l.picking.counts.units} units · ${l.picking.counts.lines} lines · ${l.picking.counts.skus} SKUs`} />
                {l.picking.excludedInOrder.length > 0 && <Row k="Not charged" v={l.picking.excludedInOrder.join(', ')} />}
                {l.picking.candidates.map((c, k) => (
                  <div key={k} className="font-mono text-[11px] mt-1">
                    <span className={c.matches ? 'text-success font-bold' : 'text-ink-muted'}>{c.matches ? '✓' : '✗'} {gbp(c.amount)}</span>
                    <span className="text-ink-muted"> {c.label}: {c.formula}</span>
                  </div>
                ))}
                {l.picking.confidence != null && <div className="font-mono text-[10px] text-ink-muted mt-1">The month’s pattern reproduces {Math.round(l.picking.confidence * 100)} % of its orders.</div>}
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Rework and admin</div>
                <Row k="Rules expect" v={l.expected?.rework?.items?.length ? l.expected.rework.items.map(i => `${i.name || i.code} × ${i.qty}${i.unitPrice != null ? ` @ ${gbp(i.unitPrice)}` : ''}`).join(', ') : 'nothing'} />
                <Row k="Expected rework" v={l.expected?.rework?.amount != null ? gbp(l.expected.rework.amount) : l.expected?.rework?.items?.length ? 'price not known' : '–'} />
                {l.expected?.rework?.uncertain && <Row k="Uncertain" v={l.expected.rework.uncertain} />}
                <Row k="Usual admin fee" v={l.admin ? `${gbp(l.admin.value)} (${Math.round(l.admin.share * 100)} % of orders)` : '–'} />
                {l.postageUsual && <Row k="Usual postage" v={`${gbp(l.postageUsual.usual)} per parcel on this service`} />}
                {l.auditRules.length > 0 && l.auditRules.map(r => (
                  <Row key={r.id} k={`Your rule ${r.name}`} v={r.applies === true ? (r.flagged ? <span className="text-danger">not met: {r.expectation}</span> : <span className="text-success">✓ {r.expectation}</span>) : r.applies === false ? 'does not apply' : 'cannot tell'} />
                ))}
              </div>
            </div>
            <div className="mt-3 border-t border-brand-border pt-2">
              <FindingList flags={l.flags} canReview={canReview} locked={l.invoiceStatus === 'signed_off'} onSaved={load} empty="Nothing to review on this line." />
            </div>
          </Box>
        ))}
      </div>
    </div>
  )
}
