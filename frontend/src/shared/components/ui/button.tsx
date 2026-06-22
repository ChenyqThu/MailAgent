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
    // §9.3 press feedback needs `transform` in the transition list — a bare
    // `transition-colors` would hard-jump the active:scale (#14: name exact
    // properties, never transition-all).
    'transition-[color,background-color,border-color,transform] duration-fast ease-standard',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0'
  ),
  {
    variants: {
      // §9.3 Active/pressed: coral CTAs get `active:scale-[0.98]`, ghost gets
      // `active:bg-ink-4` (one tier deeper than hover), never an opacity dip.
      // Disabled coral swaps to `coral-dim` (§9.4) so it reads as "the disabled
      // accent" rather than muddied gray.
      variant: {
        default:
          'bg-coral/100 text-accent-fg hover:bg-coral-hover active:scale-[0.98] disabled:bg-coral-dim',
        secondary:
          'bg-ink-3 text-ink-fg border border-ink-border-soft hover:bg-ink-4 active:scale-[0.98]',
        ghost: 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4',
        outline:
          'border border-ink-border bg-transparent text-ink-fg hover:bg-ink-3 active:scale-[0.98]',
        destructive: 'bg-fail text-accent-fg hover:opacity-90 active:scale-[0.98]',
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
