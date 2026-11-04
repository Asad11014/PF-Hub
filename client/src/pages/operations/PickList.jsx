import { useState } from 'react'
import StatusBar from '../../components/StatusBar'

// Export the pick list as a CSV the picker can print and tick off.
function exportPickListCsv(order, lines) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = []
  rows.push([`Pick List — Order ${order.orderNumber}`])
  rows.push([`Client: ${order.clientName || order.clientId}`, `Recipient: ${order.recipient || ''}`, `Units: ${order.totalUnits}`])
  rows.push([])
  rows.push(['Picked', 'Location(s)', 'SKU', 'Product', 'Qty to Pick', 'In Stock'])
  lines.forEach(l => {
    const locs = l.locations.length
      ? l.locations.map(loc => `${loc.location} (${loc.locationType} x${loc.quantity})`).join(' ; ')
      : 'NO LOCATION'
    rows.push(['[  ]', locs, l.sku, l.name, l.qtyRequired, l.totalAvailable])
  })
  const csv  = rows.map(r => r.map(esc).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const a    = document.createElement('a')
  a.href     = URL.createObjectURL(blob)
  a.download = `picklist-${order.orderNumber}.csv`
  a.click()
}

const STATUS_NAMES = {
  1: 'New', 2: 'Printed', 3: 'Cancelled', 4: 'Despatched', 5: 'Invoiced',
  6: 'Invoice Failed', 7: 'Holding', 8: 'Failed', 9: 'On Back Order',
  10: 'Awaiting Confirmation', 11: 'Awaiting Documentation', 12: 'Awaiting Payment',
  13: 'Query Raised', 14: 'Pack and Hold', 15: 'Awaiting Picking', 16: 'Picking Started',
  17: 'Picked', 18: 'Fraud Risk', 19: 'Picking Skipped', 20: 'Packed',
  21: 'Awaiting Replen', 22: 'Processing', 23: 'Rebinned',
}

