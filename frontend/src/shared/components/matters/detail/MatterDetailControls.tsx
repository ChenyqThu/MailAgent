import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Hourglass,
  RotateCcw,
  Save,
  Sparkles,
  Target,
  Trash2,
  X
} from 'lucide-react'

import {
  BUILTIN_MATTER_TYPES,
  MATTER_HEALTH_VALUES,
  MATTER_PRIORITIES,
  MATTER_STATUSES
} from '@shared/api/types/matter'
import type {
  Matter,
  MatterHealth,
  MatterPriority,
  MatterStakeholder,
  MatterStatus
} from '@shared/api/types/matter'
import { Input } from '@shared/components/ui/input'
import { Popmenu } from '@shared/components/ui/Popmenu'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@shared/components/ui/select'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { formatMatterAgo, trashDaysRemaining } from '@shared/lib/matterDerive'

import { MatterDatePicker } from '../MatterDatePicker'
import {
  MATTER_HEALTH_ICONS,
  MATTER_HEALTH_TEXT_CLASS,
  MATTER_PRIORITY_TONES,
  MATTER_STATUS_ICONS,
  MATTER_STATUS_TONES,
  MATTER_TONE_CHIP_CLASS,
  MATTER_TONE_DOT_CLASS,
  MATTER_TONE_OUTLINE_CLASS,
  MATTER_TONE_TEXT_CLASS,
  matterDueTone
} from '../matterVocab'

export interface MatterPrevNextProps {
  current: number
  total: number
  previousLabel: string
  nextLabel: string
  canPrevious: boolean
  canNext: boolean
  onPrevious(): void
  onNext(): void
}

