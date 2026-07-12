import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Loader2, X } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'

import { Button, type ButtonProps } from '@shared/components/ui/button'
import { cn } from '@shared/lib/cn'
import { SPRING_PRESS, SPRING_SWAP } from '@shared/lib/motion-tokens'

export type StatefulButtonState = 'idle' | 'loading' | 'success' | 'error'

export interface StatefulButtonProps extends Omit<ButtonProps, 'children'> {
  state?: StatefulButtonState
  children: ReactNode
  loadingText?: ReactNode
  successText?: ReactNode
  errorText?: ReactNode
}

export const StatefulButton = forwardRef<HTMLButtonElement, StatefulButtonProps>(
  function StatefulButton(
    {
      state = 'idle',
      children,
      loadingText = children,
      successText = children,
      errorText = children,
      disabled,
      className,
      ...props
    },
    ref
  ) {
    const reduceMotion = useReducedMotion()
    const isLoading = state === 'loading'
    const content =
      state === 'loading'
        ? loadingText
        : state === 'success'
          ? successText
          : state === 'error'
            ? errorText
            : children

    return (
      <Button
        ref={ref}
        asChild
        disabled={disabled || isLoading}
        aria-busy={isLoading}
        className={cn(
          'h-auto min-h-8 px-[18px] py-2 text-[13.5px]',
          state === 'error' && 'bg-fail text-accent-fg hover:opacity-90',
          className
        )}
        {...props}
      >
        <motion.button
          whileTap={reduceMotion || disabled || isLoading ? undefined : { scale: 0.98 }}
          transition={reduceMotion ? { duration: 0 } : SPRING_PRESS}
        >
          <span
            aria-live="polite"
            className="relative inline-flex items-center justify-center gap-2"
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={state}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={reduceMotion ? { duration: 0 } : SPRING_SWAP}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap"
              >
                {state === 'loading' && (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {state === 'success' && <Check className="h-4 w-4" />}
                {state === 'error' && <X className="h-4 w-4" />}
                <span>{content}</span>
              </motion.span>
            </AnimatePresence>
          </span>
        </motion.button>
      </Button>
    )
  }
)

StatefulButton.displayName = 'StatefulButton'
