// Sprint 18 — shadcn Tooltip primitive (Radix Tooltip).
//
// Coexists with the older HoverTip (frontend/src/shared/components/ui/HoverTip.tsx)
// — HoverTip is used in 12+ places (footer chips, batch bar action labels),
// while this Radix-backed Tooltip is what Settings field-helper "?" icons hook
// into. Reasons to keep both: HoverTip ships a tiny 9px chip without portal
// (perfect for status bar dense rows); Radix Tooltip gives portal + ESC +
// keyboard focus support for the more substantial form-helper text.

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@shared/lib/cn'

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md px-2 py-1',
        'glass-pop border border-ink-border-soft',
        'shadow-[0_4px_12px_rgba(0,0,0,0.35)]',
        'text-meta text-ink-fg-1',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        'data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName
