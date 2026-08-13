import { createElement, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  BellOff,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  EyeOff,
  FileCheck,
  FileText,
  Flag,
  History,
  Hourglass,
  Link2,
  ListChecks,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  TriangleAlert,
  Users,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { MatterActorKind, MatterEvent } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'

import {
  groupTimelineEvents,
  matterEventTier,
  narrateEvent,
  narrateTimelineGroup,
  readChanges,
  readFields,
  type TimelineGroup,
  type TimelineSentence,
  type Translate
} from './matterTimelineModel'

type TimelineFilter = 'all' | MatterActorKind

/**
 * 事件 kind → 操作日志弹窗里的行图标。
 *
 * 设计稿 `AUDIT_ICON` 只覆盖 9 个 mock kind（run/email/update/status/doc/item/decision/created/
 * resource），而实到的事件有 38 个。多出来的**不自己发明符号**，一律回到设计稿里同语义位置
 * 已经用过的那个 icon：干系人=users（rail/ContextTab 通用）· 对话=message（chat.jsx）·
 * 接受/拒绝=check/x（review.jsx 的两个按钮）· 订阅=refresh、仅元数据=eyeoff（rail.jsx）·
 * 信号=alert（ATTN_META 主用）· 稍后提醒=bellsnooze（list.jsx onSignal）。
 * 归不到的走设计稿的兜底 `dot`。
 */
const TIMELINE_ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/^matter_created$/, Plus], // AUDIT_ICON.created
  [/^matter_updated$/, FileCheck], // AUDIT_ICON.update
  [/^matter_(archived|reopened|trashed|restored)$/, ArrowRight], // AUDIT_ICON.status
  [/^item_/, ListChecks], // AUDIT_ICON.item（= ITEM_KIND.action）
  [/^resource_updated$/, FileText], // AUDIT_ICON.doc
  [/^resource_suggestion_/, Sparkles], // rail「Agent 发现的资料」
  [/^resource_access_policy_changed$/, EyeOff], // rail「仅元数据」
  [/^resource_subscription_/, RefreshCw], // rail「已订阅后续」
  [/^resource_/, Link2], // AUDIT_ICON.resource
  [/^stakeholder_/, Users],
  [/^relation_/, Link2],
  [/^chat_scope_/, MessageSquare],
  [/^update_proposed$/, Sparkles],
  [/^update_accepted$/, Check],
  [/^update_rejected$/, X],
  [/^update_superseded$/, ArrowRight],
  [/^agent_binding_changed$/, Sparkles],
  [/^attention_resolved$/, Check],
  [/^attention_snoozed$/, BellOff],
  [/^attention_dismissed$/, EyeOff],
  [/^attention_/, TriangleAlert]
]

function timelineIcon(kind: string): LucideIcon {
  for (const [pattern, icon] of TIMELINE_ICONS) {
    if (pattern.test(kind)) return icon
  }
  return Circle // 设计稿兜底 'dot'
}

/**
 * 进展节点的 tone 色板（设计 `PROG_KIND[*].color` 的 token 化）。
 *
 * 🔴 **只上色，不给描边**（D13）。设计里节点确实带一圈 `alpha(c, 0.4)` 的发丝边，但它的
 * 圆底 `rgb(var(--ink-0))` **与详情页背景完全同色**、看不见，读起来只有「一个带淡色轮廓的
 * 图标」。本仓的详情壳是 `bg-ink-0/35`（半透，压在玻璃壁纸上），同一个不透明圆底在这里是
 * 实打实的一块色，叠上描边就成了 owner 报的「图标多了外圈」。圆底得留着盖住贯穿竖线，
 * 于是去掉的是描边那一层。
 */
const PROGRESS_TONE = {
  ai: 'text-ai',
  info: 'text-info',
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  neutral: 'text-ink-fg-3'
} as const

interface ProgressVisual {
  icon: LucideIcon
  tone: string
}

/**
 * 业务事件 → 进展视图的展示映射（G-18 (b) 档：数据仍是事件降级，只换 PROG_KIND 风格的
 * 视觉词汇）。对照设计 `progress.jsx` 的 `PROG_KIND`：完成=checkcircle/ok · 新待办=listcheck ·
 * 文档更新=filetext/ai · 出现风险=alert/crit · 进入等待=hourglass/warn · 开始=flag。
 * 设计里的「对方答复/会议」两类没有真实事件源（(c) 档才有结构化 progress 条目），不硬造。
 */
