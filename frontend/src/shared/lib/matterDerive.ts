import type {
  Matter,
  MatterAttentionSignal,
  MatterItem,
  MatterNextActionItem,
  MatterPriority,
  MatterUpdateSummary
} from '@shared/api/types/matter'

// 🔴 `MATTER_VIEWS` / `MatterView` / `filterView`（左轨 12 档视图模型）已随 v3 信息架构
// （V3-01/V3-03）整体退役：视图列收敛成「事项 / 看板」两 tab + 查询模型
// `matterListQuery.ts`（scope + 快捷条件 + 多选筛选）。archived/trash 不再是客户端谓词 ——
// 那两类行从未被默认请求取回（服务端默认子句 `deleted_at IS NULL AND archived_at IS NULL`），
// 现在由 `matterScopeParams` 映射成服务端 `view` 参数。

const PRIORITY_RANK: Record<MatterPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

export function isLiveMatter(matter: Matter): boolean {
  return matter.archived_at === null && matter.deleted_at === null
}

export type MatterAttentionIndex = ReadonlyMap<string, readonly MatterAttentionSignal[]>
export type MatterUpdateIndex = ReadonlyMap<string, readonly MatterUpdateSummary[]>

export function openAttentionFor(
  matter: Matter,
  attention?: MatterAttentionIndex
): MatterAttentionSignal[] {
  return [...(attention?.get(matter.public_id) ?? matter.attention_signals ?? [])].filter(
    (signal) => signal.state === 'open'
  )
}

export function rankOf(
  matter: Matter,
  attention?: MatterAttentionIndex
): readonly [number, number, number] {
  const openSignals = openAttentionFor(matter, attention)
  const attentionRank = openSignals.some((signal) => signal.severity === 'critical')
    ? 0
    : openSignals.length > 0
      ? 1
      : 2
  return [attentionRank, PRIORITY_RANK[matter.priority], matter.due_at ?? Number.MAX_SAFE_INTEGER]
}

export function compareMatterRank(
  left: Matter,
  right: Matter,
  attention?: MatterAttentionIndex
): number {
  const a = rankOf(left, attention)
  const b = rankOf(right, attention)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || right.updated_at - left.updated_at
}

/** 事项有没有一个明确的下一步。
 *
 * 🔴 判定与文案分离：`deriveFocusStats` 的「健康」以前是拿 `nextAction()` 的返回串
 * `.includes('缺少下一步')` 判的 —— 改一下那句措辞（或把它 i18n 化）就会让健康率**静默失效**，
 * 而且没有任何测试会红。语义单源放这里，文案只负责展示。 */
export function hasNextAction(
  matter: Matter,
  items: readonly MatterItem[] | null = matter.items ?? null
): boolean {
  if (itemNextAction(matter, items) !== null) return true
  return matter.status === 'monitoring' || matter.status === 'done'
}

/** 条目那三档直接取 wire 契约（`MatterNextActionItem['kind']`），不再手抄一份字面量；
 *  后三档是**纯前端**的状态派生，服务端不产出。 */
export type MatterNextActionKind =
  | MatterNextActionItem['kind']
  | 'monitoring'
  | 'done'
  | 'missing'

/** 「下一步」的**结构化**结果：文案交给 i18n，色调照设计 `list.jsx::nextAction` 的 tone。
 *
 * 🔴 返回描述符而不是成品字符串 —— 四句中文原本硬编码在这里直接上屏（G-34），而 tone 又
 * 是设计要的第二个维度；把两者塞进一个字符串就等于逼调用方再解析一次。tone 的值域刻意写
 * 成 `MatterTone` 的子集字面量：`matterVocab` 住在 components/ 下，lib 不反向依赖它。 */
export interface MatterNextActionDescriptor {
  kind: MatterNextActionKind
  /** 条目标题（用户内容，永不翻译）；派生句式时为 null。 */
  title: string | null
  tone: 'neutral' | 'warn' | 'critical'
}

const NEXT_ACTION_ITEM_TONES: Record<
  MatterNextActionItem['kind'],
  MatterNextActionDescriptor['tone']
> = { action: 'neutral', waiting: 'warn', blocker: 'critical' }

/** 「下一步」里由**条目**决定的那三档。
 *
 * 🔴 两个数据形态：详情页手里有 `items` ⇒ 就地算；清单行没有（`GET /matters` 不返回
 * items）⇒ 吃服务端投影 `matter.next_action`（canonical =
 * `src/matters/repository.py::list_next_action_summaries`，优先级与下面这段**逐条同表**，
 * 改一处必须改另一处）。少了投影这一路，清单里每一行都会落到「缺少下一步」兜底，Focus
 * 的健康活跃率也跟着一起失真（它与本函数同源）。
 *
 * `items === null` 才代表「这一层没有条目数据」；显式传 `[]` 是「确实一条都没有」，仍就地算。
 * 老后端不发这个键 ⇒ `undefined` ⇒ 与投影前行为一致（fail-soft，不猜）。 */
function itemNextAction(
  matter: Matter,
  items: readonly MatterItem[] | null
): MatterNextActionItem | null {
  if (items === null) return matter.next_action ?? null
  const actions = items.filter((item) => item.kind === 'action' && item.deleted_at === null)
  const ready = actions.find((item) => item.status === 'open' || item.status === 'in_progress')
  if (ready) return { kind: 'action', title: ready.title, due_at: ready.due_at ?? null }

  const waiting = actions.find((item) => item.status === 'waiting')
  if (waiting) return { kind: 'waiting', title: waiting.title, due_at: waiting.due_at ?? null }

  const blocker = items.find(
    (item) => item.kind === 'blocker' && item.deleted_at === null && item.status !== 'done'
  )
  if (blocker) return { kind: 'blocker', title: blocker.title, due_at: blocker.due_at ?? null }
  return null
}

