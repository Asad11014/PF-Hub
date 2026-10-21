// Client Subscriptions (warehouse users): which client has which module, module
// prices, the default modules for new clients, and an audit of every change.
import { useState, useEffect, useCallback, Fragment } from 'react'
import StatusBar from '../../components/StatusBar'
import { fmtPrice } from '../../components/ModuleGate'

const toPounds = p => (p == null ? '' : (p / 100).toFixed(2))
const toPence  = s => (String(s).trim() === '' ? null : Math.round(Number(s) * 100))
const fmtDate  = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '')
const fmtWhen  = d => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const STATUS_LABEL = { active: 'Active', trial: 'Trial', suspended: 'Suspended', cancelled: 'Cancelled' }

async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

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

function ClientDetail({ client, modules, statuses, onSaved, onError }) {
  const initial = Object.fromEntries(modules.map(m => {
    const s = client.subscriptions[m.key]
    return [m.key, {
      status: s?.status || (client.effective.includes(m.key) ? 'active' : 'cancelled'),
      ends_at: s?.ends_at ? s.ends_at.slice(0, 10) : '',
      price: toPounds(s?.price_pence),
      notes: s?.notes || '',
    }]
  }))
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(null)
  const set = (key, field, value) => setForm(f => ({ ...f, [key]: { ...f[key], [field]: value } }))

  async function save(key) {
    setSaving(key)
    try {
      const f = form[key]
      await api('/api/admin/subscriptions', 'PUT', { clientId: client.id, module: key, status: f.status, ends_at: f.ends_at || null, price_pence: toPence(f.price), notes: f.notes })
      onSaved(`${client.name}: ${modules.find(m => m.key === key).name} saved`)
    } catch (e) { onError(e.message) } finally { setSaving(null) }
  }

  return (
    <div className="bg-brand-bg border border-brand-border rounded p-4 space-y-2">
      <div className="grid grid-cols-[140px_130px_140px_110px_1fr_auto] gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted px-1 min-w-[760px]">
        <span>Module</span><span>Status</span><span>Ends</span><span>Price £/month</span><span>Notes</span><span />
      </div>
      {modules.map(m => (
        <div key={m.key} className="grid grid-cols-[140px_130px_140px_110px_1fr_auto] gap-2 items-center min-w-[760px]">
          <span className="font-sans text-xs text-ink font-medium">{m.name}</span>
          <select value={form[m.key].status} onChange={e => set(m.key, 'status', e.target.value)}
            className="font-mono text-xs border border-brand-border rounded px-2 py-1 bg-white">
            {statuses.map(s => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
          </select>
          <input type="date" value={form[m.key].ends_at} onChange={e => set(m.key, 'ends_at', e.target.value)}
            className="font-mono text-xs border border-brand-border rounded px-2 py-1 bg-white" />
          <input inputMode="decimal" placeholder={toPounds(m.monthly_price_pence) || 'module price'} value={form[m.key].price}
            onChange={e => set(m.key, 'price', e.target.value)}
            className="font-mono text-xs border border-brand-border rounded px-2 py-1 bg-white" />
          <input value={form[m.key].notes} maxLength={500} onChange={e => set(m.key, 'notes', e.target.value)}
            className="font-sans text-xs border border-brand-border rounded px-2 py-1 bg-white" />
          <button onClick={() => save(m.key)} disabled={saving === m.key}
            className="font-mono text-[11px] border border-primary text-primary rounded px-3 py-1 hover:bg-primary hover:text-white transition-colors disabled:opacity-40">
            {saving === m.key ? 'Saving…' : 'Save'}
          </button>
        </div>
      ))}
      <div className="font-mono text-[10px] text-ink-muted pt-1">
        Access needs Basic plus the module, with status Active (or Trial before its end date). An empty price uses the module price.
      </div>
    </div>
  )
}

export default function Subscriptions() {
  const [data, setData]       = useState(null)
  const [status, setStatus]   = useState({ msg: '', type: null })
  const [open, setOpen]       = useState(null)
  const [prices, setPrices]   = useState({})
  const [defaults, setDefaults] = useState([])
  const [busy, setBusy]       = useState(null)

  const load = useCallback(async () => {
    try {
      const d = await api('/api/admin/subscriptions')
      setData(d)
      setPrices(Object.fromEntries(d.modules.map(m => [m.key, toPounds(m.monthly_price_pence)])))
      setDefaults(d.defaults)
    } catch (e) { setStatus({ msg: e.message, type: 'error' }) }
  }, [])
  useEffect(() => { load() }, [load])

  const done = msg => { setStatus({ msg, type: 'success' }); load() }
  const fail = msg => setStatus({ msg, type: 'error' })

  async function toggle(client, mod) {
    const on = client.effective.includes(mod.key)
    if (on && mod.key === 'core' && !window.confirm(`Switch off Basic for ${client.name}? Their users will lose access to the whole app.`)) return
    setBusy(`${client.id}:${mod.key}`)
    try {
      const s = client.subscriptions[mod.key]
      await api('/api/admin/subscriptions', 'PUT', { clientId: client.id, module: mod.key, status: on ? 'cancelled' : 'active', ends_at: on ? null : (s?.ends_at || null), price_pence: s?.price_pence ?? null, notes: s?.notes || null })
      done(`${client.name}: ${mod.name} ${on ? 'switched off' : 'switched on'}`)
    } catch (e) { fail(e.message) } finally { setBusy(null) }
  }

  async function savePrice(mod) {
    setBusy(`price:${mod.key}`)
    try { await api(`/api/admin/modules/${mod.key}`, 'PUT', { monthly_price_pence: toPence(prices[mod.key]) }); done(`${mod.name} price saved`) }
    catch (e) { fail(e.message) } finally { setBusy(null) }
  }

  async function saveDefaults() {
    setBusy('defaults')
    try { await api('/api/admin/default-modules', 'PUT', { modules: defaults }); done('Default modules for new clients saved') }
    catch (e) { fail(e.message) } finally { setBusy(null) }
  }

  const clientName = id => data?.clients.find(c => c.id === id)?.name || (id ? `Client #${id}` : '')
  const moduleName = key => data?.modules.find(m => m.key === key)?.name || key || ''

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center justify-between sticky top-0 z-40">
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">Client Subscriptions</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">Which client has which module · changes apply within a minute</div>
        </div>
        <button onClick={load} className="font-mono text-[11px] border border-brand-border rounded px-3 py-1.5 text-ink hover:border-primary hover:text-primary">Refresh</button>
      </header>

      <div className="p-4 sm:p-7 space-y-5 max-w-6xl">
        <StatusBar message={status.msg || (!data ? 'Loading subscriptions…' : '')} type={status.msg ? status.type : 'loading'} />

        {data && (
          <>
            <Section title="Clients" hint="Click a tick to switch a module on or off. Click a client name for status, end date, price and notes.">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
                    <th className="py-2 pr-3 font-medium">Client</th>
                    {data.modules.map(m => <th key={m.key} className="py-2 px-2 font-medium text-center">{m.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map(c => (
                    <Fragment key={c.id}>
                      <tr className="border-b border-brand-border/60">
                        <td className="py-2 pr-3">
                          <button onClick={() => setOpen(open === c.id ? null : c.id)} className="font-sans text-sm text-ink hover:text-primary text-left">
                            {c.name}
                          </button>
                          <span className="font-mono text-[10px] text-ink-muted ml-2">#{c.id}</span>
                          {!c.active && <span className="ml-2 font-mono text-[9px] uppercase tracking-wider text-ink-muted border border-brand-border rounded px-1.5 py-0.5">inactive in Mintsoft</span>}
                          {!c.configured && <span className="ml-2 font-mono text-[9px] uppercase tracking-wider text-gold border border-gold/40 rounded px-1.5 py-0.5">defaults</span>}
                        </td>
                        {data.modules.map(m => {
                          const on = c.effective.includes(m.key)
                          const sub = c.subscriptions[m.key]
                          return (
                            <td key={m.key} className="py-2 px-2 text-center">
                              <button onClick={() => toggle(c, m)} disabled={busy === `${c.id}:${m.key}`}
                                title={sub ? `${STATUS_LABEL[sub.status] || sub.status}${sub.ends_at ? ` until ${fmtDate(sub.ends_at)}` : ''}` : 'Default'}
                                className={`w-8 h-7 rounded border font-mono text-xs transition-colors disabled:opacity-40 ${on ? 'bg-primary text-white border-primary' : 'bg-white text-ink-muted border-brand-border hover:border-primary'}`}>
                                {on ? '✓' : '–'}
                              </button>
                              {sub?.status === 'trial' && <div className="font-mono text-[9px] text-gold mt-0.5">trial</div>}
                            </td>
                          )
                        })}
                      </tr>
                      {open === c.id && (
                        <tr><td colSpan={data.modules.length + 1} className="py-3">
                          <ClientDetail key={JSON.stringify(c.subscriptions)} client={c} modules={data.modules} statuses={data.statuses} onSaved={done} onError={fail} />
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </Section>

            <div className="grid md:grid-cols-2 gap-5">
              <Section title="Module prices" hint="Monthly price per module. Leave empty while pricing is not decided.">
                <div className="space-y-2">
                  {data.modules.map(m => (
                    <div key={m.key} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-sans text-sm text-ink">{m.name}</div>
                        <div className="font-mono text-[10px] text-ink-muted">{fmtPrice(m.monthly_price_pence, m.currency)}</div>
                      </div>
                      <span className="font-mono text-xs text-ink-muted">£</span>
                      <input inputMode="decimal" value={prices[m.key] ?? ''} placeholder="TBC" onChange={e => setPrices(p => ({ ...p, [m.key]: e.target.value }))}
                        className="w-24 font-mono text-xs border border-brand-border rounded px-2 py-1 bg-white" />
                      <button onClick={() => savePrice(m)} disabled={busy === `price:${m.key}`}
                        className="font-mono text-[11px] border border-primary text-primary rounded px-3 py-1 hover:bg-primary hover:text-white transition-colors disabled:opacity-40">Save</button>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="New clients" hint="Modules a client gets automatically when it first appears from Mintsoft.">
                <div className="space-y-2">
                  {data.modules.map(m => (
                    <label key={m.key} className="flex items-center gap-2 font-sans text-sm text-ink">
                      <input type="checkbox" checked={m.key === 'core' || defaults.includes(m.key)} disabled={m.key === 'core'}
                        onChange={e => setDefaults(d => e.target.checked ? [...new Set([...d, m.key])] : d.filter(k => k !== m.key))} />
                      {m.name}{m.key === 'core' && <span className="font-mono text-[10px] text-ink-muted">(always)</span>}
                    </label>
                  ))}
                  <button onClick={saveDefaults} disabled={busy === 'defaults'}
                    className="mt-2 font-mono text-[11px] border border-primary text-primary rounded px-3 py-1 hover:bg-primary hover:text-white transition-colors disabled:opacity-40">Save defaults</button>
                </div>
              </Section>
            </div>

            <Section title="Recent changes" hint="Every change, newest first (last 100).">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="font-mono text-[10px] uppercase tracking-wider text-ink-muted border-b border-brand-border">
                    <th className="py-1.5 pr-3 font-medium">When</th><th className="py-1.5 pr-3 font-medium">By</th>
                    <th className="py-1.5 pr-3 font-medium">Client</th><th className="py-1.5 pr-3 font-medium">Module</th><th className="py-1.5 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map(e => (
                    <tr key={e.id} className="border-b border-brand-border/60 font-mono text-[11px] text-ink">
                      <td className="py-1.5 pr-3 whitespace-nowrap">{fmtWhen(e.at)}</td>
                      <td className="py-1.5 pr-3">{e.actor}</td>
                      <td className="py-1.5 pr-3">{clientName(e.client_id)}</td>
                      <td className="py-1.5 pr-3">{moduleName(e.module_key)}</td>
                      <td className="py-1.5 text-ink-muted">{e.action}{e.before?.status && e.after?.status ? `: ${e.before.status} → ${e.after.status}` : e.after?.status ? `: ${e.after.status}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