const PROGRESS_VISUALS: ReadonlyArray<readonly [RegExp, ProgressVisual]> = [
  [/^matter_created$/, { icon: Flag, tone: PROGRESS_TONE.neutral }], // start
  [
    /^matter_(archived|reopened|trashed|restored)$/,
    { icon: ArrowRight, tone: PROGRESS_TONE.neutral }
  ],
  [/^item_created$/, { icon: ListChecks, tone: PROGRESS_TONE.neutral }], // item_new
  [/^item_(deleted|restored)$/, { icon: ListChecks, tone: PROGRESS_TONE.neutral }],
  [/^resource_updated$/, { icon: FileText, tone: PROGRESS_TONE.ai }], // doc
  [/^resource_suggestion_accepted$/, { icon: Sparkles, tone: PROGRESS_TONE.ai }],
  [/^resource_suggestion_rejected$/, { icon: X, tone: PROGRESS_TONE.neutral }],
  [/^resource_/, { icon: Link2, tone: PROGRESS_TONE.info }],
  [/^stakeholder_/, { icon: Users, tone: PROGRESS_TONE.info }],
  [/^relation_/, { icon: Link2, tone: PROGRESS_TONE.info }],
  [/^update_proposed$/, { icon: Sparkles, tone: PROGRESS_TONE.ai }],
  [/^update_accepted$/, { icon: CheckCircle2, tone: PROGRESS_TONE.ok }],
  [/^update_rejected$/, { icon: X, tone: PROGRESS_TONE.neutral }],
  [/^update_superseded$/, { icon: ArrowRight, tone: PROGRESS_TONE.neutral }],
  [/^attention_opened$/, { icon: TriangleAlert, tone: PROGRESS_TONE.crit }], // risk
  [/^attention_resolved$/, { icon: CheckCircle2, tone: PROGRESS_TONE.ok }]
]

function progressVisual(event: MatterEvent): ProgressVisual {
  if (event.kind === 'item_updated') {
    // 勾完成的那条按设计的 item_done（checkcircle/ok）；其余条目改动维持中性。
    const changes = readChanges(event)
    if (changes?.some((change) => change.field === 'status' && change.to === 'done')) {
      return { icon: CheckCircle2, tone: PROGRESS_TONE.ok }
    }
    return { icon: ListChecks, tone: PROGRESS_TONE.neutral }
  }
  if (event.kind === 'matter_updated') {
    const fields = readFields(event)
    if (fields.includes('waiting_context')) return { icon: Hourglass, tone: PROGRESS_TONE.warn } // wait
    if (fields.includes('status')) return { icon: ArrowRight, tone: PROGRESS_TONE.info }
    return { icon: Send, tone: PROGRESS_TONE.info } // push（我方推进：改摘要/目标/截止…）
  }
  for (const [pattern, visual] of PROGRESS_VISUALS) {
    if (pattern.test(event.kind)) return visual
  }
  return { icon: Circle, tone: PROGRESS_TONE.neutral }
}

/** 按天分组的 key/标签（设计 `progress.jsx` 的 `dayKey`/`dayLabel`：今天/昨天 + 周几）。 */
function dayKeyOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabelOf(at: number, now: number, locale: string, t: Translate): string {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(at))
  if (dayKeyOf(at) === dayKeyOf(now)) return `${t('matters.timeline.dayToday')} · ${weekday}`
  if (dayKeyOf(at) === dayKeyOf(now - 86_400_000)) {
    return `${t('matters.timeline.dayYesterday')} · ${weekday}`
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(at))
}

/**
 * 事项详情的「进展」tab（G-18 Q1=(b) 两层复刻）。
 *
 * 两层信息架构，判定全在纯模块 `matterTimelineModel.ts`：
 * 1. **进展主视图** —— 业务档事件按天分组、以 PROG_KIND 风格（kind 定色的圆节点 + 加重标题）
 *    展示；顶部恒挂降级说明条（(b) 档数据仍是 38 类事件的降级映射，不是 Agent 提炼的
 *    结构化 progress —— 说明条不撒谎）。**没有**设计稿的「重新提炼」按钮：(b) 档它没有
 *    真实后端语义（run 触发已由 StateCard 的「重新生成摘要」承载）。
 * 2. **操作日志** —— 全量事件（含审计档）收进二级弹窗（设计 `AuditLogModal`），带自己的
 *    actor 筛选。收进弹窗 ≠ 删掉，「只追加、可追溯」是这套东西的立身之本。
 *
 * 同类合并仍在（一次操作扇出的一串同类事件收成一条带计数的条目，可展开）——
 * 🔴 只在渲染层；`prd.md` 的不变量是「时间线 append-only，纠错用反向事件」。
 */
