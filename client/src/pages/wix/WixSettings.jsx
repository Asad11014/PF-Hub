// Wix Integration — Settings: courier map, carrier names, add a client (owner), audit log.
import { useEffect, useState } from 'react'
import { useWix } from './WixIntegration'
import { wix, clientPath } from './wixApi'
import { Btn, Note, Panel, Skeleton, Table, Td, When } from './WixUI'
import ClientPicker from './ClientPicker'

const input = 'w-full bg-brand-bg border border-brand-border rounded px-3 py-2 font-sans text-sm text-ink focus:outline-none focus:border-primary disabled:opacity-60'
const label = 'flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted'

/** Editable rows → onSave(rows). Upsert only: removing a row here doesn't delete it. */
function RowsEditor({ fields, initial, onSave, addLabel, disabled }) {
  const [rows, setRows] = useState(initial.length ? initial : [{}])
  const [invalid, setInvalid] = useState({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { setRows(initial.length ? initial : [{}]) }, [initial])

  const set = (i, k, v) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  async function save() {
    const bad = {}
    const out = rows.filter(r => fields.some(f => String(r[f.key] ?? '').trim()))
    out.forEach(r => fields.forEach(f => { if (f.required && !String(r[f.key] ?? '').trim()) bad[`${rows.indexOf(r)}-${f.key}`] = true }))
    setInvalid(bad)
    if (Object.keys(bad).length || !out.length) return
    setBusy(true)
    try { await onSave(out) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-left text-sm">
          <thead><tr>{fields.map(f => <th key={f.key} className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted font-medium">{f.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {fields.map(f => (
                  <td key={f.key} className="py-1 pr-3">
                    <input aria-label={f.label} type={f.type || 'text'} inputMode={f.type === 'number' ? 'numeric' : undefined} disabled={disabled}
                      value={r[f.key] ?? ''} onChange={e => set(i, f.key, e.target.value)} aria-invalid={invalid[`${i}-${f.key}`] || undefined}
                      className={`${input} ${invalid[`${i}-${f.key}`] ? 'border-danger' : ''}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <Btn onClick={() => setRows(rs => [...rs, {}])}>{addLabel}</Btn>
          <Btn kind="primary" busy={busy} onClick={save}>Save</Btn>
        </div>
      )}
    </div>
  )
}

export default function WixSettings() {
  const { client, canManage, isOwner, notify } = useWix()
  const [courier, setCourier] = useState(null)
  const [carriers, setCarriers] = useState(null)
  const [audit, setAudit] = useState(null)

  useEffect(() => {
    if (!client) return
    setCourier(null)
    wix('GET', clientPath(client, '/courier-map')).then(setCourier).catch(e => notify(e.message, 'error'))
  }, [client]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    wix('GET', '/carriers').then(r => setCarriers(r.carriers)).catch(e => notify(e.message, 'error'))
    wix('GET', '/audit?limit=100').then(r => setAudit(r.entries)).catch(() => setAudit([]))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const courierRows = courier ? courier.mappings.map(m => ({ t: m.wixShippingTitle, id: m.mintsoftCourierServiceId, n: m.carrierDisplayName ?? '' })) : []
  const carrierRows = carriers ? carriers.map(c => ({ id: c.mintsoftCourierServiceId, n: c.displayName })) : []

  return (
    <>
      {client && (
        <Panel title="Courier map" actions={<ClientPicker />}>
          <p className="font-sans text-sm text-ink-muted mb-3 max-w-prose">Which Mintsoft courier service each Wix shipping option uses. Names are matched ignoring case and spaces; anything unmapped uses the client's default courier.</p>
          {!courier ? <Skeleton /> : (
            <>
              <p className="font-mono text-[11px] text-ink mb-3">Default courier service: {courier.defaultCourierServiceId ?? 'none (unmapped orders are held)'}</p>
              <RowsEditor
                disabled={!canManage}
                initial={courierRows}
                addLabel="Add shipping option"
                fields={[{ key: 't', label: 'Wix shipping option', required: true }, { key: 'id', label: 'Mintsoft courier service ID', type: 'number', required: true }, { key: 'n', label: 'Carrier name for customers' }]}
                onSave={async rows => {
                  try {
                    const r = await wix('PUT', clientPath(client, '/courier-map'), { mappings: rows.map(x => ({ wix_shipping_title: String(x.t).trim(), mintsoft_courier_service_id: Number(x.id), carrier_display_name: String(x.n ?? '').trim() || null })) })
                    setCourier(c => ({ ...c, mappings: r.mappings })); notify('Courier map saved.')
                  } catch (e) { notify(e.message, 'error') }
                }}
              />
            </>
          )}
        </Panel>
      )}

      <Panel title="Carrier names">
        <p className="font-sans text-sm text-ink-muted mb-3 max-w-prose">The carrier name customers see in Wix, by the Mintsoft courier service an order was actually despatched with.</p>
        {!carriers ? <Skeleton /> : (
          <RowsEditor
            disabled={!canManage}
            initial={carrierRows}
            addLabel="Add courier service"
            fields={[{ key: 'id', label: 'Mintsoft courier service ID', type: 'number', required: true }, { key: 'n', label: 'Name shown in Wix', required: true }]}
            onSave={async rows => {
              try {
                const r = await wix('PUT', '/carriers', { carriers: rows.map(x => ({ mintsoft_courier_service_id: Number(x.id), display_name: String(x.n).trim() })) })
                setCarriers(r.carriers); notify('Carrier names saved.')
              } catch (e) { notify(e.message, 'error') }
            }}
          />
        )}
      </Panel>

      {isOwner && <AddClient />}

      <Panel title="Audit log">
        {!audit ? <Skeleton rows={5} /> : (
          <Table
            cols={[{ label: 'When' }, { label: 'Who' }, { label: 'Action' }, { label: 'Details' }]}
            empty={['No activity yet.', 'Every change is recorded with who made it.']}
            rows={audit.map(e => (
              <tr key={e.id}>
                <Td className="text-xs"><When at={e.createdAt} /></Td>
                <Td className="font-mono text-[11px] text-ink-muted">{(e.actor || '').replace(/^hub:/, '')}</Td>
                <Td className="font-bold text-xs">{e.action}</Td>
                <Td className="text-xs text-ink-muted">{e.detail}</Td>
              </tr>
            ))}
          />
        )}
      </Panel>
    </>
  )
}

function AddClient() {
  const { reload, setClient, notify } = useWix()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const body = {}
    for (const [k, raw] of fd.entries()) {
      const v = String(raw).trim()
      if (!v) continue
      if (k === 'mintsoft_client_id' || k === 'default_courier_service_id') body[k] = Number(v)
      else if (k === 'import_orders_since') body[k] = new Date(v).toISOString()
      else body[k] = v
    }
    setBusy(true); setError('')
    try {
      const r = await wix('POST', '/clients', body)
      notify(`Added ${r.client.name} → Mintsoft client ${r.mintsoft_client.id} (${r.mintsoft_client.name}).`)
      e.currentTarget?.reset?.()
      setClient(r.client.slug); setOpen(false)
      await reload()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  const field = (name, text, { type = 'text', hint, optional } = {}) => (
    <label className={label}>
      {text}
      <input name={name} type={type} required={!optional} autoComplete="off" className={`${input} normal-case tracking-normal`} />
      {hint && <span className="normal-case tracking-normal text-[10px]">{hint}</span>}
    </label>
  )

  return (
    <Panel title="Add a client" actions={<Btn small onClick={() => setOpen(o => !o)}>{open ? 'Close' : 'Add a client'}</Btn>}>
      <p className="font-sans text-sm text-ink-muted max-w-prose">Checks the Mintsoft client ID and name match and that the Wix key works before saving. Nothing is written to Mintsoft or Wix. The Wix API key goes straight to the integration, where it's stored encrypted; the Hub doesn't keep it. The Mintsoft client must already be on the integration's allowlist.</p>
      {open && (
        <form onSubmit={submit} className="mt-4 space-y-4">
          {error && <Note type="error">{error}</Note>}
          <div className="grid gap-3 sm:grid-cols-2">
            {field('name', 'Client name')}
            {field('slug', 'Short name (used in URLs)', { hint: 'lowercase letters, digits, hyphens' })}
            {field('mintsoft_client_id', 'Mintsoft client ID', { type: 'number' })}
            {field('mintsoft_client_name', 'Mintsoft client name', { hint: 'exactly as in Mintsoft' })}
            {field('wix_site_id', 'Wix site ID')}
            {field('wix_api_key', 'Wix API key', { type: 'password' })}
            {field('default_courier_service_id', 'Default courier service ID', { type: 'number', optional: true })}
            {field('default_carrier_name', 'Default carrier name', { optional: true })}
            {field('order_number_prefix', 'Order number prefix', { optional: true })}
            {field('import_orders_since', 'Import orders updated since', { type: 'datetime-local', optional: true })}
          </div>
          <Btn kind="primary" type="submit" busy={busy}>Add client</Btn>
        </form>
      )}
    </Panel>
  )
}