export function nextAction(
  matter: Matter,
  items: readonly MatterItem[] | null = matter.items ?? null
): MatterNextActionDescriptor {
  const item = itemNextAction(matter, items)
  if (item !== null) {
    return { kind: item.kind, title: item.title, tone: NEXT_ACTION_ITEM_TONES[item.kind] }
  }
  if (matter.status === 'monitoring') return { kind: 'monitoring', title: null, tone: 'neutral' }
  if (matter.status === 'done') return { kind: 'done', title: null, tone: 'neutral' }
  return { kind: 'missing', title: null, tone: 'warn' }
}

/** 相对时间（设计 `helpers.jsx::fmtAgo`）。走 Intl 而不是手写中文串 —— 组件里不硬编码文案。
 *
 * 住在 lib 而非 MatterDetail.tsx：清单行的「更新时间」与详情头的「创建于」要的是同一份
 * 口径，抄第二份就会漂（CLAUDE.md「跨边界手抄常量」同理，这里能消灭镜像就不建闸）。 */
export function formatMatterAgo(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((at - now) / 60_000)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return rtf.format(days, 'day')
  return rtf.format(Math.round(days / 30), 'month')
}

/** 到期日的相对说法（设计 `helpers.jsx::fmtDue` 的短文案位）。整天粒度，与 `matterDueTone`
 *  的判据同一个「按自然日取整」口径，免得色和字对不上。 */
export function formatMatterDueRelative(dueAt: number, now: number, locale: string): string {
  const startOfDay = (value: number): number => {
    const date = new Date(value)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
}

export function trashDaysRemaining(matter: Matter, now = Date.now()): number | null {
  if (matter.deleted_at === null) return null
  const purgeAt = matter.purge_after ?? matter.deleted_at + 30 * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)))
}

const DAY = 86_400_000

/** 按自然日取整的到期差（设计 H3§3 同款口径）。
 *
 * 🔴 单源住这里而不是 `matterListQuery.ts`：那个文件已经 `import` 这个文件里的
 * `compareMatterRank`/`nextAction`/`openAttentionFor`，谓词若反向导入会成环 —— 层次上
 * lib 在下、components 在上，「7 天内到期含逾期」这个判据只能钉在下层。
 * （`matterVocab.matterDueTone` 有一份独立实现同一段 startOfDay 算法，语义相同但那是
 * 「到期色阶」的判据、不在 V3-15 收口范围内，未改。） */
export function matterDueDayDiff(dueAt: number, now: number): number {
  const startOfDay = (value: number): number => {
    const date = new Date(value)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  return Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)
}

/** 「7 天内到期，含已逾期」的窗口（设计 H3§3）。V3-15 收口：看板 tile 计数 /
 *  看板「临近到期」列表 / 清单 `due` 快捷条件此前各自独立算过一遍窗口（14 天不含逾期 ×2 +
 *  7 天含逾期 ×1），三处必须是同一个谓词的三种消费方式,不是三份实现。 */
export const MATTER_DUE_SOON_WINDOW_DAYS = 7

export function isMatterDueSoon(matter: Matter, now: number): boolean {
  return (
    matter.due_at != null && matterDueDayDiff(matter.due_at, now) <= MATTER_DUE_SOON_WINDOW_DAYS
  )
}

export interface FocusStats {
  openCount: number
  attentionCount: number
  reviewCount: number
  dueSoonCount: number
  /** V3-13：看板第四 tile「缺少下一步」= 未完成事项里 `nextAction().kind==='missing'` 的数量。
   *  🔴 按 kind 判、不按 icon/文案（上方 hasNextAction 的红旗同款理由）。 */
  missingNextCount: number
}

/** Focus 页指标（design-handoff 附录 E + v3 看板 V3-13）：到期窗 = `isMatterDueSoon` 的单源
 *  判据（V3-15 起 7 天含逾期，替代原先的 14 天不含逾期）。住在 lib 而非 MatterFocus.tsx ——
 *  组件文件只能导出组件（react-refresh）。`healthyRate` 字段（V3-13 已被「缺少下一步」tile
 *  换掉、成了纯遗留计算）随 i18n key 一并在 V3-14 删除。 */
export function deriveFocusStats(
  matters: readonly Matter[],
  signals: readonly MatterAttentionSignal[],
  updates: ReadonlyMap<string, readonly MatterUpdateSummary[]>,
  now: number
): FocusStats {
  const live = matters.filter(isLiveMatter)
  const open = live.filter((matter) => matter.status !== 'done' && matter.status !== 'canceled')
  const dueSoonCount = open.filter((matter) => isMatterDueSoon(matter, now)).length
  return {
    openCount: open.length,
    attentionCount: signals.filter((signal) => signal.state === 'open').length,
    reviewCount: [...updates.values()].reduce(
      (count, items) => count + items.filter((item) => item.review_status === 'pending').length,
      0
    ),
    dueSoonCount,
    missingNextCount: open.filter((matter) => nextAction(matter).kind === 'missing').length
  }
}