export function MatterTimeline({ events }: { events: readonly MatterEvent[] }): React.ReactElement {
  const { t, i18n } = useTranslation()
  const translate = t as unknown as Translate
  const locale = i18n.language || 'zh-CN'
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const [auditOpen, setAuditOpen] = useState(false)
  // 「今天/昨天」的基准挂载时冻结（react-hooks/purity：render 期间不许调 Date.now()）。
  const [now] = useState(() => Date.now())
  // 🔴 展开态记的是 `group.id`（语义分组键 + burst 内最老一条的 id），不是 `head.id`：
  // 同 burst 新到一条更新的事件会换掉 head，按 head 记的展开态会**无提示地收起**。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const options = useMemo(
    () => [
      { value: 'all' as const, label: t('matters.timeline.all') },
      { value: 'user' as const, label: t('matters.timeline.me') },
      { value: 'agent' as const, label: t('matters.timeline.agent') },
      { value: 'system' as const, label: t('matters.timeline.system') }
    ],
    [t]
  )

  const byActor = useMemo(
    () => (filter === 'all' ? events : events.filter((event) => event.actor_kind === filter)),
    [events, filter]
  )
  // 🔴 分组在**筛选之后**：看到的就是被合并的，不会出现「合并了一条你看不见的事件」。
  // 主视图只收业务档 —— 审计档整体在操作日志弹窗里。
  const groups = useMemo(
    () => groupTimelineEvents(byActor.filter((event) => matterEventTier(event) === 'business')),
    [byActor]
  )
  const days = useMemo(() => {
    const list: { key: string; at: number; groups: TimelineGroup[] }[] = []
    for (const group of groups) {
      const key = dayKeyOf(group.head.happened_at)
      const last = list[list.length - 1]
      if (last && last.key === key) last.groups.push(group)
      else list.push({ key, at: group.head.happened_at, groups: [group] })
    }
    return list
  }, [groups])

  const toggleGroup = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  return (
    <section>
      {/* 标题 + 右侧 actor 筛选与操作日志入口 = 设计稿 `RailLabel right={<Segmented/> +
          <IconBtn history/>}>事情的进展</RailLabel>`。🔴 不用仓库的 SectionHeader ——
          它是 mono UPPERCASE，且有 CI lint 规则 `no-cjk-in-mono-size` 禁 CJK。 */}
      <h2 className="mb-2 flex items-center justify-between gap-3 text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
        <span className="min-w-0 truncate">{t('matters.timeline.sectionTitle')}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <SegmentedControl<TimelineFilter>
            value={filter}
            onChange={setFilter}
            options={options}
            ariaLabel={t('matters.timeline.filter')}
          />
          <button
            type="button"
            onClick={() => setAuditOpen(true)}
            title={t('matters.timeline.auditLog')}
            aria-label={t('matters.timeline.auditLog')}
            className="grid size-6 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
          >
            <History size={13} />
          </button>
        </span>
      </h2>

      {/* 降级说明条（设计 progress.jsx:162-174 的 derived 分支）。(b) 档恒 derived ——
          这条线是事件降级生成的，不是 Agent 从邮件/文档里提炼的结构化进展。 */}
      <div className="mb-2 flex items-center gap-2 rounded-[var(--r-card)] border border-ink-border-soft bg-ink-1 px-3 py-2">
        <Sparkles size={13} className="shrink-0 text-ai" />
        <span className="min-w-0 flex-1 text-meta leading-[1.5] text-ink-fg-2">
          {t('matters.timeline.derivedNotice')}
        </span>
      </div>

      {days.map((day) => (
        <div key={day.key} data-testid="matter-timeline-day" className="mt-1.5">
          {/* 天分组头（设计 progress.jsx:179-184）：标签 + 发丝线 + 条数。 */}
          <div className="flex items-center gap-2 px-0.5 pb-0.5 pt-1.5">
            <span className="text-meta font-medium text-ink-fg-2">
              {dayLabelOf(day.at, now, locale, translate)}
            </span>
            <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
            <span className="text-micro text-ink-fg-3">
              {t('matters.timeline.dayCount', { count: day.groups.length })}
            </span>
          </div>
          {/* 时间轴本体：一条贯穿竖线 + 每条一个按 kind 定色的圆节点。竖线 left 16px =
              节点半径 12.5 + pl-1 的 4px，正好穿过圆心；节点用 bg-ink-0 盖住线。 */}
          <div className="relative pl-1">
            <span aria-hidden className="absolute bottom-3 left-4 top-3 w-px bg-ink-border" />
            {day.groups.map((group) => (
              <TimelineRow
                key={group.id}
                group={group}
                t={translate}
                expanded={expanded.has(group.id)}
                onToggle={() => toggleGroup(group.id)}
              />
            ))}
          </div>
        </div>
      ))}
      {groups.length === 0 ? <EmptyState title={t('matters.timeline.empty')} /> : null}

      {/* 操作日志脚注（设计 progress.jsx:192-198）：计数说的是**全部事件**（含业务档），
          与弹窗内容一致 —— 弹窗就是完整时间线。 */}
      <div className="mt-3 flex items-center gap-2 border-t border-ink-border-soft pt-2.5">
        <History size={12} className="shrink-0 text-ink-fg-3" />
        <span className="min-w-0 flex-1 text-meta text-ink-fg-3">
          {t('matters.timeline.auditFooter', { count: events.length })}
        </span>
        <button
          type="button"
          onClick={() => setAuditOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
        >
          {t('matters.timeline.auditOpen')}
          <ChevronRight size={11} />
        </button>
      </div>

      <MatterAuditLogModal
        open={auditOpen}
        events={events}
        locale={locale}
        onOpenChange={setAuditOpen}
      />
    </section>
  )
}

