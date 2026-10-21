// Subscription-module gating for routes. The server enforces access
// (server/entitlements.js); these components only decide what the user sees.
import { useNavigate } from 'react-router-dom'
import { useSession } from '../context/SessionContext'
import pfLogo from '../assets/pf-hub-logo.png'

export const fmtPrice = (pence, currency = 'GBP') => pence == null
  ? 'Price to be confirmed'
  : `${new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pence / 100)} / month`

function moduleInfo(session, key) {
  return (session?.moduleCatalog || []).find(m => m.key === key) || { key, name: 'This feature' }
}

// The page shown in place of a feature the client's account does not include.
export function LockedModule({ module, title }) {
  const { session } = useSession()
  const m = moduleInfo(session, module)
  return (
    <div className="flex-1 overflow-y-auto">
      <header className="bg-brand-surface border-b border-brand-border px-4 sm:px-7 min-h-[52px] flex items-center sticky top-0 z-40">
        <div className="font-sans font-bold text-[15px] text-ink">{title || m.name}</div>
      </header>
      <div className="p-4 sm:p-7">
        <div className="bg-brand-surface border border-brand-border rounded-lg p-10 flex flex-col items-center text-center max-w-2xl mx-auto">
          <div className="text-4xl mb-4" aria-hidden="true">🔒</div>
          <div className="font-sans font-bold text-lg text-ink mb-2">{m.name} is an add-on</div>
          {m.description && <p className="font-sans text-sm text-ink-muted max-w-md leading-relaxed mb-4">{m.description}</p>}
          <div className="font-mono text-sm text-navy font-semibold mb-5">{fmtPrice(m.monthly_price_pence, m.currency)}</div>
          <p className="font-mono text-xs text-ink-muted max-w-md leading-relaxed">
            It isn’t active on your account yet. Contact your account manager at Premium Fulfilment to add it.
          </p>
        </div>
      </div>
    </div>
  )
}

// Wrap a route: renders children when the session has the module, otherwise the add-on page.
export function RequireModule({ module, title, children }) {
  const { hasModule } = useSession()
  return hasModule(module) ? children : <LockedModule module={module} title={title} />
}

// Whole-screen notice for a client account without Basic access.
export function SubscriptionRequired() {
  const { setSession } = useSession()
  const navigate = useNavigate()
  async function signOut() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {})
    setSession(null)
    navigate('/', { replace: true })
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-bg p-4">
      <div className="bg-brand-surface border border-brand-border rounded-xl shadow-modal w-full max-w-[460px] p-10 text-center">
        <img src={pfLogo} alt="Premium Fulfilment Hub" className="h-10 w-auto mx-auto mb-6" />
        <div className="font-sans font-bold text-lg text-ink mb-2">Subscription required</div>
        <p className="font-sans text-sm text-ink-muted leading-relaxed mb-6">
          Your account doesn’t have an active Premium Fulfilment Hub subscription at the moment.
          Please contact your account manager at Premium Fulfilment to restore access.
        </p>
        <button onClick={signOut}
          className="font-mono text-xs border border-brand-border rounded px-4 py-2 text-ink hover:border-primary hover:text-primary transition-colors">
          Sign out
        </button>
      </div>
    </div>
  )
}
