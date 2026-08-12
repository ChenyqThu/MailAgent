/**
 * 事项时间线的**叙述层**：把 `matter_event` 行翻成「发生了什么」的句子、把一次操作产生的
 * 一串事件合并成一条、并把纯操作记录从业务历史里分出来。
 *
 * 为什么单独一个纯模块（不放进组件）：这三件事都是**逐 kind 的判定**，只有拿到 DOM 之外
 * 才测得动 —— 38 种 kind × (老行 / 新行 / 空 changes) 的组合用渲染测试写不完。
 *
 * 🔴 三条后端契约，改这里之前先读 `src/matters/event_changes.py` 的模块 docstring：
 *
 * 1. **`changes` 键不在 = 老行**（本批之前写入的事件），降级到 `fields` 字段名渲染。
 *    绝不能因为读不到值就渲染空句子。
 * 2. **`changes: []` 是有效值**，不是老行 —— 例如 `item_deleted` 的标识在 `title` 上、
 *    动作由 kind 自己叙述；`matter_updated` 只改了 `schedule_json` 这类结构化字段时
 *    `changes` 也是空的。两者都必须还能出句子。
 * 3. **`from` 键在且为 `null`** = 之前确实是空；**`from` 键不在** = 前像不可知
 *    （新建对象 / 调用方没给前像）。两者句式不同，不许合并。
 *
 * 值一律是**原始值**（枚举字面量、时间戳数字），本地化在这一层做。档位名复用既有
 * `matters.status.*` / `matters.health.*` / `matters.item.kinds.*`，不新造一套。
 */

import type { MatterEvent } from '@shared/api/types/matter'

/** 只要 key + 插值，故不引 i18next 的 TFunction 类型（那会把纯模块拽上 react-i18next）。 */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** 业务级默认显示，审计级默认收起 —— 混在一起正是 owner 说的「像 audit log」的根源。 */
export type MatterEventTier = 'business' | 'audit'

export interface MatterEventChange {
  field: string
  /** 🔴 键**在**（哪怕值是 `null`）= 前像已知；键不在 = 前像不可知。 */
  from?: unknown
  to: unknown
  /**
   * **老 payload** 的单个截断标记：只说明「这条里有值被截断」，说不出是哪一侧。
   * 🔴 不许据此推断侧别 —— 旧值恰好 120 字、新值 121 字被截到 120 字时两侧长度相同，
   * 按「谁最长谁被截」去猜会给没被截断的那一侧也加省略号（谎称它也被截断）。
   *
   * 后端已改口径：新行**不再发** `truncated`，改发下面两个分侧键；历史行不回填。
   * 所以 `truncated` 键在不在，就是「这条 entry 是老行还是新行」的判据（见 `readChanges`）。
   */
  truncated?: boolean
  /** 新 payload 的分侧标记（`from_truncated` / `to_truncated`），各自只在那一侧真被截断时
   *  出现。有它才敢标省略号。 */
  fromTruncated?: boolean
  toTruncated?: boolean
}

export interface TimelineSentence {
  /** 主句：「发生了什么」。 */
  text: string
  /** 次级说明（第二行小字）：老行降级的字段名清单、拒绝理由、Agent 给的关联理由。 */
  detail?: string
}

export interface TimelineGroup {
  /**
   * 组的稳定标识：语义分组键 + burst 内**最老**一条的 id。
   *
   * 🔴 不能用 `head.id`：同一个 burst 里新到一条更新的事件会换掉 head ⇒ 标识变了 ⇒
   * 调用方按标识记的展开态对不上，已展开的明细会**无提示地收起**。最老那条只要还在
   * 这一组里就不变，新增较新成员时标识保持稳定。
   */
  id: string
  /** 组内**最新**的那条 —— 圆点图标 / actor 配色 / 时间戳都取它。 */
  head: MatterEvent
  /** 新到旧。长度 1 = 没有合并。 */
  events: readonly MatterEvent[]
  tier: MatterEventTier
}

/* -------------------------------------------------------------------------- */
/* payload 安全读取                                                            */
/* -------------------------------------------------------------------------- */

function payloadOf(event: MatterEvent): Record<string, unknown> {
  const payload: unknown = event.payload
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/** 非空字符串，否则 `null`。空串与缺失在渲染上是同一件事（都写不出标识）。 */
function readText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readCount(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (Array.isArray(value)) return value.length
  return null
}

/** 本次 patch 触及的字段名。老行与新行都有，是降级渲染的唯一依据。 */
export function readFields(event: MatterEvent): string[] {
  const fields = payloadOf(event).fields
  if (!Array.isArray(fields)) return []
  return fields.filter((field): field is string => typeof field === 'string' && field.length > 0)
}

/**
 * → `null` 表示**老行**（payload 里根本没有 `changes` 键）；`[]` 表示新行但没有可叙述的
 * 值级变更。调用方必须分开处理这两种（契约纪律 1 / 2）。
 *
 * 🔴 非空数组里只要有**一个**条目不合形状（非对象 / 缺 `field` / 缺 `to`），整份
 * `changes` 判为不可信 ⇒ 返回 `null` 走字段名降级。跳过坏条目会**隐藏字段**：
 * `fields:['status','priority']` + `changes:[{status…}, null]` 会只叙述状态、优先级
 * 整个消失，而句子读起来像完整的。宁可降级也不要说半句真话。
 */
export function readChanges(event: MatterEvent): MatterEventChange[] | null {
  const payload = payloadOf(event)
  if (!('changes' in payload)) return null
  const raw = payload.changes
  // 形状非法一律当老行 —— 宁可降级到字段名，也不要把脏数据当变更详情渲染出去。
  if (!Array.isArray(raw)) return null
  const changes: MatterEventChange[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    const field = record.field
    if (typeof field !== 'string' || field.length === 0) return null
    if (!('to' in record)) return null
    const change: MatterEventChange = { field, to: record.to }
    if ('from' in record) change.from = record.from
    // 🔴 新老由 **entry 整体**判，不按键逐个回落：`truncated` 键在 = 老行（那一版后端
    // 只写这一个不分侧的布尔），键不在 = 新行（只写 `from_truncated`/`to_truncated`，
    // 各自只在那一侧真被截断时出现）。逐侧回落（`from_truncated ?? truncated`）会在
    // 「只有 to 被截」的新行上把 `truncated` 派给 from 侧 —— 正好把这里要修的谎话复现。
    if ('truncated' in record) {
      if (record.truncated === true) change.truncated = true
    } else {
      if (record.from_truncated === true) change.fromTruncated = true
      if (record.to_truncated === true) change.toTruncated = true
    }
    changes.push(change)
  }
  return changes
}

/* -------------------------------------------------------------------------- */
/* 业务 / 审计分档                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 纯配置/纯操作记录 —— 默认收起，但**必须可达**（「只追加、可追溯」是这套东西的立身之本）。
 * `matter_updated` 不在这里，它按触及的字段二次判定（见 `matterEventTier`）。
 */
const AUDIT_KINDS: ReadonlySet<string> = new Set([
  // 🔴 chat_scope_* 的**产出路径已退役**（0812：事项对话的检索范围开关整体移除，写侧端点与
  // service 方法都已删）。这两个 kind 与下面 narrate 的分支**保留仅为渲染历史事件** —— 活库里
  // 已经有这样的事件行，删掉判定就只剩兜底文案。
  'chat_scope_expanded',
  'chat_scope_restored',
  'resource_access_policy_changed',
  'resource_subscription_paused',
  'resource_subscription_resumed',
  'agent_binding_changed',
  'attention_snoozed',
  'attention_dismissed'
])

/**
 * `matter_updated` 触及这些字段才算业务变化。
 *
 * 比 PRD 给的清单多三个：`description`（核心目标）/ `waiting_context`（等待原因）/
 * `goal_checks`（完成标志）—— 它们和 status/priority 一样长在 StateCard 上、一样是
 * 「事项现在怎么回事」的一部分；把改核心目标算成操作记录会把真业务变更藏起来。
 * 反过来 `tags` / `agent_*` / `schedule_json` / `next_attention_at` / `attention_reason`
 * 是配置，留在审计档。
 */
const BUSINESS_MATTER_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'current_summary',
  'status',
  'health',
  'priority',
  'matter_type',
  'due_at',
  'goal_checks',
  'waiting_context'
])

export function matterEventTier(event: MatterEvent): MatterEventTier {
  if (AUDIT_KINDS.has(event.kind)) return 'audit'
  if (event.kind !== 'matter_updated') return 'business'
  const fields = readFields(event)
  // 🔴 老行可能连 `fields` 都没有 —— 判据缺失时算业务级：宁可多显示一行，
  // 也不要把一条读不懂的事件默默藏进折叠区。
  if (fields.length === 0) return 'business'
  return fields.some((field) => BUSINESS_MATTER_FIELDS.has(field)) ? 'business' : 'audit'
}

/* -------------------------------------------------------------------------- */
/* 同类合并                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 相邻两条之间的最大间隔。活库实测的重复形态最长是「连改标签 25 秒内 4 条」，
 * 60s 留了一个数量级余量。
 */
export const TIMELINE_BURST_GAP_MS = 60_000

/**
 * 一个 burst 的最大跨度。只有相邻间隔约束时，用户每 50 秒操作一次能把一小时的操作
 * 链成一组；跨度上限把「语义上独立」的两次操作切开 —— 隔了两分钟就是两件事。
 */
export const TIMELINE_BURST_SPAN_MS = 120_000

