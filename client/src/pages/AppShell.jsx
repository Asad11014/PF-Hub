import { Routes, Route, Navigate, useNavigate, Link } from 'react-router-dom'
import { useEffect } from 'react'
import { useSession } from '../context/SessionContext'
import { UIProvider, useUI } from '../context/UIContext'
import Sidebar from '../components/Sidebar'
import pfLogo from '../assets/pf-hub-logo.png'
import Dashboard   from './Dashboard'
import Calendar    from './Calendar'

// Inventory
import HealthScore      from './inventory/HealthScore'
import Snapshot         from './inventory/Snapshot'
import Aging            from './inventory/Aging'
import Velocity         from './inventory/Velocity'
// Operations
import Fulfillment from './operations/Fulfillment'
import EodDespatch from './operations/EodDespatch'
import PickList    from './operations/PickList'
import ReplenList  from './operations/ReplenList'

// Financial
import Profitability from './financial/Profitability'

// Analytics
import BestSellers from './analytics/BestSellers'
import SalesTrend  from './analytics/SalesTrend'

// Client Hub
import ReportsIndex    from './ReportsIndex'
import ProductOverview from './stock/ProductOverview'
import InventoryPlanner from './stock/InventoryPlanner'
import ExcessStock     from './stock/ExcessStock'
import StorageCalculator from './invoice/StorageCalculator'
import SeoPage         from './SeoPage'
import HelpGuides      from './help/HelpGuides'
import HelpGuideView   from './help/HelpGuideView'
import BookReturn      from './returns/BookReturn'
import ReturnHistory   from './returns/ReturnHistory'
import ReturnsHub      from './operations/ReturnsHub'
import Placeholder     from './Placeholder'

function WarehouseOnly({ children }) {
  const { session } = useSession()
  if (session && !session.isWarehouse) return <Navigate to="/app" replace />
  return children
}

function DemoBanner() {
  return (
    <div className="sticky top-0 z-20 bg-primary text-white px-4 py-1.5 flex items-center justify-center gap-3 text-center">
      <span className="font-mono text-[11px] tracking-wide">
        🔎 Demo mode — sample data, read-only. Nothing you do here is saved.
      </span>
      <a
        href="https://pf-landing.onrender.com"
        className="font-mono text-[11px] font-bold underline underline-offset-2 hover:opacity-80 flex-shrink-0"
      >
        Book a real demo →
      </a>
    </div>
  )
}

