import { useState, useCallback, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useSession } from '../context/SessionContext'
import { useUI }      from '../context/UIContext'
import { CLIENT_NAV, WAREHOUSE_NAV } from '../lib/nav'
import clsx from 'clsx'

function SyncButton({ incrementalOnly = false }) {
  const [phase,       setPhase]    = useState('idle')  // idle | syncing | done | partial | error
  const [stepLabel,   setStep]     = useState('')
  const [records,     setRecords]  = useState(null)
  const [elapsed,     setElapsed]  = useState(0)
  const [lastSyncAt,  setLastSync] = useState(undefined) // undefined = loading, null = never, string = date
  const pollRef  = useRef(null)
  const timerRef = useRef(null)
  const startRef = useRef(null)

  // Check sync history on mount so we know whether to run full or incremental
  useEffect(() => {
    fetch('/api/sync/status')
      .then(r => r.json())
      .then(d => setLastSync(d.lastSyncAt ?? null))
      .catch(() => setLastSync(null))
  }, [])

  const stopPolling = useCallback(() => {
    clearInterval(pollRef.current)
    clearInterval(timerRef.current)
    pollRef.current  = null
    timerRef.current = null
  }, [])

  const pollStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/sync/status')
      const data = await res.json()
      const job  = data.lastJob
      if (!job) return
      if (job.status === 'running') {
        setStep(job.current_step || 'Preparing…')
      } else if (job.status === 'success') {
        stopPolling()
        setLastSync(data.lastSyncAt)
        setRecords(job.records_synced)
        setPhase('done')
        setTimeout(() => { setPhase('idle'); setRecords(null); setElapsed(0) }, 8000)
      } else if (job.status === 'partial') {
        stopPolling()
        setLastSync(data.lastSyncAt)
        setRecords(job.records_synced)
        setPhase('partial')
        setTimeout(() => { setPhase('idle'); setRecords(null); setElapsed(0) }, 8000)
      } else if (job.status === 'error') {
        stopPolling()
        setStep(job.error || 'Unknown error')
        setPhase('error')
        setTimeout(() => { setPhase('idle'); setStep(''); setElapsed(0) }, 8000)
      }
    } catch { /* network blip — keep polling */ }
  }, [stopPolling])

  const firSync = useCallback(async (full) => {
    if (phase === 'syncing') return
    setPhase('syncing')
    setStep(full ? 'Starting full sync…' : 'Starting…')
    setRecords(null)
    setElapsed(0)
    startRef.current = Date.now()

    try {
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full }),
      })
    } catch {
      setPhase('error')
      setStep('Could not reach server')
      setTimeout(() => { setPhase('idle'); setStep('') }, 4000)
      return
    }

    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    pollRef.current = setInterval(pollStatus, 3000)
    pollStatus()
  }, [phase, pollStatus])

  useEffect(() => () => stopPolling(), [stopPolling])

  const fmtElapsed = s => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`

  const everSynced = !!lastSyncAt  // false on first use → full sync
  const isLoading  = lastSyncAt === undefined

  if (phase === 'syncing') {
    return (
      <div className="w-full border border-gold rounded font-mono text-[11px] py-1.5 px-2 text-gold bg-gold/10 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 border border-gold border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <span className="truncate">{stepLabel}</span>
          <span className="ml-auto text-gold/70 flex-shrink-0">{fmtElapsed(elapsed)}</span>
        </div>
        <div className="w-full bg-gold/20 rounded-full h-0.5 overflow-hidden">
          <div className="h-full bg-gold rounded-full animate-pulse" style={{ width: '60%' }} />
        </div>
      </div>
    )
  }

  const label = phase === 'done'    ? `✓ Synced · ${records ?? 0} records`
              : phase === 'partial' ? `⚠ Synced · ${records ?? 0} records`
              : phase === 'error'   ? '✕ Sync failed'
              : everSynced          ? '⟳ Sync Data'
              : isLoading           ? '⟳ Sync Data'
              : incrementalOnly     ? '⟳ Sync Data'
              : '⟳ Initial Sync'
  const cls   = phase === 'done'    ? 'border-success text-success'
              : phase === 'partial' ? 'border-gold text-gold'
              : phase === 'error'   ? 'border-danger text-danger'
              : 'border-white/20 text-white/80 hover:border-gold hover:text-gold'

  return (
    <div className="space-y-1">
      <button
        onClick={() => firSync(incrementalOnly ? false : !everSynced)}
        disabled={isLoading}
        className={`w-full border rounded font-mono text-[11px] py-1.5 transition-colors bg-transparent cursor-pointer disabled:opacity-40 ${cls}`}
      >
        {label}
      </button>
      {/* Full resync option — warehouse only, after initial sync has been done */}
      {!incrementalOnly && everSynced && phase === 'idle' && (
        <button
          onClick={() => firSync(true)}
          className="w-full font-mono text-[10px] text-white/40 hover:text-white/70 transition-colors text-center py-0.5"
        >
          ↺ Full resync
        </button>
      )}
    </div>
  )
}

// Recursively flatten a group's leaf routes (for active-state detection).
function flattenRoutes(node) {
  if (node.items) return node.items.flatMap(flattenRoutes)
  return node.to ? [node.to] : []
}

// A single client-nav node — either a leaf link or a (possibly nested) group.
function NavNode({ node, closeSidebar, depth }) {
  if (node.items) return <CollapsibleGroup group={node} closeSidebar={closeSidebar} depth={depth} />
  return (
    <NavLink
      to={node.to}
      onClick={closeSidebar}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      className={({ isActive }) => clsx(
        'flex items-center gap-2 pr-3 py-1.5 text-[12px] transition-all no-underline mx-2 rounded border-l-2',
        isActive
          ? 'bg-white/10 text-white font-semibold border-gold'
          : 'text-white/70 hover:bg-white/5 hover:text-white border-transparent'
      )}
    >
      <span className="text-sm flex-shrink-0">{node.icon}</span>
      <span className="flex-1 truncate">{node.clientLabel || node.label}</span>
    </NavLink>
  )
}

// A collapsible nav group. Open state can be controlled by the parent (for
// accordion behaviour) or self-managed (for nested groups).
function CollapsibleGroup({ group, closeSidebar, depth = 0, open: openProp, onToggle }) {
  const location = useLocation()
  const [openLocal, setOpenLocal] = useState(() => flattenRoutes(group).some(to => location.pathname.startsWith(to)))
  const controlled = openProp !== undefined
  const open   = controlled ? openProp : openLocal
  const toggle = controlled ? onToggle : () => setOpenLocal(o => !o)

  return (
    <div>
      <button
        onClick={toggle}
        style={{ paddingLeft: `${16 + depth * 12}px` }}
        className="w-full flex items-center gap-2.5 pr-3 py-2 text-left transition-colors hover:bg-white/5 group select-none"
      >
        <span className="text-base w-5 text-center flex-shrink-0">{group.icon}</span>
        <span className={clsx(
          'flex-1 font-mono uppercase tracking-widest font-bold',
          depth === 0 ? 'text-[10px]' : 'text-[9px]',
          open ? 'text-gold' : 'text-white/50 group-hover:text-white'
        )}>
          {group.label}
        </span>
        <span className={clsx('font-mono text-[10px] text-white/40 transition-transform duration-200', open && 'rotate-90')}>
          ▶
        </span>
      </button>

      <div className={clsx(
        'overflow-hidden transition-all duration-200',
        open ? 'max-h-[900px] opacity-100' : 'max-h-0 opacity-0'
      )}>
        {group.items.map((node, i) => (
          <NavNode key={node.to || node.id || i} node={node} closeSidebar={closeSidebar} depth={depth + 1} />
        ))}
      </div>
    </div>
  )
}

// Flat links + collapsible groups with accordion behaviour (one group open at a
// time). Used for both the Client Hub and Warehouse Hub menus.
function AccordionNav({ nav, closeSidebar }) {
  const location = useLocation()
  const [openId, setOpenId] = useState(() => {
    const g = nav.find(e => e.type === 'group' && e.items.some(i => location.pathname.startsWith(i.to)))
    return g?.id || null
  })

  return (
    <div className="space-y-0.5">
      {nav.map(entry => entry.type === 'link' ? (
        <div key={entry.to} className="px-2">
          <NavLink
            to={entry.to}
            end={entry.exact}
            onClick={closeSidebar}
            className={({ isActive }) => clsx(
              'flex items-center gap-2.5 px-3 py-2 rounded text-[13px] font-medium transition-all no-underline border-l-2',
              isActive
                ? 'bg-white/10 text-white font-semibold border-gold'
                : 'text-white/70 hover:bg-white/5 hover:text-white border-transparent'
            )}
          >
            <span className="text-base w-5 text-center flex-shrink-0">{entry.icon}</span>
            {entry.label}
          </NavLink>
        </div>
      ) : (
        <CollapsibleGroup key={entry.id} group={entry} closeSidebar={closeSidebar}
          open={openId === entry.id}
          onToggle={() => setOpenId(id => id === entry.id ? null : entry.id)} />
      ))}
    </div>
  )
}

export default function Sidebar() {
  const { session, warehouseId, setWarehouseId, selectedClientId, setSelectedClientId } = useSession()
  const { sidebarOpen, closeSidebar } = useUI()
  const navigate   = useNavigate()
  const warehouses = session?.warehouses || []
  const clients    = session?.clients    || []

  async function logout() {
    await fetch('/api/logout', { method: 'POST' })
    navigate('/')
  }

  return (
    <aside className={clsx(
      'w-60 bg-navy border-r border-navy-dark flex flex-col fixed top-16 left-0 bottom-0 z-40',
      'transition-transform duration-200 ease-in-out',
      'lg:translate-x-0',
      sidebarOpen ? 'translate-x-0' : '-translate-x-full'
    )}>

      {/* Scrollable middle */}
      <div className="flex-1 overflow-y-auto min-h-0 py-2">

        {/* Warehouse selector */}
        {warehouses.length > 1 && (
          <div className="px-4 pt-1 pb-2">
            <label className="block font-mono text-[9px] text-white/50 uppercase tracking-widest mb-1">Warehouse</label>
            <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
              className="w-full bg-navy-dark border border-white/15 rounded text-white font-mono text-xs px-2 py-1.5 focus:outline-none focus:border-gold">
              <option value="">— Select —</option>
              {warehouses.map(w => <option key={w.ID} value={String(w.ID)}>{w.Name}</option>)}
            </select>
          </div>
        )}

        {/* Client selector */}
        {session?.isWarehouse && clients.length > 0 && (
          <div className="px-4 pb-2">
            <label className="block font-mono text-[9px] text-white/50 uppercase tracking-widest mb-1">Client</label>
            <select value={selectedClientId} onChange={e => setSelectedClientId(e.target.value)}
              className="w-full bg-navy-dark border border-white/15 rounded text-white font-mono text-xs px-2 py-1.5 focus:outline-none focus:border-gold">
              <option value="">All clients</option>
              {[...clients].sort((a,b) => (a.Name||a.name).localeCompare(b.Name||b.name)).map(c => (
                <option key={c.ID||c.id} value={String(c.ID||c.id)}>{c.Name||c.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* ── Navigation (Client Hub or Warehouse Hub) ── */}
        {!session?.isWarehouse
          ? <AccordionNav nav={CLIENT_NAV} closeSidebar={closeSidebar} />
          : <AccordionNav nav={WAREHOUSE_NAV} closeSidebar={closeSidebar} />}
      </div>

      {/* Footer — always pinned */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-white/10 space-y-2">
        <div className="font-mono text-[11px] text-white/60">
          <strong className="block text-white text-xs mb-0.5 truncate">{session?.username}</strong>
          {session?.demo ? 'Demo mode' : session?.isWarehouse ? 'Warehouse user' : 'Client user'}
        </div>
        {!session?.demo && session?.isWarehouse && <SyncButton />}
        <button onClick={logout}
          className="w-full border border-white/20 rounded text-white/70 font-mono text-[11px] py-1.5 hover:border-danger hover:text-danger transition-colors bg-transparent cursor-pointer">
          Sign Out
        </button>
      </div>
    </aside>
  )
}
