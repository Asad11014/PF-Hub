// Invoice Audit — access (owner only): who else can open the module, and who
// of them can also review findings, sign off invoices and edit rules and prices.
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../../context/SessionContext'
import StatusBar from '../../components/StatusBar'
import { fmtDateTime } from './format'

export default function AuditAccess() {
  const { session } = useSession()
  const [data, setData] = useState(null)
  const [username, setUsername] = useState('')
  const [asReviewer, setAsReviewer] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: null })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch('/api/audit/access')
    const d = await r.json()
    if (!r.ok) { setStatus({ msg: d.error || 'Failed to load access', type: 'error' }); return }
    setData(d)
  }, [])
  useEffect(() => { load() }, [load])

  async function call(method, body, qs = '') {
    setBusy(true)
    try {
      const r = await fetch(`/api/audit/access${qs}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Request failed')
      return d
    } finally { setBusy(false) }
  }

  async function grant(e) {
    e.preventDefault()
    try {
      const d = await call('POST', { username, permission: asReviewer ? 'invoice_audit_review' : 'invoice_audit' })
      setStatus({ msg: d.granted ? `${username.trim().toLowerCase()} can now ${asReviewer ? 'view and review' : 'view'} Invoice Audit` : 'That user already has this access', type: 'success' })
      setUsername(''); setAsReviewer(false); load()
    } catch (err) { setStatus({ msg: err.message, type: 'error' }) }
  }

  async function setReviewer(u, on) {
    try {
      if (on) await call('POST', { username: u, permission: 'invoice_audit_review' })
      else await call('DELETE', null, `?username=${encodeURIComponent(u)}&permission=invoice_audit_review`)
      setStatus({ msg: on ? `${u} can now review findings and sign off invoices` : `${u} can now only view`, type: 'success' }); load()
    } catch (err) { setStatus({ msg: err.message, type: 'error' }) }
  }

  async function revoke(u) {
    if (!window.confirm(`Remove Invoice Audit access for ${u}?`)) return
    try { await call('DELETE', null, `?username=${encodeURIComponent(u)}`); setStatus({ msg: `Access removed for ${u}`, type: 'success' }); load() }
    catch (err) { setStatus({ msg: err.message, type: 'error' }) }
  }

  if (!session?.isOwner) {
    return <div className="p-4 sm:p-7"><StatusBar message="Only the owner can manage access to Invoice Audit." type="error" /></div>
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center gap-3 sticky top-0 z-40">
        <Link to="/app/audit" className="font-mono text-[11px] text-ink-muted hover:text-primary no-underline">← Invoice Audit</Link>
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">Who can see Invoice Audit</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">Warehouse users only · changes apply within a minute</div>
        </div>
      </header>

      <div className="p-4 sm:p-7 space-y-5 max-w-3xl">
        <StatusBar message={status.msg} type={status.type} />
        {data && (
          <>
            <section className="bg-brand-surface border border-brand-border rounded-lg p-5 space-y-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Owner</div>
                {data.owners.map(o => <div key={o} className="font-mono text-sm text-ink">{o}</div>)}
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Also has access</div>
                {data.grants.length === 0 && <div className="font-sans text-sm text-ink-muted">Nobody else yet.</div>}
                {data.grants.map(g => (
                  <div key={g.username} className="flex items-center gap-3 py-1.5 border-b border-brand-border/60 last:border-0">
                    <span className="font-mono text-sm text-ink flex-1">{g.username}</span>
                    <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-muted" title="Review findings, sign off invoices, confirm prices and edit audit rules">
                      <input type="checkbox" checked={(data.reviewers || []).includes(g.username)} disabled={busy} onChange={e => setReviewer(g.username, e.target.checked)} /> can review
                    </label>
                    <span className="font-mono text-[10px] text-ink-muted">added {fmtDateTime(g.granted_at)} by {g.granted_by}</span>
                    <button onClick={() => revoke(g.username)} disabled={busy} className="font-mono text-[11px] border border-danger/40 text-danger rounded px-2.5 py-1 hover:bg-danger hover:text-white disabled:opacity-40">Remove</button>
                  </div>
                ))}
              </div>
              <form onSubmit={grant} className="flex flex-wrap items-end gap-2 pt-1">
                <label className="flex flex-col gap-1 flex-1 min-w-[240px] font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                  Give access to (Mintsoft username)
                  <input value={username} onChange={e => setUsername(e.target.value)} placeholder="name@premiumfulfilment.co.uk"
                    className="normal-case tracking-normal bg-brand-bg border border-brand-border rounded px-3 py-2 font-mono text-sm text-ink focus:outline-none focus:border-primary" />
                </label>
                <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-muted pb-2.5">
                  <input type="checkbox" checked={asReviewer} onChange={e => setAsReviewer(e.target.checked)} /> can also review
                </label>
                <button type="submit" disabled={busy || !username.trim()} className="bg-primary hover:bg-primary-hover text-white font-sans font-bold text-sm rounded px-4 py-2 disabled:opacity-40">Give access</button>
              </form>
              <p className="font-mono text-[10px] text-ink-muted">Only warehouse users can open the module; a client login is refused even if added here. Viewers see everything; reviewers can also mark findings, sign off invoices, confirm prices and edit audit rules. Every change they make is recorded in the audit trail.</p>
            </section>

            <section className="bg-brand-surface border border-brand-border rounded-lg p-5">
              <div className="font-sans font-bold text-sm text-ink mb-2">History</div>
              {data.events.map(e => (
                <div key={e.id} className="font-mono text-[11px] text-ink py-1 border-b border-brand-border/60 last:border-0">
                  <span className="text-ink-muted">{fmtDateTime(e.at)}</span> · {e.actor} · {e.action} {e.username}{e.permission === 'invoice_audit_review' ? ' (reviewing)' : ''}
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