export default function PickList() {
  const [orderNumber, setOrderNumber] = useState('')
  const [data,    setData]    = useState(null)
  const [status,  setStatus]  = useState({ msg: '', type: null })
  const [loading, setLoading] = useState(false)

  async function run(e) {
    e?.preventDefault()
    const num = orderNumber.trim()
    if (!num) { setStatus({ msg: 'Enter an order number.', type: 'error' }); return }
    setLoading(true); setData(null); setStatus({ msg: 'Looking up order…', type: 'loading' })
    try {
      const res  = await fetch(`/api/picklist?orderNumber=${encodeURIComponent(num)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to build pick list')
      setData(json)
      const missing = json.lines.filter(l => l.totalAvailable === 0).length
      setStatus({
        msg: missing > 0
          ? `${json.lines.length} lines · ${missing} with no stock in a location`
          : `${json.lines.length} lines ready to pick`,
        type: missing > 0 ? 'warning' : 'success',
      })
    } catch (err) {
      setStatus({ msg: err.message, type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const order = data?.order

  return (
    <div className="flex-1 overflow-y-auto print:overflow-visible">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center justify-between sticky top-0 z-40 gap-2 print:hidden">
        <div>
          <div className="font-sans font-bold text-[15px] text-ink">Pick List</div>
          <div className="font-mono text-[11px] text-ink-muted hidden sm:block">
            Generate a pick list for any order — even ones Mintsoft won’t allocate (e.g. Awaiting Replen)
          </div>
        </div>
        {data && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => exportPickListCsv(data.order, data.lines)}
              className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-gold hover:text-gold transition-colors">
              Export CSV
            </button>
            <button onClick={() => window.print()}
              className="border border-brand-border rounded text-ink-muted font-mono text-[11px] px-3 py-1.5 hover:border-primary hover:text-primary transition-colors">
              🖨 Print
            </button>
          </div>
        )}
      </header>

      <div className="p-4 sm:p-7 space-y-5 print:p-0">
        {/* Search */}
        <form onSubmit={run} className="bg-brand-surface border border-brand-border rounded-lg px-4 sm:px-6 py-3 sm:py-4 print:hidden">
          <div className="font-mono text-[9px] text-primary uppercase tracking-widest mb-3">▸ Order Lookup</div>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">Order Number</label>
              <input
                value={orderNumber}
                onChange={e => setOrderNumber(e.target.value)}
                placeholder="e.g. IN84815"
                className="bg-brand-bg border border-brand-border rounded px-3 py-2 font-mono text-sm text-ink w-56 focus:outline-none focus:border-primary"
              />
            </div>
            <button type="submit" disabled={loading}
              className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-sans font-bold text-sm rounded px-5 py-2 h-9 transition-colors disabled:opacity-50">
              {loading ? '⟳ Building…' : '▶ Build Pick List'}
            </button>
          </div>
        </form>

        <div className="print:hidden"><StatusBar message={status.msg} type={status.type} /></div>

        {data && (
          <div className="bg-brand-surface border border-brand-border rounded-lg overflow-hidden print:border-0 print:bg-white">
            {/* Order header */}
            <div className="px-4 sm:px-6 py-4 border-b border-brand-border grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4">
              <HeaderField label="Order" value={order.orderNumber} strong />
              <HeaderField label="Client" value={order.clientName || `#${order.clientId}`} />
              <HeaderField label="Status" value={STATUS_NAMES[order.statusId] || `#${order.statusId}`} />
              <HeaderField label="Courier" value={order.courier || '—'} />
              <HeaderField label="Recipient" value={order.recipient || '—'} />
              <HeaderField label="Lines" value={order.itemCount} />
              <HeaderField label="Total Units" value={order.totalUnits} />
            </div>

            {/* Pick lines */}
            <table className="w-full text-left">
              <thead>
                {/* Repeats at the top of every printed page */}
                <tr className="hidden print:table-row">
                  <th colSpan={6} className="px-4 pt-1 pb-2 text-left font-mono text-[10px] text-ink-muted">
                    Pick list · Order <span className="font-bold text-ink">{order.orderNumber}</span>
                    {' · '}{order.clientName || `Client #${order.clientId}`} · {order.itemCount} lines · {order.totalUnits} units
                  </th>
                </tr>
                <tr className="border-b border-brand-border">
                  <th className="hidden print:table-cell w-8 px-2 py-3 font-mono text-[9px] text-ink-dim uppercase">✓</th>
                  <Th>Location(s)</Th>
                  <Th>SKU</Th>
                  <Th>Product</Th>
                  <Th align="right">Qty to Pick</Th>
                  <Th align="right">In Stock</Th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => {
                  const noStock = l.totalAvailable === 0
                  const short   = !noStock && l.totalAvailable < l.qtyRequired
                  return (
                    <tr key={i} className="border-b border-brand-border last:border-0 align-top">
                      <td className="hidden print:table-cell px-2 py-3 print:py-1.5"><span className="inline-block w-4 h-4 border border-ink rounded-sm" /></td>
                      <td className="px-4 py-3 print:py-1.5">
                        {l.locations.length === 0 ? (
                          <span className="font-mono text-xs text-danger font-semibold">NO LOCATION</span>
                        ) : (
                          <div className="space-y-1">
                            {l.locations.map((loc, j) => (
                              <div key={j} className="flex items-center gap-2">
                                <span className="font-mono text-xs font-bold text-ink">{loc.location}</span>
                                <span className="font-mono text-[9px] text-ink-dim uppercase">{loc.locationType}</span>
                                <span className="font-mono text-[10px] text-ink-muted">×{loc.quantity}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 print:py-1.5 font-mono text-xs text-ink">{l.sku}</td>
                      <td className="px-4 py-3 print:py-1.5 text-sm print:text-xs print:leading-snug text-ink">{l.name || '—'}</td>
                      <td className="px-4 py-3 print:py-1.5 text-right font-mono text-sm font-bold text-ink">{l.qtyRequired}</td>
                      <td className="px-4 py-3 print:py-1.5 text-right">
                        <span className={`font-mono text-xs font-semibold ${noStock ? 'text-danger' : short ? 'text-warning' : 'text-success'}`}>
                          {l.totalAvailable}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function HeaderField({ label, value, strong }) {
  return (
    <div>
      <div className="font-mono text-[9px] text-ink-dim uppercase tracking-widest">{label}</div>
      <div className={`text-ink ${strong ? 'font-sans font-bold text-base' : 'font-mono text-sm'}`}>{value}</div>
    </div>
  )
}

function Th({ children, align = 'left' }) {
  return (
    <th className={`px-4 py-3 font-mono text-[9px] text-ink-dim uppercase tracking-widest text-${align}`}>
      {children}
    </th>
  )
}
