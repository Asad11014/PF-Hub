// Central navigation definition — shared by Sidebar and AppShell routing.

// Top-level standalone links (appear above the collapsible sections)
export const TOP_LINKS = [
  { to: '/app',            label: 'Dashboard',  icon: '⬛', exact: true },
  { to: '/app/calendar',   label: 'Calendar',   icon: '📅' },
];

// Report sub-categories within the single "Reports" section.
// Each group has a label, optional warehouseOnly flag, and items.
export const REPORT_GROUPS = [
  {
    id: 'inventory',
    label: 'Inventory',
    items: [
      { to: '/app/inventory/health-score',  label: 'Health Score',      icon: '❤️',  badge: 'new'  },
      { to: '/app/inventory/snapshot',      label: 'Live Snapshot',     icon: '📷',  badge: 'new'  },
      { to: '/app/inventory/aging',         label: 'Aging Report',      icon: '⏳',  badge: 'new'  },
      { to: '/app/inventory/velocity',      label: 'SKU Velocity',      icon: '⚡',  badge: 'new'  },
    ]
  },
  {
    id: 'operations',
    label: 'Operations',
    warehouseOnly: true,
    items: [
      { to: '/app/operations/returns-hub',  label: 'Returns Hub',      icon: '↩️', badge: 'new'  },
      { to: '/app/operations/fulfillment',  label: 'Fulfillment',      icon: '📤', badge: 'new'  },
      { to: '/app/operations/eod-despatch', label: 'End-of-Day Despatch', icon: '🚚', badge: 'new'  },
      { to: '/app/operations/pick-list',    label: 'Pick List',        icon: '📝', badge: 'new', hideInDemo: true },
      { to: '/app/operations/replen',       label: 'Replen List',      icon: '🔁', badge: 'new', hideInDemo: true },
    ]
  },
  {
    id: 'financial',
    label: 'Financial',
    items: [
      { to: '/app/financial/profitability', label: 'Revenue Breakdown', clientLabel: 'Cost Breakdown', icon: '💹', badge: 'new'  },
    ]
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { to: '/app/analytics/best-sellers', label: 'Best Sellers', icon: '🏆' },
      { to: '/app/analytics/sales-trend',  label: 'Sales Trend',  icon: '📊' },
    ]
  },
];

// ── Client Hub navigation (PF Client Hub spec) ────────────────────────────────
// Items with `module` belong to a paid add-on (server/entitlements.js). Clients
// without it still see the item, with a lock, and the route shows the add-on page.
// Seven headings shown to CLIENT users only. Mix of flat links and collapsible
// groups. Items map to existing pages where available, otherwise to a placeholder.
// Report sub-categories clients can see — everything from REPORT_GROUPS except
// the warehouse-only Operations reports. Used by the Reports index page.
export const CLIENT_REPORT_GROUPS = REPORT_GROUPS.filter(g => !g.warehouseOnly);

export const CLIENT_NAV = [
  { type: 'link', to: '/app', label: 'Dashboard', icon: '⬛', exact: true },
  {
    type: 'group', id: 'stock', label: 'Stock Analytics', icon: '📈',
    items: [
      { to: '/app/stock/reports',           label: 'Reports',          icon: '📊' },
      { to: '/app/stock/product-overview',  label: 'Product Overview', icon: '📋' },
      { to: '/app/stock/inventory-planner', label: 'Inventory Planner', icon: '📦', module: 'forecasting' },
      { to: '/app/stock/excess',            label: 'Excess Stock',      icon: '🗄️' },
      { to: '/app/stock/bbe',               label: 'BBE Report',        icon: '⏰', module: 'bbe' },
      { to: '/app/stock/quarantine',        label: 'Quarantine Report', icon: '🚫', module: 'quarantine' },
    ],
  },
  {
    type: 'group', id: 'returns', label: 'Returns', icon: '↩️',
    items: [
      { to: '/app/returns/book',       label: 'Book a Return',        icon: '📝' },
      { to: '/app/returns/history',    label: 'Return History',       icon: '📋' },
    ],
  },
  {
    type: 'group', id: 'shipping', label: 'Shipping Calculator', icon: '🚢',
    items: [
      { to: '/app/shipping/international', label: 'International Calculator',  icon: '🌍' },
      { to: '/app/shipping/collection',   label: 'Stock Collection Request',  icon: '🚚' },
      { to: '/app/shipping/pallets',      label: 'Pallets & Arctic Pricing',  icon: '🚛' },
      { to: '/app/shipping/freight',      label: 'Freight Forwarding',        icon: '🛫' },
      { to: '/app/shipping/history',      label: 'Shipping History',          icon: '🕘' },
    ],
  },
  {
    type: 'group', id: 'invoice', label: 'Invoice Analysis', icon: '💷',
    items: [
      { to: '/app/invoice/overview', label: 'Overview',             icon: '📑' },
      { to: '/app/invoice/storage',  label: 'Storage Calculator',   icon: '📐' },
      { to: '/app/invoice/bespoke',  label: 'Bespoke Calculations', icon: '🧮' },
    ],
  },
  { type: 'link', to: '/app/seo',  label: 'Website SEO', icon: '🖥️' },
  { type: 'link', to: '/app/help', label: 'Help Guides', icon: '❓' },
];

// ── PF Warehouse Hub navigation (warehouse users) ─────────────────────────────
// Tools  = operational action tools; Figures = analytical / numbers reports.
export const WAREHOUSE_NAV = [
  { type: 'link', to: '/app', label: 'Dashboard', icon: '⬛', exact: true },
  {
    type: 'group', id: 'tools', label: 'Tools', icon: '🛠️',
    items: [
      { to: '/app/operations/fulfillment',  label: 'Fulfillment',         icon: '📤' },
      { to: '/app/operations/eod-despatch', label: 'End-of-Day Despatch', icon: '🚚' },
      { to: '/app/operations/pick-list',    label: 'Pick List',           icon: '📝' },
      { to: '/app/operations/replen',       label: 'Replen List',         icon: '🔁' },
    ],
  },
  {
    type: 'group', id: 'figures', label: 'Figures', icon: '📈',
    items: [
      { to: '/app/stock/inventory-planner', label: 'Inventory Planner',  icon: '📦' },
      { to: '/app/inventory/health-score',  label: 'Health Score',      icon: '❤️' },
      { to: '/app/inventory/snapshot',      label: 'Live Snapshot',     icon: '📷' },
      { to: '/app/inventory/aging',         label: 'Aging Report',      icon: '⏳' },
      { to: '/app/inventory/velocity',      label: 'SKU Velocity',      icon: '⚡' },
      { to: '/app/financial/profitability', label: 'Revenue Breakdown', icon: '💹' },
      { to: '/app/analytics/best-sellers',  label: 'Best Sellers',      icon: '🏆' },
      { to: '/app/analytics/sales-trend',   label: 'Sales Trend',       icon: '📊' },
    ],
  },
  { type: 'link', to: '/app/operations/returns-hub', label: 'Returns Portal',      icon: '↩️' },
  { type: 'link', to: '/app/shipping-requests',      label: 'Shipping Requests',   icon: '🚢' },
  { type: 'link', to: '/app/extras-requests',        label: 'Requests for Extras', icon: '✨' },
  { type: 'link', to: '/app/calendar',               label: 'Warehouse Calendar',  icon: '📅' },
  { type: 'link', to: '/app/todo',                   label: 'To Do Lists',         icon: '✅' },
  { type: 'link', to: '/app/admin/subscriptions',    label: 'Client Subscriptions', icon: '🔑' },
  { type: 'link', to: '/app/help',                   label: 'Help Guides',         icon: '❓' },
];

// Flat list of all report items — useful for route matching
export const ALL_REPORT_ITEMS = REPORT_GROUPS.flatMap(g => g.items);

// Legacy export so any code still importing NAV_SECTIONS doesn't break
export const NAV_SECTIONS = REPORT_GROUPS.map(g => ({ ...g, icon: '' }));
export const ALL_NAV_ITEMS = ALL_REPORT_ITEMS;
