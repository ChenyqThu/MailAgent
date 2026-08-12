import { createElement, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  FileCheck,
  FileText,
  Link2,
  ListChecks,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Users,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { MatterActorKind, MatterEvent } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'

import {
  groupTimelineEvents,
  matterEventTier,
  narrateEvent,
  narrateTimelineGroup,
  type TimelineGroup,
  type TimelineSentence,
  type Translate
} from './matterTimelineModel'

type TimelineFilter = 'all' | MatterActorKind

/** 节点圆的 actor 配色（设计稿 `TL_TONE`：agent=--c-ai / me=--c-accent / system=--ink-fg-3，
 *  边框取该色 40% alpha）。实现的 actor 值域是 user/agent/system，设计的 `me` 即 user。 */
const TIMELINE_TONE: Record<string, string> = {
  agent: 'border-ai/40 text-ai',
  user: 'border-coral/40 text-coral',
  system: 'border-ink-border text-ink-fg-3'
}

/**
 * 事件 kind → 节点图标。
 *
 * 设计稿 `TL_ICON` 只覆盖 9 个 mock kind（run/email/update/status/doc/item/decision/created/
 * resource），而实到的事件有 38 个。多出来的**不自己发明符号**，一律回到设计稿里同语义位置
 * 已经用过的那个 icon：干系人=users（rail/ContextTab 通用）· 对话=message（chat.jsx）·
 * 接受/拒绝=check/x（review.jsx 的两个按钮）· 订阅=refresh、仅元数据=eyeoff（rail.jsx）·
 * 信号=alert（ATTN_META 主用）· 稍后提醒=bellsnooze（list.jsx onSignal）。
 * 归不到的走设计稿的兜底 `dot`。
 */
const TIMELINE_ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/^matter_created$/, Plus], // TL_ICON.created
  [/^matter_updated$/, FileCheck], // TL_ICON.update
  [/^matter_(archived|reopened|trashed|restored)$/, ArrowRight], // TL_ICON.status
  [/^item_/, ListChecks], // TL_ICON.item（= ITEM_KIND.action）
  [/^resource_updated$/, FileText], // TL_ICON.doc
  [/^resource_suggestion_/, Sparkles], // rail「Agent 发现的资料」
  [/^resource_access_policy_changed$/, EyeOff], // rail「仅元数据」
  [/^resource_subscription_/, RefreshCw], // rail「已订阅后续」
  [/^resource_/, Link2], // TL_ICON.resource
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
 * 事项详情的**跟进历史**（原本是审计日志观感：「更新事项 / 改动字段：状态、优先级」）。
 *
 * 三层处理，判定全在纯模块 `matterTimelineModel.ts`：
 * 1. **叙述** —— payload 的值级 `changes` 拼成「状态 进行中 → 等待中，优先级 P2 → P0」。
 * 2. **合并** —— 一次操作扇出的一串同类事件收成一条带计数的条目，可展开看明细。
 *    🔴 只在渲染层做；`prd.md` 的不变量是「时间线 append-only，纠错用反向事件」。
 * 3. **分档** —— 纯配置/操作记录默认收起。收起 ≠ 删掉，「只追加、可追溯」是这套东西的
 *    立身之本，所以给了一个显式开关，并且**与既有 actor 四档筛选是两个独立维度**。
 */
