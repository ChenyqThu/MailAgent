/**
 * 今日页五节的行模型（task 08-27 P4c）—— **纯模块**：不 import react / react-query /
 * i18next，只吃各源的响应形状，吐每一节的行。
 *
 * 与 `todayGroups.ts` 的分工：那份是**例外面**的读态分组（等我处理 / 进行中 / 已失效 /
 * 需要留意 / 最近结果），行走 `TodayItemRow`（带行内审批卡、派发回答框、信号 triage 菜单）。
 * 本模块管的是**五节**（按域切）：
 *
 *   decide 等你拍板 —— 读态组 waiting + expired（`TodayItemRow`）
 *   meet   今天的会 —— 日历 agenda 当天窗口（本模块的 `TodaySectionItem`）
 *   reply  待回邮件 —— `GET /api/today` 的 reply 块
 *   due    临期事项 —— 关注信号里**与临期直接相关的三个 kind**（`TodayItemRow`，保住 triage 菜单）
 *   out    智能体产出 —— 当天报告 + 读态组 inProgress / attention / recent
 *
 * 🔴 两套行模型并存是有意的：decide / due / out 的 run 与信号必须保留行内动作面
 * （批准 / 回答 / 解决），换成简化行等于把批次 2-3 做的事拆掉；meet / reply / 报告
 * 没有行内动作，用不上那一套。
 *
 * 🔴 时间单位：本模块的 `atMs` 恒毫秒。跨源折算一律走 `epochToMs`（`async_jobs` 是秒
 * float、`matter_*` 是毫秒 int、`report.generated_at` 是秒）—— 同 `todayGroups` 的纪律。
 */

import type { AgendaEntry, ReportListItem } from '@shared/api/types'
import type { MatterAttentionKind } from '@shared/api/types/matter'
import type { TodayReplyItem } from '@shared/api/types/today'
import { TODAY_SECTIONS, type TodaySectionId } from '@shared/state/today-section'

import {
  epochToMs,
  type TodayGroup,
  type TodayGroupId,
  type TodayItem,
  type TodaySignalItem,
  type Translate
} from './todayGroups'

// ── 读态组 → 节 ────────────────────────────────────────────────────────────

/**
 * 每一节吃哪几个读态组。**表驱动**（同 `TODAY_GROUP_IDS` 的取向：组序是产品语义，
 * 不是算出来的）。
 *
 * · `waiting` / `expired` → decide：都是「球在你这边」，`expired` 是它诚实的死亡分支。
 * · `inProgress` / `attention` / `recent` → out：智能体这边的动静 —— 在跑的、挂了的、
 *   出了东西的。把失败的 run 放进「产出」看着别扭，但它确实是 agent 的消息，塞进
 *   「等你拍板」更糟（你拍不了板，只能去看它为什么挂）。
 * · meet / reply 没有读态组（数据不来自那四条源）。
 */
export const SECTION_READ_STATE_GROUPS: Readonly<Record<TodaySectionId, readonly TodayGroupId[]>> =
  {
    decide: ['waiting', 'expired'],
    meet: [],
    reply: [],
    due: [],
    out: ['inProgress', 'attention', 'recent']
  }

/**
 * 「临期事项」认哪几种关注信号。
 *
 * 判据来自后端 `src/matters/attention.py::_collect_facts` —— 这三种 kind 的产生条件
 * 就是「快到期 / 已逾期 / 等太久」，而且**每种都自带一句后端写好的 reason**
 * （「事项今天到期」/「行动项『X』已逾期 3 天」），直接就是这一节要的「为什么是今天」。
 *
 * 其余四种（`needs_review` / `run_failed` / `context_gap` / `health_down`）留在 decide：
 * 它们要的是你拿主意，不是提醒你时间快到了。
 *
 * switch 无 default —— 新增 kind 时 tsc 当场红，逼人显式定它归哪一节。
 */
