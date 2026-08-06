// Connectors 配置台的小型 UI 原语（Lane B）。
//
//   · SegIconSelect —— 三档图标单选的通用件：connector 的 auto/ask/off 与内置工具的
//     ask/auto/deny 是**两条不同的轴**（off 作用在注册面、deny 同理，但值域与词表不同），
//     这里只统一「authored `.seg` + `.on` + disabled 形态」这层壳，值域由调用方给。
//     不用 `ui/segmented` 是因为它没有 disabled 形态，而 orphan / 不可配置行**必须**
//     渲染成禁用而不是消失。
//   · BulkMenu —— 组头右侧的组级批量下拉（走既有 bulk 端点，items 由调用方给）。
//   · ToolCategoryGroup —— 可折叠的工具类别组。🔴 owner 拍板：**每个类别默认折叠**，
//     点组头单独展开（参考 LobeHub 截图里是展开的，我们要更收敛的默认态）。展开态受控
//     （expanded/onToggle）——「sync 发现 orphan 自动展开那一组」这类语义需要外部写入。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

export interface SegOption<T extends string> {
  value: T
  label: string
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
}

export function SegIconSelect<T extends string>({
  value,
  options,
  disabled,
  ariaLabel,
  onChange
}: {
  value: T
  options: readonly SegOption<T>[]
  disabled: boolean
  ariaLabel: string
  onChange(next: T): void
}): React.ReactElement {
  return (
    <div className="seg shrink-0" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-pressed={value === opt.value}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => {
              if (opt.value !== value) onChange(opt.value)
            }}
            className={cn(
              value === opt.value && 'on',
              disabled && 'cursor-not-allowed opacity-50 hover:text-ink-fg-2'
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

export interface BulkMenuItem {
  key: string
  label: string
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
}

export function BulkMenu({
  ariaLabel,
  items,
  onApply
}: {
  ariaLabel: string
  items: readonly BulkMenuItem[]
  onApply(key: string): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
          aria-label={ariaLabel}
        >
          {t('settings.connectors.tools.bulk.label')}
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-4"
            onClick={() => {
              setOpen(false)
              onApply(key)
            }}
          >
            {Icon ? <Icon className="size-3.5 text-ink-fg-2" aria-hidden="true" /> : null}
            {label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** 可折叠工具类别组：组头 = 折叠开关（chevron + 类别药丸 + 数量徽标）+ 右侧批量下拉。
 *  批量下拉是组头的**兄弟**而不是孩子 —— 嵌套 button 是非法 DOM，也会让点批量误触折叠。 */
export function ToolCategoryGroup({
  id,
  expanded,
  onToggle,
  labelPill,
  count,
  bulk,
  children
}: {
  id: string
  expanded: boolean
  onToggle(): void
  labelPill: React.ReactNode
  count: number
  bulk?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="pt-1">
      <div className="flex items-center justify-between gap-3 border-b border-ink-border-soft pb-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={onToggle}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-ctl)] px-1 py-0.5 text-left transition-colors duration-fast hover:bg-ink-fg/[0.025]"
        >
          <CollapseChevron expanded={expanded} size={14} className="text-ink-fg-2" />
          {labelPill}
          <span className="text-micro text-ink-fg-3">{count}</span>
        </button>
        {bulk}
      </div>
      <CollapsibleRegion expanded={expanded} id={id}>
        {children}
      </CollapsibleRegion>
    </div>
  )
}
