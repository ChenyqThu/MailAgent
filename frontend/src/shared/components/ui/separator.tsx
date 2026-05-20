// Sprint 18 — shadcn Separator primitive (Radix Separator).
//
// Uses `bg-ink-border-soft` — the hairline ramp that already separates rows
// in the EmailRow stack (Sprint 17). Defaults to decorative (a11y: skipped by
// AT) since most separators in Settings are visual rhythm, not structural.

import * as React from 'react'
import * as SeparatorPrimitive from '@radix-ui/react-separator'

import { cn } from '@shared/lib/cn'

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-ink-border-soft',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className
    )}
    {...props}
  />
))
Separator.displayName = SeparatorPrimitive.Root.displayName