/**
 * 合并判据（🔴 **只在渲染层**：`prd.md` 的架构不变量是「时间线 append-only，纠错用
 * 反向事件」，这里一行都不写库、不改后端）：
 *
 * 1. 先按 `happened_at` 排序（后端给的是 id DESC），再按时间切成 **burst** —— 相邻间隔
 *    > 60s，或距 burst 内最新一条 > 120s，就开一个新 burst。
 * 2. burst 内按 `kind | actor_kind | actor_id | source | 目标对象身份` 分组
 *    （最后一段见 `groupTarget`）。
 *
 * 为什么用「burst + 组内聚合」而不是「相邻同类才合并」：接受提案的扇出里 per-change
 * 事件是**交替出现**的（matter_updated / item_created / matter_updated 同毫秒），
 * 严格相邻会把它们切成三条。burst 内聚合能收拢，又不会跨越时间边界。
 *
 * 为什么不会误合语义上独立的事件：两次操作只要间隔超过 60s（或整段超过 120s）就
 * 结构性落在不同 burst；`actor_id` / `source` 进 key 保证「我改的」和「Agent 改的」、
 * 「桌面端」和「定时跟进」永远不混。
 */
export function groupTimelineEvents(events: readonly MatterEvent[]): TimelineGroup[] {
  // 🔴 先按时间排一遍再切 burst。后端 `list_events` 是 `ORDER BY id DESC`，**不是**按时间：
  // 时钟漂移让更晚写入的一行带上更早的时间戳时，负的相邻差被 `Math.max(0, …)` 夹成 0，
  // 于是相隔一小时的两条**照样合并**（夹取只防住了「burst 被无限拉长」，没防住误合并）。
  // 入参是 readonly，复制后排；只按时间排、不加 id 次序 —— `Array.prototype.sort` 是稳定的
  // （ES2019 起是规范要求），同一毫秒的那些事件因此保持调用方给的顺序，也就是后端的 id DESC。
  const ordered = [...events].sort((left, right) => right.happened_at - left.happened_at)
  const groups: TimelineGroup[] = []
  let burst: MatterEvent[] = []

  const flush = (): void => {
    if (burst.length === 0) return
    const byKey = new Map<string, MatterEvent[]>()
    for (const event of burst) {
      const key = groupKey(event)
      const bucket = byKey.get(key)
      if (bucket) bucket.push(event)
      else byKey.set(key, [event])
    }
    for (const [key, bucket] of byKey) {
      groups.push({
        id: `${key}${KEY_SEP}${bucket[bucket.length - 1].id}`,
        head: bucket[0],
        events: bucket,
        tier: groupTier(bucket)
      })
    }
    burst = []
  }

  for (const event of ordered) {
    if (burst.length > 0) {
      const previous = burst[burst.length - 1].happened_at
      const newest = burst[0].happened_at
      const gap = previous - event.happened_at
      const span = newest - event.happened_at
      if (gap > TIMELINE_BURST_GAP_MS || span > TIMELINE_BURST_SPAN_MS) flush()
    }
    burst.push(event)
  }
  flush()
  return groups
}

/**
 * 组的档位：任一成员是业务级，整组就是业务级。
 *
 * 🔴 不能只看 `bucket[0]`（最新那条）：最新一条 `matter_updated` 只改了 `tags`（审计档）、
 * 10 秒前那条改了 `status`（业务档）时，按最新条判会把**真业务变更**按操作记录处理。
 * 这与单条事件已有的「混合 patch 业务优先」是同一条纪律，只是漏了组这一层。
 */
function groupTier(events: readonly MatterEvent[]): MatterEventTier {
  return events.some((event) => matterEventTier(event) === 'business') ? 'business' : 'audit'
}

/** 分组键的字段分隔符。用 NUL 是为了不与任何字段值撞车；🔴 写成转义序列，别把裸字节
 *  敲进源文件（那会让 `file` 把这个 .ts 判成 data、`grep`/`rg` 默认跳过它，
 *  而 git 的二进制探测只看前 8000 字节 —— 上面一涨，diff 就会变成 Binary files differ）。 */
const KEY_SEP = '\u0000'

function groupKey(event: MatterEvent): string {
  return [
    event.kind,
    event.actor_kind,
    event.actor_id ?? '',
    event.source,
    groupTarget(event)
  ].join(KEY_SEP)
}

/**
 * 分组键的第五段：同一 kind 内**不可混谈**的维度。
 *
 * 🔴 值级净变化只允许在同一个目标对象内计算。少了这一段，同一分钟里「条目 A open→done」
 * 与「条目 B waiting→blocked」会落进同一组，净变化算出「状态 等待中 → 已完成」——
 * 这个变化在**任何一个条目上都没发生过**，而且合并句连是哪个条目都说不出来。
 *
 * 计数类的 kind（「关联了 6 份资料」）**有意不带对象身份**：那种句子本来就是跨对象的，
 * 加了身份等于把合并关掉。
 */
