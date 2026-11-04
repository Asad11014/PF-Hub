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
  // Expected vs billed (rules, rework prices, picking pattern)
  rework_missing:      { label: 'Rework not charged',    cls: 'bg-danger/15 text-danger border-danger/30' },
  rework_differs:      { label: 'Rework differs',        cls: 'bg-warning/15 text-warning border-warning/30' },
  rework_unpriced:     { label: 'Rework charged £0',     cls: 'bg-danger/15 text-danger border-danger/30' },
  rework_not_expected: { label: 'Rework without a rule', cls: 'bg-primary/10 text-primary border-primary/20' },
  picking_below:       { label: 'Picking under',         cls: 'bg-danger/15 text-danger border-danger/30' },
  picking_above:       { label: 'Picking over',          cls: 'bg-warning/15 text-warning border-warning/30' },
  picking_capped:      { label: 'Flat picking charge',   cls: 'bg-primary/10 text-primary border-primary/20' },
  picking_bulk:        { label: 'Bulk order',            cls: 'bg-primary/10 text-primary border-primary/20' },
  admin_differs:       { label: 'Admin fee differs',     cls: 'bg-warning/15 text-warning border-warning/30' },
  // Stage I3: goods-in against the rate card, postage outliers, your own rules, header vs lines
  goods_in_unit:       { label: 'Goods-in unit rate',    cls: 'bg-warning/15 text-warning border-warning/30' },
  goods_in_sku:        { label: 'Goods-in SKU rate',     cls: 'bg-warning/15 text-warning border-warning/30' },
  goods_in_admin:      { label: 'ASN admin differs',     cls: 'bg-warning/15 text-warning border-warning/30' },
  goods_in_delivery:   { label: 'Delivery charge',       cls: 'bg-primary/10 text-primary border-primary/20' },
  goods_in_zeroed:     { label: 'Goods-in not charged',  cls: 'bg-primary/10 text-primary border-primary/20' },
  postage_unusual:     { label: 'Unusual postage',       cls: 'bg-primary/10 text-primary border-primary/20' },
  audit_rule:          { label: 'Your rule',             cls: 'bg-danger/15 text-danger border-danger/30' },
  lines_differ:        { label: 'Lines ≠ invoice',       cls: 'bg-danger/15 text-danger border-danger/30' },
  unbilled:            { label: 'Not billed',            cls: 'bg-danger/15 text-danger border-danger/30' },
}

// Review of one finding, and of a whole invoice.
export const REVIEW_META = {
  ok:     { label: 'OK',        cls: 'bg-success/15 text-success border-success/30' },
  credit: { label: 'To credit', cls: 'bg-warning/15 text-warning border-warning/30' },
  charge: { label: 'To charge', cls: 'bg-primary/10 text-primary border-primary/20' },
}
export const INVOICE_STATUS = {
  not_reviewed: { label: 'Not reviewed', cls: 'bg-brand-bg text-ink-muted border-brand-border' },
  in_review:    { label: 'In review',    cls: 'bg-warning/15 text-warning border-warning/30' },
  signed_off:   { label: 'Signed off',   cls: 'bg-success/15 text-success border-success/30' },
}
export const needsReview = f => f.severity === 'error' || f.severity === 'warning'
export const isOpen = f => needsReview(f) && !f.review

// Explained / informational flags are shown muted so warnings stand out.
export const flagClass = f => (f.severity === 'info' ? 'bg-brand-bg text-ink-muted border-brand-border' : FLAG_META[f.code]?.cls || '')

export const fmtModel = m => {
  if (!m) return '—'
  if (m.kind === 'perSkuPerUnit') return `${gbp(m.S)} per order + ${gbp(m.K)} per SKU + ${gbp(m.U)} per unit`
  return `${gbp(m.S)} + ${gbp(m.A)} per extra ${m.by === 'lines' ? 'order line' : 'unit'}${m.N > 1 ? ` after ${m.N}` : ''}`
}
