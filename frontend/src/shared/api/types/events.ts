// ---- Sprint 16 §SSE — events bridge surface ----------------------------

/** 后端实际会发的全部 SSE 事件名（perf-sse-realtime R2 起是**契约**而非注释）。
 *
 *  单源纪律：后端发布点全走 `safe_publish("<literal>", …)` 字面量（`src/` 全树），
 *  本数组与那些字面量的集合恒等 —— 一致性闸
 *  `tests/shared/api/sseEventTypes.contract.test.ts` 从 Python 源码抽取事件名做
 *  双向对拍（新增后端事件漏这里必红；这里留了后端已死的名字也必红）。
 *  改集合 = 两边同步 + 补 `docs/reference/integrations/sse-events.md` 表。 */
export const SSE_EVENT_TYPES = [
  // 邮件生命周期
  'email.new',
  'email.synced',
  'email.failed',
  'email.dead_letter',
  'email.flag_changed',
  'email.pin_changed',
  // outbox 派发
  'outbox.enqueued',
  'outbox.done',
  'outbox.failed',
  'outbox.dead_letter',
  // LLM 处理
  'llm.success',
  'llm.failed',
  'llm.gave_up',
  // async job（resync 等维护任务, resyncJob.ts 消费）
  'job.enqueued',
  'job.running',
  'job.progress',
  'job.done',
  'job.failed',
  // 文件夹（R1-2: CRUD/cleanup + folder_pref 写; 取代已死的 folder.synced）
  'folder.changed',
  // 日历（后台 worker reconcile + R1-4 的 REST 写面）
  'calendar.synced',
  // 事项域
  'matter.changed',
  'matter.attention',
  'matter.notify',
  'matter.run.changed',
  // 通讯录（R1-3: 扫描 tick / 画像 / 建议采纳）
  'contact.changed',
  // custom agent run 生命周期（R1-5）
  'agent.run.changed'
] as const

/** Sprint 16 — SSE event types. 后端 publish 点见 src/events/publisher.py
 *  + docs/reference/integrations/sse-events.md. */
export type SseEventType = (typeof SSE_EVENT_TYPES)[number]

export interface SseEvent {
  event_type: SseEventType | string
  ts: number
  internal_id: number | null
  data: Record<string, unknown>
  source: string
}

export type EventsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'disabled'

export interface EventsStatus {
  state: EventsConnectionState
  lastError: string | null
  lastEventTs: number | null
  url: string
}

export interface EventsApi {
  /** Current snapshot (idempotent invoke). */
  status(): Promise<EventsStatus>
  /** 立即重连 — 清退避 / 取消当前 fetch / 启新 attempt; 返回新 status. */
  reconnect(): Promise<EventsStatus>
  /** Subscribe to incoming SSE events; returns unsubscribe fn. */
  onEvent(handler: (event: SseEvent) => void): () => void
  /** Subscribe to connection-state changes; returns unsubscribe fn. */
  onStatus(handler: (status: EventsStatus) => void): () => void
}
