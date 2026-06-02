// Sprint 18 — shadcn RadioGroup primitive (Radix RadioGroup).
//
// Geometry follows mockup-settings.html `.rad`:
//   outer ring 14×14, border 1.5px ink-fg-3, accent border on checked.
//   Inner dot 6×6 coral. Sprint 18 PR C hoists `--rad-size / --rad-dot` to
//   :root; here we keep the values inline so this PR ships alone.

import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'

import { cn } from '@shared/lib/cn'

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2', className)} {...props} />
))
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'aspect-square h-[14px] w-[14px] rounded-full border-[1.5px] border-ink-fg-3',
      'transition-colors duration-fast ease-standard',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-coral',
      className
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex h-full w-full items-center justify-center">
      <span className="block h-[6px] w-[6px] rounded-full bg-coral/100" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
))
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName
