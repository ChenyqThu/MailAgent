import { createElement, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  BellOff,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  EyeOff,
  FileText,
  History,
  Hourglass,
  Link2,
  ListChecks,
  MessageSquare,
  NotebookPen,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'

import { dayLabelOf, groupByDay, type Translate } from './matterDayGroups'
import { MatterNarrativeBody } from './MatterNarrativeBody'
import {
  groupTimelineEvents,
  narrateEvent,
  narrateTimelineGroup,
  readChanges,
  readFields,
  type TimelineGroup
} from './matterTimelineModel'

type AuditFilter = 'all' | MatterActorKind

/**
 * 节点的 tone 色板（设计 `PROG_KIND[*].color` 的 token 化）。
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

interface EventVisual {
  icon: LucideIcon
  tone: string
}

/**
 * 事件 kind → 操作日志节点的图标与色调。
 *
 * task 08-25 前这是**两张**表：主视图（进展观感）的 `PROGRESS_VISUALS` 与弹窗平铺行的
 * `TIMELINE_ICONS`。进展换成 curated lane 之后，节点样式整体归了操作日志，两张表也就合成
 * 这一张 —— 两张表各覆盖一半 kind、同一个事件在两个面长得不一样，是纯粹的漂移源。
 *
 * 对照关系（右侧注释是设计原型写的语义名）：设计 `progress.jsx` 的 `PROG_KIND` 给出
 * 完成=checkcircle/ok · 新待办=listcheck · 文档更新=filetext/ai · 出现风险=alert/crit ·
 * 进入等待=hourglass/warn · 开始=flag；设计 `AUDIT_ICON` 的 9 个 mock kind 覆盖不到的
 * 那些**不自己发明符号**，一律回到设计稿里同语义位置已经用过的那个：干系人=users ·
 * 对话=message · 接受/拒绝=check/x · 订阅=refresh · 仅元数据=eyeoff · 稍后提醒=bellsnooze。
 * 归不到的走设计稿的兜底 `dot`（`Circle`）。
 */
const EVENT_VISUALS: ReadonlyArray<readonly [RegExp, EventVisual]> = [
  [/^matter_created$/, { icon: Plus, tone: PROGRESS_TONE.neutral }], // created→plus
  [
    /^matter_(archived|reopened|trashed|restored)$/,
    { icon: ArrowRight, tone: PROGRESS_TONE.neutral } // status→arrowright
  ],
  [/^item_/, { icon: ListChecks, tone: PROGRESS_TONE.neutral }], // item→listcheck
  // curated 进展的维护动作（task 08-25）：日志回答的是「谁动了哪一条」，用记事本符号，
  // 不借用五类进展自己的图标 —— 那是**进展本身**的语义，不是「有人改了一条进展」。
  [/^progress_/, { icon: NotebookPen, tone: PROGRESS_TONE.neutral }],
  [/^resource_updated$/, { icon: FileText, tone: PROGRESS_TONE.ai }], // doc→filetext
  [/^resource_suggestion_accepted$/, { icon: Sparkles, tone: PROGRESS_TONE.ai }],
  [/^resource_suggestion_rejected$/, { icon: X, tone: PROGRESS_TONE.neutral }],
  [/^resource_access_policy_changed$/, { icon: EyeOff, tone: PROGRESS_TONE.neutral }], // rail「仅元数据」
  [/^resource_subscription_/, { icon: RefreshCw, tone: PROGRESS_TONE.neutral }], // rail「已订阅后续」
  [/^resource_/, { icon: Link2, tone: PROGRESS_TONE.info }], // resource→link
  [/^stakeholder_/, { icon: Users, tone: PROGRESS_TONE.info }],
  [/^relation_/, { icon: Link2, tone: PROGRESS_TONE.info }],
  [/^chat_scope_/, { icon: MessageSquare, tone: PROGRESS_TONE.neutral }],
  [/^update_proposed$/, { icon: Sparkles, tone: PROGRESS_TONE.ai }],
  [/^update_accepted$/, { icon: CheckCircle2, tone: PROGRESS_TONE.ok }],
  [/^update_rejected$/, { icon: X, tone: PROGRESS_TONE.neutral }],
  [/^update_superseded$/, { icon: ArrowRight, tone: PROGRESS_TONE.neutral }],
  [/^agent_binding_changed$/, { icon: Sparkles, tone: PROGRESS_TONE.neutral }],
  [/^attention_opened$/, { icon: TriangleAlert, tone: PROGRESS_TONE.crit }], // risk→alert
  [/^attention_resolved$/, { icon: CheckCircle2, tone: PROGRESS_TONE.ok }],
  [/^attention_snoozed$/, { icon: BellOff, tone: PROGRESS_TONE.neutral }],
  [/^attention_dismissed$/, { icon: EyeOff, tone: PROGRESS_TONE.neutral }]
]

function eventVisual(event: MatterEvent): EventVisual {
  if (event.kind === 'item_updated') {
    // 勾完成的那条按设计的 item_done（checkcircle/ok）；其余条目改动维持中性。
    const changes = readChanges(event)
    if (changes?.some((change) => change.field === 'status' && change.to === 'done')) {
      return { icon: CheckCircle2, tone: PROGRESS_TONE.ok }
    }
    return { icon: ListChecks, tone: PROGRESS_TONE.neutral }
  }
  if (event.kind === 'matter_updated') {
    // 🔴 这一支**不用**设计 AUDIT_ICON 的 update=filecheck：一条 `matter_updated` 可能是
    // 「进入等待」也可能是「改了摘要」，用一个静态符号等于把句子里已经说清的差别抹平。
    const fields = readFields(event)
    if (fields.includes('waiting_context')) return { icon: Hourglass, tone: PROGRESS_TONE.warn } // wait
    if (fields.includes('status')) return { icon: ArrowRight, tone: PROGRESS_TONE.info }
    return { icon: Send, tone: PROGRESS_TONE.info } // push（我方推进：改摘要/目标/截止…）
  }
  for (const [pattern, visual] of EVENT_VISUALS) {
    if (pattern.test(event.kind)) return visual
  }
  return { icon: Circle, tone: PROGRESS_TONE.neutral } // 设计稿兜底 'dot'
}

/**
 * 操作日志弹窗（设计 progress.jsx `AuditLogModal`）—— **全量** `matter_event`，一条不少。
 *
 * task 08-25：呈现从平铺清单换成进展 tab 原来那套（按天分组 + 贯穿竖线 + kind 定色圆节点
 * + 叙事主句 + 正文卡）。owner 原话：「把现在的进展样式搬到操作日志里」。
 *
 * 0825 dogfood 回修：**同类合并回来了**。上一版有意平铺（判据写的是「回看与追责要逐条
 * 原始记录」），owner 实测的结论相反 —— 一次接受提案扇出十几行、连改标签四行，平铺出来
 * 「日志 UI 体验很不好」。合并**不删任何一条**：一个 burst 里同 kind/同 actor/同来源/同
 * 目标的事件收成一条带计数的条目，展开后逐条明细（各自带各自的正文）一条不少，所以
 * 「可追溯」没有让步，让步的只是默认占多少屏。判定全在 `matterTimelineModel`
 * （`groupTimelineEvents` / `narrateTimelineGroup`），本文件只负责画。
 *
 * 🔴 合并**只在渲染层**：`matter_event` 仍是 append-only，纠错走反向事件。
 * 🔴 **不做业务/审计分档**：弹窗是完整时间线，`matterEventTier` 那一路留给别的面。
 */
export function MatterAuditLogModal({
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
  const [actor, setActor] = useState<AuditFilter>('all')
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
  const list = useMemo(
    () => (actor === 'all' ? events : events.filter((event) => event.actor_kind === actor)),
    [actor, events]
  )
  // 🔴 分组在**筛选之后**：看到的就是被合并的，不会出现「合并了一条你看不见的事件」。
  // `groupTimelineEvents` 内部已按 `happened_at` 排过序（后端 `list_events` 是 id DESC，
  // 不是按时间），这里再按组头排一次是为了满足 `groupByDay` 的前提：**输入必须时间倒序**，
  // 否则相邻切分会切出重复的天头。`sort` 稳定，同一毫秒的组保持分组时的次序。
  const groups = useMemo(
    () =>
      groupTimelineEvents(list).sort(
        (left, right) => right.head.happened_at - left.head.happened_at
      ),
    [list]
  )
  const days = useMemo(() => groupByDay(groups, (group) => group.head.happened_at), [groups])

  const toggleGroup = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 比默认的 max-w-lg 宽一大截：这一屏的行是「主句 + 正文卡 + 元信息 + 明细列表」的
          完整时间线条目，不是一行审计流水。窄容器下正文卡每条都要 clamp，读起来全是省略号。
          `max-w-[calc(100vw-2rem)]` 保证窄窗不溢出（同 MatterLinkResourceModal 的写法）。 */}
      <DialogContent className="max-h-[86vh] w-[820px] max-w-[calc(100vw-2rem)] grid-rows-[auto_auto_1fr]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={14} className="shrink-0 text-ink-fg-2" />
            {t('matters.timeline.auditLog')}
          </DialogTitle>
          <DialogDescription>{t('matters.timeline.auditLogHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <SegmentedControl<AuditFilter>
            value={actor}
            onChange={setActor}
            options={options}
            ariaLabel={t('matters.timeline.filter')}
          />
          <span className="flex-1" />
          {/* 计数说的是**事件条数**（不是合并后的行数）—— 合并是阅读优化，「一共记了多少条」
              这个数字不能跟着缩水，否则日志看起来就像少记了。 */}
          <span className="text-meta text-ink-fg-3">
            {t('matters.timeline.auditCount', { count: list.length })}
          </span>
        </div>
        <div className="min-h-0 overflow-y-auto border-t border-ink-border-soft px-0.5 scrollbar-thin">
          {days.map((day) => (
            <div key={day.key} data-testid="matter-audit-day" className="mt-1.5">
              {/* 天分组头（设计 progress.jsx:179-184）：标签 + 发丝线 + 条数。 */}
              <div className="flex items-center gap-2 px-0.5 pb-0.5 pt-2">
                <span className="text-meta font-medium text-ink-fg-2">
                  {dayLabelOf(day.at, now, locale, translate)}
                </span>
                <span aria-hidden className="h-px flex-1 bg-ink-border-soft" />
                <span className="text-micro text-ink-fg-3">
                  {t('matters.timeline.dayCount', { count: day.rows.length })}
                </span>
              </div>
              {/* 时间轴本体：一条贯穿竖线 + 每条一个按 kind 定色的圆节点。竖线 left 16px =
                  节点半径 12.5 + pl-1 的 4px，正好穿过圆心；节点用 bg-ink-0 盖住线。 */}
              <div className="relative pl-1">
                <span aria-hidden className="absolute bottom-3 left-4 top-3 w-px bg-ink-border" />
                {day.rows.map((group) => (
                  <AuditRow
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
          {list.length === 0 ? (
            <p className="py-6 text-center text-meta text-ink-fg-3">
              {t('matters.timeline.auditEmpty')}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 一条日志条目 = 一个合并组。组内只有一条时它就是那条事件本身（没有展开钮）。
 *
 * 节点图标 / 色调 / 时间戳 / actor 都取 `group.head`（组内**最新**那条）—— 与
 * `narrateTimelineGroup` 算净变化时取的 to 侧是同一条，句子和符号说的是同一件事。
 */
function AuditRow({
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
  const visual = eventVisual(head)
  // 🔴 `const Icon = eventVisual(...)` + `<Icon/>` 会撞 eslint `react-hooks/static-components`
  // （调用表达式证明不了每次 render 拿到同一个组件身份）。`createElement` 绕开的是**写法**，
  // 不是规则的实质关切 —— 这张表是模块级常量，身份本来就稳定。同 `matterVocab.ts` 的先例。
  const icon = createElement(visual.icon, { size: 12 })
  const sentence = narrateTimelineGroup(group, t)
  const mergedCount = group.events.length

  return (
    <div className="relative flex gap-3 py-2" data-testid="matter-audit-entry">
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
        <div className="text-body font-medium leading-[1.5] text-ink-fg">{sentence.text}</div>
        {sentence.detail ? (
          <div className="mt-0.5 text-meta leading-[1.55] text-ink-fg-3">{sentence.detail}</div>
        ) : null}
        {/* 正文紧跟主句、排在时间/来源那行**之前** —— 内容是第一等的，元信息才是脚注。 */}
        {sentence.body ? (
          <MatterNarrativeBody text={sentence.body.text} truncated={sentence.body.truncated} />
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-[7px]">
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
              className="mt-1 inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
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

/**
 * 合并组展开后的单条明细。
 *
 * 🔴 正文只能在这儿露面：计数句本身**不挂正文**（那等于替用户从三条备注里挑一条说
 * 「这就是进展」），少了这一层，「新增了 3 条备注」展开后仍然一个字都读不到。
 */
function MergedEntry({ event, t }: { event: MatterEvent; t: Translate }): React.ReactElement {
  const sentence = narrateEvent(event, t)
  return (
    <li className="text-micro leading-[1.55] text-ink-fg-3">
      <span className="text-ink-fg-2">{sentence.text}</span>
      {sentence.detail ? <span> · {sentence.detail}</span> : null}
      <time className="ml-1.5 font-mono">{new Date(event.happened_at).toLocaleTimeString()}</time>
      {sentence.body ? (
        <MatterNarrativeBody
          text={sentence.body.text}
          truncated={sentence.body.truncated}
          compact
        />
      ) : null}
    </li>
  )
}
