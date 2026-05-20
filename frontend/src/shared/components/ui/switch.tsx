// Sprint 18 — shadcn Switch primitive (Radix Switch).
//
// Geometry follows mockup-settings.html `.tog`:
//   track 32×18, thumb 14×14, thumb-travel 14 (i.e. 1+14+1+14+1 = 33 ≈ 32 with
//   the right-side gap collapsing on `[data-state=checked]`). Sprint 18 PR C
//   will hoist these to :root vars (--tog-w / --tog-h / --tog-thumb) so the
//   single source of truth is in CSS not 11 component files; until then the
//   numbers live inline to keep this PR independently shippable.
//
// `data-[state=checked]` swaps `bg-ink-4` → `bg-coral` and translates the
// thumb 14px right. Border swap to `border-coral-hover` echoes the mockup's
// `.tog-on` 1px outline hint.

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@shared/lib/cn'

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-[18px] w-[32px] shrink-0 cursor-pointer items-center',
      'rounded-full border border-ink-border bg-ink-4',
      'transition-colors duration-fast ease-standard',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-1',
      'data-[state=checked]:bg-coral/100 data-[state=checked]:border-coral-hover',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-[14px] w-[14px] rounded-full bg-ink-fg',
        'shadow-[0_1px_2px_rgba(0,0,0,0.25)]',
        'translate-x-[1px] transition-transform duration-fast ease-standard',
        'data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-white'
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName
