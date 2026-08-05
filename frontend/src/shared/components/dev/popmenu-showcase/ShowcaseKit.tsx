// Popmenu showcase —— 页面外壳与复用零件（dev-only，见 ../PopmenuShowcaseMount.tsx）。
//
// 这里只放「卡片 / 分节 / 触发器+Popmenu 的样板」，具体场景在 scenes*.tsx。
// 字号刻意用 Tailwind 原生 text-xs/text-sm 而不是仓内 text-micro/text-meta ——
// 后两者按 DESIGN §14 #2 是「英文专用」（11/12px CJK 会糊），showcase 里满屏中文。

import { useRef, useState, type ReactNode } from 'react'

import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { cn } from '@shared/lib/cn'

const TRIGGER_CLASS =
  'inline-flex h-7 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-3 px-2.5 text-sm text-ink-fg transition-colors duration-fast hover:bg-ink-4 data-[open=true]:bg-ink-4'

/** 触发按钮 + 受控 Popmenu 的样板。定位父元素 `relative` 由这里提供。 */
export function MenuDemo({
  label,
  ariaLabel,
  items,
  render,
  title,
  width,
  maxHeight,
  // 基座默认 'end'（右对齐），但 showcase 的卡片都是左对齐的窄触发器，右对齐会让面板
  // 向左糊出卡片外、撞上视口左缘的夹取。这里默认改 'start'，个别场景仍可覆盖。
  align = 'start',
  anchorClassName,
  dim,
  triggerClassName,
  wrapperClassName
}: {
  label: ReactNode
  ariaLabel: string
  /** 函数形态用于 custom 行里需要 `close()` 的场景。 */
  items?: readonly PopmenuItem[] | ((close: () => void) => readonly PopmenuItem[])
  /** 逃生舱：整个根面板自绘。 */
  render?: (close: () => void) => ReactNode
  title?: string
  width?: number
  maxHeight?: number
  align?: 'start' | 'end'
  anchorClassName?: string
  dim?: boolean
  triggerClassName?: string
  wrapperClassName?: string
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = (): void => setOpen(false)
  const resolved = typeof items === 'function' ? items(close) : items

  return (
    <div className={cn('relative', wrapperClassName)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(TRIGGER_CLASS, triggerClassName)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open ? 'true' : 'false'}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      <Popmenu
        open={open}
        onClose={close}
        ariaLabel={ariaLabel}
        items={resolved}
        title={title}
        triggerRef={triggerRef}
        align={align}
        anchorClassName={anchorClassName}
        width={width}
        maxHeight={maxHeight}
        dim={dim}
      >
        {render?.(close)}
      </Popmenu>
    </div>
  )
}

/** 一个场景卡：编号 + 功能名 + 现状一句话 + 可交互实例。 */
export function ShowcaseCard({
  code,
  name,
  status,
  note,
  span,
  children
}: {
  code: string
  name: string
  /** 来自盘点的「现状实现」一句话。 */
  status: string
  /** 迁移时发现的额外结论（可选）。 */
  note?: string
  span?: boolean
  children: ReactNode
}): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-[var(--r-card)] border border-ink-border bg-ink-2/70 p-3.5',
        span === true && 'md:col-span-2'
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] text-ink-fg-3">{code}</span>
        <h3 className="text-sm font-medium text-ink-fg">{name}</h3>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-fg-2">{status}</p>
      {note !== undefined && (
        <p className="mt-1 border-l-2 border-coral/50 pl-2 text-xs leading-relaxed text-ink-fg-3">
          {note}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-start gap-2">{children}</div>
    </div>
  )
}

/** 只讲结论、没有实例的卡（边界小节用）。 */
export function ShowcaseNote({
  code,
  name,
  reason
}: {
  code: string
  name: string
  reason: string
}): React.ReactElement {
  return (
    <div className="rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-1/60 p-3.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] text-ink-fg-3">{code}</span>
        <h3 className="text-sm font-medium text-ink-fg-1">{name}</h3>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-fg-2">{reason}</p>
    </div>
  )
}

export function ShowcaseSection({
  id,
  title,
  hint,
  children
}: {
  id: string
  title: string
  hint?: string
  children: ReactNode
}): React.ReactElement {
  return (
    <section id={id} className="mt-9 scroll-mt-24">
      <div className="mb-3 flex items-baseline gap-2.5 border-b border-ink-border-soft pb-1.5">
        <h2 className="text-base font-semibold text-ink-fg">{title}</h2>
        {hint !== undefined && <span className="text-xs text-ink-fg-3">{hint}</span>}
      </div>
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        {children}
      </div>
    </section>
  )
}

/** 富行（两行文本 + 前置槽）—— 基座的 `custom` 行里复用。 */
export function RichRow({
  lead,
  primary,
  secondary,
  trailing,
  onClick,
  active
}: {
  lead?: ReactNode
  primary: ReactNode
  secondary?: ReactNode
  trailing?: ReactNode
  onClick?: () => void
  active?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast hover:bg-ink-4',
        active === true && 'bg-ink-4'
      )}
    >
      {lead !== undefined && (
        <span className="inline-flex h-4 w-4 flex-none items-center justify-center text-ink-fg-2">
          {lead}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-fg">{primary}</span>
        {secondary !== undefined && (
          <span className="mt-0.5 block truncate text-xs text-ink-fg-3">{secondary}</span>
        )}
      </span>
      {trailing}
    </button>
  )
}