export function MatterTimeline({ events }: { events: readonly MatterEvent[] }): React.ReactElement {
  const { t } = useTranslation()
  const translate = t as unknown as Translate
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const [showAudit, setShowAudit] = useState(false)
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
  const auditCount = useMemo(
    () => byActor.filter((event) => matterEventTier(event) === 'audit').length,
    [byActor]
  )
  // 🔴 分组在**筛选之后**：看到的就是被合并的，不会出现「合并了一条你看不见的事件」。
  const groups = useMemo(
    () =>
      groupTimelineEvents(
        showAudit ? byActor : byActor.filter((event) => matterEventTier(event) === 'business')
      ),
    [byActor, showAudit]
  )

  const toggleGroup = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  return (
    <section>
      {/* 标题 + 右侧筛选 = 设计稿 `RailLabel right={<Segmented/>}>业务时间线 · 只追加</RailLabel>`。
          🔴 不用仓库的 SectionHeader —— 它是 mono UPPERCASE，且有 CI lint 规则
          `no-cjk-in-mono-size` 禁 CJK；这里沿用 matters 内部同形态的小标题。 */}
      <h2 className="mb-2 flex items-center justify-between gap-3 text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
        <span className="min-w-0 truncate">{t('matters.timeline.sectionTitle')}</span>
        <SegmentedControl<TimelineFilter>
          value={filter}
          onChange={setFilter}
          options={options}
          ariaLabel={t('matters.timeline.filter')}
        />
      </h2>

      {/* 时间轴本体（设计稿 detail.jsx `Timeline`）：一条贯穿竖线 + 每条事件一个圆节点。
          此前是一堆独立卡片，没有任何时间轴形态。竖线 left 15px = 节点半径 11.5 + pl-1 的 4px，
          正好穿过圆心；节点用 bg-ink-0 盖住线，边框按 actor 取色。 */}
      <div className="relative pl-1">
        <span aria-hidden className="absolute bottom-2.5 left-[15px] top-2.5 w-px bg-ink-border" />
        {groups.map((group) => (
          <TimelineRow
            key={group.id}
            group={group}
            t={translate}
            expanded={expanded.has(group.id)}
            onToggle={() => toggleGroup(group.id)}
          />
        ))}
        {groups.length === 0 ? <EmptyState title={t('matters.timeline.empty')} /> : null}
      </div>

      {/* 审计档入口。放在列表下方而不是挤进标题行：标题行已经有四档 actor 筛选，
          再塞一个开关会在窄栏把小标题挤没。 */}
      {auditCount > 0 || showAudit ? (
        <button
          type="button"
          onClick={() => setShowAudit((current) => !current)}
          aria-pressed={showAudit}
          className="mt-1 inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] px-1.5 py-1 text-micro text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-2"
        >
          {showAudit ? <EyeOff size={11} /> : <Eye size={11} />}
          {showAudit
            ? t('matters.timeline.hideAudit')
            : t('matters.timeline.showAudit', { count: auditCount })}
        </button>
      ) : null}
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
  const tone = TIMELINE_TONE[head.actor_kind] ?? TIMELINE_TONE.system
  // 🔴 `const Icon = timelineIcon(...)` + `<Icon/>` 会撞 eslint `react-hooks/static-components`
  // （调用表达式证明不了每次 render 拿到同一个组件身份）。`createElement` 绕开的是**写法**，
  // 不是规则的实质关切 —— 这张表是模块级常量，身份本来就稳定。同 `matterVocab.ts` 的先例。
  const icon = createElement(timelineIcon(head.kind), { size: 11 })
  const sentence = narrateTimelineGroup(group, t)
  const mergedCount = group.events.length

  return (
    <div className="relative flex gap-[11px] py-[7px]" data-testid="matter-timeline-entry">
      <span
        className={cn(
          'z-[1] grid size-[23px] shrink-0 place-items-center rounded-full border bg-ink-0',
          tone,
          group.tier === 'audit' && 'opacity-70'
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div
          className={cn(
            'text-meta leading-[1.55]',
            group.tier === 'audit' ? 'text-ink-fg-2' : 'text-ink-fg-1'
          )}
        >
          {sentence.text}
        </div>
        {sentence.detail ? (
          <div className="mt-0.5 text-meta leading-[1.55] text-ink-fg-3">{sentence.detail}</div>
        ) : null}
        <div className="mt-[3px] flex flex-wrap items-center gap-[7px]">
          <time className="font-mono text-micro text-ink-fg-3">
            {new Date(head.happened_at).toLocaleString()}
          </time>
          {head.actor_kind === 'agent' ? (
            <span className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-ai/10 px-1.5 py-0.5 text-micro text-ai">
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
          {group.tier === 'audit' ? (
            <span className="rounded-[var(--r-pill)] border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-3">
              {t('matters.timeline.auditBadge')}
            </span>
          ) : null}
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