function groupTarget(event: MatterEvent): string {
  const payload = payloadOf(event)
  switch (event.kind) {
    case 'matter_updated':
    case 'agent_binding_changed':
      // 一条时间线只属于一个事项，这段是恒定的；写出来是为了让「谁是目标」显式。
      return `matter:${event.matter_id}`
    case 'item_updated':
      return objectKey('item', event.item_id ?? readIdentifier(payload, 'item_id'), event)
    case 'stakeholder_updated':
      return objectKey('stakeholder', readIdentifier(payload, 'stakeholder_id'), event)
    case 'resource_updated':
      // 「确认关联」与「检出新版本」是两句话（见 `narrateEvent` 的 `confirmed` 分支）。
      // 混在一组时计数模板会凭空说出「N 份资料有新版本」——一次接受提案确认两份资料就撞上。
      return payload.confirmed === true ? 'confirmed' : 'updated'
    default:
      return ''
  }
}

function readIdentifier(payload: Record<string, unknown>, key: string): string | number | null {
  const value = payload[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

/** 身份不可知 ⇒ 退化成「只和自己一组」：宁可多出一行，也不要把两个对象的值级变更
 *  合成一条谁身上都没发生过的净变化。 */
function objectKey(prefix: string, id: string | number | null, event: MatterEvent): string {
  return id === null ? `${prefix}#event:${event.id}` : `${prefix}:${id}`
}

/* -------------------------------------------------------------------------- */
/* 值的本地化                                                                  */
/* -------------------------------------------------------------------------- */

/** 变更子句里字段值的形状。`domain` 决定同名字段查哪张词表（item 的 status ≠ matter 的）。 */
type ChangeDomain = 'matter' | 'item' | 'stakeholder'
type FieldShape =
  | 'status'
  | 'itemStatus'
  | 'health'
  | 'priority'
  | 'itemKind'
  | 'date'
  | 'bool'
  | 'tags'
  | 'longText'
  | 'text'

function fieldShape(field: string, domain: ChangeDomain): FieldShape {
  if (field === 'status') return domain === 'item' ? 'itemStatus' : 'status'
  if (field === 'health') return 'health'
  if (field === 'priority') return 'priority'
  if (field === 'kind') return 'itemKind'
  if (field === 'due_at' || field === 'next_attention_at' || field === 'completed_at') return 'date'
  if (field === 'agent_enabled' || field === 'is_waiting_on') return 'bool'
  if (field === 'tags') return 'tags'
  if (field === 'description' || field === 'current_summary' || field === 'matter_instructions') {
    return 'longText'
  }
  return 'text'
}

function fieldLabel(field: string, t: Translate): string {
  return t(`matters.eventField.${field}`, { defaultValue: field })
}

const ELLIPSIS = '…'

/** 变更子句渲染的是哪一侧的值。截断标记是**分侧**的，两侧不能共用一个判据。 */
type ChangeSide = 'from' | 'to'

/**
 * 这一侧的值被截断了吗。
 *
 * 判据只认后端的分侧标记（`from_truncated` / `to_truncated`）。🔴 **不许按长度推断**：
 * 后端对两侧独立截断到同一上限，旧值恰好 120 字、新值 121 字被截成 120 字时两侧一样长，
 * 「谁最长谁被截」会给两边都加省略号 —— 谎称没被截的那一侧也被截了。
 */
function isSideTruncated(change: MatterEventChange, side: ChangeSide): boolean {
  return side === 'from' ? change.fromTruncated === true : change.toTruncated === true
}

/**
 * 老 payload（只有单个 `truncated` 布尔）：知道「这条里有值被截断」，但不知道是哪一侧。
 * 这种时候不猜侧别，改由句尾一个中性提示承载（见 `changeClause`）。
 */
function hasUnsidedTruncation(change: MatterEventChange): boolean {
  return change.truncated === true && change.fromTruncated !== true && change.toTruncated !== true
}

function joinCapped(
  parts: readonly string[],
  cap: number,
  t: Translate,
  separator: string
): string {
  if (parts.length <= cap) return parts.join(separator)
  const shown = parts.slice(0, cap).join(separator)
  return `${shown}${separator}${t('matters.narrative.change.more', { count: parts.length - cap })}`
}

/** 值 → 展示串。`null` = 这一侧是空（未设置 / 清空），由调用方选清空句式。 */
function renderValue(
  raw: unknown,
  shape: FieldShape,
  change: MatterEventChange,
  side: ChangeSide,
  t: Translate
): string | null {
  if (raw === null || raw === undefined) return null
  switch (shape) {
    case 'status':
      return t(`matters.status.${String(raw)}`, { defaultValue: String(raw) })
    case 'itemStatus':
      return t(`matters.narrative.itemStatus.${String(raw)}`, { defaultValue: String(raw) })
    case 'health':
      return t(`matters.health.${String(raw)}`, { defaultValue: String(raw) })
    case 'itemKind':
      return t(`matters.item.kinds.${String(raw)}`, { defaultValue: String(raw) })
    case 'priority':
      return String(raw).toUpperCase()
    case 'date': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
      return new Date(raw).toLocaleDateString()
    }
    default: {
      const text = String(raw).trim()
      if (text.length === 0) return null
      const shown = isSideTruncated(change, side) ? `${text}${ELLIPSIS}` : text
      return t('matters.narrative.quoteValue', { text: shown })
    }
  }
}

function changeClause(
  change: MatterEventChange,
  domain: ChangeDomain,
  t: Translate
): string | null {
  const shape = fieldShape(change.field, domain)
  const clause = buildChangeClause(change, shape, t)
  if (clause === null) return null
  // 老 payload 只说得出「有值被截断」⇒ 句尾挂一个中性提示，不指侧别。只在句子里真的
  // 写了值的形态上挂：长文本 / 布尔本来就不展示值，挂上去只是噪音。
  const showsValues = shape !== 'longText' && shape !== 'bool'
  return showsValues && hasUnsidedTruncation(change)
    ? `${clause}${t('matters.narrative.change.truncatedHint')}`
    : clause
}

function buildChangeClause(
  change: MatterEventChange,
  shape: FieldShape,
  t: Translate
): string | null {
  const label = fieldLabel(change.field, t)
  if (shape === 'tags') return tagsClause(change, label, t)
  if (shape === 'bool') return booleanClause(change, label, t)
  if (shape === 'longText') return longTextClause(change, label, t)

  const to = renderValue(change.to, shape, change, 'to', t)
  const hasFrom = 'from' in change
  const from = hasFrom ? renderValue(change.from, shape, change, 'from', t) : null

  if (to === null) {
    if (!hasFrom) return null // 「设成了空」且不知道原来是什么 —— 没有可叙述的内容
    if (from === null) return null // 空 → 空，不是变更
    return t('matters.narrative.change.cleared', { field: label, from })
  }
  if (!hasFrom) return t('matters.narrative.change.set', { field: label, to })
  if (from === null) return t('matters.narrative.change.filled', { field: label, to })
  return t('matters.narrative.change.pair', { field: label, from, to })
}

function booleanClause(change: MatterEventChange, label: string, t: Translate): string | null {
  if (typeof change.to !== 'boolean' && typeof change.to !== 'number') return null
  const on = Boolean(change.to)
  return t(on ? 'matters.narrative.change.boolOn' : 'matters.narrative.change.boolOff', {
    field: label
  })
}

function longTextClause(change: MatterEventChange, label: string, t: Translate): string | null {
  // 长文本不把 120 字塞进时间线一行 —— 只说「填了 / 改写了 / 清空了」，正文在状态卡上。
  const to = typeof change.to === 'string' ? change.to.trim() : ''
  const hasFrom = 'from' in change
  const from = typeof change.from === 'string' ? change.from.trim() : ''
  if (to.length === 0) {
    if (!hasFrom || from.length === 0) return null
    return t('matters.narrative.change.textCleared', { field: label })
  }
  if (!hasFrom) return t('matters.narrative.change.textSet', { field: label })
  if (from.length === 0) return t('matters.narrative.change.textFilled', { field: label })
  return t('matters.narrative.change.textRewritten', { field: label })
}

function asStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function tagsClause(change: MatterEventChange, label: string, t: Translate): string | null {
  const to = asStringList(change.to)
  if (to === null) return null
  const from = 'from' in change ? asStringList(change.from) : null
  if (from === null) {
    if (to.length === 0) return null
    return t('matters.narrative.change.set', {
      field: label,
      to: joinCapped(to, 5, t, t('matters.narrative.listSep'))
    })
  }
  const added = to.filter((tag) => !from.includes(tag))
  const removed = from.filter((tag) => !to.includes(tag))
  if (added.length === 0 && removed.length === 0) return null
  const parts = [
    ...added.map((tag) => t('matters.narrative.change.tagAdded', { tag })),
    ...removed.map((tag) => t('matters.narrative.change.tagRemoved', { tag }))
  ]
  return t('matters.narrative.change.tags', {
    field: label,
    delta: joinCapped(parts, 6, t, ' ')
  })
}

type ClauseResult =
  | { shape: 'legacy' } // 老行：payload 里没有 `changes` 键
  | { shape: 'empty' } // 新行，但没有可叙述的值级变更（`changes: []` 或全是结构化字段）
  | { shape: 'clauses'; text: string }

function clausesOf(event: MatterEvent, domain: ChangeDomain, t: Translate): ClauseResult {
  const changes = readChanges(event)
  if (changes === null) return { shape: 'legacy' }
  const clauses: string[] = []
  for (const change of changes) {
    const clause = changeClause(change, domain, t)
    if (clause) clauses.push(clause)
  }
  if (clauses.length === 0) return { shape: 'empty' }
  // 一次 patch 改了状态和优先级 ⇒ 一句「状态 A → B，优先级 P2 → P0」，不是两行。
  return { shape: 'clauses', text: clauses.join(t('matters.narrative.clauseSep')) }
}

/* -------------------------------------------------------------------------- */
/* 单条事件 → 句子                                                             */
/* -------------------------------------------------------------------------- */

function fieldsDetail(event: MatterEvent, t: Translate): string | undefined {
  const fields = readFields(event)
  if (fields.length === 0) return undefined
  return t('matters.timeline.changedFields', {
    fields: fields.map((field) => fieldLabel(field, t)).join(t('matters.narrative.listSep'))
  })
}

/** 兜底：通用事件名 + 「改动：字段名」。老行、以及任何没写模板的新 kind 都落到这里。 */
function genericSentence(event: MatterEvent, t: Translate): TimelineSentence {
  const detail = fieldsDetail(event, t)
  const text = t(`matters.events.${event.kind}`, { defaultValue: event.kind })
  return detail ? { text, detail } : { text }
}

function itemKindLabel(payload: Record<string, unknown>, t: Translate): string {
  const kind = readText(payload, 'kind')
  return kind
    ? t(`matters.item.kinds.${kind}`, { defaultValue: kind })
    : t('matters.narrative.itemFallbackKind')
}

/** 事件自带的标识串（item 标题 / 资料名 / 干系人名 / 关联事项名）。缺失 ⇒ 走无标识模板。 */
function quoted(
  payload: Record<string, unknown>,
  key: string,
  template: string,
  t: Translate
): string | null {
  const text = readText(payload, key)
  return text === null ? null : t(template, { text })
}

export function narrateEvent(event: MatterEvent, t: Translate): TimelineSentence {
  const payload = payloadOf(event)
  const say = (suffix: string, values?: Record<string, unknown>): TimelineSentence => ({
    text: t(`matters.narrative.${suffix}`, values)
  })

  switch (event.kind) {
    /* ---- 事项本体 ---- */
    case 'matter_created':
    case 'matter_archived':
    case 'matter_reopened':
    case 'matter_trashed':
    case 'matter_restored':
      return say(event.kind)

    case 'matter_updated':
    case 'agent_binding_changed': {
      const result = clausesOf(event, 'matter', t)
      if (result.shape === 'clauses') return { text: result.text }
      // 老行 / 只动了结构化字段：回到「更新了事项」+「改动：跟进规则」。
      const detail = fieldsDetail(event, t)
      const text = t(
        event.kind === 'agent_binding_changed'
          ? 'matters.narrative.agent_binding_changed'
          : 'matters.narrative.matter_updated_plain'
      )
      return detail ? { text, detail } : { text }
    }

    /* ---- 条目 ---- */
    case 'item_created':
    case 'item_deleted':
    case 'item_restored': {
      const title = quoted(payload, 'title', 'matters.narrative.quoteTitle', t)
      if (title === null) return say(`${event.kind}_plain`)
      return say(event.kind, { kind: itemKindLabel(payload, t), title })
    }
    case 'item_updated': {
      const title = quoted(payload, 'title', 'matters.narrative.quoteTitle', t)
      const result = clausesOf(event, 'item', t)
      if (title === null) {
        return result.shape === 'clauses'
          ? say('item_updated_untitled', { changes: result.text })
          : genericSentence(event, t)
      }
      const kind = itemKindLabel(payload, t)
      return result.shape === 'clauses'
        ? say('item_updated', { kind, title, changes: result.text })
        : say('item_updated_plain', { kind, title })
    }

    /* ---- 资料 ---- */
    case 'resource_linked': {
      const title = quoted(payload, 'title', 'matters.narrative.quoteDoc', t)
      const kind = resourceKindLabel(payload, t)
      if (title === null) return say('resource_linked_plain')
      const suggested = payload.suggested === true
      const sentence = say(suggested ? 'resource_linked_suggested' : 'resource_linked', {
        kind,
        title
      })
      const reason = readText(payload, 'reason')
      return suggested && reason ? { ...sentence, detail: reason } : sentence
    }
    case 'resource_updated': {
      const title = quoted(payload, 'title', 'matters.narrative.quoteDoc', t)
      const kind = resourceKindLabel(payload, t)
      // 接受提案落下来的那条：语义是「确认关联」，不是「资料有新版本」。
      const key = payload.confirmed === true ? 'resource_confirmed' : 'resource_updated'
      if (title === null) return say(`${key}_plain`)
      return say(key, { kind, title })
    }
    case 'resource_unlinked':
    case 'resource_restored':
    case 'resource_suggestion_accepted':
    case 'resource_suggestion_rejected':
    case 'resource_access_policy_changed':
    case 'resource_subscription_paused':
    case 'resource_subscription_resumed': {
      const title = quoted(payload, 'title', 'matters.narrative.quoteDoc', t)
      if (title === null) return say(`${event.kind}_plain`)
      return say(event.kind, { kind: resourceKindLabel(payload, t), title })
    }

    /* ---- 干系人 ---- */
    case 'stakeholder_added':
    case 'stakeholder_removed':
    case 'stakeholder_restored': {
      const name = readText(payload, 'display_name')
      if (name === null) return say(`${event.kind}_plain`)
      return say(event.kind, { name })
    }
    case 'stakeholder_updated': {
      const name = readText(payload, 'display_name')
      const result = clausesOf(event, 'stakeholder', t)
      if (name === null) {
        return result.shape === 'clauses'
          ? say('stakeholder_updated_untitled', { changes: result.text })
          : genericSentence(event, t)
      }
      return result.shape === 'clauses'
        ? say('stakeholder_updated', { name, changes: result.text })
        : say('stakeholder_updated_plain', { name })
    }

    /* ---- 事项间关联 ---- */
    case 'relation_added': {
      const title = quoted(payload, 'target_title', 'matters.narrative.quoteTitle', t)
      return title === null ? say('relation_added_plain') : say('relation_added', { title })
    }
    case 'relation_updated':
    case 'relation_removed':
    case 'relation_restored':
      return say(event.kind)

    /* ---- 对话检索范围（审计） ---- */
    // 🔴 产出路径已退役（0812 检索范围开关移除），**保留仅为渲染历史事件**：活库里已有这两种
    // 事件行，删掉分支它们会退成兜底文案。配套 locale 键 matters.narrative/events.chat_scope_*
    // 同理保留。回归闸见 matterTimelineModel.test.ts 的 legacy chat_scope 用例。
    case 'chat_scope_expanded':
    case 'chat_scope_restored':
      return say(event.kind)

    /* ---- 提案 ---- */
    case 'update_proposed': {
      // 设计稿第一条时间线就是「跟进运行完成 · 检出 N 项变化，生成 1 条更新提案」。
      // `run_id` + `change_count` 在 payload 里，所以有产出的那一轮跟进这里就能如实叙述。
      const changeCount = readCount(payload, 'change_count')
      return changeCount === null || changeCount <= 0
        ? say('update_proposed_plain')
        : say('update_proposed', { count: changeCount })
    }
    case 'update_accepted': {
      const accepted = readCount(payload, 'accepted_change_ids')
      return accepted === null || accepted <= 0
        ? say('update_accepted_plain')
        : say('update_accepted', { count: accepted })
    }
    case 'update_rejected': {
      const reason = readText(payload, 'reason')
      const sentence = say('update_rejected')
      return reason ? { ...sentence, detail: reason } : sentence
    }
    case 'update_superseded':
      return say('update_superseded')

    /* ---- 关注信号 ---- */
    case 'attention_opened': {
      const kind = readText(payload, 'kind')
      return kind === null
        ? say('attention_opened_plain')
        : say('attention_opened', {
            kind: t(`matters.attention.kind.${kind}`, { defaultValue: kind })
          })
    }
    case 'attention_resolved':
    case 'attention_snoozed':
    case 'attention_dismissed':
      return say(event.kind)

    default:
      // 新增 kind 还没写模板时不炸也不空句：回到事件名 + 字段名。
      return genericSentence(event, t)
  }
}

function resourceKindLabel(payload: Record<string, unknown>, t: Translate): string {
  const kind = readText(payload, 'resource_kind')
  return kind
    ? t(`matters.context.kind.${kind}`, { defaultValue: kind })
    : t('matters.narrative.resourceFallbackKind')
}

/* -------------------------------------------------------------------------- */
/* 合并组 → 句子                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 写了「N 份资料」这类量词句的 kind。
 *
 * 🔴 白名单是显式的，不靠 `t(key, { defaultValue: '' })` 探测 key 在不在 —— 那种探测在
 * i18next 换配置（`returnEmptyString` / `parseMissingKeyHandler`）后会静默变成「永远命中」
 * 或「永远不命中」，而两种失效都不会红。缺模板必须在 locale 覆盖测试里红。
 */
export const GROUPED_TEMPLATE_KINDS: ReadonlySet<string> = new Set([
  'resource_linked',
  'resource_unlinked',
  'resource_restored',
  'resource_updated',
  // 🔴 不是事件 kind，是 `resource_updated` 里 `confirmed: true` 那半边的模板名
  // （见 `groupedTemplateKind`）。少了它，一次接受提案确认两份资料会显示成
  // 「2 份资料检出新版本」—— 纯属虚构。
  'resource_confirmed',
  'resource_suggestion_accepted',
  'resource_suggestion_rejected',
  'item_created',
  'item_deleted',
  'item_restored',
  'stakeholder_added',
  'stakeholder_removed',
  'relation_added',
  'update_superseded',
  'attention_opened'
])

/** 携带 `changes` 的 kind：合并时算**净变化**（首条的 from → 末条的 to）比数数有信息量。 */
const NET_DIFF_DOMAIN: Readonly<Record<string, ChangeDomain>> = {
  matter_updated: 'matter',
  agent_binding_changed: 'matter',
  item_updated: 'item',
  stakeholder_updated: 'stakeholder'
}

/**
 * 把一组同 kind 事件压成净变化：同一个字段被连改 4 次，只说「优先级 P2 → P0」。
 *
 * `events` 是新到旧，所以前像取**最后**一条、后像取**第一**条。净变化为空
 * （改了又改回来）时返回 `null`，调用方回到计数句式。
 */
function netChanges(events: readonly MatterEvent[]): MatterEventChange[] | null {
  const first = new Map<string, MatterEventChange>() // 时间上最早
  const last = new Map<string, MatterEventChange>() // 时间上最晚
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const changes = readChanges(events[index])
    if (changes === null) return null // 组里混了老行 ⇒ 净变化不可信
    for (const change of changes) {
      if (!first.has(change.field)) first.set(change.field, change)
      last.set(change.field, change)
    }
  }
  const merged: MatterEventChange[] = []
  // 单条事件里 `changes` 已经是后端按字段名排好的；合并组也排一次，同一组事件
  // 换个到达顺序不该产出不同的句子。
  for (const [field, tail] of [...last].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const head = first.get(field) as MatterEventChange
    const change: MatterEventChange = { field, to: tail.to }
    if ('from' in head) change.from = head.from
    // from 侧来自最早那条、to 侧来自最新那条，分侧标记也各跟各的那一侧。
    if (head.fromTruncated === true) change.fromTruncated = true
    if (tail.toTruncated === true) change.toTruncated = true
    if (head.truncated === true || tail.truncated === true) change.truncated = true
    // 改了又改回来：净变化为零，不写进句子。
    if ('from' in change && JSON.stringify(change.from) === JSON.stringify(change.to)) continue
    merged.push(change)
  }
  return merged.length > 0 ? merged : null
}

