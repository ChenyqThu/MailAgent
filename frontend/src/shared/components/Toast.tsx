// Top-right toast stack. The zustand store remains the single source of truth;
// this file owns rendering, progress visuals, actions and motion only.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Info as InfoIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@shared/lib/cn'
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from '@shared/lib/motion-tokens'
import { useToastStore, type Toast as ToastModel } from '@shared/state/toast'

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

function ToastCard({
  toast,
  onDismiss
}: {
  toast: ToastModel
  onDismiss(): void
}): React.ReactElement {
  const actionFiredRef = useRef(false)
  const reduceMotion = useReducedMotion()
  const [autoProgress, setAutoProgress] = useState(1)

  useEffect(() => {
    if (toast.progress !== undefined) return
    const ttl = toast.ttlMs ?? 3000
    if (ttl <= 0) return

    const start = Date.now()
    let frame = 0
    const tick = (): void => {
      const elapsed = Date.now() - start
      setAutoProgress(Math.max(0, 1 - elapsed / ttl))
      if (elapsed < ttl) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [toast.progress, toast.ttlMs])

  const progressFraction =
    toast.progress === undefined ? autoProgress : Math.max(0, Math.min(1, toast.progress))
  const isCallerProgress = toast.progress !== undefined

  return (
    <div
      role="status"
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'relative w-[320px] overflow-hidden rounded-md border border-ink-border bg-ink-2',
        'shadow-[var(--shadow-raised)]'
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={toast.variant}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.8 }}
              transition={reduceMotion ? { duration: 0 } : SPRING_SWAP}
              className="inline-flex"
            >
              <VariantIcon variant={toast.variant} />
            </motion.span>
          </AnimatePresence>
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-aux font-medium text-ink-fg">{toast.title}</div>
          {toast.detail && (
            <div className="mt-0.5 break-words font-mono text-meta text-ink-fg-2">
              {toast.detail}
            </div>
          )}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                if (actionFiredRef.current) return
                actionFiredRef.current = true
                toast.action?.onClick()
                onDismiss()
              }}
              className="mt-1.5 text-meta font-medium text-coral transition-colors duration-fast hover:text-coral/80"
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 shrink-0 p-1 text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-1"
          aria-label="Dismiss"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="h-0.5 bg-ink-border-soft">
        <div
          className={cn(
            'h-full',
            toast.variant === 'success'
              ? 'bg-ok'
              : toast.variant === 'error'
                ? 'bg-fail'
                : 'bg-coral/80',
            isCallerProgress && 'transition-[width] duration-base'
          )}
          style={{ width: `${progressFraction * 100}%` }}
        />
      </div>
    </div>
  )
}

export function ToastContainer(): React.ReactElement | null {
  const items = useToastStore((state) => state.items)
  const dismiss = useToastStore((state) => state.dismiss)
  const reduceMotion = useReducedMotion()
  const [expanded, setExpanded] = useState(false)
  const ordered = [...items].reverse()

  if (items.length === 0) return null

  return (
    <ol
      aria-live="polite"
      aria-atomic="false"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className="pointer-events-none fixed right-4 top-titlebar z-50 flex flex-col pt-2"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {ordered.map((toast, index) => {
          const depth = Math.min(index, 3)
          const stackCollapsed = !expanded && !reduceMotion
          return (
            <motion.li
              key={toast.id}
              layout={!reduceMotion}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
              animate={{
                opacity: 1,
                x: 0,
                y: stackCollapsed ? depth * 6 : 0,
                scale: stackCollapsed ? 1 - depth * 0.035 : 1,
                marginTop: index === 0 ? 0 : stackCollapsed ? -44 : 8
              }}
              exit={
                reduceMotion
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { opacity: 0, x: 24, scale: 0.96, transition: { duration: 0.16, ease: EASE_OUT } }
              }
              transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
              className="pointer-events-auto relative origin-top-right will-change-transform"
              style={{ zIndex: ordered.length - index }}
            >
              <ToastCard toast={toast} onDismiss={() => dismiss(toast.id)} />
            </motion.li>
          )
        })}
      </AnimatePresence>
    </ol>
  )
}
