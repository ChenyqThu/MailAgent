// v0.7.2 dogfood round 3 — unified SegmentedControl（用户：「好几个地方的
// switch tab 效果不一致……我比较喜欢报告类型切换那里的」）。
//
// Visual baseline = authored `.seg`（index.css）：半透 ink track + hairline
// 边框，active 胶囊是半透 ink-fg wash（暗）/ 近白（亮）——没有硬实底，玻璃
// 材质下不割裂。本组件复用那套规则，并新增一个「测量式」滑动指示器
// （`.seg-indicator`）：position:absolute + translateX(px) + width(px)，由
// active button 的 offsetLeft/offsetWidth 驱动 —— 与旧 BackendSelector thumb
// 的 translateX(100%) 两等分手法不同，能支持不等宽段（SessionsPage 的过滤
// 按钮自适应文本宽）。
//
// Active 按钮刻意 **不加 `.on`**（那条规则自带胶囊底 → 与 indicator 双底
// 叠加）；active 文字色走 authored `.seg button.seg-active`。存量 `.seg` +
// `.on` 原生用法（ScheduleBuilder / 各 agent 配置页的分段选择）不受影响、继续可用。
//
// Motion：indicator 的 transition 类有两道闸 —— ① 初次挂载先直接就位
// （首次定位渲染不带 transition，避免从 x=0 滑入）；② useReducedMotion()
// 为 true 时完全不加（跳变）。

import * as React from 'react'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

export interface SegmentedOption<T extends string> {
  value: T
  /** Visible content; may be a composite node (e.g. status dot + text). */
  label: React.ReactNode
  /** Accessible name for the tab when `label` isn't plain text. */
  ariaLabel?: string
}

interface SegmentedControlProps<T extends string> {
  value: T
  onChange(next: T): void
  options: ReadonlyArray<SegmentedOption<T>>
  /** tablist accessible name（i18n 文案由调用方传）。 */
  ariaLabel: string
  /** true → 每段 flex-1 等分；false（默认）→ 自适应文本宽。 */
  fluid?: boolean
  /** sm = h-7（默认，报告 cadence 基准）· md = h-8（chat BackendSelector）。 */
  size?: 'sm' | 'md'
  /** 'accent' → 选中段 coral 实底 + 白字加粗（强调用，如账户页「邮件源选择」，
   *  默认 wash 胶囊在玻璃上太淡看不出选中）；'default'（默认）→ 玻璃 wash 胶囊。 */
  tone?: 'default' | 'accent'
  className?: string
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  fluid = false,
  size = 'sm',
  tone = 'default',
  className
}: SegmentedControlProps<T>): React.ReactElement {
  const reduceMotion = useReducedMotion()
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const buttonRefs = React.useRef(new Map<string, HTMLButtonElement>())
  // Latest value for the ResizeObserver callback (subscribed once).
  const valueRef = React.useRef(value)

  // `animate` rides inside the measurement (functional update: prev !== null)
  // instead of a ref — render may not read refs (react-hooks/refs). The FIRST
  // measurement commits with animate:false → no transition class on the first
  // positioned paint, so the capsule appears in place instead of sliding in
  // from x=0 on mount. Every later measurement (value change / resize) sees a
  // non-null prev → transition class joins the same commit as the new
  // transform, which is exactly when CSS picks it up.
  const [indicator, setIndicator] = React.useState<{
    left: number
    width: number
    animate: boolean
  } | null>(null)

  React.useLayoutEffect(() => {
    valueRef.current = value
    const btn = options.length > 0 ? buttonRefs.current.get(value) : undefined
    if (!btn) {
      setIndicator(null)
      return
    }
    // offsetLeft is measured from the offsetParent's padding edge — the same
    // origin as the indicator's `left: 0` inside position:relative `.seg`,
    // so the raw value maps 1:1 onto translateX.
    const left = btn.offsetLeft
    const width = btn.offsetWidth
    setIndicator((prev) => ({ left, width, animate: prev !== null }))
  }, [value, options])

  // Re-measure on track resize — window/font/sidebar width changes move the
  // active button under fluid layouts. (happy-dom has no ResizeObserver →
  // guarded; tests only assert presence, not geometry.)
  React.useLayoutEffect(() => {
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const btn = buttonRefs.current.get(valueRef.current)
      if (!btn) return
      const left = btn.offsetLeft
      const width = btn.offsetWidth
      setIndicator((prev) => ({ left, width, animate: prev !== null }))
    })
    ro.observe(track)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn('seg', tone === 'accent' && 'seg-accent', className)}
    >
      <span
        aria-hidden
        className={cn(
          'seg-indicator',
          indicator?.animate === true && !reduceMotion && 'seg-indicator-anim'
        )}
        style={
          indicator
            ? { transform: `translateX(${indicator.left}px)`, width: indicator.width }
            : { visibility: 'hidden', width: 0 }
        }
      />
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={opt.ariaLabel}
            ref={(el) => {
              if (el) buttonRefs.current.set(opt.value, el)
              else buttonRefs.current.delete(opt.value)
            }}
            onClick={() => onChange(opt.value)}
            className={cn(
              // Content sits above the absolutely-positioned indicator.
              'relative z-[1] justify-center',
              // §9.3 press feedback — light scale on the segment tab (≥0.95).
              // Animates via the authored `.seg button` transition.
              'active:scale-[0.96]',
              size === 'md' ? 'h-8' : 'h-7',
              fluid && 'flex-1',
              active && 'seg-active'
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
