// Wix Integration — access (owner only): who else can open the page, and who of them
// can also manage it (switch writes, import, retry, create products, edit mappings).
// Mirrors Invoice Audit's access page; enforced on the server in server/wix.js.
import { useCallback, useEffect, useState } from 'react'
import { useWix } from './WixIntegration'
import { wix } from './wixApi'
import { Btn, Note, Panel } from './WixUI'
import { fmtDateTime } from '../audit/format'

export default function WixAccess() {
  const { isOwner } = useWix()
  const [data, setData] = useState(null)
  const [username, setUsername] = useState('')
  const [asManager, setAsManager] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: null })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setData(await wix('GET', '/access')) } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [])
  useEffect(() => { load() }, [load])

  async function call(method, body, qs = '') {
    setBusy(true)
    try { return await wix(method, `/access${qs}`, body) } finally { setBusy(false) }
  }

  async function grant(e) {
    e.preventDefault()
    const u = username.trim().toLowerCase()
    try {
      const d = await call('POST', { username: u, permission: asManager ? 'wix_integration_manage' : 'wix_integration' })
      setStatus({ msg: d.granted ? `${u} can now ${asManager ? 'view and manage' : 'view'} the Wix Integration` : 'That user already has this access', type: 'success' })
      setUsername(''); setAsManager(false); load()
    } catch (err) { setStatus({ msg: err.message, type: 'error' }) }
  }

  async function setManager(u, on) {
    try {
      if (on) await call('POST', { username: u, permission: 'wix_integration_manage' })
      else await call('DELETE', undefined, `?username=${encodeURIComponent(u)}&permission=wix_integration_manage`)
      setStatus({ msg: on ? `${u} can now manage the integration` : `${u} can now only view`, type: 'success' }); load()
    } catch (err) { setStatus({ msg: err.message, type: 'error' }) }
  }

  async function revoke(u) {
    if (!window.confirm(`Remove Wix Integration access for ${u}?`)) return
    try { await call('DELETE', undefined, `?username=${encodeURIComponent(u)}`); setStatus({ msg: `Access removed for ${u}`, type: 'success' }); load() }
    catch (err) { setStatus({ msg: err.message, type: 'error' }) }
  }

  if (!isOwner) return <Note type="error">Only the owner can manage access to the Wix Integration.</Note>

  return (
    <div className="space-y-5 max-w-3xl">
      {status.msg && <Note type={status.type}>{status.msg}</Note>}
      {data && (
        <>
          <Panel title="Who can use the Wix Integration">
            <div className="space-y-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Owner</div>
                {data.owners.map(o => <div key={o} className="font-mono text-sm text-ink">{o}</div>)}
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-muted mb-1">Also has access</div>
                {data.grants.length === 0 && <div className="font-sans text-sm text-ink-muted">Nobody else yet.</div>}
                {data.grants.map(g => (
                  <div key={g.username} className="flex flex-wrap items-center gap-3 py-1.5 border-b border-brand-border/60 last:border-0">
                    <span className="font-mono text-sm text-ink flex-1 min-w-0 break-all">{g.username}</span>
                    <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-muted" title="Switch Mintsoft writes, import, retry, create products, edit mappings, resolve errors">
                      <input type="checkbox" checked={(data.managers || []).includes(g.username)} disabled={busy} onChange={e => setManager(g.username, e.target.checked)} /> can manage
                    </label>
                    <span className="font-mono text-[10px] text-ink-muted">added {fmtDateTime(g.granted_at)} by {g.granted_by}</span>
                    <Btn small kind="danger" disabled={busy} onClick={() => revoke(g.username)}>Remove</Btn>
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
                  <input type="checkbox" checked={asManager} onChange={e => setAsManager(e.target.checked)} /> can also manage
                </label>
                <Btn kind="primary" type="submit" disabled={busy || !username.trim()}>Give access</Btn>
              </form>
              <p className="font-mono text-[10px] text-ink-muted">Only warehouse users can open the page; a client login is refused even if added here. Viewers can see status, preview imports and read errors. Managers can also switch Mintsoft writes on and off, import, retry, create products, edit mappings and resolve errors. Every action is recorded with who did it.</p>
            </div>
          </Panel>

          <Panel title="History">
            {data.events.length === 0 && <div className="font-sans text-sm text-ink-muted">No changes yet.</div>}
            {data.events.map(e => (
              <div key={e.id} className="font-mono text-[11px] text-ink py-1 border-b border-brand-border/60 last:border-0">
                <span className="text-ink-muted">{fmtDateTime(e.at)}</span> · {e.actor} · {e.action} {e.username}{e.permission === 'wix_integration_manage' ? ' (managing)' : ''}
              </div>
            ))}
          </Panel>
        </>
      )}
    </div>
  )
}