export function narrateTimelineGroup(group: TimelineGroup, t: Translate): TimelineSentence {
  if (group.events.length === 1) return narrateEvent(group.head, t)

  const domain = NET_DIFF_DOMAIN[group.head.kind]
  if (domain) {
    const net = netChanges(group.events)
    if (net) {
      const clauses: string[] = []
      for (const change of net) {
        const clause = changeClause(change, domain, t)
        if (clause) clauses.push(clause)
      }
      if (clauses.length > 0) {
        // 分组键带了目标对象身份（`groupTarget`）⇒ 组内必定是同一个条目 / 同一位干系人，
        // 于是可以照单条的句式把标识带上（此前合并句把条目标题整个丢了）。
        return wrapClauses(group.head, clauses.join(t('matters.narrative.clauseSep')), t)
      }
    }
  }

  const count = group.events.length
  const template = groupedTemplateKind(group.head)
  if (GROUPED_TEMPLATE_KINDS.has(template)) {
    return { text: t(`matters.narrative.grouped.${template}`, { count }) }
  }
  // 没写复数模板的 kind：「调整资料可见性 · 3 条」。计数永远在，信息不丢。
  return {
    text: t('matters.narrative.grouped.generic', {
      label: t(`matters.events.${group.head.kind}`, { defaultValue: group.head.kind }),
      count
    })
  }
}

