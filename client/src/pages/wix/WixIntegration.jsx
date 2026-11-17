// Wix Integration — the Wix ↔ Mintsoft order/despatch integration (a Cloudflare Worker),
// managed from the Hub. Status strip + tabs; each tab is its own file in this folder.
// Access: 'wix_integration' (view, previews) / 'wix_integration_manage' (anything that
// writes) / owner (add clients, manage access). Enforced again on the server (server/wix.js).
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import clsx from 'clsx'
import { useSession } from '../../context/SessionContext'
import { wix, ago, minutesSince } from './wixApi'
import { Btn, Lamp, StatusText, Note, useConfirm } from './WixUI'
import WixOverview from './WixOverview'
import WixOrders from './WixOrders'
import WixProducts from './WixProducts'
import WixErrors from './WixErrors'
import WixSettings from './WixSettings'
import WixAccess from './WixAccess'

const WixContext = createContext(null)
export const useWix = () => useContext(WixContext)

export default function WixIntegration() {
  const { session, hasPermission } = useSession()
  const [state, setState] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [client, setClient] = useState(null)
  const [message, setMessage] = useState({ msg: '', type: null })
  const [confirm, confirmNode] = useConfirm()

  const reload = useCallback(async () => {
    try {
      const s = await wix('GET', '/state')
      setState(s)
      setClient(c => (c && s.clients.some(x => x.slug === c) ? c : s.clients[0]?.slug ?? null))
      setLoadError(null)
      return s
    } catch (e) { setLoadError(e); return null }
  }, [])

  useEffect(() => {
    reload()
    const t = setInterval(() => { if (!document.hidden) reload() }, 60_000)
    return () => clearInterval(t)
  }, [reload])

  const canManage = hasPermission('wix_integration_manage')
  const isOwner = !!session?.isOwner
  const notify = (msg, type = 'success') => setMessage({ msg, type })
  const ctx = { state, reload, client, setClient, canManage, isOwner, confirm, notify }

  const tabs = [
    { to: '', label: 'Overview', end: true },
    { to: 'orders', label: 'Orders', count: heldCount(state), countKind: 'warning' },
    { to: 'products', label: 'Products' },
    { to: 'errors', label: 'Errors', count: state?.unresolvedErrors, countKind: 'danger' },
    { to: 'settings', label: 'Settings' },
    ...(isOwner ? [{ to: 'access', label: 'Access' }] : []),
  ]

  return (
    <WixContext.Provider value={ctx}>
      <div className="flex-1 min-w-0 overflow-y-auto">
        <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex flex-wrap items-center gap-x-4 gap-y-1 py-2 sticky top-0 z-40">
          <div>
            <div className="font-sans font-bold text-[15px] text-ink">Wix Integration</div>
            <div className="font-mono text-[11px] text-ink-muted hidden sm:block">Wix orders → Mintsoft · despatches → Wix tracking</div>
          </div>
          {state && (
            <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted" aria-label="Write target">
              <span className="border border-brand-border rounded px-2 py-0.5">Client <b className="text-ink">{state.allowedClientIds.join(', ') || 'none'}</b></span>
              <span className="border border-brand-border rounded px-2 py-0.5">Warehouse <b className="text-ink">{state.warehouseId ?? 'not set'}</b></span>
            </div>
          )}
          {!canManage && state && <span className="ml-auto font-mono text-[11px] text-ink-muted">View only</span>}
        </header>

        {loadError ? (
          <div className="p-4 sm:p-7 max-w-3xl space-y-3">
            <Note type="error">{loadError.message}</Note>
            {loadError.data?.code === 'not_configured' && (
              <p className="font-sans text-sm text-ink-muted">The Hub needs <code className="font-mono">WIX_INTEGRATION_URL</code> and <code className="font-mono">WIX_INTEGRATION_TOKEN</code> set in its environment to reach the integration.</p>
            )}
            <Btn onClick={reload}>Try again</Btn>
          </div>
        ) : !state ? (
          <div className="p-7 flex items-center gap-3 font-mono text-xs text-ink-muted">
            <span className="w-5 h-5 border-2 border-brand-border border-t-primary rounded-full animate-spin" /> Loading the integration…
          </div>
        ) : (
          <>
            <StatusStrip />
            <nav className="bg-brand-surface border-b border-brand-border px-3 sm:px-6 flex gap-1 overflow-x-auto" aria-label="Wix Integration sections">
              {tabs.map(t => (
                <NavLink key={t.to} to={t.to} end={t.end}
                  className={({ isActive }) => clsx(
                    'flex items-center gap-2 px-3 py-3 font-sans text-sm whitespace-nowrap border-b-2 no-underline transition-colors',
                    isActive ? 'border-primary text-primary font-bold' : 'border-transparent text-ink-muted hover:text-ink',
                  )}>
                  {t.label}
                  {!!t.count && (
                    <span className={clsx('font-mono text-[10px] font-bold rounded-full px-1.5 py-0.5 tabular-nums',
                      t.countKind === 'danger' ? 'bg-danger text-white' : 'bg-warning/15 text-[#8a6620]')}>{t.count}</span>
                  )}
                </NavLink>
              ))}
            </nav>
            <div className="p-4 sm:p-7 space-y-5 max-w-[1400px]">
              {message.msg && (
                <div className="flex items-start gap-3">
                  <div className="flex-1"><Note type={message.type}>{message.msg}</Note></div>
                  <button onClick={() => setMessage({ msg: '', type: null })} className="font-mono text-[11px] text-ink-muted hover:text-ink pt-2" aria-label="Dismiss">Dismiss</button>
                </div>
              )}
              <Routes>
                <Route index element={<WixOverview />} />
                <Route path="orders" element={<WixOrders />} />
                <Route path="products" element={<WixProducts />} />
                <Route path="errors" element={<WixErrors />} />
                <Route path="settings" element={<WixSettings />} />
                <Route path="access" element={isOwner ? <WixAccess /> : <Navigate to="/app/wix" replace />} />
                <Route path="*" element={<Navigate to="/app/wix" replace />} />
              </Routes>
            </div>
          </>
        )}
      </div>
      {confirmNode}
    </WixContext.Provider>
  )
}