export function isDueSignalKind(kind: MatterAttentionKind): boolean {
  switch (kind) {
    case 'deadline_near':
    case 'action_overdue':
    case 'wait_overdue':
      return true
    case 'needs_review':
    case 'run_failed':
    case 'context_gap':
    case 'health_down':
      return false
  }
  return false
}

/** 一条行是不是该被 due 节接走。只有信号型可能是。 */
function isDueItem(item: TodayItem): item is TodaySignalItem {
  return item.source === 'signal' && isDueSignalKind(item.kind)
}

/**
 * 把例外面的分组结果拆成「decide/out 继续用的组」与「due 节接走的信号」。
 *
 * 为什么在分组之后拆而不是分组之前：`groupTodayItems` 的组内排序（severity + 等龄）
 * 对 due 节同样成立，拆出来的行保持原序即可 —— 分组前拆就得把那套排序抄一遍。
 */
export function splitDueSignals(groups: readonly TodayGroup[]): {
  groups: TodayGroup[]
  due: TodaySignalItem[]
} {
  const rest: TodayGroup[] = []
  const due: TodaySignalItem[] = []
  for (const group of groups) {
    const kept = group.items.filter((item) => {
      if (!isDueItem(item)) return true
      due.push(item)
      return false
    })
    if (kept.length > 0) rest.push({ id: group.id, items: kept })
  }
  return { groups: rest, due }
}

// ── 简化行（meet / reply / 报告） ──────────────────────────────────────────

export type TodaySectionLink =
  | { kind: 'mail'; internalId: number }
  | { kind: 'calendar' }
  | { kind: 'report'; reportId: string }

export interface TodaySectionItem {
  /** 跨源唯一（`{source}:{源实体主键}`）—— 同 `TodayItemBase` 的身份纪律。 */
  id: string
  source: 'mail' | 'calendar' | 'report'
  title: string
  /** 一等字段：**为什么是今天**。空串 = 组装不出，渲染面按缺席处理，不编一句话填上。 */
  why: string
  /** 右侧次要串（时间 / 发件人）。空串 = 不渲染。 */
  meta: string
  /** 🔴 恒毫秒。 */
  atMs: number
  /** true → accent 描边 + 右侧动作按钮（design §十「条目分两级」）。 */
  actionable: boolean
  link: TodaySectionLink
}

export interface TodaySectionBuildContext {
  t: Translate
  /** 毫秒 → 「HH:MM」。locale 相关，注入进来让本模块保持纯（也让测试可断言）。 */
  formatTime: (ms: number) => string
  /** 时长毫秒 → 「26 小时前」式相对串（注入 `ageLabel`）。 */
  formatAge: (ms: number) => string
}

/** 「今天的会」。入参已是当天窗口的 agenda（本节只取邮箱日历源 —— 事项截止归 due 节、
 *  agent 排程归 out 节，同一件事不出现两遍）。 */
export function buildMeetItems(
  entries: readonly AgendaEntry[],
  nowMs: number,
  ctx: TodaySectionBuildContext
): TodaySectionItem[] {
  const items: TodaySectionItem[] = []
  for (const entry of entries) {
    if (entry.source !== 'mail') continue
    const startMs = Date.parse(entry.startIso)
    // 时刻解析不了 = 排不了序也说不出「几点」——「为什么是今天」就只剩空话，不渲染。
    if (!Number.isFinite(startMs)) continue
    const time = entry.allDay ? ctx.t('today.meet.allDay') : ctx.formatTime(startMs)
    items.push({
      id: `calendar:${entry.id}`,
      source: 'calendar',
      title: entry.title || ctx.t('today.meet.untitled'),
      why: ctx.t(startMs >= nowMs ? 'today.why.meetUpcoming' : 'today.why.meetPast', { time }),
      meta: time,
      atMs: startMs,
      // 会议本身没有「在这一行做完」的动作（加入链接不在 agenda 投影里）——
      // 它是知会型，平铺不加动作钮。
      actionable: false,
      link: { kind: 'calendar' }
    })
  }
  items.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return items
}

/** 「待回邮件」。`why` 由后端组装（跨线程全历史判「已回」+ 等龄），前端只做形状转换 ——
 *  在这里再拼一遍就是第二个口径。 */
export function buildReplyItems(reply: readonly TodayReplyItem[]): TodaySectionItem[] {
  const items: TodaySectionItem[] = []
  for (const row of reply) {
    const atMs = Date.parse(row.atIso)
    if (!Number.isFinite(atMs)) continue
    items.push({
      id: row.id,
      source: 'mail',
      title: row.title,
      why: row.why,
      meta: row.meta,
      atMs,
      actionable: row.actionable,
      link: { kind: 'mail', internalId: row.link.internalId }
    })
  }
  return items
}

/** 「智能体产出」里的报告部分（当天生成的那几份）。 */
export function buildReportItems(
  reports: readonly ReportListItem[],
  window: { startMs: number; endMs: number },
  ctx: TodaySectionBuildContext
): TodaySectionItem[] {
  const items: TodaySectionItem[] = []
  for (const report of reports) {
    const atMs = epochToMs(report.generated_at ?? report.created_at)
    if (atMs < window.startMs || atMs >= window.endMs) continue
    // 🔴 `report` 行没有触发字段（无 schedule/manual 之分，P4a 已记）——「昨夜自动生成」
    // 这类话标不出来，只说是哪一档报告。
    items.push({
      id: `report:${report.id}`,
      source: 'report',
      title: report.headline || ctx.t(`agents.cadence.${report.cadence}`),
      why: ctx.t('today.why.report', { cadence: ctx.t(`agents.cadence.${report.cadence}`) }),
      meta: ctx.formatTime(atMs),
      atMs,
      actionable: false,
      link: { kind: 'report', reportId: report.id }
    })
  }
  items.sort((a, b) => b.atMs - a.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return items
}

// ── 节视图 ────────────────────────────────────────────────────────────────

export interface TodaySectionView {
  id: TodaySectionId
  /** 走 `TodayItemRow` 的行（保留行内审批 / 回答 / triage 菜单），按读态组分块。 */
  groups: TodayGroup[]
  /** 走 `TodaySectionRow` 的行。 */
  rows: TodaySectionItem[]
  /** 二级栏的计数 = 这一节屏幕上的行数。**唯一来源**：nav 与主区读同一个字段，
   *  两处各算一遍必然漂开。 */
  count: number
  /** 二级栏第二行。空串 = 不渲染（算不出一句有信息量的就别占一行）。 */
  meta: string
}

function countOf(groups: readonly TodayGroup[], rows: readonly TodaySectionItem[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0) + rows.length
}

export interface TodaySectionsInput {
  /** `groupTodayItems` 的产物（未拆 due）。 */
  groups: readonly TodayGroup[]
  meet: readonly TodaySectionItem[]
  reply: readonly TodaySectionItem[]
  reports: readonly TodaySectionItem[]
}

/**
 * 五节视图。顺序 = `TODAY_SECTIONS`（二级栏与主区共用那份词表）。
 *
 * meta 只给算得出一句有信息量的两节：
 *   · meet —— 下一场几点（已经全部开完就不给）
 *   · reply —— 最久的那封等了多久
 * decide / due / out 没有这样的一句 ⇒ 空串，二级栏那一行只有标题 + 计数。
 * **不用「N 件待处理」凑数** —— 那是把右边的计数换个说法再写一遍。
 */
export function buildTodaySections(
  input: TodaySectionsInput,
  nowMs: number,
  ctx: TodaySectionBuildContext
): TodaySectionView[] {
  const split = splitDueSignals(input.groups)
  const byGroupId = new Map<TodayGroupId, TodayGroup>(split.groups.map((g) => [g.id, g]))
  const pick = (id: TodaySectionId): TodayGroup[] =>
    SECTION_READ_STATE_GROUPS[id]
      .map((gid) => byGroupId.get(gid))
      .filter((g): g is TodayGroup => g !== undefined)

  const decideGroups = pick('decide')
  const outGroups = pick('out')
  // 🔴 组 id 用 `waiting` 而不是另编一个：这些信号**本来就在** `waiting` 组（`todayGroupOf`
  // 把所有信号归那一组），due 节只是把其中「临期」那三种 kind 接走。改成别的 id 会让
  // `TodayItemRow` 的色调与它在例外面时不一致，也会让 `data-group` 说一句不实的话。
  const dueGroups: TodayGroup[] = split.due.length > 0 ? [{ id: 'waiting', items: split.due }] : []

  const nextMeet = input.meet.find((item) => item.atMs >= nowMs)
  const oldestReply = input.reply.reduce<TodaySectionItem | null>(
    (acc, item) => (acc === null || item.atMs < acc.atMs ? item : acc),
    null
  )

  // 🔴 先落成 `Record<TodaySectionId, …>` 再按 `TODAY_SECTIONS` 铺开：往词表里加一节
  // 而忘了在这里给它内容，tsc 当场红（直接 return 数组的写法只会静默少一节，二级栏那一行
  // 点了什么也不出现）。顺序单源是词表，不是这里的书写顺序。
  const views: Record<TodaySectionId, TodaySectionView> = {
    decide: {
      id: 'decide',
      groups: decideGroups,
      rows: [],
      count: countOf(decideGroups, []),
      meta: ''
    },
    meet: {
      id: 'meet',
      groups: [],
      rows: [...input.meet],
      count: input.meet.length,
      meta: nextMeet ? ctx.t('today.meta.nextMeet', { time: nextMeet.meta }) : ''
    },
    reply: {
      id: 'reply',
      groups: [],
      rows: [...input.reply],
      count: input.reply.length,
      // 最久那封的 `why` 后半段就是「等了 N 小时」，但那是后端组的整句；二级栏这一行
      // 只要时间，所以按 atMs 现算 —— 不去切后端那句话（切串是最容易碎的解析）。
      meta: oldestReply
        ? ctx.t('today.meta.oldestReply', { age: ctx.formatAge(nowMs - oldestReply.atMs) })
        : ''
    },
    due: {
      id: 'due',
      groups: dueGroups,
      rows: [],
      count: countOf(dueGroups, []),
      meta: ''
    },
    out: {
      id: 'out',
      groups: outGroups,
      rows: [...input.reports],
      count: countOf(outGroups, input.reports),
      meta: ''
    }
  }
  return TODAY_SECTIONS.map((id) => views[id])
}

// ── 「还剩多久」 ──────────────────────────────────────────────────────────

/**
 * 剩余毫秒 → 「2 小时 40 分」/「18 分钟」。已经开始了返**空串**（调用方换一句
 * 「已经开始」，不显示负数）。
 *
 * 住在这个纯模块而不是 `TodayNextHardPoint.tsx`：组件文件里导出非组件会被
 * react-refresh 判成「Fast refresh 失效」（同 `ageLabel.ts` 从 AgentRecordView 拆出来的
 * 那次），而且这样它才测得动。
 */
export function remainingLabel(t: Translate, ms: number): string {
  if (ms <= 0) return ''
  const mins = Math.floor(ms / 60_000)
  const hours = Math.floor(mins / 60)
  if (hours <= 0) return t('today.next.inMinutes', { n: Math.max(1, mins) })
  const rest = mins % 60
  // 整点时不写「2 小时 0 分」—— 那个 0 是算出来的，不是要说的。
  return rest === 0
    ? t('today.next.inHoursOnly', { h: hours })
    : t('today.next.inHours', { h: hours, m: rest })
}
