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

/** `GET /notifications/unread-count`。四类恒全（服务端补零），无需 `?? 0`。 */
export interface NotificationUnreadCount {
  total: number
  byCategory: Record<NotificationCategory, number>
}
