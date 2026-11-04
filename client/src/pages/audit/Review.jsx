// Invoice Audit review workflow (stage I3): findings marked OK / to credit /
// to charge with a note, invoice sign-off, and the audit trail.
import { useState } from 'react'
import { gbp, signedGbp, isZero, fmtDateTime, FLAG_META, REVIEW_META, INVOICE_STATUS, flagClass, needsReview } from './format'

async function send(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || 'Could not save')
  return d
}

export const Chip = ({ cls, children, title }) => (
  <span title={title} className={`inline-block font-mono text-[10px] border rounded px-1.5 py-0.5 ${cls}`}>{children}</span>
)

export function FlagChip({ f }) {
  const label = f.code === 'manual_note' ? `“${f.text.slice(0, 40)}${f.text.length > 40 ? '…' : ''}”` : FLAG_META[f.code]?.label || f.code
  return (
    <span title={`${f.text}${f.explained ? ` (${f.explained})` : ''}${f.review ? ` · ${REVIEW_META[f.review.status]?.label}` : ''}`}
      className={`inline-flex items-center gap-1 mr-1 mb-1 font-mono text-[10px] border rounded px-1.5 py-0.5 ${f.code === 'manual_note' ? FLAG_META.manual_note.cls : flagClass(f)} ${f.review ? 'opacity-70' : ''}`}>
      {f.review && <span aria-label="reviewed">✓</span>}{label}
      {f.value != null && !isZero(f.value) && f.severity !== 'info' && <span>{signedGbp(f.value)}</span>}
    </span>
  )
}

// One finding: its text, its review, and (for reviewers) the controls to change it.
export function ReviewControl({ f, canReview, locked, onSaved }) {
  const [editing, setEditing] = useState(null)   // null | 'ok' | 'credit' | 'charge'
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const r = f.review

  function start(status) {
    setEditing(status); setErr('')
    setNote(r?.note || '')
    setAmount(r?.amount != null ? String(r.amount) : f.value != null && status !== 'ok' ? Math.abs(f.value).toFixed(2) : '')
  }
  async function save(status) {
    setBusy(true); setErr('')
    try {
      await send('/api/audit/reviews', { subject: f.subject, check: f.check, status, note: status === 'open' ? null : note, amount: status === 'ok' || status === 'open' ? null : amount })
      setEditing(null); onSaved?.()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const btn = 'font-mono text-[10px] border rounded px-2 py-0.5 disabled:opacity-50'
  return (
    <div className="flex flex-col gap-1 py-1.5" data-finding={`${f.subject}|${f.check}`}>
      <div className="flex flex-wrap items-start gap-2">
        <FlagChip f={f} />
        <span className="font-sans text-xs text-ink flex-1 min-w-[200px]">{f.text}{f.explained && <span className="text-ink-muted"> ({f.explained})</span>}</span>
        {r && !editing && (
          <span className="flex items-center gap-1.5">
            <Chip cls={REVIEW_META[r.status]?.cls}>{REVIEW_META[r.status]?.label}{r.amount != null ? ` ${gbp(r.amount)}` : ''}</Chip>
            <span className="font-mono text-[10px] text-ink-muted">{r.by} · {fmtDateTime(r.at)}</span>
          </span>
        )}
      </div>
      {r?.note && !editing && <div className="font-sans text-xs text-ink-muted pl-1">“{r.note}”</div>}
      {canReview && !locked && !editing && (needsReview(f) || r) && (
        <div className="flex flex-wrap gap-1.5">
          {['ok', 'credit', 'charge'].map(s => (
            <button key={s} type="button" disabled={busy} onClick={() => (s === 'ok' && !r ? save('ok') : start(s))}
              className={`${btn} ${r?.status === s ? REVIEW_META[s].cls : 'bg-white text-ink-muted border-brand-border hover:text-ink'}`}>
              {s === 'ok' ? 'Mark OK' : REVIEW_META[s].label}
            </button>
          ))}
          {r && <button type="button" disabled={busy} onClick={() => save('open')} className={`${btn} bg-white text-ink-muted border-brand-border hover:text-danger`}>Reopen</button>}
          {!r && <button type="button" disabled={busy} onClick={() => start('ok')} className={`${btn} bg-white text-ink-muted border-brand-border hover:text-ink`}>OK with note…</button>}
        </div>
      )}
      {editing && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); save(editing) }}>
          <Chip cls={REVIEW_META[editing].cls}>{REVIEW_META[editing].label}</Chip>
          {editing !== 'ok' && (
            <label className="font-mono text-[10px] text-ink-muted flex items-center gap-1">£
              <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" aria-label="Amount"
                className="w-20 bg-brand-bg border border-brand-border rounded px-1.5 py-0.5 text-ink text-xs" />
            </label>
          )}
          <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} aria-label="Note"
            placeholder={editing === 'ok' ? 'Note (optional)' : 'Why? (required)'}
            className="flex-1 min-w-[220px] bg-brand-bg border border-brand-border rounded px-2 py-0.5 font-sans text-xs text-ink" />
          <button type="submit" disabled={busy} className={`${btn} bg-primary text-white border-primary`}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => setEditing(null)} className={`${btn} bg-white text-ink-muted border-brand-border`}>Cancel</button>
        </form>
      )}
      {err && <div className="font-mono text-[10px] text-danger">{err}</div>}
    </div>
  )
}

export function FindingList({ flags, canReview, locked, onSaved, empty = 'No findings.' }) {
  if (!flags.length) return <div className="font-mono text-[11px] text-ink-muted py-1">{empty}</div>
  // Findings that need a review first, notes after.
  const sorted = [...flags].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)))
  return <div className="divide-y divide-brand-border/60">{sorted.map(f => <ReviewControl key={`${f.subject}|${f.check}`} f={f} canReview={canReview} locked={locked} onSaved={onSaved} />)}</div>
}

// Not reviewed → in review → signed off; a signed-off invoice is locked until reopened.
export function InvoiceReviewBar({ invoiceId, review, canReview, onSaved }) {
  const [note, setNote] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const st = INVOICE_STATUS[review.status] || INVOICE_STATUS.not_reviewed
  const rv = review.reviewed || {}

  async function set(status) {
    setBusy(true); setErr('')
    try {
      await send(`/api/audit/invoices/${invoiceId}/review`, { status, note: note || null })
      setAsking(false); setNote(''); onSaved?.()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <section className="bg-brand-surface border border-brand-border rounded-lg px-5 py-3" aria-label="Invoice review">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-sans font-bold text-sm text-ink">Review</span>
        <Chip cls={st.cls}>{st.label}</Chip>
        {review.status !== 'not_reviewed' && review.updated_by && <span className="font-mono text-[10px] text-ink-muted">{review.updated_by} · {fmtDateTime(review.updated_at)}</span>}
        <span className={`font-mono text-[11px] ${review.open ? 'text-warning font-bold' : 'text-success'}`}>{review.open ? `${review.open} finding${review.open === 1 ? '' : 's'} open` : '✓ no open findings'}</span>
        <span className="font-mono text-[11px] text-ink-muted">
          {rv.ok || 0} OK · {rv.credit || 0} to credit{rv.creditAmount ? ` (${gbp(rv.creditAmount)})` : ''} · {rv.charge || 0} to charge{rv.chargeAmount ? ` (${gbp(rv.chargeAmount)})` : ''}
        </span>
        {canReview && (
          <span className="ml-auto flex gap-2">
            {review.status !== 'signed_off'
              ? <button type="button" disabled={busy} onClick={() => (review.open ? setAsking(a => !a) : set('signed_off'))}
                  className="font-mono text-[11px] rounded border px-3 py-1 bg-success text-white border-success disabled:opacity-50">Sign off invoice</button>
              : <button type="button" disabled={busy} onClick={() => set('in_review')}
                  className="font-mono text-[11px] rounded border px-3 py-1 bg-white text-ink-muted border-brand-border hover:text-ink">Reopen</button>}
          </span>
        )}
      </div>
      {review.note && <div className="font-sans text-xs text-ink-muted mt-1">“{review.note}”</div>}
      {review.status === 'signed_off' && <div className="font-mono text-[10px] text-ink-muted mt-1">Signed off: findings are locked. Reopen the invoice to change them.</div>}
      {asking && (
        <form className="flex flex-wrap items-center gap-2 mt-2" onSubmit={e => { e.preventDefault(); set('signed_off') }}>
          <span className="font-mono text-[11px] text-warning">{review.open} finding{review.open === 1 ? ' is' : 's are'} still open. Say why you are signing off anyway:</span>
          <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} aria-label="Sign-off note" placeholder="e.g. remaining notes checked with the client"
            className="flex-1 min-w-[240px] bg-brand-bg border border-brand-border rounded px-2 py-1 font-sans text-xs text-ink" />
          <button type="submit" disabled={busy || !note.trim()} className="font-mono text-[11px] rounded border px-3 py-1 bg-success text-white border-success disabled:opacity-50">Sign off</button>
        </form>
      )}
      {err && <div className="font-mono text-[10px] text-danger mt-1">{err}</div>}
    </section>
  )
}