function heldCount(state) {
  return state ? state.clients.reduce((n, c) => n + ((c.orderCounts && c.orderCounts.held) || 0), 0) : 0
}

function runSummary(r) {
  const s = r?.summary
  if (!s || s.skipped) return ''
  const parts = []
  if (s.imported) parts.push(`${s.imported} imported`)
  if (s.held) parts.push(`${s.held} held`)
  if (s.pushed) parts.push(`${s.pushed} fulfilled in Wix`)
  if (s.errors) parts.push(`${s.errors} failed`)
  return parts.length ? ` · ${parts.join(', ')}` : ' · nothing new'
}

function lampFor(run, { idle, label }) {
  if (!run) return ['off', idle]
  if (run.summary && run.summary.ok === false) return ['stop', `Last run failed: ${run.summary.error || 'unknown error'}`]
  if (minutesSince(run.at) > 15) return ['stop', `No run for ${ago(run.at).replace(' ago', '')}. Check the Worker`]
  return ['go', `${label} · ${ago(run.at)}${runSummary(run)}`]
}

function StatusStrip() {
  const { state, canManage, confirm, reload, notify } = useWix()
  const [busy, setBusy] = useState(false)
  const w = state.writes
  const runs = state.lastRuns || {}

  const imp = !w.effective ? ['hold', 'Paused · no orders go to Mintsoft'] : lampFor(runs.importOrders, { idle: 'Live · waiting for the first run', label: 'Running' })
  const desp = lampFor(runs.reconcile, { idle: 'Waiting for the first check', label: 'Checking' })
  const writes = !w.master ? ['off', 'Locked off at deploy (MINTSOFT_WRITES_ENABLED)'] : w.effective ? ['go', 'Live · orders and products are created in Mintsoft'] : ['hold', 'Paused · nothing is written to Mintsoft']
  const held = heldCount(state)
  const n = state.unresolvedErrors
  const attention = held || n
    ? ['stop', [held && `${held} held order${held === 1 ? '' : 's'}`, n && `${n} unresolved error${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ')]
    : ['go', 'Nothing waiting']

  async function toggle(on) {
    if (on) {
      const ok = await confirm({
        title: 'Switch Mintsoft writes on?',
        ok: 'Go live',
        body: (
          <>
            <p>While writes are live, every 5 minutes the integration creates each paid, unfulfilled Wix order in Mintsoft, and the Import and Products buttons can create orders and products.</p>
            <p className="font-mono text-xs">Target: Mintsoft client {state.allowedClientIds.join(', ')} · warehouse {state.warehouseId ?? 'not set'}</p>
            <p className="text-ink-muted">Writes to any other Mintsoft client are refused whatever this switch says.</p>
          </>
        ),
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await wix('PUT', '/settings/writes', { enabled: on })
      notify(on ? 'Mintsoft writes are live.' : 'Mintsoft writes paused.')
      await reload()
    } catch (e) { notify(e.message, 'error') } finally { setBusy(false) }
  }

  const cell = 'flex items-start gap-3 px-4 sm:px-6 py-4 border-brand-border'
  return (
    <div className="bg-brand-surface border-b border-brand-border grid grid-cols-2 lg:grid-cols-4">
      <div className={clsx(cell, 'border-r border-b lg:border-b-0')} role="status"><Lamp state={imp[0]} /><div><div className="font-sans font-bold text-sm text-ink">Order import</div><StatusText state={imp[0]}>{imp[1]}</StatusText></div></div>
      <div className={clsx(cell, 'border-b lg:border-b-0 lg:border-r')} role="status"><Lamp state={desp[0]} /><div><div className="font-sans font-bold text-sm text-ink">Despatch → Wix</div><StatusText state={desp[0]}>{desp[1]}</StatusText></div></div>
      <div className={clsx(cell, 'border-r')} role="status">
        <Lamp state={writes[0]} />
        <div className="space-y-1.5">
          <div className="font-sans font-bold text-sm text-ink">Mintsoft writes</div>
          <StatusText state={writes[0]}>{writes[1]}</StatusText>
          {w.master && (
            <div className="flex flex-wrap items-center gap-2">
              {w.effective
                ? <Btn small kind="pause" busy={busy} disabled={!canManage} title={canManage ? undefined : 'Needs managing access'} onClick={() => toggle(false)}>Pause writes</Btn>
                : <Btn small kind="write" busy={busy} disabled={!canManage} title={canManage ? undefined : 'Needs managing access'} onClick={() => toggle(true)}>Go live…</Btn>}
            </div>
          )}
          {w.updatedBy && <div className="font-mono text-[10px] text-ink-muted">{w.toggle ? 'Switched on' : 'Paused'} by {w.updatedBy.replace(/^hub:/, '')}, {ago(w.updatedAt)}</div>}
        </div>
      </div>
      <div className={cell} role="status"><Lamp state={attention[0]} /><div><div className="font-sans font-bold text-sm text-ink">Needs attention</div><StatusText state={attention[0]}>{attention[1]}</StatusText></div></div>
    </div>
  )
}
