/**
 * 事项域共享的**日期选择 popover**（0813 dogfood 轮 2 · 追加条目 #21）。
 *
 * 原本是一个裸 `<input type="date">`：能用，但 owner 反馈「配置建议改用日历组件」——
 * 要的是打开就看见**当月**、当天有标记、还能一键「本周 / 下周 / 本月」。
 *
 * ## 为什么没有用 HeroUI（owner 点名的那个）
 * `@heroui/calendar@2.2.32` 的 peer 是 `@heroui/theme >= 2.4.24`，而 `@heroui/theme`
 * 自 2.4.19 起 peer 已是 `tailwindcss >= 4.0.0`；本仓是 Tailwind **3.4.19**。
 * 唯一还兼容 Tailwind 3 的 `@heroui/theme@2.4.15` 又低于 calendar 的 peer 下界。
 * 更要命的是它的 tailwind 插件把整套语义色板 `theme.extend.colors` **全局**注入
 * （background / foreground / primary / secondary / default / divider / focus / …），
 * 而本仓 `tailwind.config.ts` 已经把同名 key 别名到 ink/coral token 上（shadcn 别名，
 * Popmenu、streamdown 全在用）—— 装上等于静默改写既有 utilities，正是 DESIGN.md v3
 * token SSoT 不允许的那条线。故这里**零新依赖**手写月网格，交互对齐 HeroUI calendar。
 *
 * 弹层不自造：走仓库统一的 `Popmenu` 基座（`children` 逃生舱 = 整个根面板交给这里
 * 渲染），于是定位、outside-click、Esc、退场动效全部与全 app 一致。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Popmenu } from '@shared/components/ui/Popmenu'
import { cn } from '@shared/lib/cn'

import {
  MATTER_DATE_PRESETS,
  addLocalDays,
  isSameLocalDay,
  monthGridDays,
  resolveMatterDatePreset,
  shiftDayByMonths,
  shiftMonth,
  startOfLocalDay
} from './matterDatePresets'

/** 周一起算的一周（与 `resolveMatterDatePreset` 的「本周日 = 周末」同一套口径）。
 *  取 2024-01-01（周一）起的连续 7 天，让 `Intl` 给出当前 locale 的窄名。 */
const WEEKDAY_SAMPLE_START = new Date(2024, 0, 1)

interface MatterDatePickerProps {
  open: boolean
  onClose(): void
  /** 当前值：本地零点 epoch **毫秒**，或 null（未设置）。 */
  value: number | null
  /** 选中某天 / 点「清除」（传 null）。调用方负责关闭。 */
  onSelect(value: number | null): void
  now: number
  triggerRef: React.RefObject<HTMLElement | null>
  ariaLabel: string
  align?: 'start' | 'end'
}

export function MatterDatePicker({
  open,
  onClose,
  value,
  onSelect,
  now,
  triggerRef,
  ariaLabel,
  align = 'start'
}: MatterDatePickerProps): React.ReactElement {
  return (
    <Popmenu
      open={open}
      onClose={onClose}
      ariaLabel={ariaLabel}
      triggerRef={triggerRef}
      align={align}
      width={276}
      // 网格是固定 6 行，整块一起看才有意义 —— 不让它在面板内部滚出半行。
      maxHeight={420}
    >
      {/* 只在 open 时挂载 ⇒ 每次打开都重新落到「当月 / 选中月」，不残留上次翻到的月份。 */}
      <MatterCalendar value={value} now={now} onSelect={onSelect} />
    </Popmenu>
  )
}