function AppShellLayout() {
  const { session, loading } = useSession()
  const { sidebarOpen, openSidebar, closeSidebar } = useUI()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !session) navigate('/', { replace: true })
  }, [session, loading, navigate])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-border border-t-primary rounded-full animate-spin" />
          <span className="font-mono text-xs text-ink-muted">Loading…</span>
        </div>
      </div>
    )
  }

  if (!session) return null

  return (
    <div className="h-screen flex flex-col bg-brand-bg overflow-hidden">

      {/* Full-width top header — spans the entire page */}
      <header className="flex-shrink-0 h-16 bg-white flex items-center justify-between px-4 sm:px-6 z-50">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => (sidebarOpen ? closeSidebar() : openSidebar())} aria-label="Toggle menu"
            className="lg:hidden w-8 h-8 flex items-center justify-center text-navy hover:bg-brand-surface2 rounded transition-colors flex-shrink-0">
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden="true">
              <rect y="0"  width="18" height="2" rx="1" fill="currentColor"/>
              <rect y="6"  width="18" height="2" rx="1" fill="currentColor"/>
              <rect y="12" width="18" height="2" rx="1" fill="currentColor"/>
            </svg>
          </button>
          <Link to="/app" onClick={closeSidebar} aria-label="Go to dashboard">
            <img src={pfLogo} alt="Premium Fulfilment Hub" className="h-8 sm:h-10 w-auto" />
          </Link>
        </div>
        <a href="https://wms.premiumfulfilment.co.uk" target="_blank" rel="noopener noreferrer"
          className="font-mono text-[11px] sm:text-sm text-navy hover:text-gold underline underline-offset-4 decoration-navy/30 hover:decoration-gold transition-colors whitespace-nowrap flex-shrink-0">
          Premium WMS <span aria-hidden="true">↗</span>
        </a>
      </header>

      {/* Body: sidebar + main content */}
      <div className="flex-1 min-h-0 relative">

        {sidebarOpen && (
          <div className="fixed inset-x-0 bottom-0 top-16 bg-black/40 z-30 lg:hidden" onClick={closeSidebar} />
        )}

        <Sidebar />

        <main className="h-full lg:ml-60 flex flex-col min-w-0 overflow-x-hidden">
        {session.demo && <DemoBanner />}
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="calendar"    element={<Calendar />} />

          {/* Inventory */}
          <Route path="inventory/health-score"  element={<HealthScore />} />
          <Route path="inventory/snapshot"      element={<Snapshot />} />
          <Route path="inventory/aging"         element={<Aging />} />
          <Route path="inventory/velocity"      element={<Velocity />} />
          {/* Operations — warehouse users only */}
          <Route path="operations/returns-hub"  element={<WarehouseOnly><ReturnsHub /></WarehouseOnly>} />
          <Route path="operations/fulfillment"  element={<WarehouseOnly><Fulfillment /></WarehouseOnly>} />
          <Route path="operations/eod-despatch" element={<WarehouseOnly><EodDespatch /></WarehouseOnly>} />
          <Route path="operations/pick-list"    element={<WarehouseOnly><PickList /></WarehouseOnly>} />
          <Route path="operations/replen"       element={<WarehouseOnly><ReplenList /></WarehouseOnly>} />

          {/* Warehouse Hub — placeholders (warehouse only) */}
          <Route path="shipping-requests" element={<WarehouseOnly><Placeholder title="Shipping Requests" blurb="All shipping form requests from clients (collections, pallets, freight) will appear here to action." icon="🚢" /></WarehouseOnly>} />
          <Route path="extras-requests"   element={<WarehouseOnly><Placeholder title="Requests for Extras" blurb="Client requests for extras — SEO, assembly and one-offs — will appear here." icon="✨" /></WarehouseOnly>} />
          <Route path="todo"              element={<WarehouseOnly><Placeholder title="To Do Lists" blurb="Team to-do lists — a future home for warehouse tasks (eventually replacing Trello)." icon="✅" /></WarehouseOnly>} />

          {/* Financial */}
          <Route path="financial/profitability" element={<Profitability />} />

          {/* Analytics */}
          <Route path="analytics/best-sellers"  element={<BestSellers />} />
          <Route path="analytics/sales-trend"   element={<SalesTrend />} />

          {/* ── PF Client Hub routes ── */}
          {/* Stock Analytics */}
          <Route path="stock/reports"           element={<ReportsIndex />} />
          <Route path="stock/product-overview"  element={<ProductOverview />} />
          <Route path="stock/inventory-planner" element={<InventoryPlanner />} />
          <Route path="stock/excess"            element={<ExcessStock />} />

          {/* Returns */}
          <Route path="returns/book"            element={<BookReturn />} />
          <Route path="returns/history"         element={<ReturnHistory />} />

          {/* Shipping Calculator */}
          <Route path="shipping/international"  element={<Placeholder title="International Calculator" blurb="An international shipping rate calculator is on the way." icon="🌍" />} />
          <Route path="shipping/collection"     element={<Placeholder title="Stock Collection Request" blurb="Request a collection of your stock via a simple form." icon="🚚" />} />
          <Route path="shipping/pallets"        element={<Placeholder title="Pallets & Arctic Pricing" blurb="Request pricing for palletised freight and artic (articulated lorry) transport." icon="🚛" />} />
          <Route path="shipping/freight"        element={<Placeholder title="Freight Forwarding" blurb="Submit a freight forwarding request and we’ll come back to you with options." icon="🛫" />} />
          <Route path="shipping/history"        element={<Placeholder title="Shipping History" blurb="A record of your previous bespoke quotes and shipments will appear here." icon="🕘" />} />

          {/* Invoice Analysis */}
          <Route path="invoice/overview"        element={<Profitability />} />
          <Route path="invoice/storage"         element={<StorageCalculator />} />
          <Route path="invoice/bespoke"         element={<Placeholder title="Bespoke Calculations" blurb="Bespoke cost breakdowns — e.g. bundle and assembly costs — laid out clearly." icon="🧮" />} />

          {/* Website SEO + Help */}
          <Route path="seo"  element={<SeoPage />} />
          <Route path="help"        element={<HelpGuides />} />
          <Route path="help/:slug"  element={<HelpGuideView />} />

          {/* Redirect old flat URLs to new paths */}
          <Route path="reports/best-sellers"  element={<Navigate to="/app/analytics/best-sellers" replace />} />
          <Route path="reports/sales-trend"   element={<Navigate to="/app/analytics/sales-trend" replace />} />

          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
        </main>
      </div>
    </div>
  )
}

export default function AppShell() {
  return (
    <UIProvider>
      <AppShellLayout />
    </UIProvider>
  )
}
