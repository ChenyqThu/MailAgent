// Sprint 18 — shadcn Button primitive.
//
// Variants are tokenised — `default` rides on `bg-coral / text-accent-fg` so a
// single `--c-accent` swap (DESIGN.md §2.7) re-skins every CTA. `secondary`
// uses the ink ramp for non-destructive actions (e.g. "稍后" in RestartBanner
// confirm dialog). `destructive` reaches for `bg-fail` only when a user click
// would erase irreversible state (Sprint 19 — not used in Sprint 18 yet).

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@shared/lib/cn'

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'rounded-md text-aux font-medium',
    'transition-colors duration-fast ease-standard',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0'
  ),
  {
    variants: {
      variant: {
        default: 'bg-coral/100 text-accent-fg hover:bg-coral-hover',
        secondary: 'bg-ink-3 text-ink-fg border border-ink-border-soft hover:bg-ink-4',
        ghost: 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg',
        outline: 'border border-ink-border bg-transparent text-ink-fg hover:bg-ink-3',
        destructive: 'bg-fail text-accent-fg hover:opacity-90',
        link: 'text-coral underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2.5 text-meta',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    )
  }
)
Button.displayName = 'Button'

// `buttonVariants` is intentionally NOT re-exported here — keeping a single
// component export per file is what react-refresh/only-export-components
// requires. Callers that need the cva config (e.g. to share a CTA style with
// a non-button `<a>`) should import `Button` with `asChild` + Slot pattern.
