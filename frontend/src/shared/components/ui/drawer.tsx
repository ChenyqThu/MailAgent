import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'

import { cn } from '@shared/lib/cn'
import { EASE_OUT, SPRING_PANEL } from '@shared/lib/motion-tokens'

export interface DrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: 'left' | 'right'
  children: ReactNode
  className?: string
  backdropClassName?: string
  ariaLabel?: string
  dismissable?: boolean
  width?: number
}

export function Drawer({
  open,
  onOpenChange,
  side = 'right',
  children,
  className,
  backdropClassName,
  ariaLabel,
  dismissable = true,
  width = 480
}: DrawerProps): React.ReactElement {
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    const previousOverflow = document.body.style.overflow

    window.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onOpenChange])

  const offscreen = side === 'right' ? '100%' : '-100%'

  return (
    <AnimatePresence>
      {open ? (
        <div className="absolute inset-0" data-ui-drawer="">
          <motion.button
            type="button"
            aria-label="Close"
            tabIndex={dismissable ? 0 : -1}
            onClick={() => dismissable && onOpenChange(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className={cn(
              'absolute inset-0 z-[60] h-full w-full cursor-default bg-black/40',
              backdropClassName
            )}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            onClick={(event) => event.stopPropagation()}
            initial={reduceMotion ? { opacity: 0 } : { x: offscreen }}
            animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: offscreen }}
            transition={reduceMotion ? { duration: 0.2, ease: EASE_OUT } : SPRING_PANEL}
            className={cn(
              'absolute inset-y-0 z-[61] flex max-w-[92%] flex-col',
              side === 'right' ? 'right-0' : 'left-0 border-r border-[var(--hairline-strong)]',
              className
            )}
            style={{
              width,
              background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
              borderLeft: side === 'right' ? '1px solid var(--hairline-strong)' : undefined,
              boxShadow: 'var(--shadow-raised)'
            }}
          >
            {children}
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>
  )
}
