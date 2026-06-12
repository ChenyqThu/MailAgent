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
      // Sprint 18 review — 默认 font-normal, 选中态才加 font-medium. 旧版
      // 全 font-medium 让 SettingsRail 的 8 个 tab 都看起来加粗, 跟主
      // Sidebar 风格不一致 (Sidebar 默认 font-normal, selected 才 medium).
      'text-aux font-normal ring-offset-ink-1',
      'transition-colors duration-fast ease-standard',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
      'disabled:pointer-events-none disabled:opacity-50',
      'text-ink-fg-1 hover:text-ink-fg',
      // Horizontal default: coral underline (matches RightPanel pattern)
      'data-[orientation=horizontal]:justify-center data-[orientation=horizontal]:px-3 data-[orientation=horizontal]:py-1.5',
      'data-[orientation=horizontal]:border-b-2 data-[orientation=horizontal]:border-transparent',
      'data-[orientation=horizontal]:data-[state=active]:font-medium data-[orientation=horizontal]:data-[state=active]:text-ink-fg',
      'data-[orientation=horizontal]:data-[state=active]:border-coral',
      // Vertical (Settings rail) — 跟主 Sidebar `.row-selected` 同源:
      // active = `bg-ink-4 text-ink-fg font-medium` + 3px coral 左条
      // inset-y-0 (全高).
      //
      // ⚠️ 链式 data-attr 语法: Tailwind 要求每个 data-attr 是独立 variant,
      // 用 `:` 串起来 (data-[a=x]:data-[b=y]:bg-foo). 旧版用
      // `data-[a=x][data-b=y]:` 把两个 attr 塞一个 `[...]` 里 Tailwind 不认
      // → JIT 静默不生成 CSS → active 态完全无效. (这是 Sprint 18 review
      // 用户报"选中没高亮"的根因.)
      'data-[orientation=vertical]:justify-start data-[orientation=vertical]:gap-2.5',
      'data-[orientation=vertical]:px-2.5 data-[orientation=vertical]:py-[7px]',
      'data-[orientation=vertical]:hover:bg-ink-3 data-[orientation=vertical]:hover:text-ink-fg',
      // round 8 — vertical active 的底色与光条改走 index.css authored 规则
      // (与主菜单同语言: accent wash + 悬挂胶囊光条)。v1 的 bg-ink-4 灰白
      // 平涂 + before:* 通高直角条 (上面五行) 整套退役, 这里只留字色/字重
      // — 两套 before 规则 specificity 同级, 留着会按源序打架。
      'data-[orientation=vertical]:data-[state=active]:text-ink-fg',
      'data-[orientation=vertical]:data-[state=active]:font-medium',
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
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName
