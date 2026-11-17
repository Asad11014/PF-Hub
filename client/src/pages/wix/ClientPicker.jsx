// Picks which Wix client a tab works on. Hidden when there's only one.
import { useWix } from './WixIntegration'

export default function ClientPicker() {
  const { state, client, setClient } = useWix()
  if (!state || state.clients.length <= 1) return null
  return (
    <label className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
      Client
      <select value={client || ''} onChange={e => setClient(e.target.value)}
        className="bg-brand-bg border border-brand-border rounded px-2 py-1.5 font-sans text-sm text-ink focus:outline-none focus:border-primary">
        {state.clients.map(c => <option key={c.slug} value={c.slug}>{c.name} ({c.slug})</option>)}
      </select>
    </label>
  )
}