export function MatterPrevNext({
  current,
  total,
  previousLabel,
  nextLabel,
  canPrevious,
  canNext,
  onPrevious,
  onNext
}: MatterPrevNextProps): React.ReactElement {
  return (
    <div className="inline-flex shrink-0 items-center overflow-hidden rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 text-ink-fg-1">
      {/* E10④（dogfood 轮 2）—— 高度改 `h-8`（32px）对齐相邻的「立即跟进」按钮
          （它 `py-1.5` + `text-aux` 20px 行高 = 32px）：这两颗按钮共处 header 的
          `items-start` 一行，原来的 `size-7`（28px）比邻居矮 4px，顶边对齐、底边错位。 */}
      <button
        type="button"
        title={previousLabel}
        aria-label={previousLabel}
        disabled={!canPrevious}
        onClick={onPrevious}
        className="grid h-8 w-7 place-items-center transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronUp size={14} />
      </button>
      <span className="w-16 text-center font-mono text-meta tabular-nums text-ink-fg-2">
        {current} / {total}
      </span>
      <button
        type="button"
        title={nextLabel}
        aria-label={nextLabel}
        disabled={!canNext}
        onClick={onNext}
        className="grid h-8 w-7 place-items-center transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  )
}

/**
 * 状态选择面（轮 3 #2 —— 第三次返工，这次照设计**逐属性**落）。
 *
 * 触发器 = 裸 `StatusChip`（设计 detail.jsx:190-192：Pip + 每档一个 icon，无下拉箭头）。
 * 点它打开的**不是下拉**，是设计 create.jsx:108-131 的 `StatusMenu` **模态**：380px 宽、
 * ModalHead（target icon 井 + 「更改业务状态」+ 副题「状态变更会写入时间线…」）+ 八档
 * 状态行（icon 按 tone 上色 size 14 · 13px 标签 · 选中 = `--ink-3` 底 + accent 勾）。
 *
 * 🔴 前两轮失败的根因正是这里：只把 trigger 修成了 Pip，打开的面板仍是 shadcn Select
 * 的库存样式（勾在左、pl-7、glass-pop）—— 与设计的选择面一个属性都对不上。
 */
export function StatusMenu({
  value,
  onChange
}: {
  value: MatterStatus
  onChange(value: MatterStatus): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const Icon = MATTER_STATUS_ICONS[value]
  // 设计 Modal = fadeIn 遮罩 + popIn 卡片（ui.jsx:204-222）；走仓库统一 `useExitAnimation`
  // 通道（同 AddItemModal / 永久删除确认），不自造 keyframes。
  const { shouldRender: renderStatusModal, scopeRef: statusModalRef } =
    useExitAnimation<HTMLDivElement>(open, { card: '[data-anim-card]' })
  // 设计 Modal 支持 Esc 关闭（ui.jsx:206-210）；只在打开期间挂 document。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return (): void => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('matters.detail.status')}
        title={t('matters.detail.status')}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--r-ctl)] border px-[7px] py-[3px] text-meta leading-none',
          'transition-opacity duration-fast ease-standard hover:opacity-80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
          MATTER_TONE_CHIP_CLASS[MATTER_STATUS_TONES[value]]
        )}
      >
        <Icon size={11} className="shrink-0" />
        {t(`matters.status.${value}`)}
      </button>
      {renderStatusModal ? (
        <div
          ref={statusModalRef}
          role="presentation"
          onClick={(event) => {
            // 设计的遮罩点击即关（ui.jsx:211）；只认遮罩本体，卡片内点击不冒到这里关掉。
            if (event.target === event.currentTarget) setOpen(false)
          }}
          className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
        >
          <section
            data-anim-card
            role="dialog"
            aria-modal="true"
            aria-label={t('matters.detail.statusModalTitle')}
            className="w-full max-w-[380px] rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
          >
            <header className="flex items-start gap-3 border-b border-ink-border-soft px-[18px] pb-3.5 pt-4">
              <span className="grid size-7 shrink-0 place-items-center rounded-[var(--r-ctl)] bg-coral/12 text-coral">
                <Target size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-lead font-semibold tracking-[-0.01em] text-ink-fg">
                  {t('matters.detail.statusModalTitle')}
                </h2>
                <p className="mt-0.5 text-meta text-ink-fg-2">
                  {t('matters.detail.statusModalSub')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('common.cancel')}
                className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
              >
                <X size={15} />
              </button>
            </header>
            <div
              role="listbox"
              aria-label={t('matters.detail.status')}
              className="flex flex-col gap-0.5 p-3"
            >
              {MATTER_STATUSES.map((status) => {
                const ItemIcon = MATTER_STATUS_ICONS[status]
                const selected = status === value
                return (
                  <button
                    key={status}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setOpen(false)
                      if (status !== value) onChange(status)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-[var(--r-ctl)] px-3 py-2 text-left transition-colors duration-fast ease-standard',
                      selected ? 'bg-ink-3' : 'hover:bg-ink-fg/[0.04]'
                    )}
                  >
                    <ItemIcon
                      size={14}
                      className={cn(
                        'shrink-0',
                        MATTER_TONE_TEXT_CLASS[MATTER_STATUS_TONES[status]]
                      )}
                    />
                    <span className="min-w-0 flex-1 text-body text-ink-fg">
                      {t(`matters.status.${status}`)}
                    </span>
                    {selected ? <Check size={13} className="shrink-0 text-coral" /> : null}
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

/**
 * 健康度（设计 detail.jsx:145 → `HealthChip` = **裸文本无边框无底**，icon 与文字同色）。
 * 保留可改（设计原型这里是只读展示，实现侧的可改是净增能力），但去掉 pill 边框与 chevron。
 */

export function HealthMenu({
  value,
  onChange
}: {
  value: MatterHealth
  onChange(value: MatterHealth): void
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon = MATTER_HEALTH_ICONS[value]
  return (
    <Select value={value} onValueChange={(health) => onChange(health as MatterHealth)}>
      <SelectTrigger
        aria-label={t('matters.detail.health')}
        className={cn(
          // `!bg-transparent` 压 SelectTrigger 自带的 authored `.input-surface`（见 matterVocab
          // 的说明）—— 设计要的是**裸文本**，有输入框底就不是裸的了。
          'h-auto w-auto justify-start gap-1 whitespace-nowrap rounded-[var(--r-ctl)] border-0 !bg-transparent px-1.5 py-1 text-meta',
          // 末位 svg = trigger 自带的 chevron，设计里健康度没有它（裸文本 + icon）。
          '[&>svg:last-child]:hidden hover:!bg-ink-fg/[0.05]',
          MATTER_HEALTH_TEXT_CLASS[value]
        )}
      >
        <Icon size={11} strokeWidth={2.4} className="shrink-0" />
        {t(`matters.health.${value}`)}
      </SelectTrigger>
      <SelectContent>
        {MATTER_HEALTH_VALUES.map((health) => {
          const ItemIcon = MATTER_HEALTH_ICONS[health]
          return (
            <SelectItem key={health} value={health}>
              <span className="inline-flex items-center gap-2">
                <ItemIcon
                  size={12}
                  strokeWidth={2.4}
                  className={MATTER_HEALTH_TEXT_CLASS[health]}
                />
                {t(`matters.health.${health}`)}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/**
 * 优先级选择面（轮 3 #2）。触发器 = `PriorityTag` mono 小标签 + **标签外** 8px chevron
 * （设计 detail.jsx:194-203，轮 2 已对齐）；打开的面板照设计 `PickMenu`
 * （detail.jsx:120-145）：窄面板 · 行 = 7px tone 圆点 + 标签(flex-1) + 行尾 accent 勾，
 * 选中底 `--ink-fg/0.06`、hover `--ink-fg/0.04`。
 *
 * 🔴 前两轮只修了 trigger，面板仍是 shadcn SelectContent 库存样式（勾在左、pl-7、
 * text-aux）—— 这轮把面板换成仓库统一弹层基座 `Popmenu` 的逃生舱（同 MatterDatePicker
 * 先例），定位 / outside-click / Esc / 退场动效与全 app 一致，行按设计逐属性画。
 */

export function PriorityMenu({
  value,
  onChange
}: {
  value: MatterPriority
  onChange(value: MatterPriority): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('matters.detail.priority')}
        title={t('matters.detail.priority')}
        className={cn(
          'inline-flex items-center gap-[3px] rounded-[var(--r-ctl)]',
          'transition-opacity duration-fast ease-standard hover:opacity-80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70'
        )}
      >
        <span
          className={cn(
            'rounded-[var(--r-ctl)] border px-[5px] py-[2px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[0.02em]',
            MATTER_TONE_CHIP_CLASS[MATTER_PRIORITY_TONES[value]]
          )}
        >
          {value.toUpperCase()}
        </span>
        <ChevronDown size={8} className="shrink-0 text-ink-fg-3" />
      </button>
      <Popmenu
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={t('matters.detail.priority')}
        triggerRef={triggerRef}
        align="start"
        width={124}
      >
        <div role="listbox" aria-label={t('matters.detail.priority')}>
          {MATTER_PRIORITIES.map((priority) => {
            const selected = priority === value
            return (
              <button
                key={priority}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false)
                  if (priority !== value) onChange(priority)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta text-ink-fg transition-colors duration-fast ease-standard',
                  selected ? 'bg-ink-fg/[0.06]' : 'hover:bg-ink-fg/[0.04]'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-[7px] shrink-0 rounded-full',
                    MATTER_TONE_DOT_CLASS[MATTER_PRIORITY_TONES[priority]]
                  )}
                />
                <span className="min-w-0 flex-1 font-mono">{priority.toUpperCase()}</span>
                {selected ? <Check size={11} className="shrink-0 text-coral" /> : null}
              </button>
            )
          })}
        </div>
      </Popmenu>
    </span>
  )
}

/** 详情头右端的跟进 Agent 入口（设计 detail.jsx:163-174）。 */

export function AgentPill({
  bound,
  interactive,
  label,
  onOpen
}: {
  bound: boolean
  interactive: boolean
  label: string
  onOpen(): void
}): React.ReactElement {
  const { t } = useTranslation()
  // D9 —— 未绑定态照设计 detail.jsx:211-216 也是 **AI 色系**（虚线 `--c-ai/0.45` 边 +
  // `--c-ai/0.06` 底 + ai 前景），不是灰色。「还没设置自动跟进」是个邀请，灰掉它等于
  // 把这个入口藏起来；sparkles 两态恒 ai 色同理。
  const skin = cn(
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta',
    bound
      ? 'border-ai/20 bg-ai/[0.08] text-ink-fg-1'
      : 'border-dashed border-ai/45 bg-ai/[0.06] text-ai'
  )
  if (!interactive) {
    return (
      <span className={skin}>
        <Sparkles size={11} className="shrink-0 text-ai" />
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('matters.agentConfig.open')}
      className={cn(
        skin,
        'transition-colors duration-fast ease-standard',
        bound ? 'hover:bg-ai/[0.14]' : 'hover:bg-ai/[0.12]'
      )}
    >
      <Sparkles size={11} className="shrink-0 text-ai" />
      {label}
      <ChevronDown size={9} className="shrink-0 opacity-60" />
    </button>
  )
}

/**
 * 类型切换（设计 detail.jsx:158-170 的触发器 + 71-118 的 `TypeMenu`）。
 *
 * 触发器 = 元信息行里的**裸文本按钮** + 8px chevron，只在 hover/打开时才浮出一层 6% 底；
 * 负 margin 抵掉 padding，让它在文字流里不额外占宽。
 *
 * 🔴 D4 —— 菜单改成设计的**搜索即筛选、没命中就现场新建**：改动前是 shadcn Select 的死列表
 * 加一个「自定义…」项，选中它会在**元信息行里**长出一个输入框 + 两个按钮（把 `pub · 类型 ·
 * 创建于…` 这行撑变形），且要先滚到列表底部才找得到。Radix Select 的 listbox 里塞不了搜索框，
 * 所以这里自绘 —— 收起行为（点外部 / Esc）与「更多」菜单同一条实现。
 *
 * 设计里还有「每个类型后面的事项计数」与「删除未被使用的自定义类型」：本仓没有类型注册表，
 * 计数与删除都无处可取，**不造** —— 类型就是 `matter.matter_type` 上的自由字符串。
 */

export function MatterTypeEditor({
  value,
  busy,
  onChange
}: {
  value: string | null
  busy: boolean
  onChange(value: string | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchorRef = useRef<HTMLDivElement>(null)
  const { shouldRender: renderTypeMenu, scopeRef: typeMenuRef } = useExitAnimation<HTMLDivElement>(
    open,
    {
      backdrop: false,
      from: { autoAlpha: 0, y: -4, scale: 0.98, transformOrigin: 'top left' },
      enterDuration: DUR.fast
    }
  )

  // 打开时清空上一次的搜索词（关闭期间不清 —— 退场还在播，清了会当场换内容）。
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setQuery('')
  }

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: MouseEvent): void => {
      const anchor = anchorRef.current
      if (anchor && !anchor.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const keyword = query.trim()
  // 候选 = 预置 6 项 + 当前这条自定义值（它不在预置里时也要能被看见/选中）。
  const allTypes = useMemo(() => {
    const list: string[] = [...BUILTIN_MATTER_TYPES]
    if (value !== null && !list.includes(value)) list.unshift(value)
    return list
  }, [value])
  const matches = keyword
    ? allTypes.filter((type) => type.toLowerCase().includes(keyword.toLowerCase()))
    : allTypes
  const exact = allTypes.some((type) => type === keyword)

  const pick = (next: string | null): void => {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  const row = (
    key: string,
    label: string,
    selected: boolean,
    onSelect: () => void
  ): React.ReactElement => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-meta transition-colors duration-fast ease-standard',
        selected ? 'bg-coral/10 text-ink-fg' : 'text-ink-fg-1 hover:bg-ink-fg/[0.05]'
      )}
    >
      {/* 设计 detail.jsx:83-85：勾**紧跟**标签（label 不吃 flex），行尾 spacer ——
          不是「勾钉在最右」。 */}
      <span className="min-w-0 truncate">{label}</span>
      {selected ? <Check size={12} className="shrink-0 text-coral" /> : null}
      <span aria-hidden className="flex-1" />
    </button>
  )

  return (
    <div ref={anchorRef} className="relative inline-flex">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('matters.detail.type')}
        title={t('matters.detail.type')}
        className={cn(
          // 负 margin 抵消 padding：hover 底比文字大一圈，但按钮的外框仍与文字等宽，
          // 于是它在 `pub · 类型 · 创建于…` 这行里不会撑开额外的间距（设计 margin:'-2px -5px'）。
          'inline-flex items-center gap-[3px] whitespace-nowrap rounded-[var(--r-ctl)] -mx-[5px] -my-[2px] px-[5px] py-[2px]',
          // 字号与颜色**跟随同行元信息**：用 inherit 而不是写死 ink-fg-2，这一行的颜色改了
          // 它自动跟着改。
          'text-meta text-inherit transition-colors duration-fast ease-standard',
          'hover:bg-ink-fg/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
          open && 'bg-ink-fg/[0.06]'
        )}
      >
        {value ?? t('matters.detail.typeUnset')}
        <ChevronDown size={8} className="shrink-0 opacity-[0.55]" />
      </button>
      {renderTypeMenu ? (
        <div
          ref={typeMenuRef}
          role="listbox"
          aria-label={t('matters.detail.type')}
          className="absolute left-0 top-[calc(100%+5px)] z-30 max-h-80 w-52 overflow-y-auto rounded-[var(--r-pop)] border border-ink-border bg-ink-1 p-1.5 shadow-md scrollbar-thin"
        >
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter 且当前搜索词不是既有类型 → 就地新建（设计 detail.jsx:96）。
              if (event.key === 'Enter' && keyword && !exact) pick(keyword)
            }}
            placeholder={t('matters.detail.typeSearchPlaceholder')}
            aria-label={t('matters.detail.typeSearchPlaceholder')}
            className="mb-1 h-7 w-full px-2 text-meta"
          />
          {!keyword
            ? row('__unset', t('matters.detail.typeUnset'), value === null, () => pick(null))
            : null}
          {matches.map((type) => row(type, type, value === type, () => pick(type)))}
          {keyword && !exact
            ? row('__create', t('matters.detail.typeCreate', { name: keyword }), false, () =>
                pick(keyword)
              )
            : null}
        </div>
      ) : null}
    </div>
  )
}

export function DueDateControl({
  value,
  saving,
  now,
  onChange
}: {
  value: number | null
  saving: boolean
  now: number
  onChange(value: number | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  // 0813 dogfood #21：原来点开是个裸 `<input type="date">`，现在换成日历 popover
  // （`MatterDatePicker`，默认落当月 + 标记今天 + 今天/本周/下周/本月快捷键）。
  // 写入语义一字未变 —— 仍是**本地零点的 epoch 毫秒**（服务端 `_require_epoch_ms` 硬闸）。
  const [pickerOpen, setPickerOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const label =
    value == null
      ? t('matters.detail.noDue')
      : t('matters.detail.due', { date: new Date(value).toLocaleDateString() })
  // 设计 detail.jsx:50 `DueButton`：未设置 = 虚线边框 + fg-3；已设置 = 按 due tone 上色的实线。
  const tone = matterDueTone(value, now)

  return (
    <span className="relative inline-flex items-center gap-1 text-meta text-ink-fg-2">
      <button
        ref={triggerRef}
        type="button"
        disabled={saving}
        onClick={() => setPickerOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        className={cn(
          'inline-flex items-center gap-1 rounded-[var(--r-ctl)] border px-2 py-1 transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50',
          tone === null
            ? 'border-dashed border-ink-border text-ink-fg-3 hover:text-ink-fg'
            : MATTER_TONE_OUTLINE_CLASS[tone]
        )}
      >
        <Clock size={11} />
        {label}
      </button>
      <MatterDatePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        value={value}
        now={now}
        triggerRef={triggerRef}
        ariaLabel={t('matters.datePicker.label')}
        onSelect={(next) => {
          onChange(next)
          setPickerOpen(false)
        }}
      />
      {value != null ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => onChange(null)}
          aria-label={t('matters.detail.noDue')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
          <X size={12} />
        </button>
      ) : null}
    </span>
  )
}

/**
 * 分节标签（设计 `ui.jsx` 的 `RailLabel`）—— D8：状态 tab 的三类分节此前是**卡片内部的一行
 * 粗标题**，既没有 icon，也没有把「这是一节」的边界画出来。设计里每一节都是
 * `[icon] LABEL ————————————— [right]`：标签在卡**外面**，一条发丝线把这一行填满。
 *
 * 🔴 不用仓库的 `SectionHeader`，也不上 `font-mono`：CI lint 规则 `no-cjk-in-mono-size`
 * 禁 CJK 走等宽（中文在 mono 下字距会散）。同 `MatterProgressLane` 区头的处理。
 */
export function MatterSectionLabel({
  icon,
  children,
  right
}: {
  icon?: React.ReactNode
  children: React.ReactNode
  right?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mb-2 flex items-center gap-2 px-0.5">
      {icon}
      <h2 className="shrink-0 text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
        {children}
      </h2>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-ink-border-soft" />
      {right}
    </div>
  )
}

/**
 * 归档 / 回收站状态条（设计 detail.jsx:230-244）。删除态用 crit 色调并写明保留期与
 * 「关联的邮件与外部文档不受影响」；归档态是中性条 + 「归档不改变业务状态」。
 * 两个动作与「更多」菜单里的同名项**共用同一个 mutation**，不另起一条写路径。
 */
export function MatterLifecycleBanner({
  matter,
  busy,
  now,
  locale,
  onRestore
}: {
  matter: Matter
  busy: boolean
  now: number
  locale: string
  onRestore(): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const trashed = matter.deleted_at !== null
  if (!trashed && matter.archived_at === null) return null
  const BannerIcon = trashed ? Trash2 : Archive
  return (
    <div
      className={cn(
        'mb-5 flex items-center gap-3 rounded-[var(--r-card)] border px-4 py-3',
        trashed ? 'border-crit/25 bg-crit/[0.07]' : 'border-ink-border bg-ink-fg/[0.04]'
      )}
    >
      <BannerIcon size={14} className={cn('shrink-0', trashed ? 'text-crit' : 'text-ink-fg-2')} />
      <p className="min-w-0 flex-1 text-body text-ink-fg-1">
        {trashed
          ? t('matters.detail.trashedBanner', { count: trashDaysRemaining(matter, now) ?? 0 })
          : t('matters.detail.archivedBanner', {
              time: formatMatterAgo(matter.archived_at as number, now, locale)
            })}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onRestore}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
      >
        <RotateCcw size={13} />
        {t(trashed ? 'matters.actions.restore' : 'matters.actions.restoreArchive')}
      </button>
    </div>
  )
}

/**
 * `waiting_context` 是无 schema 的 JSON 对象（wire 契约 `Record<string, unknown> | null`；
 * 提案通道与测试里的既有形状是 `{who: …}` 一类的 ad-hoc dict）→ 展示时投影成一行文本：
 * 取原始值键的 `k: v`（约定键 `note` 直接出值，是本组件自己写入的形状），投不出来就整段
 * JSON 兜底 —— 宁可难看也不隐藏「它在等」这个事实。
 */
function waitingContextText(value: Record<string, unknown> | null): string | null {
  if (value === null) return null
  const parts: string[] = []
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      parts.push(key === 'note' ? String(raw) : `${key}: ${String(raw)}`)
    }
  }
  if (parts.length > 0) return parts.join(' · ')
  return Object.keys(value).length > 0 ? JSON.stringify(value) : null
}

/**
 * G-08 等待条（设计 detail.jsx:205-209 的 `m.waiting` 行，按真实数据微调）：真实数据是
 * 无 schema 的 `waiting_context` dict + `stakeholder.is_waiting_on`，不是设计的结构化
 * `{who,what,since}` —— 显示投影文本 + 等待中干系人名；「等了多久」没有起始时间戳可依据，
 * 不渲染。点击就地编辑（保存为 `{note: 文本}`）/ 清除（DIRECT_PATCH_FIELDS 既有通道）。
 */
export function MatterWaitingBar({
  waitingContext,
  stakeholders,
  saving,
  onSave
}: {
  waitingContext: Record<string, unknown> | null
  stakeholders: readonly MatterStakeholder[]
  saving: boolean
  onSave(waitingContext: Record<string, unknown> | null): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const waitingNames = stakeholders
    .filter((stakeholder) => stakeholder.is_waiting_on && stakeholder.deleted_at === null)
    .map((stakeholder) => stakeholder.display_name ?? stakeholder.email_normalized ?? '—')
  const contextText = waitingContextText(waitingContext)
  if (!editing && contextText === null && waitingNames.length === 0) return null

  const label =
    contextText !== null && waitingNames.length > 0
      ? t('matters.detail.waitingBoth', { names: waitingNames.join('、'), context: contextText })
      : contextText !== null
        ? t('matters.detail.waitingContext', { context: contextText })
        : t('matters.detail.waitingNames', { names: waitingNames.join('、') })

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Hourglass size={11} className="shrink-0 text-warn" />
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onSave(draft.trim() ? { note: draft.trim() } : null)
              setEditing(false)
            }
            if (event.key === 'Escape') setEditing(false)
          }}
          placeholder={t('matters.detail.waitingPlaceholder')}
          aria-label={t('matters.detail.waitingEdit')}
          className="h-7 w-52 px-2 text-meta"
        />
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            onSave(draft.trim() ? { note: draft.trim() } : null)
            setEditing(false)
          }}
          aria-label={t('matters.actions.save')}
          className="rounded-[var(--r-ctl)] p-1 text-ok transition-colors duration-fast ease-standard hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
          <Save size={12} />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          aria-label={t('matters.actions.cancel')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          <X size={12} />
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setDraft(contextText ?? '')
          setEditing(true)
        }}
        title={t('matters.detail.waitingEdit')}
        className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1 py-0.5 text-meta text-warn transition-colors duration-fast ease-standard hover:bg-warn/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
      >
        <Hourglass size={11} className="shrink-0" />
        <span className="max-w-72 truncate">{label}</span>
      </button>
      {waitingContext !== null ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(null)}
          aria-label={t('matters.detail.waitingClear')}
          className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-50"
        >
          <X size={11} />
        </button>
      ) : null}
    </span>
  )
}

export function MenuButton({
  icon,
  label,
  danger = false,
  onClick
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-body hover:bg-ink-3',
        danger && 'text-fail'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
