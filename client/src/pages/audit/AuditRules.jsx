// Invoice Audit — your own audit rules (stage I3): "orders that match these
// conditions should be charged …". Checked on every billed order; an order that
// breaks a rule becomes a finding on its invoice.
import { useState, useEffect, useCallback } from 'react'
import { fmtDate } from './format'

const OP_LABEL = {
  Equals: 'equals', NotEqual: 'does not equal', Contains: 'contains', DoesNotContain: 'does not contain', StartsWith: 'starts with',
  DoesNotStartWith: 'does not start with', Empty: 'is empty', IsNotEmpty: 'is not empty', GreaterThan: 'is more than', LessThan: 'is less than',
  EqualsOrGreaterThan: 'is at least', EqualsOrLessThan: 'is at most',
}
const FIELD_LABEL = {
  OrderItemProductSKUS: 'Product SKU (any item)', OrderItemProductNames: 'Product name (any item)', OrderItemProductCategory: 'Product category (any item)',
  TotalItems: 'Total items', OrderVolume: 'Order volume (m³)', TotalWeight: 'Total weight (kg)', OrderValue: 'Order value (£)', NumberOfParcels: 'Parcels',
  LargestProductDimension: 'Largest product dimension (cm)', Channel: 'Sales channel', CourierService: 'Courier service', CompanyName: 'Company name',
  PostCode: 'Postcode', Town: 'Town', County: 'County', OrderNumber: 'Order number', ExternalOrderReference: 'External reference',
  DeliveryNotes: 'Delivery notes', GiftMessages: 'Gift message', FirstName: 'First name', Address1: 'Address 1', Address2: 'Address 2',
  PhoneNumber: 'Phone', MobileNumber: 'Mobile', Email: 'Email',
}
const EXPECT_LABEL = { rework_item: 'charges the rework item', min_charge: 'charges at least', max_charge: 'charges at most', no_charge: 'does not charge' }
const NO_VALUE = new Set(['Empty', 'IsNotEmpty'])
const input = 'bg-white border border-brand-border rounded px-2 py-1 text-xs text-ink'
const blank = clientId => ({ name: '', clientId, conditionType: 'AND', conditions: [{ field: 'OrderItemProductCategory', operator: 'Contains', value: '' }],
  expectation: { type: 'rework_item', item: '' }, effectiveFrom: '', active: true })

function RuleForm({ initial, meta, clientId, onSaved, onCancel }) {
  const [r, setR] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = patch => setR(x => ({ ...x, ...patch }))
  const setCond = (i, patch) => set({ conditions: r.conditions.map((c, k) => (k === i ? { ...c, ...patch } : c)) })
  const x = r.expectation

  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('')
    try {
      const res = await fetch(r.id ? `/api/audit/rules/${r.id}` : '/api/audit/rules', {
        method: r.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...r, effectiveFrom: r.effectiveFrom || null }),
      })
      const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Could not save')
      onSaved(`Rule “${d.rule.name}” saved`)
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save} className="border border-brand-border rounded-lg p-4 space-y-3 bg-brand-bg/60 font-mono text-[11px] text-ink-muted" aria-label="Audit rule">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-0.5 flex-1 min-w-[220px]">Name<input value={r.name} onChange={e => set({ name: e.target.value })} maxLength={80} required className={input} placeholder="e.g. Glass needs a double-wall box" /></label>
        <label className="flex flex-col gap-0.5">Applies to
          <select value={r.clientId == null ? '' : String(r.clientId)} onChange={e => set({ clientId: e.target.value ? Number(e.target.value) : null })} className={input}>
            <option value={String(clientId)}>This client</option><option value="">Every client</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">From invoice date<input type="date" value={r.effectiveFrom || ''} onChange={e => set({ effectiveFrom: e.target.value })} className={input} /></label>
        <label className="flex items-center gap-1.5 self-end pb-1"><input type="checkbox" checked={r.active} onChange={e => set({ active: e.target.checked })} /> active</label>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">When an order matches
          <select value={r.conditionType} onChange={e => set({ conditionType: e.target.value })} className={input}><option value="AND">all</option><option value="OR">any</option></select>
          of these:</div>
        {r.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select value={c.field} onChange={e => setCond(i, { field: e.target.value })} className={input} aria-label="Field">
              {meta.fields.map(f => <option key={f} value={f}>{FIELD_LABEL[f] || f}</option>)}
            </select>
            <select value={c.operator} onChange={e => setCond(i, { operator: e.target.value })} className={input} aria-label="Operator">
              {meta.operators.map(o => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
            </select>
            {!NO_VALUE.has(c.operator) && <input value={c.value} onChange={e => setCond(i, { value: e.target.value })} maxLength={200} className={`${input} min-w-[160px]`} aria-label="Value" />}
            {r.conditions.length > 1 && <button type="button" onClick={() => set({ conditions: r.conditions.filter((_, k) => k !== i) })} className="text-ink-muted hover:text-danger underline">remove</button>}
          </div>
        ))}
        {r.conditions.length < 10 && <button type="button" onClick={() => set({ conditions: [...r.conditions, { field: 'Channel', operator: 'Equals', value: '' }] })} className="text-primary underline">+ condition</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">expect the invoice line
        <select value={x.type} onChange={e => set({ expectation: e.target.value === 'rework_item' ? { type: 'rework_item', item: '' } : { type: e.target.value, category: x.category || 'picking', ...(e.target.value === 'no_charge' ? {} : { amount: x.amount ?? '' }) } })} className={input} aria-label="Expectation">
          {meta.expectations.map(t => <option key={t} value={t}>{EXPECT_LABEL[t] || t}</option>)}
        </select>
        {x.type === 'rework_item'
          ? <input value={x.item} onChange={e => set({ expectation: { ...x, item: e.target.value } })} maxLength={80} placeholder="item name as on the invoice" className={`${input} min-w-[200px]`} aria-label="Rework item" />
          : <>
              <select value={x.category} onChange={e => set({ expectation: { ...x, category: e.target.value } })} className={input} aria-label="Category">
                {meta.categories.map(c => <option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>)}
              </select>
              {x.type !== 'no_charge' && <label className="flex items-center gap-1">£<input value={x.amount} onChange={e => set({ expectation: { ...x, amount: e.target.value } })} inputMode="decimal" className={`${input} w-20`} aria-label="Amount" /></label>}
            </>}
      </div>
      {err && <div className="text-danger">{err}</div>}
      <div className="flex gap-2">
        <button disabled={busy} className="border border-primary bg-primary text-white rounded px-3 py-1 text-[11px] disabled:opacity-50">{busy ? 'Saving…' : 'Save rule'}</button>
        <button type="button" onClick={onCancel} className="border border-brand-border rounded px-3 py-1 text-[11px] bg-white">Cancel</button>
      </div>
    </form>
  )
}

