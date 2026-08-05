// Shadcn-style Popover primitive wrapping @radix-ui/react-popover.
//
// Styling mirrors select.tsx: glass-pop surface, ink-border-soft border,
// z-50 so it clears Settings modal layers (Dialog is z-40 in dialog.tsx).
// sideOffset=4 matches Select's translate-y-1 visual gap.

import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'

import { cn } from '@shared/lib/cn'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'start', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        // 主题 v3 C8/批 4: 与 select.tsx 同族的菜单/控件档浮层 rounded-md(6) → --r-ctl(8)
        'relative z-50 min-w-[8rem] overflow-hidden rounded-[var(--r-ctl)]',
        // 投影走 `.glass-pop` 自带的 --pop-shadow：authored 的 `.glass-pop` 排在
        // `@tailwind utilities` 之后，同特异度源码序胜 —— 再挂 `shadow-[…]` 是死类。
        'glass-pop text-ink-fg',
        'border border-ink-border-soft',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'origin-[var(--radix-popover-content-transform-origin)]',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName
