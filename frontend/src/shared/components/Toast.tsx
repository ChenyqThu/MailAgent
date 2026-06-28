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
// Motion (DESIGN.md §8): enter = slide-in from right + autoAlpha, DUR.base.
// Leave = slide-out to the right + autoAlpha, DUR.fast. Both via GSAP through
// `@shared/lib/gsap` (one-curve standard, three-tier durations).
//
// AnimatePresence-lite: the store remove (TTL setTimeout / manual X / demote
// over-cap) is treated as a *signal*, not the unmount. `ToastContainer` keeps
// its own render list that is a superset of the store `items` — it retains a
// toast whose id has just left `items`, marks it `exiting`, and only drops it
// from the render list once the slide-out tween completes. This routes all
// three removal paths through the same exit animation without touching the
// store model (the store stays a plain serializable queue).

import { useEffect, useRef, useState } from 'react'
import { Check, Info as InfoIcon, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useToastStore, type Toast as ToastModel } from '@shared/state/toast'

interface CardProps {
  toast: ToastModel
  /** True once this toast has left the store queue — play slide-out. */
  exiting: boolean
  /** Called after the exit tween completes (or immediately in reduced-motion)
   *  so the container can drop this id from its render list. */
  onExited(): void
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

function ToastCard({ toast, exiting, onExited, onDismiss }: CardProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  // M1d — one-shot latch: the card stays clickable through the 120ms slide-out, so a
  // double-click would fire the action twice — a 2nd undo on an already-deleted memory id
  // could surface a spurious「撤销失败」. Latch on first click so it runs at most once.
  const actionFiredRef = useRef(false)
  const reduce = useReducedMotion()
  // Time-based progress for non-long-task toasts (TTL bar). For toasts
  // with a caller-supplied `progress` field, we render that fraction
  // instead.
  const [autoProgress, setAutoProgress] = useState(1)

  // Enter = slide-in from right + autoAlpha (DUR.base). Exit = slide-out to
  // the right + autoAlpha (DUR.fast), then call onExited so the container
  // unmounts. reduced-motion short-circuits both (no tween). Scope binds the
  // tween to this card; useGSAP auto-reverts on unmount.
  useGSAP(
    () => {
      const el = rootRef.current
      if (!el) return
      if (exiting) {
        if (reduce) {
          onExited()
          return
        }
        gsap.to(el, { autoAlpha: 0, x: 16, duration: DUR.fast, onComplete: onExited })
      } else {
        if (reduce) {
          gsap.set(el, { clearProps: 'opacity,visibility,transform' })
          return
        }
        gsap.from(el, { autoAlpha: 0, x: 16, duration: DUR.base, clearProps: 'transform' })
      }
    },
    { dependencies: [exiting, reduce], scope: rootRef }
  )

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
      ref={rootRef}
      role="status"
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'relative w-[320px] rounded-md border border-ink-border bg-ink-2 overflow-hidden',
        'shadow-[0_8px_24px_rgba(0,0,0,0.35)]'
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
          {/* M1d — optional inline action (e.g. mem0 auto-capture 「撤销」). Run the
              action then dismiss the toast. Absent for every existing caller → not
              rendered (zero visual change to current toasts). */}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                if (actionFiredRef.current) return
                actionFiredRef.current = true
                toast.action!.onClick()
                onDismiss()
              }}
              className="mt-1.5 text-meta font-medium text-coral hover:text-coral/80 transition-colors duration-fast"
            >
              {toast.action.label}
            </button>
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

/** One entry in the container's render list — a cached snapshot of the toast
 *  plus whether it's currently playing its slide-out. `exiting` toasts have
 *  already left the store queue; we keep rendering them off the cached
 *  `toast` until the exit tween completes. */
interface RenderEntry {
  toast: ToastModel
  exiting: boolean
}

export function ToastContainer(): React.ReactElement | null {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)

  // Render list = superset of store items. Live toasts mirror the store;
  // toasts whose id has left the store are retained with `exiting: true`
  // until their slide-out finishes (then dropped via `onExited`). All three
  // removal paths (TTL / manual X / demote) funnel through items.filter, so
  // diffing prev-frame items against the store catches every departure.
  const [rendered, setRendered] = useState<RenderEntry[]>(() =>
    items.map((t) => ({ toast: t, exiting: false }))
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Toast 离场 reconciliation：每帧 diff prev-frame items vs store，把离场项标 exiting 保留到 slide-out 完成。离场动画状态机本质需 effect+state（非纯 derived）。React Compiler 迁移债。
    setRendered((prev) => {
      // Refresh live entries (progress / detail updates) and detect those
      // that left the store this frame → mark exiting (keep cached toast so
      // the card content stays stable through the slide-out).
      const next: RenderEntry[] = prev.map((e) => {
        const live = items.find((t) => t.id === e.toast.id)
        if (live) return { toast: live, exiting: false }
        return { ...e, exiting: true }
      })
      // Append toasts new this frame (not already in the render list).
      const knownIds = new Set(prev.map((e) => e.toast.id))
      for (const t of items) {
        if (!knownIds.has(t.id)) next.push({ toast: t, exiting: false })
      }
      // No structural change → skip the state churn (also avoids re-marking).
      const sameLength = next.length === prev.length
      const sameShape =
        sameLength &&
        next.every((e, i) => e.toast === prev[i].toast && e.exiting === prev[i].exiting)
      if (sameShape) return prev
      return next
    })
  }, [items])

  const dropEntry = (id: number): void =>
    setRendered((prev) => prev.filter((e) => e.toast.id !== id))

  if (rendered.length === 0) return null
  return (
    <div
      aria-live="polite"
      className={cn(
        'fixed top-titlebar right-4 z-50 flex flex-col gap-2 pointer-events-none',
        // gap above the title bar's draggable region.
        'pt-2'
      )}
    >
      {rendered.map((e) => (
        <div key={e.toast.id} className="pointer-events-auto">
          <ToastCard
            toast={e.toast}
            exiting={e.exiting}
            onExited={() => dropEntry(e.toast.id)}
            onDismiss={() => dismiss(e.toast.id)}
          />
        </div>
      ))}
    </div>
  )
}
