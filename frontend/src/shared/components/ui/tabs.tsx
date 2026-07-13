// Sprint 18 — shadcn Tabs primitive (Radix Tabs).
//
// Sprint 18 uses orientation=vertical for the Settings 180px section rail. To
// keep one component file covering both layouts:
//   - Horizontal: coral underline follows the active trigger via layoutId.
//   - Vertical: the authored --sel-wash pill + hanging accent bar move as one
//     indicator layer, preserving the existing selected-state recipe.
//
// Radix exposes orientation as `data-orientation` on List + Trigger; we hook
// both styles off that selector to avoid a wrapping conditional in callers.

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@shared/lib/cn'
import { SPRING_LAYOUT } from '@shared/lib/motion-tokens'

const TabsValueContext = React.createContext<string | undefined>(undefined)

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>): React.ReactElement {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
  const currentValue = value ?? uncontrolledValue

  function handleValueChange(nextValue: string): void {
    if (value === undefined) setUncontrolledValue(nextValue)
    onValueChange?.(nextValue)
  }

  return (
    <TabsValueContext.Provider value={currentValue}>
      <TabsPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        {...props}
      />
    </TabsValueContext.Provider>
  )
}

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
>(({ className, children, ...props }, ref) => {
  const reduceMotion = useReducedMotion()
  const currentValue = React.useContext(TabsValueContext)
  const active = currentValue === props.value

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'group relative isolate inline-flex items-center whitespace-nowrap rounded-[var(--r-ctl)]',
        // Sprint 18 review — 默认 font-normal, 选中态才加 font-medium. 旧版
        // 全 font-medium 让 SettingsRail 的 8 个 tab 都看起来加粗, 跟主
        // Sidebar 风格不一致 (Sidebar 默认 font-normal, selected 才 medium).
        'text-aux font-normal',
        'transition-colors duration-fast ease-standard',
        // Focus ring unified to coral/70 with no offset (the orphan
        // `ring-offset-ink-1` had no matching offset-width and is dropped).
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
        'disabled:pointer-events-none disabled:opacity-50',
        'text-ink-fg-1 hover:text-ink-fg',
        // Horizontal default: coral underline (matches RightPanel pattern)
        'data-[orientation=horizontal]:justify-center data-[orientation=horizontal]:px-3 data-[orientation=horizontal]:py-1.5',
        'data-[orientation=horizontal]:data-[state=active]:font-medium data-[orientation=horizontal]:data-[state=active]:text-ink-fg',
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
        // vertical active 的终态配方仍由 index.css authored 规则定义；组件只
        // 挂载单一 layoutId 层，避免旧 active 背景/伪元素与滑动层叠加双影。
        'data-[orientation=vertical]:data-[state=active]:text-ink-fg',
        'data-[orientation=vertical]:data-[state=active]:font-medium',
        className
      )}
      {...props}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="tabs-indicator"
          transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT}
          className={cn(
            'tabs-indicator pointer-events-none absolute z-0',
            'group-data-[orientation=horizontal]:inset-x-0 group-data-[orientation=horizontal]:bottom-0 group-data-[orientation=horizontal]:h-0.5',
            'group-data-[orientation=vertical]:inset-0 group-data-[orientation=vertical]:rounded-[inherit]'
          )}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-[inherit]">{children}</span>
    </TabsPrimitive.Trigger>
  )
})
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
