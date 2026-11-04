// Invoice Audit — rates & rules for one client: Mintsoft order rules (and how
// often they apply), rework item prices learned from billing (confirmable),
// and the picking pattern per month against the current rate card.
import { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../../context/SessionContext'
import StatusBar from '../../components/StatusBar'
import StatCard  from '../../components/StatCard'
import { gbp, fmtDate, fmtDateTime, fmtModel } from './format'
import AuditRulesSection from './AuditRules'
import { AuditTrail } from './Review'

// Never round a near-miss up to 100%: 6,356 of 6,375 shows as 99.7%.
const pct = (a, b) => { if (!b) return '—'; const p = (100 * a) / b; return a === b ? '100%' : `${p >= 99.95 ? '99.9' : p.toFixed(p >= 10 ? 1 : 0)}%` }
const monthLabel = m => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })

function Section({ title, hint, children }) {
  return (
    <section className="bg-brand-surface border border-brand-border rounded-lg">
      <div className="px-5 py-3 border-b border-brand-border">
        <div className="font-sans font-bold text-sm text-ink">{title}</div>
        {hint && <div className="font-mono text-[11px] text-ink-muted mt-0.5">{hint}</div>}
      </div>
      <div className="p-5 overflow-x-auto">{children}</div>
    </section>
  )
}

function PriceForm({ item, clientId, onDone, onError }) {
  const last = item.prices[item.prices.length - 1]
  const [price, setPrice] = useState(last ? String(last.price) : '')
  const [from, setFrom] = useState(last ? `${last.month}-01` : new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(e) {
    e.preventDefault(); setBusy(true)
    try {
      const r = await fetch(`/api/audit/clients/${clientId}/prices`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemKey: item.key, price: Number(price), effectiveFrom: from, note }) })
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not save')
      onDone(`${item.name || item.code} confirmed at ${gbp(Number(price))} from ${fmtDate(from)}`)
    } catch (err) { onError(err.message) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2 font-mono text-[10px] text-ink-muted">
      <label className="flex flex-col gap-0.5">Price £<input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" className="w-20 bg-white border border-brand-border rounded px-2 py-1 text-xs text-ink" /></label>
      <label className="flex flex-col gap-0.5">From<input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-white border border-brand-border rounded px-2 py-1 text-xs text-ink" /></label>
      <label className="flex flex-col gap-0.5 flex-1 min-w-[140px]">Note<input value={note} onChange={e => setNote(e.target.value)} maxLength={300} className="bg-white border border-brand-border rounded px-2 py-1 text-xs text-ink font-sans" /></label>
      <button disabled={busy || price === ''} className="border border-primary text-primary rounded px-3 py-1 text-[11px] hover:bg-primary hover:text-white disabled:opacity-40">Confirm price</button>
    </form>
  )
}

export default function AuditClient() {
  const { id } = useParams()
  const { hasPermission } = useSession()
  const canReview = hasPermission('invoice_audit_review')
  const [data, setData] = useState(null)
  const [events, setEvents] = useState([])
  const [status, setStatus] = useState({ msg: 'Working out this client’s rates…', type: 'loading' })
  const loadEvents = useCallback(() => {
    fetch(`/api/audit/events?clientId=${id}&limit=50`).then(r => r.json()).then(d => setEvents((d.events || []).filter(e => e.action === 'price' || e.action === 'rule'))).catch(() => {})
  }, [id])
  useEffect(() => { loadEvents() }, [loadEvents])

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/audit/clients/${id}`)
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load')
      setData(d); setStatus(s => (s.type === 'loading' ? { msg: '', type: null } : s))
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [id])
  useEffect(() => { load() }, [load])

  async function removeConfirmed(item, c) {
    if (!window.confirm(`Remove the confirmed price ${gbp(Number(c.price))} from ${fmtDate(c.effective_from)}?`)) return
    await fetch(`/api/audit/clients/${id}/prices?itemKey=${encodeURIComponent(item.key)}&effectiveFrom=${c.effective_from}`, { method: 'DELETE' })
    setStatus({ msg: 'Confirmed price removed', type: 'success' }); load(); loadEvents()
  }

  if (!data) return <div className="p-4 sm:p-7"><StatusBar message={status.msg} type={status.type} /></div>
  const { client, rules, reworkItems, picking, accuracy, card, cardAt, rulesAt, minConfidence } = data
  const months = Object.entries(picking.months)
  const charging = rules.filter(r => r.charging)

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center gap-3 sticky top-0 z-40">
        <Link to="/app/audit" className="font-mono text-[11px] text-ink-muted hover:text-primary no-underline">← Invoice Audit</Link>
        <div className="min-w-0">
          <div className="font-sans font-bold text-[15px] text-ink truncate">{client.name} · rates &amp; rules</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">
            Learned from this client’s billing · rate card {cardAt ? `captured ${fmtDateTime(cardAt)}` : 'not captured yet'} · rules {rulesAt ? `captured ${fmtDateTime(rulesAt)}` : 'not captured yet'}
          </div>
        </div>
        <Link to={`/app/audit/preview?clientId=${id}`} className="ml-auto font-mono text-[11px] text-ink-muted hover:text-primary no-underline flex-shrink-0">This month so far</Link>
      </header>

      <div className="p-4 sm:p-7 space-y-5 max-w-6xl">
        <StatusBar message={status.msg} type={status.type} />
        <div className="flex flex-wrap gap-3">
          <StatCard label="Rework reproduced" value={accuracy.rework ? pct(accuracy.rework.reproduced, accuracy.rework.total) : 'n/a'}
            accent={accuracy.rework && accuracy.rework.reproduced / Math.max(1, accuracy.rework.total) >= minConfidence ? 'success' : undefined} />
          <StatCard label="Picking reproduced" value={pct(accuracy.picking.matched, accuracy.picking.total)}
            accent={accuracy.picking.matched / Math.max(1, accuracy.picking.total) >= minConfidence ? 'success' : 'warning'} />
          <StatCard label="Orders checked" value={accuracy.picking.total.toLocaleString('en-GB')} />
        </div>
        <div className="font-mono text-[11px] text-ink-muted -mt-2">
          {accuracy.rework
            ? `Rework: today’s Mintsoft rules reproduce ${accuracy.rework.reproduced.toLocaleString('en-GB')} of ${accuracy.rework.total.toLocaleString('en-GB')} orders; ${accuracy.rework.uncertain.toLocaleString('en-GB')} are uncertain (placed before a rule was edited, or missing product data).`
            : 'Rework: this client has no rework rules in Mintsoft, so rework is added by hand; only items charged £0.00 are checked.'}
          {' '}Order-by-order checks run only where the engine reproduces at least {Math.round(minConfidence * 100)}% of a month’s billing.
        </div>

        <Section title="Rework items and prices" hint="Prices learned from billing, month by month. Confirm a price to lock it in from a date; a confirmed price wins over a learned one.">
          {reworkItems.length === 0 && <div className="font-sans text-sm text-ink-muted">No rework billed or expected for this client.</div>}
          <div className="space-y-4">
            {reworkItems.map(item => (
              <div key={item.key} className="border-b border-brand-border/60 last:border-0 pb-4 last:pb-0 space-y-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-sans font-semibold text-sm text-ink">{item.name || item.code || 'Unnamed item'}</span>
                  {item.code && item.name !== item.code && <span className="font-mono text-[10px] text-ink-muted">rule code {item.code}{item.name === '' ? ' · prints without a name on invoices' : ''}</span>}
                  <span className="font-mono text-[9px] uppercase tracking-wider text-ink-muted border border-brand-border rounded px-1.5 py-0.5">{item.source}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {item.prices.length === 0 && <span className="font-mono text-[11px] text-warning">No price learned yet — confirm one below.</span>}
                  {item.prices.map(p => (
                    <span key={p.month} title={`${p.n} of ${p.of} single-item orders at this price`} className="font-mono text-[10px] bg-brand-bg border border-brand-border rounded px-1.5 py-0.5 text-ink">
                      {monthLabel(p.month)} {gbp(p.price)}{p.n < p.of ? <span className="text-ink-muted"> ({p.n}/{p.of})</span> : ''}
                    </span>
                  ))}
                </div>
                {item.confirmed.map(c => (
                  <div key={c.effective_from} className="flex items-center gap-2 font-mono text-[11px] text-success">
                    ✓ {gbp(Number(c.price))} from {fmtDate(c.effective_from)} · {c.confirmed_by}{c.note ? ` · ${c.note}` : ''}
                    {canReview && <button onClick={() => removeConfirmed(item, c)} className="text-ink-muted hover:text-danger text-[10px] underline">remove</button>}
                  </div>
                ))}
                {canReview && <PriceForm item={item} clientId={id} onDone={m => { setStatus({ msg: m, type: 'success' }); load(); loadEvents() }} onError={m => setStatus({ msg: m, type: 'error' })} />}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Picking by month" hint={`Rate card method: ${picking.method || 'unknown'} · today’s card: ${fmtModel(card.PickingCalculationType === 'PerOrderPerSkuPerUnit'
          ? { kind: 'perSkuPerUnit', S: card.StandardPickingCost, K: card.PickingSKUCost, U: card.AdditionalPickingCostPerItem }
          : { kind: 'byCount', by: card.PickingCalculationType === 'PerItem' ? 'units' : 'lines', S: card.StandardPickingCost, A: card.AdditionalPickingCostPerItem, N: card.NumberOfItemsIncludedInStandardPick })}${picking.excludedSkus.length ? ` · never charged: ${picking.excludedSkus.join(', ')}` : ''}`}>
          <table className="w-full text-left min-w-[760px]">
            <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
              <th className="py-1.5 pr-3 font-medium">Invoice month</th><th className="py-1.5 pr-3 font-medium text-right">Orders</th>
              <th className="py-1.5 pr-3 font-medium text-right">Reproduced</th><th className="py-1.5 pr-3 font-medium">Pattern billed</th>
              <th className="py-1.5 pr-3 font-medium text-right">At today’s card</th><th className="py-1.5 pr-3 font-medium">Other channels</th>
              <th className="py-1.5 font-medium text-right">Admin / order</th></tr></thead>
            <tbody>{months.slice().reverse().map(([m, v]) => (
              <tr key={m} className="border-b border-brand-border/60 last:border-0 font-mono text-[11px] text-ink align-top">
                <td className="py-1.5 pr-3">{monthLabel(m)}</td>
                <td className="py-1.5 pr-3 text-right">{v.orders}</td>
                <td className={`py-1.5 pr-3 text-right ${(v.confidence || 0) >= minConfidence ? 'text-success' : 'text-warning'}`}>{pct(v.matched, v.orders)}</td>
                <td className="py-1.5 pr-3">{fmtModel(v.model)}</td>
                <td className="py-1.5 pr-3 text-right text-ink-muted">{pct(v.cardMatched, v.orders)}</td>
                <td className="py-1.5 pr-3 text-[10px] text-ink-muted">{Object.entries(v.channels || {}).filter(([, cm]) => cm && fmtModel(cm) !== fmtModel(v.model)).map(([ch, cm]) => `${ch}: ${fmtModel(cm)}`).join(' · ') || '—'}</td>
                <td className="py-1.5 text-right">{v.admin ? gbp(v.admin.value) : '—'}</td>
              </tr>))}</tbody>
          </table>
        </Section>

        <Section title="Your audit rules" hint="Checks of your own, on top of Mintsoft’s rules. An order that breaks one becomes a finding on its invoice.">
          <AuditRulesSection clientId={id} canReview={canReview} onStatus={setStatus} onChanged={() => { load(); loadEvents() }} />
        </Section>

        <Section title={`Mintsoft order rules (${rules.length})`} hint={`${charging.length} add a rework charge; the others change couriers, holds or inserts and are shown for reference.`}>
          <table className="w-full text-left min-w-[760px]">
            <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
              <th className="py-1.5 pr-3 font-medium">Action</th><th className="py-1.5 pr-3 font-medium">Adds / sets</th><th className="py-1.5 pr-3 font-medium">When</th>
              <th className="py-1.5 pr-3 font-medium">Last edited</th><th className="py-1.5 font-medium text-right">Applied to</th></tr></thead>
            <tbody>{rules.map(r => (
              <tr key={r.id} className={`border-b border-brand-border/60 last:border-0 font-mono text-[11px] align-top ${r.charging ? 'text-ink' : 'text-ink-muted'} ${r.active ? '' : 'line-through opacity-60'}`}>
                <td className="py-1.5 pr-3 whitespace-nowrap">{r.action}{!r.active && ' (off)'}</td>
                <td className="py-1.5 pr-3">{r.param || '—'}</td>
                <td className="py-1.5 pr-3 font-sans text-xs max-w-[420px]">
                  {r.conditions.length === 0 ? 'every order' : r.conditions.slice(0, 4).map(c => `${c.field} ${c.operator} ${c.value ?? ''}`).join(r.conditionType === 'OR' ? ' or ' : ' and ')}
                  {r.conditions.length > 4 && ` … (+${r.conditions.length - 4} more)`}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(r.lastUpdated)}</td>
                <td className="py-1.5 text-right">{r.fired == null ? '—' : `${r.fired.toLocaleString('en-GB')} orders`}</td>
              </tr>))}</tbody>
          </table>
        </Section>

        <AuditTrail events={events} title="Price and rule changes" subjectLabel={s => s} />
      </div>
    </div>
  )
}