const ACTION = { review: 'Finding', invoice_status: 'Invoice', sign_off: 'Signed off', reopen: 'Reopened', price: 'Price', rule: 'Audit rule' }
const statusText = s => (s == null ? 'open' : REVIEW_META[s]?.label || INVOICE_STATUS[s]?.label || s)

function describe(e, subjectLabel) {
  if (e.action === 'review') {
    const what = `${FLAG_META[e.check?.split(':')[0]]?.label || e.check} on ${subjectLabel(e.subject)}`
    return `${what}: ${statusText(e.before?.status)} → ${statusText(e.after?.status)}${e.after?.amount != null ? ` ${gbp(e.after.amount)}` : ''}`
  }
  if (e.action === 'sign_off') return `Invoice signed off${e.after?.openFindings ? ` with ${e.after.openFindings} finding${e.after.openFindings === 1 ? '' : 's'} open` : ''}`
  if (e.action === 'reopen' || e.action === 'invoice_status') return `Invoice ${statusText(e.before?.status)} → ${statusText(e.after?.status)}`
  if (e.action === 'price') return `${e.subject?.replace(/^price:(rule|name):/, '')}: ${e.before ? gbp(e.before.price) : 'none'} → ${e.after ? gbp(e.after.price) : 'removed'}`
  if (e.action === 'rule') return `${e.after?.name || e.before?.name || e.subject}${!e.after ? ' (deleted)' : ''}`
  return e.subject || ''
}

export function AuditTrail({ events, subjectLabel = s => s, title = 'Audit trail' }) {
  return (
    <section className="bg-brand-surface border border-brand-border rounded-lg overflow-x-auto" aria-label={title}>
      <div className="px-5 py-3 border-b border-brand-border font-sans font-bold text-sm text-ink">{title}</div>
      {!events.length ? <div className="px-5 py-4 font-mono text-[11px] text-ink-muted">Nothing recorded yet.</div> : (
        <table className="w-full text-left min-w-[640px]">
          <thead><tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
            <th className="px-5 py-2 font-medium">When</th><th className="px-5 py-2 font-medium">Who</th><th className="px-5 py-2 font-medium">What</th>
            <th className="px-5 py-2 font-medium">Change</th><th className="px-5 py-2 font-medium">Note</th></tr></thead>
          <tbody>{events.map(e => (
            <tr key={e.id} className="border-b border-brand-border/60 last:border-0 font-mono text-[11px] text-ink align-top">
              <td className="px-5 py-1.5 whitespace-nowrap">{fmtDateTime(e.at)}</td>
              <td className="px-5 py-1.5">{e.actor}</td>
              <td className="px-5 py-1.5">{ACTION[e.action] || e.action}</td>
              <td className="px-5 py-1.5 font-sans text-xs">{describe(e, subjectLabel)}</td>
              <td className="px-5 py-1.5 font-sans text-xs text-ink-muted">{e.note || ''}</td>
            </tr>))}</tbody>
        </table>
      )}
    </section>
  )
}
