import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { forwardRef, useEffect, useRef, type InputHTMLAttributes } from 'react'

import { cn } from '@shared/lib/cn'
import { EASE_OUT, SPRING_PRESS } from '@shared/lib/motion-tokens'

const CHECK_PATH = 'M5 13l4 4L19 7'
const INDETERMINATE_PATH = 'M6 12h12'

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  indeterminate?: boolean
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onCheckedChange, indeterminate = false, disabled, className, ...props },
  forwardedRef
) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const reduceMotion = useReducedMotion()
  const showMark = checked || indeterminate

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <motion.span
      whileTap={reduceMotion || disabled ? undefined : { scale: 0.9 }}
      transition={reduceMotion ? { duration: 0 } : SPRING_PRESS}
      className={cn('relative inline-flex size-4 shrink-0', className)}
    >
      <input
        {...props}
        ref={(node) => {
          inputRef.current = node
          if (typeof forwardedRef === 'function') forwardedRef(node)
          else if (forwardedRef) forwardedRef.current = node
        }}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={cn(
          'inline-flex size-4 items-center justify-center rounded-[4px] border transition-colors duration-fast',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-coral/50 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background',
          'peer-disabled:opacity-50',
          showMark
            ? 'border-coral bg-coral/100 text-accent-fg'
            : 'border-ink-border bg-ink-2 text-transparent peer-hover:border-coral/70'
        )}
      >
        <AnimatePresence initial={false}>
          {showMark ? (
            <motion.svg
              key={indeterminate ? 'indeterminate' : 'checked'}
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
            >
              <motion.path
                d={indeterminate ? INDETERMINATE_PATH : CHECK_PATH}
                initial={reduceMotion ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { duration: indeterminate ? 0.2 : 0.3, ease: EASE_OUT, delay: 0.04 }
                }
              />
            </motion.svg>
          ) : null}
        </AnimatePresence>
      </span>
    </motion.span>
  )
})

Checkbox.displayName = 'Checkbox'
