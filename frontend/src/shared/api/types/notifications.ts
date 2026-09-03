// 统一通知中心 wire 类型（task 08-20-notification-center 步骤 7；design §2.1 值域 + §5 投影）。
//
// 🔴 下面三组 `*_VALUES` 是 `src/notify/center_models.py` 同名常量的**手抄镜像** ——
// renderer 不能 import Python，运行时值集只能自带一份（镜像消灭不掉，故建闸）：跨语言闸
// `tests/config/test_notification_enum_parity.py` 逐词锁死两侧。
// `NOTIFICATION_LIST_STATE_VALUES` 的 canonical 另在 `src/notify/center.py::_LIST_STATE_VALUES`
// —— 它是**列表查询参数**的值域（含聚合档 `all`），与行状态 `NOTIFICATION_STATE_VALUES` 不是
// 一回事，同闸另开一条断言。
//
// 漂了会怎样：TS 多一档 → 前端能选、请求却 400 `E_INVALID_ARG`；TS 少一档 → 服务端真存着
// 那个值时前端类型收窄不到它（图标/文案投影落空）。

export const NOTIFICATION_CATEGORY_VALUES = [
  'action_required',
  'reviews',
  'results',
  'system'
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORY_VALUES)[number]

/** 行状态机。🔴 已读**不在这里** —— `readAt` 是与 state 正交的独立轴（PRD 设计基线 2）。 */
export const NOTIFICATION_STATE_VALUES = ['open', 'snoozed', 'resolved', 'dismissed'] as const
export type NotificationState = (typeof NOTIFICATION_STATE_VALUES)[number]

export const NOTIFICATION_SEVERITY_VALUES = ['info', 'warn', 'critical'] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITY_VALUES)[number]

/** `GET /notifications?state=` 的值域：`open` 含**已到期**的 snoozed（服务端读口径单源
 *  `_OPEN_PREDICATE`，design §8.d）；`all` 不加状态过滤。 */
export const NOTIFICATION_LIST_STATE_VALUES = ['open', 'snoozed', 'resolved', 'all'] as const
export type NotificationListState = (typeof NOTIFICATION_LIST_STATE_VALUES)[number]

/** `payload.link.type` 里 **Python 侧会构造**的判别值 —— canonical 在
 *  `src/notify/center_models.py` 同名常量（跨语言闸同上）。只镜像这六个：`group` /
 *  `thread` / `updater_restart` 三型恒由 Electron main 构造（`notification_fanout.ts` /
 *  `handlers/updater.ts`）、renderer 侧解析——全程 TS，不跨 Python/TS 语言边界，没有
 *  手抄副本可漂移，故不进本表（`components/notifications/navigation.ts` 的
 *  `NotificationLink` 判别 union 仍收全部九型，那张表不受这里影响）。改这里必须同步改
 *  该 union 与 `center_models.py`，三处逐字一致。 */
export const NOTIFICATION_LINK_TYPE_VALUES = [
  'session',
  'route',
  'report',
  'contact_queue',
  'matter',
  'library'
] as const

/** 单条投影（design §5 wire，camelCase）。`payload` 是自由结构化载荷，deep-link 在
 *  `payload.link` —— 解析走 `components/notifications/navigation.ts` 的单源解析器，不在
 *  这里收窄（后端可加新 link 型，老前端要能不炸地忽略）。 */
export interface NotificationItem {
  id: number
  category: NotificationCategory
  source: string
  severity: NotificationSeverity
  state: NotificationState
  title: string
  body: string
  payload: Record<string, unknown> | null
  recurrenceNo: number
  firstCreatedAt: number
  lastEventAt: number
  readAt: number | null
  snoozedUntil: number | null
  resolvedAt: number | null
  dismissedAt: number | null
}

/** `GET /notifications` 的 data(数组) + meta 合并后的读侧形状。 */
export interface NotificationListResult {
  items: NotificationItem[]
  /** 当前过滤条件下的总行数（不受 limit/offset 影响）。 */
  total: number
  /** 同 category 范围内的未读数（与 state 过滤无关 —— 徽标口径）。 */
  unread: number
  limit: number
  offset: number
}

/** `GET /notifications/unread-count`。各轴键恒全（服务端补零），无需 `?? 0`。 */
export interface NotificationUnreadCount {
  total: number
  byCategory: Record<NotificationCategory, number>
  /** 铃铛 critical 红点档的数据源（M2）：未读里有 critical → 红，否则计数点。
   *  与 `byCategory` 同出一条 GROUP BY，口径按构造一致。三档恒全（服务端补零）。 */
  bySeverity: Record<NotificationSeverity, number>
  /** **活跃**行数（open + 到期 snoozed），**不随已读掉**（M3 批 C5）。
   *  与前两轴的语义差就是它存在的理由：未读是 edge 型（看过一眼就掉），而收编进
   *  铃铛的 `AgentPendingBadge` 是 level 型（审批挂着数字就在）——「读了通知但没去批」
   *  时铃铛靠这一轴保留一档持久指示。 */
  openByCategory: Record<NotificationCategory, number>
}