function MatterCalendar({
  value,
  now,
  onSelect
}: {
  value: number | null
  now: number
  onSelect(value: number | null): void
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh-CN'
  const today = startOfLocalDay(now)

  // 打开时落在哪个月：已有值 → 那个值所在的月；未设置 → **当月**（owner 的要求）。
  const [viewMonth, setViewMonth] = useState(() => {
    const anchor = new Date(value ?? today)
    return new Date(anchor.getFullYear(), anchor.getMonth(), 1).getTime()
  })
  // 方向键的游标（roving tabindex）。初始 = 选中日 / 今天。
  const [focusedDay, setFocusedDay] = useState(() => value ?? today)

  // 拆成两个标量（而不是留一个 Date 实例）：Date 每次 render 都是新身份，挂进
  // useMemo 依赖等于每轮重算，还得靠 eslint-disable 压 exhaustive-deps。
  const viewYear = new Date(viewMonth).getFullYear()
  const viewMonthIndex = new Date(viewMonth).getMonth()
  const days = useMemo(() => monthGridDays(viewYear, viewMonthIndex), [viewYear, viewMonthIndex])

  const gridRef = useRef<HTMLDivElement>(null)
  const shouldFocus = useRef(true)

  // 面板一挂载就把焦点交给游标那一格 —— 否则方向键第一下没有落点。
  useEffect(() => {
    if (!shouldFocus.current) return
    shouldFocus.current = false
    gridRef.current?.querySelector<HTMLButtonElement>('[data-day-focused="true"]')?.focus()
  }, [])

  /** 把游标挪到 `next`，必要时跟着翻月，并把焦点交给新格。 */
  const moveFocus = useCallback((next: number) => {
    setFocusedDay(next)
    const target = new Date(next)
    setViewMonth(new Date(target.getFullYear(), target.getMonth(), 1).getTime())
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus()
    })
  }, [])

  const onGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta =
        event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowRight'
            ? 1
            : event.key === 'ArrowUp'
              ? -7
              : event.key === 'ArrowDown'
                ? 7
                : 0
      if (delta !== 0) {
        event.preventDefault()
        moveFocus(addLocalDays(focusedDay, delta))
        return
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault()
        moveFocus(shiftDayByMonths(focusedDay, event.key === 'PageUp' ? -1 : 1))
      }
      // Esc 由 Popmenu 在 document 上统一处理（逃生舱内容也盖得住），这里不重复接。
    },
    [focusedDay, moveFocus]
  )

  const monthLabel = new Date(viewMonth).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long'
  })

  return (
    <div className="px-1 pb-1 pt-0.5">
      {/* ── 月份导航 ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-1 pb-1.5">
        <button
          type="button"
          onClick={() => setViewMonth(shiftMonth(viewYear, viewMonthIndex, -1))}
          aria-label={t('matters.datePicker.prevMonth')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          <ChevronLeft size={14} />
        </button>
        <span aria-live="polite" className="text-meta font-medium text-ink-fg">
          {monthLabel}
        </span>
        <button
          type="button"
          onClick={() => setViewMonth(shiftMonth(viewYear, viewMonthIndex, 1))}
          aria-label={t('matters.datePicker.nextMonth')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* ── 星期表头（周一起算，与快捷按钮的「本周日 = 周末」同口径） ── */}
      <div className="grid grid-cols-7 pb-0.5" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index} className="py-0.5 text-center text-micro text-ink-fg-3">
            {new Date(
              WEEKDAY_SAMPLE_START.getFullYear(),
              WEEKDAY_SAMPLE_START.getMonth(),
              WEEKDAY_SAMPLE_START.getDate() + index
            ).toLocaleDateString(locale, { weekday: 'narrow' })}
          </span>
        ))}
      </div>

      {/* ── 日网格（固定 6×7，翻月不跳高） ───────────────────────
          🔴 用 `group` + `aria-pressed` 而不是 `grid`/`gridcell`：后者要求
          rowgroup/row 的完整结构，扁平 CSS grid 套上去是**无效 ARIA**（读屏器会把
          行列关系读错）。这里每一格本来就是按钮，按下态用 aria-pressed 表达即可。 */}
      <div
        ref={gridRef}
        role="group"
        aria-label={t('matters.datePicker.grid')}
        onKeyDown={onGridKeyDown}
        className="grid grid-cols-7 gap-px"
      >
        {days.map((day) => {
          const date = new Date(day)
          const inMonth = date.getMonth() === viewMonthIndex
          const isToday = isSameLocalDay(day, today)
          const selected = value != null && isSameLocalDay(day, value)
          const focused = isSameLocalDay(day, focusedDay)
          return (
            <button
              key={day}
              type="button"
              data-day={day}
              data-day-focused={focused ? 'true' : undefined}
              data-today={isToday ? 'true' : undefined}
              aria-pressed={selected}
              aria-current={isToday ? 'date' : undefined}
              tabIndex={focused ? 0 : -1}
              aria-label={date.toLocaleDateString(locale, {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}
              onClick={() => {
                setFocusedDay(day)
                onSelect(day)
              }}
              className={cn(
                'grid h-8 place-items-center rounded-[var(--r-ctl)] text-meta tabular-nums transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
                selected
                  ? 'bg-coral/100 font-medium text-accent-fg'
                  : cn(
                      'hover:bg-ink-3',
                      inMonth ? 'text-ink-fg' : 'text-ink-fg-3/70',
                      // 今天 = 描边 + 强调色（选中时让位给实心药丸，不叠两种强调）。
                      isToday && 'border border-coral/60 font-medium text-coral'
                    )
              )}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>

      {/* ── 快捷按钮 + 清除 ─────────────────────────────────────── */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-ink-border-soft pt-1.5">
        {MATTER_DATE_PRESETS.map((preset) => {
          const resolved = resolveMatterDatePreset(preset, now)
          return (
            <button
              key={preset}
              type="button"
              title={new Date(resolved).toLocaleDateString(locale)}
              onClick={() => onSelect(resolved)}
              // 圆角走 `--r-ctl`（index.css「按钮/输入」档）。胶囊形按词表用 `rounded-full`
              // （index.css 注释明确胶囊 999 是特例不进 token，勿再发明 `--r-pill` 之类变量）。
              className="rounded-[var(--r-ctl)] border border-ink-border px-2 py-1 text-micro text-ink-fg-2 transition-colors duration-fast ease-standard hover:border-coral/60 hover:text-coral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
            >
              {t(`matters.datePicker.presets.${preset}`)}
            </button>
          )
        })}
        {/* 没设过值就没有「清除」—— 否则点它只会打出一次 `due_at: null` 的空写。 */}
        {value != null ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="ml-auto rounded-[var(--r-ctl)] px-2 py-1 text-micro text-ink-fg-3 transition-colors duration-fast ease-standard hover:text-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            {t('matters.datePicker.clear')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
