// 今日页里「没有行内动作」的那种行（会 / 待回邮件 / 报告），task 08-27 P4c。
//
// 与 `TodayItemRow` 的分工：那一个带行内审批卡 / 派发回答框 / 信号 triage 菜单，是
// 例外面的行；这一个只有「点开它」一个动作，所以整行就是一个按钮。
//
// design §十「条目分两级」：
//   · 要动手（`actionable`）—— accent 描边 + accent 底 + 右侧动作钮
//   · 只是知会 —— 平铺（弱边 + 弱底、无按钮）
// 两级的配方照原型 SpecBoard 的 `.titem.hot` / `.titem`（用 token，不硬写 alpha）。

import { useTranslation } from 'react-i18next'
import { CalendarClock, FileText, Mail, type LucideIcon } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import type { TodaySectionItem } from './todaySections'

/** 行图标按**源**走（这一条是一封信、一场会，还是一份报告）。 */
const SECTION_ROW_ICONS: Record<TodaySectionItem['source'], LucideIcon> = {
  mail: Mail,
  calendar: CalendarClock,
  report: FileText
}

/** 动作钮的文案 —— 只有 actionable 的行有。目前只有「待回邮件」是这一档。 */
const ACTION_LABEL_KEY: Record<TodaySectionItem['source'], string> = {
  mail: 'today.action.openMail',
  calendar: 'today.action.openCalendar',
  report: 'today.action.openReport'
}

export function TodaySectionRow({
  item,
  onOpen
}: {
  item: TodaySectionItem
  onOpen(item: TodaySectionItem): void
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon = SECTION_ROW_ICONS[item.source]

  return (
    <div
      data-testid="today-section-item"
      data-source={item.source}
      data-actionable={item.actionable ? 'true' : 'false'}
      className={cn(
        'mb-1.5 rounded-[var(--r-ctl)] border transition-colors duration-fast',
        item.actionable
          ? 'border-[rgb(var(--c-accent))]/34 bg-[rgb(var(--c-accent))]/[0.07] hover:bg-[rgb(var(--c-accent))]/[0.11]'
          : 'border-ink-border bg-ink-fg/[0.035] hover:bg-ink-3'
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          <span
            className={cn(
              'mt-px grid size-[26px] shrink-0 place-items-center rounded-lg',
              item.actionable
                ? 'bg-[rgb(var(--c-accent))]/12 text-[rgb(var(--c-accent))]'
                : 'bg-ink-fg/[0.07] text-ink-fg-3'
            )}
          >
            <Icon size={14} strokeWidth={2} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-aux font-medium text-ink-fg">{item.title}</span>
              {item.meta.length > 0 && (
                <span className="shrink-0 font-mono text-micro text-ink-fg-3">{item.meta}</span>
              )}
            </span>
            {/* 「为什么是今天」是一等字段，行上直读。空串 = 组装不出 → **按缺席渲染**，
                不兜底成一句套话（那样每行都有话说，等于每行都没说）。 */}
            {item.why.length > 0 && (
              <span className="mt-0.5 line-clamp-2 text-meta text-ink-fg-2">{item.why}</span>
            )}
          </span>
        </button>
        {item.actionable && (
          <button
            type="button"
            onClick={() => onOpen(item)}
            className={cn(
              'mt-px shrink-0 rounded-[var(--r-ctl)] px-2 py-1 text-micro font-medium',
              'bg-[rgb(var(--c-accent))]/14 text-[rgb(var(--c-accent))]',
              'transition-colors duration-fast hover:bg-[rgb(var(--c-accent))]/22'
            )}
          >
            {t(ACTION_LABEL_KEY[item.source])}
          </button>
        )}
      </div>
    </div>
  )
}
