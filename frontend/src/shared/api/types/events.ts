// ---- Sprint 16 §SSE — events bridge surface ----------------------------

/** Sprint 16 — SSE event types. 后端 publish 点见 src/events/publisher.py
 *  + docs/reference/integrations/sse-events.md. */
export type SseEventType =
  | 'email.synced'
  | 'email.failed'
  | 'email.dead_letter'
  | 'email.flag_changed'
  | 'email.pin_changed'
  | 'outbox.enqueued'
  | 'outbox.done'
  | 'outbox.failed'
  | 'outbox.dead_letter'
  | 'llm.success'
  | 'llm.failed'
  | 'llm.gave_up'
  | 'folder.synced'
  | 'calendar.synced'

export interface SseEvent {
  event_type: SseEventType | string
  ts: number
  internal_id: number | null
  data: Record<string, unknown>
  source: string
  /** Phase C — `folder.synced` 事件携带的 folder 名 (archive | drafts). */
  folder?: string
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
