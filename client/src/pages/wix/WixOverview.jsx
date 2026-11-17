// Wix Integration — Overview: clients, despatch push, recent activity.
import { useEffect, useState } from 'react'
import { useWix } from './WixIntegration'
import { wix } from './wixApi'
import { Btn, Chip, Note, Panel, Skeleton, Table, Td, When } from './WixUI'

const who = a => (a || '').replace(/^hub:/, '')

export default function WixOverview() {
  const { state, canManage, confirm, reload, notify } = useWix()
  const [activity, setActivity] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    wix('GET', '/audit?limit=8').then(r => setActivity(r.entries)).catch(() => setActivity([]))
  }, [state])

  async function checkDespatches() {
    const ok = await confirm({
      title: 'Check Mintsoft for despatches now?',
      ok: 'Check now',
      kind: 'primary',
      body: <p>Orders despatched in Mintsoft that aren't fulfilled in Wix yet are marked fulfilled in Wix, with their tracking. Wix may email those customers. Nothing is written to Mintsoft.</p>,
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await wix('POST', '/reconcile')
      const pushed = r.results.filter(x => x.outcome !== 'error').length
      setResult({ ...r, pushed, failed: r.results.length - pushed })
      await reload()
    } catch (e) { notify(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <>
      {!state.writes.master && <Note>Mintsoft writes are locked off at deploy level (MINTSOFT_WRITES_ENABLED isn't "true"). Everything can be previewed, but nothing can be written.</Note>}

      <Panel title="Clients">
        <Table
          cols={[{ label: 'Client' }, { label: 'Mintsoft client' }, { label: 'Catalog' }, { label: 'Imported', num: 1 }, { label: 'Held', num: 1 }, { label: 'Fulfilled', num: 1 }, { label: 'Status' }]}
          empty={['No clients yet.', 'The owner can add a Wix store under Settings.']}
          rows={state.clients.map(c => {
            const k = c.orderCounts || {}
            return (
              <tr key={c.slug} className={k.held ? 'bg-warning/5' : undefined}>
                <Td><span className="font-bold">{c.name}</span> <span className="font-mono text-[11px] text-ink-muted">{c.slug}</span></Td>
                <Td mono>{c.mintsoftClientId}</Td>
                <Td>{c.catalogVersion || '—'}</Td>
                <Td num>{(k.imported || 0) + (k.despatched || 0)}</Td>
                <Td num>{k.held || 0}</Td>
                <Td num>{k.fulfilled || 0}</Td>
                <Td>{c.active ? <Chip state="go">Active</Chip> : <Chip state="stop">Deactivated</Chip>}</Td>
              </tr>
            )
          })}
        />
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel title="Despatch → Wix" actions={<Btn onClick={checkDespatches} busy={busy} disabled={!canManage} title={canManage ? undefined : 'Needs managing access'}>Check despatches now</Btn>}>
          <p className="font-sans text-sm text-ink-muted max-w-prose">Runs automatically every 5 minutes, and Mintsoft also notifies the integration about 10 minutes after each despatch. Use this to push tracking to Wix straight away.</p>
          {result && (
            <div className="mt-3">
              <Note type={result.failed ? 'error' : 'success'}>
                {result.despatchedSeen} despatched order(s) seen in Mintsoft, {result.ours} from Wix. {result.pushed} fulfilled in Wix{result.failed ? `, ${result.failed} failed (see Errors)` : ''}.
              </Note>
            </div>
          )}
        </Panel>

        <Panel title="Recent activity">
          {!activity ? <Skeleton rows={4} /> : (
            <Table
              cols={[{ label: 'When' }, { label: 'Who' }, { label: 'What' }]}
              empty={['No activity yet.', 'Actions taken here are recorded with who did them.']}
              rows={activity.map(e => (
                <tr key={e.id}>
                  <Td className="text-xs"><When at={e.createdAt} /></Td>
                  <Td className="font-mono text-[11px] text-ink-muted">{who(e.actor)}</Td>
                  <Td className="text-xs"><span className="font-bold">{e.action}</span> {e.detail}</Td>
                </tr>
              ))}
            />
          )}
        </Panel>
      </div>
    </>
  )
}
