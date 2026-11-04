// Formatting shared by the Invoice Audit pages.
const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })

export const gbp = v => (v == null ? '—' : GBP.format(v))
export const signedGbp = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${GBP.format(v)}`)
export const isZero = v => v == null || Math.abs(v) < 0.005
export const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
export const fmtDateTime = d => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

export const FLAG_META = {
  double_billed:      { label: 'Double-billed',          cls: 'bg-danger/15 text-danger border-danger/30' },
  cancelled:          { label: 'Cancelled order billed', cls: 'bg-danger/15 text-danger border-danger/30' },
  not_despatched:     { label: 'Not despatched',         cls: 'bg-danger/15 text-danger border-danger/30' },
  order_missing:      { label: 'Order not in Mintsoft',  cls: 'bg-warning/15 text-warning border-warning/30' },
  postage_below_cost: { label: 'Postage below cost',     cls: 'bg-warning/15 text-warning border-warning/30' },
  zero_charge:        { label: 'Zero charge',            cls: 'bg-warning/15 text-warning border-warning/30' },
  manual_zeroing:     { label: 'Manually zeroed',        cls: 'bg-warning/15 text-warning border-warning/30' },
  manual_note:        { label: 'Note',                   cls: 'bg-primary/10 text-primary border-primary/20' },
}