/**
 * 合并组的计数模板名。
 *
 * `resource_updated` 按 `confirmed` 分成两句：「确认关联」与「检出新版本」。分组键已经
 * 把两者切开（`groupTarget`），这里只是取对应的模板 —— 无条件用 `resource_updated`
 * 会让「接受提案确认了两份资料」显示成「2 份资料检出新版本」。
 */
function groupedTemplateKind(head: MatterEvent): string {
  if (head.kind === 'resource_updated' && payloadOf(head).confirmed === true) {
    return 'resource_confirmed'
  }
  return head.kind
}

/**
 * 给合并组的净变化子句套上单条事件同款的标识外壳（条目标题 / 干系人名）。
 * 前提是分组键里已有目标对象身份，组内不会混着两个对象。
 */
function wrapClauses(head: MatterEvent, changes: string, t: Translate): TimelineSentence {
  const payload = payloadOf(head)
  if (head.kind === 'item_updated') {
    const title = quoted(payload, 'title', 'matters.narrative.quoteTitle', t)
    return title === null
      ? { text: t('matters.narrative.item_updated_untitled', { changes }) }
      : {
          text: t('matters.narrative.item_updated', {
            kind: itemKindLabel(payload, t),
            title,
            changes
          })
        }
  }
  if (head.kind === 'stakeholder_updated') {
    const name = readText(payload, 'display_name')
    return name === null
      ? { text: t('matters.narrative.stakeholder_updated_untitled', { changes }) }
      : { text: t('matters.narrative.stakeholder_updated', { name, changes }) }
  }
  return { text: changes }
}

/** 组内明细（展开后逐条显示）。 */
export function narrateGroupEntries(
  group: TimelineGroup,
  t: Translate
): { event: MatterEvent; sentence: TimelineSentence }[] {
  return group.events.map((event) => ({ event, sentence: narrateEvent(event, t) }))
}