function TimelineRow({
  group,
  t,
  expanded,
  onToggle
}: {
  group: TimelineGroup
  t: Translate
  expanded: boolean
  onToggle(): void
}): React.ReactElement {
  const { head } = group
  const visual = progressVisual(head)
  // 🔴 `const Icon = progressVisual(...)` + `<Icon/>` 会撞 eslint `react-hooks/static-components`
  // （调用表达式证明不了每次 render 拿到同一个组件身份）。`createElement` 绕开的是**写法**，
  // 不是规则的实质关切 —— 这张表是模块级常量，身份本来就稳定。同 `matterVocab.ts` 的先例。
  const icon = createElement(visual.icon, { size: 12 })
  const sentence = narrateTimelineGroup(group, t)
  const mergedCount = group.events.length

  return (
    <div className="relative flex gap-[11px] py-[7px]" data-testid="matter-timeline-entry">
      {/* D13 —— 圆底只为盖住贯穿竖线，**不描边**（见 PROGRESS_TONE 的说明）。 */}
      <span
        className={cn(
          'z-[1] grid size-[25px] shrink-0 place-items-center rounded-full bg-ink-0',
          visual.tone
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        {/* 进展标题（设计 ProgressEntry：13.5/500 主句）—— 比旧审计观感重半档。 */}
        <div className="text-body font-medium leading-[1.5] text-ink-fg">{sentence.text}</div>
        {sentence.detail ? (
          <div className="mt-0.5 text-meta leading-[1.55] text-ink-fg-3">{sentence.detail}</div>
        ) : null}
        <div className="mt-[3px] flex flex-wrap items-center gap-[7px]">
          <time className="font-mono text-micro text-ink-fg-3">
            {new Date(head.happened_at).toLocaleString()}
          </time>
          {head.actor_kind === 'agent' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ai/10 px-1.5 py-0.5 text-micro text-ai">
              <Sparkles size={9} />
              {t('matters.timeline.agent')}
            </span>
          ) : (
            <span className="text-micro text-ink-fg-3">
              · {t(`matters.eventActor.${head.actor_kind}`, { defaultValue: head.actor_kind })}
            </span>
          )}
          <span className="text-micro text-ink-fg-3">
            · {t(`matters.eventSource.${head.source}`, { defaultValue: head.source })}
          </span>
        </div>
        {/* 合并了才有展开钮 —— 明细一条不丢，只是默认不占位置。 */}
        {mergedCount > 1 ? (
          <>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1 py-0.5 text-micro text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-2"
            >
              {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              {expanded
                ? t('matters.narrative.collapse')
                : t('matters.narrative.expand', { count: mergedCount })}
            </button>
            {expanded ? (
              <ul className="mt-1 space-y-0.5 border-l border-ink-border pl-2.5">
                {group.events.map((event) => (
                  <MergedEntry key={event.id} event={event} t={t} />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

function MergedEntry({ event, t }: { event: MatterEvent; t: Translate }): React.ReactElement {
  const sentence: TimelineSentence = narrateEvent(event, t)
  return (
    <li className="text-micro leading-[1.55] text-ink-fg-3">
      <span className="text-ink-fg-2">{sentence.text}</span>
      {sentence.detail ? <span> · {sentence.detail}</span> : null}
      <time className="ml-1.5 font-mono">{new Date(event.happened_at).toLocaleTimeString()}</time>
    </li>
  )
}

/** 操作日志行的 actor 配色（设计 AuditLogModal：agent=--c-ai / me=--c-accent / system=fg-3）。 */
const AUDIT_ACTOR_TONE: Record<string, string> = {
  agent: 'text-ai',
  user: 'text-coral',
  system: 'text-ink-fg-3'
}

/**
 * 操作日志弹窗（设计 progress.jsx `AuditLogModal`）：**全量**事件的平铺清单（不做同类合并 ——
 * 回看/追责要的就是逐条原始记录），带自己的 actor 四档筛选，与主视图的筛选相互独立。
 */
function MatterAuditLogModal({
  open,
  events,
  locale,
  onOpenChange
}: {
  open: boolean
  events: readonly MatterEvent[]
  locale: string
  onOpenChange(open: boolean): void
}): React.ReactElement {
  const { t } = useTranslation()
  const translate = t as unknown as Translate
  const [actor, setActor] = useState<TimelineFilter>('all')
  const options = useMemo(
    () => [
      { value: 'all' as const, label: t('matters.timeline.all') },
      { value: 'user' as const, label: t('matters.timeline.me') },
      { value: 'agent' as const, label: t('matters.timeline.agent') },
      { value: 'system' as const, label: t('matters.timeline.system') }
    ],
    [t]
  )
  const list = useMemo(
    () => (actor === 'all' ? events : events.filter((event) => event.actor_kind === actor)),
    [actor, events]
  )
  const stampFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
    [locale]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] max-w-xl grid-rows-[auto_auto_1fr]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={14} className="shrink-0 text-ink-fg-2" />
            {t('matters.timeline.auditLog')}
          </DialogTitle>
          <DialogDescription>{t('matters.timeline.auditLogHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <SegmentedControl<TimelineFilter>
            value={actor}
            onChange={setActor}
            options={options}
            ariaLabel={t('matters.timeline.filter')}
          />
          <span className="flex-1" />
          <span className="text-meta text-ink-fg-3">
            {t('matters.timeline.auditCount', { count: list.length })}
          </span>
        </div>
        <div className="min-h-0 overflow-y-auto border-t border-ink-border-soft scrollbar-thin">
          {list.map((event) => {
            const sentence = narrateEvent(event, translate)
            const icon = createElement(timelineIcon(event.kind), {
              size: 12,
              className: cn(
                'mt-0.5 shrink-0',
                AUDIT_ACTOR_TONE[event.actor_kind] ?? 'text-ink-fg-3'
              )
            })
            return (
              <div
                key={event.id}
                data-testid="matter-audit-entry"
                className="flex items-start gap-2.5 border-b border-ink-border-soft py-2"
              >
                <time className="w-24 shrink-0 pt-0.5 font-mono text-micro text-ink-fg-3">
                  {stampFormat.format(event.happened_at)}
                </time>
                {icon}
                <span className="min-w-0 flex-1 text-meta leading-[1.55] text-ink-fg-1">
                  {sentence.text}
                  {sentence.detail ? (
                    <span className="text-ink-fg-3"> · {sentence.detail}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-micro text-ink-fg-3">
                  {t(`matters.eventActor.${event.actor_kind}`, {
                    defaultValue: event.actor_kind
                  })}
                </span>
              </div>
            )
          })}
          {list.length === 0 ? (
            <p className="py-6 text-center text-meta text-ink-fg-3">
              {t('matters.timeline.empty')}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