export default function AuditRulesSection({ clientId, canReview, onChanged, onStatus }) {
  const [meta, setMeta] = useState(null)
  const [editing, setEditing] = useState(null)   // null | rule object

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/audit/rules?clientId=${clientId}`)
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load audit rules')
      setMeta(d)
    } catch (e) { onStatus?.({ msg: e.message, type: 'error' }) }
  }, [clientId, onStatus])
  useEffect(() => { load() }, [load])

  async function remove(rule) {
    if (!window.confirm(`Delete the audit rule “${rule.name}”?${rule.clientId == null ? ' It applies to every client.' : ''}`)) return
    const r = await fetch(`/api/audit/rules/${rule.id}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return onStatus?.({ msg: d.error || 'Could not delete', type: 'error' })
    onStatus?.({ msg: `Rule “${rule.name}” deleted`, type: 'success' }); load(); onChanged?.()
  }

  if (!meta) return <div className="font-mono text-[11px] text-ink-muted">Loading audit rules…</div>
  return (
    <div className="space-y-3">
      {meta.rules.length === 0 && !editing && <div className="font-sans text-sm text-ink-muted">No audit rules yet. Add one to check something Mintsoft’s own rules don’t, e.g. “orders with category GLASS must carry DW-BOX”.</div>}
      {meta.rules.map(r => (
        <div key={r.id} className={`flex flex-wrap items-start gap-3 border-b border-brand-border/60 pb-2 ${r.active ? '' : 'opacity-60'}`}>
          <div className="flex-1 min-w-[260px]">
            <div className="font-sans font-semibold text-sm text-ink">{r.name} {r.clientId == null && <span className="font-mono text-[9px] uppercase border border-brand-border rounded px-1 py-0.5 text-ink-muted">every client</span>} {!r.active && <span className="font-mono text-[10px] text-ink-muted">(off)</span>}</div>
            <div className="font-mono text-[11px] text-ink-muted">
              When {r.conditions.map(c => `${FIELD_LABEL[c.field] || c.field} ${OP_LABEL[c.operator] || c.operator}${NO_VALUE.has(c.operator) ? '' : ` “${c.value}”`}`).join(r.conditionType === 'OR' ? ' or ' : ' and ')}: {r.describe}
              {r.effectiveFrom && ` · from ${fmtDate(r.effectiveFrom)}`}
            </div>
            {r.stats && <div className="font-mono text-[10px] text-ink-muted">{r.stats.matched.toLocaleString('en-GB')} orders matched · <span className={r.stats.flagged ? 'text-warning' : 'text-success'}>{r.stats.flagged.toLocaleString('en-GB')} not as expected</span>{r.stats.unknown ? ` · ${r.stats.unknown} could not be read` : ''}</div>}
          </div>
          {canReview && (
            <div className="flex gap-2 font-mono text-[11px]">
              <button onClick={() => setEditing({ ...r, effectiveFrom: r.effectiveFrom || '' })} className="text-primary underline">edit</button>
              <button onClick={() => remove(r)} className="text-ink-muted hover:text-danger underline">delete</button>
            </div>
          )}
        </div>
      ))}
      {editing && <RuleForm key={editing.id || 'new'} initial={editing} meta={meta} clientId={clientId}
        onSaved={m => { setEditing(null); onStatus?.({ msg: m, type: 'success' }); load(); onChanged?.() }} onCancel={() => setEditing(null)} />}
      {canReview && !editing && <button onClick={() => setEditing(blank(Number(clientId)))} className="border border-primary text-primary rounded px-3 py-1 font-mono text-[11px] hover:bg-primary hover:text-white">+ Add audit rule</button>}
    </div>
  )
}
