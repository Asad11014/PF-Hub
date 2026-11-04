// Invoice Audit — one invoice: header vs lines per category, every order line
// with its full charge breakdown and flags, and the goods-in / returns / other lines.
import { useState, useEffect, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import StatusBar from '../../components/StatusBar'
import StatCard  from '../../components/StatCard'
import { downloadCsv } from '../../lib/reportUtils'
import { gbp, signedGbp, isZero, fmtDate, fmtDateTime, FLAG_META } from './format'

const KIND_LABEL = { goods_in: 'Goods in', returns: 'Returns', other: 'Other', collections: 'Collections' }
const money = v => (v == null || isZero(v) ? <span className="text-ink-dim">–</span> : gbp(v))
const rework = items => items.map(i => `${i.item || 'Rework item'}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')

export default function AuditInvoice() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [status, setStatus] = useState({ msg: 'Loading invoice…', type: 'loading' })
  const [filter, setFilter] = useState('all')   // all | flagged | <flag code>
  const [search, setSearch] = useState('')

  useEffect(() => {
    let alive = true
    fetch(`/api/audit/invoices/${id}`).then(async r => {
      const d = await r.json()
      if (!alive) return
      if (!r.ok) throw new Error(d.error || 'Failed to load invoice')
      setData(d); setStatus({ msg: '', type: null })
    }).catch(e => alive && setStatus({ msg: e.message, type: 'error' }))
    return () => { alive = false }
  }, [id])

  const orders = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.orders.filter(o => {
      if (filter === 'flagged' && !o.flags.length) return false
      if (filter !== 'all' && filter !== 'flagged' && !o.flags.some(f => f.code === filter)) return false
      if (q && ![o.orderNumber, o.reference, o.courier, ...o.reworkItems.map(i => i.item)].some(v => (v || '').toLowerCase().includes(q))) return false
      return true
    })
  }, [data, filter, search])

  if (!data) return <div className="p-4 sm:p-7"><StatusBar message={status.msg} type={status.type} /></div>
  const { invoice: inv, categories, integrity, postage, flagCounts, extras } = data
  const flagged = data.orders.filter(o => o.flags.length).length
  const itemisedDiff = integrity.difference

  function exportCsv() {
    downloadCsv(`invoice-${inv.id}-${(inv.clientName || '').replace(/\W+/g, '-')}-audit.csv`,
      ['Order', 'Reference', 'Despatched', 'Status', 'Courier', 'Items', 'Units', 'Picks', 'Picking', 'Extra picking', 'Postage charged', 'Courier cost', 'Postage margin',
        'VAT-free postage', 'Packaging', 'Rework', 'Rework items', 'Admin', 'Total', 'Flags', 'Notes'],
      data.orders.map(o => [o.orderNumber || o.orderId, o.reference, o.despatchDate ? fmtDate(o.despatchDate) : '', o.status, o.courier, o.items, o.units, o.picks,
        o.picking, o.extraPicking, o.postage, o.postageCourierCost, o.postageMargin, o.vatFreePostage, o.packaging, o.rework, rework(o.reworkItems), o.admin, o.total,
        o.flags.map(f => FLAG_META[f.code]?.label || f.code).join('; '), o.notes.join(' · ')]))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center justify-between sticky top-0 z-40 gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/app/audit" className="font-mono text-[11px] text-ink-muted hover:text-primary no-underline">← Invoices</Link>
          <div className="min-w-0">
            <div className="font-sans font-bold text-[15px] text-ink truncate">{inv.name || `Invoice #${inv.id}`} · {inv.clientName}</div>
            <div className="font-mono text-[11px] text-ink-muted hidden sm:block">#{inv.id} · dated {fmtDate(inv.date)} · last changed in Mintsoft {fmtDateTime(inv.updatedAt)}</div>
          </div>
        </div>
        <button onClick={exportCsv} className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-gold hover:text-gold flex-shrink-0">Export orders CSV</button>
      </header>

      <div className="p-4 sm:p-7 space-y-5">
        {integrity.unavailable.length > 0
          ? <StatusBar message={`Mintsoft no longer holds some lines for this invoice (${categories.filter(c => c.unavailable).map(c => c.label.toLowerCase()).join(', ')}), so those categories can’t be checked.`} type="loading" />
          : inv.beforeHistory && <StatusBar message="This invoice predates the order history held in Mintsoft, so order details (dates, status) are unavailable for its lines." type="loading" />}
        <div className="flex flex-wrap gap-3">
          <StatCard label="Invoice total (net)" value={gbp(inv.total)} />
          <StatCard label="Order lines" value={data.orders.length} />
          <StatCard label="Lines vs invoice" value={isZero(itemisedDiff) ? '✓ match' : signedGbp(itemisedDiff)} accent={isZero(itemisedDiff) ? 'success' : 'danger'} />
          <StatCard label="Postage margin" value={gbp(postage.margin)} accent={postage.margin < 0 ? 'danger' : undefined} />
          <StatCard label="Flagged lines" value={flagged} accent={flagged ? 'warning' : 'success'} />
        </div>
        {postage.linesWithoutCost > 0 && (
          <div className="font-mono text-[11px] text-ink-muted -mt-2">
            Postage margin covers orders where Mintsoft recorded the courier cost. {postage.linesWithoutCost} order{postage.linesWithoutCost === 1 ? '' : 's'} charged {gbp(postage.totalCharged - postage.charged)} postage with no courier cost recorded.
          </div>
        )}

        <section className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
          <div className="px-5 py-3 border-b border-brand-border font-sans font-bold text-sm text-ink">Invoice totals vs its lines</div>
          <table className="w-full text-left min-w-[560px]">
            <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
              <th className="px-5 py-2 font-medium">Category</th><th className="px-5 py-2 font-medium text-right">On invoice</th>
              <th className="px-5 py-2 font-medium text-right">Sum of lines</th><th className="px-5 py-2 font-medium text-right">Difference</th></tr></thead>
            <tbody>{categories.filter(c => !isZero(c.header) || !isZero(c.lines)).map(c => (
              <tr key={c.key} className="border-b border-brand-border/60 last:border-0 font-mono text-xs text-ink">
                <td className="px-5 py-2 font-sans text-sm">{c.label}</td>
                <td className="px-5 py-2 text-right">{gbp(c.header)}</td>
                <td className="px-5 py-2 text-right">
                  {c.unavailable ? <span className="text-ink-muted">order lines not available</span>
                    : c.partlyItemised ? <>{gbp(c.lines)}{!isZero(c.notItemisedRemainder) && <div className="text-[10px] text-ink-muted">+ {gbp(c.notItemisedRemainder)} daily storage, not itemised by Mintsoft</div>}</>
                    : gbp(c.lines)}
                </td>
                <td className={`px-5 py-2 text-right ${c.difference == null ? 'text-ink-muted' : isZero(c.difference) ? 'text-success' : 'text-danger font-bold'}`}>
                  {c.difference == null ? '—' : isZero(c.difference) ? '✓' : signedGbp(c.difference)}
                </td>
              </tr>))}</tbody>
          </table>
        </section>

        <div className="bg-brand-surface border border-brand-border rounded-lg px-4 py-3 flex flex-wrap items-center gap-2">
          {[['all', `All (${data.orders.length})`], ['flagged', `Flagged (${flagged})`], ...Object.entries(flagCounts).map(([k, v]) => [k, `${FLAG_META[k]?.label || k} (${v})`])].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`font-mono text-[11px] rounded border px-2.5 py-1 ${filter === k ? 'bg-primary text-white border-primary' : 'bg-white text-ink-muted border-brand-border hover:text-ink'}`}>{label}</button>
          ))}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search order, reference, courier, rework item…"
            className="flex-1 min-w-[220px] bg-brand-bg border border-brand-border rounded px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-primary" />
        </div>

        <div className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
          <table className="w-full text-left min-w-[1180px]">
            <thead>
              <tr className="border-b border-brand-border font-mono text-[9px] text-ink-dim uppercase tracking-widest">
                <th className="px-3 py-3">Order</th><th className="px-3 py-3">Despatched</th><th className="px-3 py-3 text-right">Items</th>
                <th className="px-3 py-3 text-right">Picking</th><th className="px-3 py-3 text-right">Postage</th><th className="px-3 py-3 text-right">Courier cost</th>
                <th className="px-3 py-3 text-right">Margin</th><th className="px-3 py-3 text-right">Rework</th><th className="px-3 py-3 text-right">Packaging</th>
                <th className="px-3 py-3 text-right">Admin</th><th className="px-3 py-3 text-right">Total</th><th className="px-3 py-3">Flags</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={12} className="px-4 py-8 text-center font-mono text-xs text-ink-muted">Nothing matches.</td></tr>}
              {orders.map(o => (
                <tr key={o.lineId} className="border-b border-brand-border/60 last:border-0 align-top font-mono text-xs text-ink">
                  <td className="px-3 py-2"><div className="font-bold">{o.orderNumber || `#${o.orderId}`}</div><div className="text-[10px] text-ink-muted">{o.status || '—'}{o.courier ? ` · ${o.courier}` : ''}</div></td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(o.despatchDate)}</td>
                  <td className="px-3 py-2 text-right">{o.items ?? '—'}<div className="text-[10px] text-ink-muted">{o.units != null ? `${o.units} units` : ''}</div></td>
                  <td className="px-3 py-2 text-right">{money(o.totalPicking)}{!isZero(o.extraPicking) && <div className="text-[10px] text-ink-muted">incl. extra {gbp(o.extraPicking)}</div>}</td>
                  <td className="px-3 py-2 text-right">{money(o.postage)}</td>
                  <td className="px-3 py-2 text-right text-ink-muted">{money(o.postageCourierCost)}</td>
                  <td className={`px-3 py-2 text-right ${o.postageMargin < 0 ? 'text-danger font-bold' : ''}`}>
                    {o.postageMargin != null ? gbp(o.postageMargin) : o.postage ? <span className="text-[10px] text-ink-muted" title="Mintsoft has no courier cost for this order">cost not recorded</span> : <span className="text-ink-dim">–</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{money(o.rework)}{o.reworkItems.length > 0 && <div className="text-[10px] text-ink-muted max-w-[180px] ml-auto">{rework(o.reworkItems)}</div>}</td>
                  <td className="px-3 py-2 text-right">{money(o.packaging)}</td>
                  <td className="px-3 py-2 text-right">{money(o.admin)}</td>
                  <td className="px-3 py-2 text-right font-bold">{gbp(o.total)}</td>
                  <td className="px-3 py-2 max-w-[240px]">
                    {o.flags.map((f, i) => (
                      <div key={i} title={f.text} className={`inline-block mr-1 mb-1 font-mono text-[10px] border rounded px-1.5 py-0.5 ${FLAG_META[f.code]?.cls || ''}`}>
                        {f.code === 'manual_note' ? `“${f.text.slice(0, 40)}${f.text.length > 40 ? '…' : ''}”` : FLAG_META[f.code]?.label || f.code}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {extras.length > 0 && (
          <section className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto">
            <div className="px-5 py-3 border-b border-brand-border font-sans font-bold text-sm text-ink">Other charges on this invoice</div>
            <table className="w-full text-left min-w-[760px]">
              <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
                <th className="px-5 py-2 font-medium">Type</th><th className="px-5 py-2 font-medium">Item</th><th className="px-5 py-2 font-medium">Reference</th>
                <th className="px-5 py-2 font-medium">Detail</th><th className="px-5 py-2 font-medium text-right">Amount</th><th className="px-5 py-2 font-medium">Comments</th></tr></thead>
              <tbody>{extras.map(e => (
                <tr key={`${e.kind}-${e.id}`} className="border-b border-brand-border/60 last:border-0 font-mono text-xs text-ink align-top">
                  <td className="px-5 py-2">{KIND_LABEL[e.kind]}</td>
                  <td className="px-5 py-2 font-sans text-sm">{e.itemType}{e.chargeType && <span className="ml-1.5 font-mono text-[9px] uppercase text-ink-dim">{e.chargeType}</span>}</td>
                  <td className="px-5 py-2">{e.kind === 'goods_in' ? (e.poReference ? `${e.poReference} (ASN ${e.referenceId})` : `ASN ${e.referenceId}`) : e.referenceId ? `#${e.referenceId}` : '—'}</td>
                  <td className="px-5 py-2 text-[11px] text-ink-muted">{e.detail ? `${e.detail.units} units × ${gbp(e.detail.unitCost)} = ${gbp(e.detail.unitTotal)} + admin ${gbp(e.detail.adminCost)}${e.detail.skus ? ` · ${e.detail.skus} SKUs` : ''}` : e.quantity ?? ''}</td>
                  <td className={`px-5 py-2 text-right ${e.amount < 0 ? 'text-success' : ''}`}>{gbp(e.amount)}</td>
                  <td className="px-5 py-2 font-sans text-xs text-ink-muted max-w-[280px]">{e.comments || '—'}</td>
                </tr>))}</tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  )
}
