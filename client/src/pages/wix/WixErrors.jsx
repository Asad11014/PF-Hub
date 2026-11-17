// Wix Integration — Errors: what needs a person, with Resolve.
import { useCallback, useEffect, useState } from 'react'
import { useWix } from './WixIntegration'
import { wix } from './wixApi'
import { Btn, Chip, Panel, Skeleton, Table, Td, When } from './WixUI'

const CODE = {
  unknown_sku: 'SKU not in Mintsoft', missing_sku: 'No SKU in Wix', unmapped_courier: 'Courier not mapped', invalid_address: 'Incomplete address',
  invalid_line: 'Bad quantity', unknown_item_type: 'Unrecognised item type', mintsoft_rejected: 'Rejected by Mintsoft', mintsoft_api_error: 'Mintsoft unavailable',
  wix_api_error: 'Wix unavailable', order_not_found: 'Despatch not matched', mintsoft_cancelled: 'Cancelled in Mintsoft', despatch_mismatch: "Despatch doesn't match Wix",
  despatch_payload_invalid: 'Unreadable despatch', order_cancelled: 'Cancelled in Wix', mintsoft_client_mismatch: 'Wrong Mintsoft client', mintsoft_verify_failed: 'Not verified',
  mintsoft_accepted_unknown_sku: 'Accepted with unknown SKU', config_error: 'Configuration', internal_error: 'Internal error',
  mintsoft_writes_disabled: 'Writes off', mintsoft_client_not_allowed: 'Client not allowlisted',
}

export default function WixErrors() {
  const { state, canManage, reload, notify } = useWix()
  const [showResolved, setShowResolved] = useState(false)
  const [errors, setErrors] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(() => {
    wix('GET', `/errors?limit=200${showResolved ? '' : '&unresolved=1'}`).then(r => setErrors(r.errors)).catch(e => notify(e.message, 'error'))
  }, [showResolved]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setErrors(null); load() }, [load, state.unresolvedErrors])

  async function resolve(e) {
    setBusy(e.id)
    try { await wix('POST', `/errors/${e.id}/resolve`); notify('Marked resolved.'); await reload(); load() }
    catch (err) { notify(err.message, 'error') }
    finally { setBusy(null) }
  }

  return (
    <Panel
      title="Errors"
      actions={
        <label className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
          <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      }
    >
      {!errors ? <Skeleton rows={5} /> : (
        <Table
          cols={[{ label: 'When' }, { label: 'Order / SKU' }, { label: 'Problem' }, { label: 'Details' }, { label: '' }]}
          empty={['Nothing needs attention.', 'Held orders, failed fulfilments and Mintsoft cancellations appear here until someone resolves them.']}
          rows={errors.map(e => (
            <tr key={e.id} className={e.resolved ? undefined : 'bg-danger/5'}>
              <Td className="text-xs"><When at={e.createdAt} /></Td>
              <Td mono>{e.ref || '—'}</Td>
              <Td className="font-bold whitespace-nowrap">{CODE[e.code] || e.code}</Td>
              <Td className="text-xs text-ink-muted max-w-[70ch]">{e.message}</Td>
              <Td className="text-right">
                {e.resolved ? <Chip state="off">Resolved</Chip>
                  : <Btn small busy={busy === e.id} disabled={!canManage} title={canManage ? undefined : 'Needs managing access'} onClick={() => resolve(e)}>Resolve</Btn>}
              </Td>
            </tr>
          ))}
        />
      )}
    </Panel>
  )
}
