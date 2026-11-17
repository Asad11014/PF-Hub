// Small building blocks for the Wix Integration pages, in the Hub's own styles.
import { forwardRef, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ago, fmtWhen } from './wixApi'

export function Panel({ title, actions, children, className }) {
  return (
    <section className={clsx('bg-brand-surface border border-brand-border rounded-lg', className)}>
      <header className="flex flex-wrap items-center gap-3 px-5 py-3.5 border-b border-brand-border">
        <h2 className="font-sans font-bold text-sm text-ink">{title}</h2>
        <div className="flex-1" />
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

const BTN = {
  default: 'border border-brand-border bg-brand-surface text-ink hover:border-primary hover:text-primary',
  primary: 'border border-primary bg-primary text-white hover:bg-primary-hover',
  write:   'border border-success bg-success text-white hover:bg-[#12843c]',
  pause:   'border border-warning/60 bg-warning/10 text-[#8a6620] hover:bg-warning/20',
  danger:  'border border-danger/40 text-danger hover:bg-danger hover:text-white',
}

export const Btn = forwardRef(function Btn({ kind = 'default', small, busy, disabled, children, className, ...p }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...p}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'inline-flex items-center gap-2 font-sans font-bold rounded transition-colors whitespace-nowrap',
        'disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        small ? 'text-xs px-3 py-1.5' : 'text-sm px-4 py-2',
        BTN[kind], className,
      )}
    >
      {busy && <span className="inline-block w-3 h-3 border-2 border-current border-r-transparent rounded-full animate-spin" />}
      {children}
    </button>
  )
})

// Andon-style status: go (running), hold (paused / waiting), stop (a person is needed), off.
const DOT = { go: 'bg-success', hold: 'bg-warning', stop: 'bg-danger', off: 'bg-ink-dim' }
const TXT = { go: 'text-success', hold: 'text-[#8a6620]', stop: 'text-danger', off: 'text-ink-muted' }

export function Lamp({ state = 'off', size = 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-block rounded-full flex-shrink-0 ring-2 ring-white shadow-[0_1px_3px_rgba(26,28,46,0.25)] transition-colors duration-200',
        size === 'sm' ? 'w-2 h-2 ring-0 shadow-none' : 'w-3.5 h-3.5',
        DOT[state],
      )}
    />
  )
}

export function StatusText({ state, children }) {
  return <span className={clsx('font-mono text-[11px]', TXT[state])}>{children}</span>
}

/** A status chip: lamp dot + word, so meaning never relies on colour alone. */
export function Chip({ state = 'off', children }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 font-mono text-[11px] font-medium whitespace-nowrap', TXT[state])}>
      <Lamp state={state} size="sm" />{children}
    </span>
  )
}

export function Table({ cols, rows, empty }) {
  if (!rows.length) {
    return (
      <div className="py-4">
        <div className="font-sans font-bold text-sm text-ink">{empty[0]}</div>
        {empty[1] && <div className="font-sans text-sm text-ink-muted mt-0.5">{empty[1]}</div>}
      </div>
    )
  }
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} scope="col" className={clsx('py-2 px-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted font-medium bg-brand-surface2 border-b border-brand-border whitespace-nowrap', c.num && 'text-right')}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}

export const Td = ({ num, mono, className, children, ...p }) => (
  <td {...p} className={clsx('py-2.5 px-3 border-b border-brand-border/60 align-top', num && 'text-right tabular-nums', mono && 'font-mono text-[12px]', className)}>{children}</td>
)

export const When = ({ at }) => <time title={fmtWhen(at)} className="whitespace-nowrap">{ago(at)}</time>

export function Note({ type, children }) {
  return (
    <div className={clsx('flex items-start gap-2 px-4 py-2.5 rounded-lg border font-mono text-xs',
      type === 'error' && 'border-danger/40 bg-danger/5 text-danger',
      type === 'success' && 'border-success/30 bg-success/5 text-success',
      type === 'warning' && 'border-warning/40 bg-warning/10 text-[#8a6620]',
      !type && 'border-brand-border bg-brand-surface2 text-ink-muted',
    )}>{children}</div>
  )
}

export function Skeleton({ rows = 3 }) {
  return (
    <div className="space-y-2.5 py-1" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="h-4 rounded bg-brand-surface2 animate-pulse" style={{ width: `${92 - i * 9}%` }} />)}
    </div>
  )
}

/**
 * Confirmation for actions that write. Returns [confirm(opts) → Promise<boolean>, node].
 * opts: { title, body: ReactNode, ok: label, kind: 'write' | 'pause' | 'primary' }
 */
export function useConfirm() {
  const [req, setReq] = useState(null)
  const confirm = opts => new Promise(resolve => setReq({ ...opts, resolve }))
  const close = ok => { req?.resolve(ok); setReq(null) }
  const node = req ? <ConfirmModal {...req} onClose={close} /> : null
  return [confirm, node]
}

function ConfirmModal({ title, body, ok, kind = 'write', onClose }) {
  const cancelRef = useRef(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = e => { if (e.key === 'Escape') onClose(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[60] bg-ink/40 flex items-center justify-center p-4" onClick={() => onClose(false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="wix-confirm-title" onClick={e => e.stopPropagation()}
        className="bg-brand-surface rounded-lg shadow-modal border border-brand-border w-full max-w-lg">
        <div className="px-6 pt-5">
          <h2 id="wix-confirm-title" className="font-sans font-bold text-base text-ink">{title}</h2>
        </div>
        <div className="px-6 py-3 font-sans text-sm text-ink space-y-2">{body}</div>
        <div className="flex justify-end gap-2 px-6 pb-5 pt-2">
          <Btn ref={cancelRef} onClick={() => onClose(false)}>Cancel</Btn>
          <Btn kind={kind} onClick={() => onClose(true)}>{ok}</Btn>
        </div>
      </div>
    </div>
  )
}

/** Runs an async action with a busy flag and reports errors. */
export function useAction(onError) {
  const [busy, setBusy] = useState(null)
  const run = async (key, fn) => {
    setBusy(key)
    try { return await fn() }
    catch (e) { onError?.(e.message || String(e)); return undefined }
    finally { setBusy(null) }
  }
  return [busy, run]
}
