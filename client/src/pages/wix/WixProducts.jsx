// Wix Integration — Products: preview the product import, create one, then all.
import { useEffect, useState } from 'react'
import { useWix } from './WixIntegration'
import { wix, clientPath, gbp } from './wixApi'
import { Btn, Chip, Note, Panel, Table, Td } from './WixUI'
import ClientPicker from './ClientPicker'

const KEYS = ['wouldCreate', 'created', 'skippedExisting', 'missingSku', 'duplicateSkuInWix', 'errors']

/** Walks the catalogue page by page (one Worker call each), accumulating the report. */
async function walk(client, { dryRun, maxCreates, onPage }) {
  const acc = { wouldCreate: [], created: [], skippedExisting: [], missingSku: [], duplicateSkuInWix: [], errors: [], skippedNonPhysical: 0, pages: 0 }
  let cursor = null
  while (acc.pages < 200) {
    const q = new URLSearchParams({ dryRun: String(dryRun) })
    if (cursor) q.set('cursor', cursor)
    if (maxCreates) q.set('maxCreates', String(maxCreates))
    const r = await wix('POST', clientPath(client, `/import-products?${q}`))
    acc.pages++
    KEYS.forEach(k => { acc[k] = acc[k].concat(r[k] || []) })
    acc.skippedNonPhysical += r.skippedNonPhysical || 0
    acc.dryRun = r.dryRun
    onPage?.(acc)
    if (r.done || r.stoppedBy === 'api_error') break
    if (maxCreates === 1 && acc.created.length >= 1) break
    cursor = r.nextCursor
  }
  return acc
}

export default function WixProducts() {
  const { state, client, canManage, confirm, reload, notify } = useWix()
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const [progress, setProgress] = useState('')
  const live = state.writes.effective
  useEffect(() => { setPreview(null); setResult(null); setProgress('') }, [client])

  if (!client) return <Note>No clients yet. The owner can add a Wix store under Settings.</Note>

  const toCreate = preview ? preview.wouldCreate.length : 0
  const why = !canManage ? 'You can preview; creating products needs managing access.'
    : !live ? 'Writes are paused, so creating is off.'
    : !preview ? 'Preview first.'
    : !toCreate ? 'Every SKU is already in Mintsoft.' : ''

  async function runPreview() {
    setBusy('preview'); setResult(null)
    try { setPreview(await walk(client, { dryRun: true, onPage: a => setProgress(`Reading Wix… page ${a.pages}`) })) }
    catch (e) { notify(e.message, 'error') }
    finally { setBusy(null); setProgress('') }
  }

  async function create(max) {
    const ok = await confirm({
      title: max === 1 ? 'Create one product in Mintsoft?' : `Create ${toCreate} product(s) in Mintsoft?`,
      ok: max === 1 ? 'Create one' : 'Create all',
      body: (
        <>
          <p>{max === 1
            ? 'Creates the first missing SKU and checks Mintsoft can find it again, before you create the rest.'
            : "Creates every SKU from the preview that isn't in Mintsoft yet. Existing SKUs are never changed. No stock is sent."}</p>
          <p className="font-mono text-xs">Target: Mintsoft client {state.allowedClientIds.join(', ')}</p>
        </>
      ),
    })
    if (!ok) return
    setBusy(max === 1 ? 'one' : 'all')
    try {
      const r = await walk(client, { dryRun: false, maxCreates: max, onPage: a => setProgress(`Creating… ${a.created.length} created`) })
      setPreview(null); setResult(r)
      notify(`${r.created.length} product(s) created in Mintsoft${r.errors.length ? `, ${r.errors.length} failed` : ''}.`, r.errors.length ? 'error' : 'success')
      await reload()
    } catch (e) { notify(e.message, 'error') }
    finally { setBusy(null); setProgress('') }
  }

  const shown = result || preview
  return (
    <Panel
      title="Products from Wix"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <ClientPicker />
          <Btn kind="primary" busy={busy === 'preview'} disabled={!!busy && busy !== 'preview'} onClick={runPreview}>{preview ? 'Preview again' : 'Preview product import'}</Btn>
          <Btn kind="write" busy={busy === 'one'} disabled={!!why || !!busy} onClick={() => create(1)}>Create first product…</Btn>
          <Btn kind="write" busy={busy === 'all'} disabled={!!why || !!busy} onClick={() => create(0)}>Create all…</Btn>
          {(progress || why) && <span className="font-mono text-[11px] text-ink-muted">{progress || why}</span>}
        </div>
      }
    >
      {!shown ? (
        <div>
          <div className="font-sans font-bold text-sm text-ink">Bring this store's products into Mintsoft.</div>
          <div className="font-sans text-sm text-ink-muted mt-0.5">Preview lists every Wix variant and whether it would be created. SKUs already in Mintsoft are never changed, and stock is never sent.</div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="font-mono text-[11px] text-ink-muted">
            {preview
              ? `Preview: nothing was written. ${toCreate} to create · ${preview.skippedExisting.length} already in Mintsoft · ${preview.missingSku.length} without a SKU · ${preview.skippedNonPhysical} digital skipped.`
              : `${result.created.length} created in Mintsoft${result.errors.length ? ` · ${result.errors.length} failed` : ''}.`}
          </div>
          <Table
            cols={[{ label: 'SKU' }, { label: 'Name' }, { label: 'Weight', num: 1 }, { label: 'Price', num: 1 }, { label: 'Status' }]}
            empty={['Nothing to show.', 'This store has no physical products with SKUs.']}
            rows={[
              ...(preview ? shown.wouldCreate : shown.created).map(x => {
                const p = x.payload || {}
                const zero = (x.flags || []).includes('zero_weight')
                return (
                  <tr key={`n-${x.sku}`} className={zero ? 'bg-warning/5' : undefined}>
                    <Td mono>{x.sku}</Td>
                    <Td>{p.Name || '—'}</Td>
                    <Td num>{zero ? <Chip state="hold">0 kg</Chip> : p.Weight != null ? `${p.Weight} kg` : '—'}</Td>
                    <Td num>{p.Price != null ? gbp(p.Price) : '—'}</Td>
                    <Td>{preview ? <Chip state="go">Would create</Chip> : <Chip state="go">Created · #{x.mintsoftProductId}</Chip>}</Td>
                  </tr>
                )
              }),
              ...shown.skippedExisting.map(x => (
                <tr key={`e-${x.sku}`}><Td mono>{x.sku}</Td><Td>—</Td><Td num>—</Td><Td num>—</Td><Td><Chip state="off">Already in Mintsoft</Chip></Td></tr>
              )),
              ...shown.missingSku.map((name, i) => (
                <tr key={`m-${i}`} className="bg-danger/5"><Td mono>—</Td><Td>{name}</Td><Td num>—</Td><Td num>—</Td><Td><Chip state="stop">No SKU in Wix</Chip></Td></tr>
              )),
              ...shown.errors.map((e, i) => (
                <tr key={`x-${i}`} className="bg-danger/5"><Td mono>{e.sku}</Td><Td className="text-xs text-ink-muted">{e.message}</Td><Td /><Td /><Td><Chip state="stop">Failed</Chip></Td></tr>
              )),
            ]}
          />
        </div>
      )}
    </Panel>
  )
}
