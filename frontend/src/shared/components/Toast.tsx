// Sprint 5 §2.2 — top-right toast stack.
//
// Mount `<ToastContainer />` once at App root. Components fire via
// `toastSuccess(...)` / `toastError(...)` / store push (long-task with
// progress bar).
//
// Visual: DESIGN.md §5 component catalog calls for shadcn-style cards in
// the top-right corner with a 3s auto-dismiss progress bar. We keep the
// hand-rolled card (no shadcn `<Toast>` install) because the design system
// only uses 3 variants and the progress fill needs to sync with our
// zustand-driven `progress` field (a non-time-based fraction for long
// tasks).
//
// Motion: enter = slide-in from right + opacity, 220ms. Leave on dismiss
// is instant (CSS unmount) — the 3s TTL already cushions the user; a
// second fade-out delays clean-up without UX value.

import { useEffect, useState } from 'react'
import { Check, Info as InfoIcon, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useToastStore, type Toast as ToastModel } from '@shared/state/toast'

interface CardProps {
  toast: ToastModel
  onDismiss(): void
}

function VariantIcon({ variant }: { variant: ToastModel['variant'] }): React.ReactElement {
  switch (variant) {
    case 'success':
      return <Check size={14} strokeWidth={2} className="text-ok" />
    case 'error':
      return <X size={14} strokeWidth={2} className="text-fail" />
    default:
      return <InfoIcon size={14} strokeWidth={2} className="text-info" />
  }
}

function ToastCard({ toast, onDismiss }: CardProps): React.ReactElement {
  // Slide-in animation: start translated, then commit to 0 after first
  // paint. Using a CSS class hand-off rather than a library because the
  // motion is the same shape DESIGN.md §8 calls out (220ms standard).
  const [entered, setEntered] = useState(false)
  // Time-based progress for non-long-task toasts (TTL bar). For toasts
  // with a caller-supplied `progress` field, we render that fraction
  // instead.
  const [autoProgress, setAutoProgress] = useState(1)

  useEffect(() => {
    requestAnimationFrame(() => setEntered(true))
  }, [])

  useEffect(() => {
    if (toast.progress !== undefined) return // caller-driven; no time bar.
    const ttl = toast.ttlMs ?? 3000
    if (ttl <= 0) return
    // Capture the start timestamp inside the effect so the render body
    // stays pure (react-hooks/purity rejects Date.now() during render).
    const start = Date.now()
    let raf = 0
    const tick = (): void => {
      const elapsed = Date.now() - start
      setAutoProgress(Math.max(0, 1 - elapsed / ttl))
      if (elapsed < ttl) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return (): void => {
      cancelAnimationFrame(raf)
    }
  }, [toast.progress, toast.ttlMs])

  const progressFraction =
    toast.progress !== undefined ? Math.max(0, Math.min(1, toast.progress)) : autoProgress
  const isLongTask = toast.progress !== undefined

  return (
    <div
      role="status"
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'relative w-[320px] rounded-md border border-ink-border bg-ink-2 overflow-hidden',
        'shadow-[0_8px_24px_rgba(0,0,0,0.35)]',
        'transition-all duration-base ease-standard',
        entered ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="shrink-0 mt-0.5">
          <VariantIcon variant={toast.variant} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-aux text-ink-fg font-medium break-words">{toast.title}</div>
          {toast.detail && (
            <div className="text-meta font-mono text-ink-fg-2 mt-0.5 break-words">
              {toast.detail}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 p-1 -m-1 text-ink-fg-3 hover:text-ink-fg-1 transition-colors duration-fast"
          aria-label="Dismiss"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      {/* Progress bar — fill mirrors the TTL countdown OR the caller's
          fractional progress for long tasks. */}
      <div className="h-0.5 bg-ink-border-soft">
        <div
          className={cn(
            'h-full',
            toast.variant === 'success'
              ? 'bg-ok'
              : toast.variant === 'error'
                ? 'bg-fail'
                : 'bg-coral/80',
            isLongTask ? 'transition-[width] duration-base' : ''
          )}
          style={{ width: `${progressFraction * 100}%` }}
        />
      </div>
    </div>
  )
}

export function ToastContainer(): React.ReactElement | null {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)
  if (items.length === 0) return null
  return (
    <div
      aria-live="polite"
      className={cn(
        'fixed top-titlebar right-4 z-50 flex flex-col gap-2 pointer-events-none',
        // gap above the title bar's draggable region.
        'pt-2'
      )}
    >
      {items.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastCard toast={t} onDismiss={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  )
}
