// Sprint 18 — shadcn Slider primitive (Radix Slider).
//
// Geometry follows mockup-settings.html `.slider-*`:
//   track 4px high coral-on-ink-4, thumb 16×16 white with 1px ink-border
//   outline + Level-1 drop shadow. Sprint 18 PR C hoists --slider-track-h /
//   --slider-thumb-size to :root.
//
// Thumb shadow uses `rgb(var(--ink-border))` — a CSS var reference, NOT a
// raw hex; DESIGN.md §14 #1 (no raw hex) is satisfied.

import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

import { cn } from '@shared/lib/cn'

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-[4px] w-full grow overflow-hidden rounded-full bg-ink-4">
      <SliderPrimitive.Range className="absolute h-full bg-coral/100" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className={cn(
        // UI-PRIMITIVES-01: thumb rests on the coral range; bg-white scored
        // <3:1 (WCAG 1.4.11). --c-accent-fg flips per-mode (dark→near-black /
        // light→white) for AA on coral; the 1px ink-border ring keeps the
        // edge legible over the unfilled ink-4 track.
        'block h-[16px] w-[16px] rounded-full bg-accent-fg',
        'shadow-[0_0_0_1px_rgb(var(--ink-border)),0_2px_4px_rgba(0,0,0,0.25)]',
        'transition-transform duration-fast ease-standard',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40',
        'disabled:pointer-events-none disabled:opacity-50',
        'hover:scale-110'
      )}
    />
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName
