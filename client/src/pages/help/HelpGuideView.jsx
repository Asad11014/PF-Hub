import { Link, useParams } from 'react-router-dom'
import { getGuide } from '../../lib/helpGuides'

export default function HelpGuideView() {
  const { slug } = useParams()
  const guide = getGuide(slug)

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center sticky top-0 z-40">
        <Link to="/app/help" className="font-mono text-[11px] text-ink-muted hover:text-primary no-underline">← Help Guides</Link>
      </header>

      <div className="p-4 sm:p-7 max-w-3xl mx-auto">
        {!guide ? (
          <Empty title="Guide not found" body="That guide doesn’t exist. Head back to the Help Guides index." />
        ) : !guide.published ? (
          <Empty title={guide.title} body="This guide is being written and will be published soon." badge="Coming soon" />
        ) : slug === 'hub-overview' ? (
          <HubOverview />
        ) : (
          <Empty title={guide.title} body="This guide is being written and will be published soon." badge="Coming soon" />
        )}
      </div>
    </div>
  )
}

function Empty({ title, body, badge }) {
  return (
    <div className="bg-brand-surface border border-brand-border rounded-lg p-10 text-center max-w-xl mx-auto mt-6">
      <div className="text-5xl mb-4">📘</div>
      <div className="font-sans font-bold text-lg text-ink mb-2">{title}</div>
      <p className="font-sans text-sm text-ink-muted">{body}</p>
      {badge && <span className="mt-4 inline-block font-mono text-[10px] uppercase tracking-widest text-gold bg-gold/10 border border-gold/30 rounded px-3 py-1">{badge}</span>}
    </div>
  )
}

// ── Section helpers ───────────────────────────────────────────────────────────
function Section({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-20 pt-8 first:pt-0">
      <h2 className="font-sans font-extrabold text-xl text-ink mb-3">{title}</h2>
      <div className="space-y-3 font-sans text-[15px] text-ink-muted leading-relaxed">{children}</div>
    </section>
  )
}
function Page({ name, children }) {
  return (
    <div className="border-l-2 border-brand-border pl-4 py-1">
      <div className="font-sans font-semibold text-ink text-sm">{name}</div>
      <div className="text-[14px] text-ink-muted leading-relaxed">{children}</div>
    </div>
  )
}

// ── The Hub overview guide ────────────────────────────────────────────────────
function HubOverview() {
  const toc = [
    ['dashboard', 'Dashboard'],
    ['stock', 'Stock Analytics'],
    ['returns', 'Returns'],
    ['shipping', 'Shipping Calculator'],
    ['invoice', 'Invoice Analysis'],
    ['seo', 'Website SEO'],
    ['help', 'Help Guides'],
    ['data', 'Keeping your data fresh'],
  ]
  return (
    <article className="py-6">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-primary">Getting Started</div>
      <h1 className="font-sans font-extrabold text-3xl text-ink leading-tight mb-3">How to Use the Premium Fulfilment Hub</h1>
      <p className="font-sans text-base text-ink-muted leading-relaxed mb-6">
        The Premium Fulfilment Hub is your self-service portal. It gives you a real-time view of your stock and orders,
        lets you book returns and request shipping, breaks down your invoices, and is where you’ll find help guides and
        our add-on services — all without having to email the warehouse. This guide walks through every page and what it
        does for you.
      </p>

      {/* Contents */}
      <nav className="bg-brand-surface border border-brand-border rounded-lg p-4 mb-8">
        <div className="font-mono text-[9px] text-ink-dim uppercase tracking-widest mb-2">On this page</div>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1">
          {toc.map(([id, label]) => (
            <li key={id}><a href={`#${id}`} className="font-sans text-sm text-primary hover:underline no-underline">{label}</a></li>
          ))}
        </ul>
      </nav>

      <Section id="dashboard" title="Dashboard">
        <p>Your home page and at-a-glance overview. Use the date filter in the top right (24 hours, 7, 30 or 90 days) to change the period — everything below updates to match.</p>
        <div className="space-y-2 pt-1">
          <Page name="Summary cards">Orders Shipped, Units Shipped, Orders Shipped On Time, Goods In Items Received, and Low/Out of Stock SKUs for the selected period.</Page>
          <Page name="Units Dispatched trend">A daily line chart of units shipped, so you can spot busy and quiet days.</Page>
          <Page name="Stock Health">A breakdown of your SKUs into healthy, low, overstock, dead and out-of-stock.</Page>
          <Page name="Top Products & Reorder Alerts">Your best-selling SKUs and a list of products running low, with a suggested order quantity.</Page>
        </div>
      </Section>

      <Section id="stock" title="Stock Analytics">
        <p>Everything about your inventory and how it’s selling.</p>
        <div className="space-y-2 pt-1">
          <Page name="Reports">A library of focused reports — Health Score, Live Snapshot, Aging Report, SKU Velocity, Cost Breakdown, Best Sellers and Sales Trend. Open any one to dig into the detail.</Page>
          <Page name="Product Overview">A full table of your products with on-hand stock, type, supplier and category. Filter by category or supplier, hide zero-stock or bundles, and show discontinued lines.</Page>
          <Page name="Inventory Planner">Demand forecasting and reorder planning. (Coming soon.)</Page>
          <Page name="Excess Stock">Surfaces slow-moving and overstocked SKUs so you can free up tied-up capital. (Coming soon.)</Page>
        </div>
      </Section>

      <Section id="returns" title="Returns">
        <p>Raise and track customer returns without contacting us directly.</p>
        <div className="space-y-2 pt-1">
          <Page name="Book a Return">Search for the original order, choose which items are coming back, and request a collection date. We’re notified instantly and book the courier.</Page>
          <Page name="Return History">Track the status of every return (pending → booked → collected → completed) and download the courier label once we’ve booked the collection.</Page>
        </div>
      </Section>

      <Section id="shipping" title="Shipping Calculator">
        <p>Pricing and requests for shipping beyond standard order fulfilment.</p>
        <div className="space-y-2 pt-1">
          <Page name="International Calculator">Instant international shipping estimates. (Coming soon.)</Page>
          <Page name="Stock Collection Request">Request a collection of your stock via a simple form.</Page>
          <Page name="Pallets & Arctic Pricing">Request pricing for palletised freight and artic (articulated lorry) transport.</Page>
          <Page name="Freight Forwarding">Submit a freight forwarding request and we’ll come back with options.</Page>
          <Page name="Shipping History">A record of your previous quotes and bespoke shipments.</Page>
        </div>
      </Section>

      <Section id="invoice" title="Invoice Analysis">
        <p>Understand exactly what you’re being charged.</p>
        <div className="space-y-2 pt-1">
          <Page name="Overview (Cost Breakdown)">Pick a confirmed billing month to see a clear breakdown of your charges — picking, storage, goods-in, postage and more — with the net total (no VAT).</Page>
          <Page name="Storage Calculator">A clear CBM / volumetric breakdown of your storage costs. (Coming soon.)</Page>
          <Page name="Bespoke Calculations">Bespoke cost breakdowns, e.g. bundle and assembly costs. (Coming soon.)</Page>
        </div>
      </Section>

      <Section id="seo" title="Website SEO">
        <p>Premium Fulfilment can manage your website SEO. This page lists our Standard, Plus and Enterprise packages and what each includes. If you’re interested, fill in the short form and our team will be in touch.</p>
      </Section>

      <Section id="help" title="Help Guides">
        <p>This section — a growing library of how-to guides covering sourcing, importing, using the WMS, selling on Amazon, packaging, forecasting and more. Use the search bar to find what you need. We’ll be adding guides over the coming months.</p>
      </Section>

      <Section id="data" title="Keeping your data fresh">
        <p>Your data refreshes automatically every night. If you need figures more up to date than that, please contact the warehouse team. You can also jump to the full warehouse management system any time via the <strong className="text-ink">Premium WMS</strong> link in the top right.</p>
      </Section>
    </article>
  )
}
