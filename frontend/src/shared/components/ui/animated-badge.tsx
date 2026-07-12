import { AlertTriangle, Check, Circle, Clock3, LoaderCircle, X, type LucideIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '@shared/lib/cn'
import { SPRING_SWAP } from '@shared/lib/motion-tokens'

export type AnimatedBadgeStatus =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'loading'

export interface AnimatedBadgeProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  status?: AnimatedBadgeStatus
  children: ReactNode
  pulse?: boolean
  contentKey?: string | number
}

const STATUS_CLASS: Record<AnimatedBadgeStatus, string> = {
  neutral: 'border-ink-border bg-ink-fg/5 text-ink-fg-3',
  info: 'border-ai/30 bg-ai/10 text-ai',
  success: 'border-ok/25 bg-ok/10 text-ok',
  warning: 'border-warn/30 bg-warn/10 text-warn',
  danger: 'border-fail/25 bg-fail/10 text-fail',
  loading: 'border-ai/30 bg-ai/10 text-ai'
}

const ICONS: Record<AnimatedBadgeStatus, LucideIcon> = {
  neutral: Circle,
  info: Clock3,
  success: Check,
  warning: AlertTriangle,
  danger: X,
  loading: LoaderCircle
}

export function AnimatedBadge({
  status = 'neutral',
  children,
  pulse = false,
  contentKey,
  className,
  ...props
}: AnimatedBadgeProps): React.ReactElement {
  const reduceMotion = useReducedMotion()
  const Icon = ICONS[status]
  const key = contentKey ?? status

  return (
    <span
      {...props}
      className={cn(
        'relative inline-flex h-5 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-[5px] border px-2 text-[11px] font-medium leading-none',
        STATUS_CLASS[status],
        className
      )}
    >
      {pulse && !reduceMotion ? (
        <span
          aria-hidden
          className="absolute inset-0 animate-pulse bg-current opacity-10 motion-reduce:animate-none"
        />
      ) : null}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={`icon-${key}`}
          aria-hidden
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 5, scale: 0.8 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.8 }}
          transition={reduceMotion ? { duration: 0 } : SPRING_SWAP}
          className="relative z-10 inline-flex"
        >
          <Icon className={cn('size-3', status === 'loading' && 'animate-spin motion-reduce:animate-none')} />
        </motion.span>
      </AnimatePresence>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={`text-${key}`}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5 }}
          transition={reduceMotion ? { duration: 0 } : SPRING_SWAP}
          className="relative z-10"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
