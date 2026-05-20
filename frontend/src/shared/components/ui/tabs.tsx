// Sprint 18 — shadcn Tabs primitive (Radix Tabs).
//
// Sprint 18 uses orientation=vertical for the Settings 180px section rail. To
// keep one component file covering both layouts:
//   - Horizontal (existing RightPanel usage in mockups): coral underline on
//     `data-state=active` (DESIGN.md §5 Tabs catalog).
//   - Vertical (Sprint 18 Settings nav): selected item gets `bg-ink-3/85`
//     background tint matching mockup-settings.html `.nav-on` rule + a 2px
//     left accent bar via `before:` pseudo (Sprint 11 NavLink does the same).
//
// Radix exposes orientation as `data-orientation` on List + Trigger; we hook
// both styles off that selector to avoid a wrapping conditional in callers.

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@shared/lib/cn'

export const Tabs = TabsPrimitive.Root

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-center text-ink-fg-2',
      'data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch',
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'relative inline-flex items-center whitespace-nowrap rounded-md',
      'text-aux font-medium ring-offset-ink-1',
      'transition-colors duration-fast ease-standard',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40',
      'disabled:pointer-events-none disabled:opacity-50',
      'text-ink-fg-2 hover:text-ink-fg',
      'data-[state=active]:text-ink-fg',
      // Horizontal default: coral underline (matches RightPanel pattern)
      'data-[orientation=horizontal]:justify-center data-[orientation=horizontal]:px-3 data-[orientation=horizontal]:py-1.5',
      'data-[orientation=horizontal]:border-b-2 data-[orientation=horizontal]:border-transparent',
      'data-[orientation=horizontal][data-state=active]:border-coral',
      // Vertical (Settings rail): justify-start, gap for icon + label, ink-3 fill on active
      'data-[orientation=vertical]:justify-start data-[orientation=vertical]:gap-2.5',
      'data-[orientation=vertical]:px-2.5 data-[orientation=vertical]:py-[7px]',
      'data-[orientation=vertical]:hover:bg-ink-fg/[0.06]',
      'data-[orientation=vertical][data-state=active]:bg-ink-3/85 data-[orientation=vertical][data-state=active]:text-ink-fg',
      'data-[orientation=vertical][data-state=active]:before:absolute data-[orientation=vertical][data-state=active]:before:left-0 data-[orientation=vertical][data-state=active]:before:top-1/2 data-[orientation=vertical][data-state=active]:before:-translate-y-1/2',
      'data-[orientation=vertical][data-state=active]:before:h-4 data-[orientation=vertical][data-state=active]:before:w-[2px] data-[orientation=vertical][data-state=active]:before:rounded-full data-[orientation=vertical][data-state=active]:before:bg-coral/100',
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName
