// Wix Integration — Orders: preview → import, held orders (check / retry / re-send), recent.
import { useCallback, useEffect, useState } from 'react'
import { useWix } from './WixIntegration'
import { wix, clientPath, gbp } from './wixApi'
import { Btn, Chip, Note, Panel, Skeleton, Table, Td, When } from './WixUI'
import ClientPicker from './ClientPicker'

const OUTCOME = {
  would_import: ['go', 'Would import'], imported: ['go', 'Imported'], already_in_mintsoft: ['go', 'Already in Mintsoft'],
  held: ['stop', 'Held'], skipped_non_physical: ['off', 'Nothing to ship'], skipped: ['off', 'Skipped'],
}
const STATUS = {
  imported: ['go', 'Imported'], fulfilled: ['go', 'Fulfilled in Wix'], despatched: ['go', 'Part despatched'],
  held: ['stop', 'Held'], fulfil_failed: ['stop', 'Fulfilment failed'], skipped_non_physical: ['off', 'Nothing to ship'],
}
const chip = (map, k) => { const [s, l] = map[k] || ['off', k]; return <Chip state={s}>{l}</Chip> }
const items = p => (p?.OrderItems ? p.OrderItems.map(i => `${i.SKU} × ${i.Quantity}`).join(', ') : '—')

export default function WixOrders() {
  const { state, client, canManage, confirm, reload, notify } = useWix()
  const [preview, setPreview] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  const [held, setHeld] = useState(null)
  const [recent, setRecent] = useState(null)
  const [busy, setBusy] = useState(null)
  const [checks, setChecks] = useState({})
  const live = state.writes.effective
  const target = `Mintsoft client ${state.allowedClientIds.join(', ')} · warehouse ${state.warehouseId ?? 'not set'}`

  const loadLists = useCallback(() => {
    if (!client) return
    wix('GET', clientPath(client, '/orders?status=held&limit=100')).then(r => setHeld(r.orders)).catch(e => notify(e.message, 'error'))
    wix('GET', clientPath(client, '/orders?limit=50')).then(r => setRecent(r.orders)).catch(e => notify(e.message, 'error'))
  }, [client, notify])
  useEffect(() => { setPreview(null); setLastRun(null); setHeld(null); setRecent(null); setChecks({}); loadLists() }, [client]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!client) return <Note>No clients yet. The owner can add a Wix store under Settings.</Note>

  const act = async (key, fn) => { setBusy(key); try { await fn() } catch (e) { notify(e.message, 'error') } finally { setBusy(null) } }
  const would = preview ? preview.outcomes.filter(o => o.outcome === 'would_import') : []
  const why = !canManage ? 'You can preview; importing needs managing access.'
    : !live ? 'Writes are paused, so Import is off.'
    : !preview ? 'Preview first, then import.'
    : !would.length ? 'Nothing in the preview would import.' : ''

  const runPreview = () => act('preview', async () => {
    setPreview(await wix('POST', clientPath(client, '/run-import?dryRun=true'))); setLastRun(null)
  })
  const runImport = async () => {
    const ok = await confirm({
      title: `Create ${would.length} order${would.length === 1 ? '' : 's'} in Mintsoft?`,
      ok: 'Create in Mintsoft',
      body: (
        <>
          <ul className="list-disc pl-5 space-y-0.5">
            {would.map(o => <li key={o.wixOrderNumber}><span className="font-mono">{o.wixOrderNumber}</span> · courier {o.payload.CourierServiceId} · {items(o.payload)}</li>)}
          </ul>
          <p className="font-mono text-xs">Target: {target}</p>
          <p className="text-ink-muted">Orders with an unknown SKU are sent once so Mintsoft shows its own error; they aren't created. Any order placed since the preview is included too.</p>
        </>
      ),
    })
    if (!ok) return
    await act('import', async () => {
      const r = await wix('POST', clientPath(client, '/run-import?dryRun=false'))
      setPreview(null); setLastRun(r); notify(`Import finished: ${r.outcomes.length} order(s) processed.`)
      await reload(); loadLists()
    })
  }
  const check = o => act(`check-${o.wixOrderNumber}`, async () => {
    const r = await wix('POST', clientPath(client, `/orders/${encodeURIComponent(o.wixOrderNumber)}/retry?dryRun=true`))
    setChecks(c => ({ ...c, [o.wixOrderNumber]: r.outcome }))
  })
  const retry = async (o, notifyMintsoft) => {
    const ok = await confirm(notifyMintsoft ? {
      title: `Re-send order ${o.wixOrderNumber} to Mintsoft?`, ok: 'Re-send', kind: 'primary',
      body: <><p>Mintsoft should reject it again and show its missing-SKU connect error to the warehouse team. Nothing is created while the SKU is missing.</p><p className="font-mono text-xs">Target: {target}</p></>,
    } : {
      title: `Retry order ${o.wixOrderNumber} now?`, ok: 'Retry now',
      body: <><p>If every SKU now exists, the order is created in Mintsoft.</p><p className="font-mono text-xs">Target: {target}</p></>,
    })
    if (!ok) return
    await act(`retry-${o.wixOrderNumber}`, async () => {
      const r = await wix('POST', clientPath(client, `/orders/${encodeURIComponent(o.wixOrderNumber)}/retry?dryRun=false${notifyMintsoft ? '&notify=true' : ''}`))
      notify(`Order ${o.wixOrderNumber}: ${(OUTCOME[r.outcome.outcome] || [0, r.outcome.outcome])[1]}`)
      await reload(); loadLists()
    })
  }

  const report = preview || lastRun
  return (
    <>
      <Panel
        title="Import from Wix"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ClientPicker />
            <Btn kind="primary" busy={busy === 'preview'} onClick={runPreview}>{preview ? 'Preview again' : 'Preview import'}</Btn>
            <Btn kind="write" busy={busy === 'import'} disabled={!!why} onClick={runImport}>Import now…</Btn>
            {why && <span className="font-mono text-[11px] text-ink-muted">{why}</span>}
          </div>
        }
      >
        {!report ? (
          <div>
            <div className="font-sans font-bold text-sm text-ink">See exactly what would go to Mintsoft.</div>
            <div className="font-sans text-sm text-ink-muted mt-0.5">Preview reads paid, unfulfilled Wix orders and checks each against Mintsoft without writing anything.</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="font-mono text-[11px] text-ink-muted">
              {preview ? `Preview: nothing was written. ${preview.ordersSeen} order(s) found in Wix, ${preview.alreadyHandled} already handled.` : 'Import finished.'}
            </div>
            <Table
              cols={[{ label: 'Order' }, { label: preview ? 'Would happen' : 'Result' }, { label: 'Courier' }, { label: 'Items' }, { label: 'Value', num: 1 }, { label: 'Details' }]}
              empty={['No new orders.', 'Every paid, unfulfilled Wix order has already been handled.']}
              rows={report.outcomes.map(o => (
                <tr key={o.wixOrderNumber} className={o.outcome === 'held' ? 'bg-danger/5' : undefined}>
                  <Td mono>{o.wixOrderNumber}</Td>
                  <Td>{chip(OUTCOME, o.outcome)}</Td>
                  <Td mono>{o.payload?.CourierServiceId ?? '—'}</Td>
                  <Td className="text-xs">{items(o.payload)}</Td>
                  <Td num>{o.payload?.OrderValue != null ? gbp(o.payload.OrderValue) : '—'}</Td>
                  <Td className="text-xs text-ink-muted max-w-[60ch]">{o.message || o.warning || (o.mintsoftOrderId ? `Mintsoft order ${o.mintsoftOrderId}` : '')}</Td>
                </tr>
              ))}
            />
          </div>
        )}
      </Panel>

      <Panel title="Held orders" actions={<span className="font-mono text-[11px] text-ink-muted">Retried automatically every hour for 7 days</span>}>
        {!held ? <Skeleton /> : (
          <Table
            cols={[{ label: 'Order' }, { label: "Why it's held" }, { label: 'Tries', num: 1 }, { label: 'Last tried' }, { label: '' }]}
            empty={['No held orders.', "Orders that can't be imported (unknown SKU, missing address, unmapped courier) show up here with the reason."]}
            rows={held.map(o => {
              const c = checks[o.wixOrderNumber]
              const unknownSku = /not found in Mintsoft/.test(o.lastError || '')
              const noManage = canManage ? undefined : 'Needs managing access'
              return (
                <tr key={o.wixOrderNumber} className="bg-danger/5">
                  <Td mono>{o.wixOrderNumber}</Td>
                  <Td className="text-xs text-ink-muted max-w-[60ch]">
                    {o.lastError || '—'}
                    {c && <div className="mt-1.5 flex flex-wrap items-center gap-2">{chip(OUTCOME, c.outcome)} <span>{c.message}</span></div>}
                  </Td>
                  <Td num>{o.attempts}</Td>
                  <Td className="text-xs"><When at={o.updatedAt} /></Td>
                  <Td className="text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Btn small busy={busy === `check-${o.wixOrderNumber}`} onClick={() => check(o)}>Check again</Btn>
                      <Btn small kind="write" disabled={!canManage || !live} title={noManage || (!live ? 'Writes are paused' : undefined)} busy={busy === `retry-${o.wixOrderNumber}`} onClick={() => retry(o, false)}>Retry now…</Btn>
                      {unknownSku && <Btn small disabled={!canManage || !live} title={noManage || 'Sends it again so Mintsoft shows its missing-SKU error. Nothing is created.'} onClick={() => retry(o, true)}>Re-send to Mintsoft…</Btn>}
                    </div>
                  </Td>
                </tr>
              )
            })}
          />
        )}
      </Panel>

      <Panel title="Recent orders">
        {!recent ? <Skeleton rows={5} /> : (
          <Table
            cols={[{ label: 'Order' }, { label: 'Status' }, { label: 'Mintsoft order' }, { label: 'Tracking' }, { label: 'Updated' }]}
            empty={['No orders yet.', 'Orders appear here once the import has seen them.']}
            rows={recent.map(o => (
              <tr key={o.wixOrderId}>
                <Td mono>{o.wixOrderNumber}</Td>
                <Td>{chip(STATUS, o.status)}</Td>
                <Td mono>{o.mintsoftOrderId ?? '—'}</Td>
                <Td mono>{o.trackingNumber ?? '—'}</Td>
                <Td className="text-xs"><When at={o.updatedAt} /></Td>
              </tr>
            ))}
          />
        )}
      </Panel>
    </>
  )
}
