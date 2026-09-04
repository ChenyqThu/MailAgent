import { getChatDb } from './connection'

export type QueuedInputMode = 'follow_up' | 'steering'
export type QueuedInputStatus = 'queued' | 'claimed' | 'sent' | 'canceled' | 'restored'

export interface QueuedInput {
  id: number
  sessionId: number
  runId: string | null
  mode: QueuedInputMode
  content: string
  status: QueuedInputStatus
  createdAt: number
  updatedAt: number
  deliveredMessageId: number | null
}

type QueuedInputRow = {
  id: number
  session_id: number
  run_id: string | null
  mode: QueuedInputMode
  content: string
  status: QueuedInputStatus
  created_at: number
  updated_at: number
  delivered_message_id: number | null
}

const MAX_QUEUED_INPUT_CONTENT_LENGTH = 16_384
const MAX_PENDING_QUEUED_INPUTS = 20

function toQueuedInput(row: QueuedInputRow): QueuedInput {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    mode: row.mode,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredMessageId: row.delivered_message_id
  }
}

function normalizeContent(content: string): string {
  const trimmed = content.trim()
  if (!trimmed || trimmed.length > MAX_QUEUED_INPUT_CONTENT_LENGTH) {
    throw new Error('E_INVALID_ARG')
  }
  return trimmed
}

export function getQueuedInput(id: number): QueuedInput | null {
  const row = getChatDb().prepare('SELECT * FROM chat_queued_input WHERE id = ?').get(id) as
    | QueuedInputRow
    | undefined
  return row ? toQueuedInput(row) : null
}

export function listQueuedInput(sessionId: number): QueuedInput[] {
  const rows = getChatDb()
    .prepare(
      `SELECT * FROM chat_queued_input
       WHERE session_id = ? AND status IN ('queued','claimed','restored')
       ORDER BY created_at ASC, id ASC`
    )
    .all(sessionId) as QueuedInputRow[]
  return rows.map(toQueuedInput)
}

export function listDispatchableQueuedInput(sessionId: number): QueuedInput[] {
  const rows = getChatDb()
    .prepare(
      `SELECT * FROM chat_queued_input
       WHERE session_id = ? AND status = 'queued'
       ORDER BY created_at ASC, id ASC`
    )
    .all(sessionId) as QueuedInputRow[]
  return rows.map(toQueuedInput)
}

export function enqueueQueuedInput(sessionId: number, content: string): QueuedInput {
  const normalized = normalizeContent(content)
  const db = getChatDb()
  const count = db
    .prepare(
      `SELECT COUNT(*) AS count FROM chat_queued_input
       WHERE session_id = ? AND status IN ('queued','claimed')`
    )
    .get(sessionId) as { count: number }
  if (count.count >= MAX_PENDING_QUEUED_INPUTS) throw new Error('E_QUEUE_FULL')
  const now = Date.now()
  const result = db
    .prepare(
      `INSERT INTO chat_queued_input
       (session_id, run_id, mode, content, status, claimed_at, delivered_message_id, created_at, updated_at)
       VALUES (?, NULL, 'follow_up', ?, 'queued', NULL, NULL, ?, ?)`
    )
    .run(sessionId, normalized, now, now)
  const item = getQueuedInput(Number(result.lastInsertRowid))
  if (!item) throw new Error('E_QUEUED_INPUT_STATE')
  return item
}

export function updateQueuedInput(id: number, content: string): boolean {
  const normalized = normalizeContent(content)
  const result = getChatDb()
    .prepare(
      `UPDATE chat_queued_input SET content = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued','restored')`
    )
    .run(normalized, Date.now(), id)
  return result.changes === 1
}

export function cancelQueuedInput(id: number): boolean {
  const result = getChatDb()
    .prepare(
      `UPDATE chat_queued_input SET status = 'canceled', updated_at = ?
       WHERE id = ? AND status IN ('queued','restored')`
    )
    .run(Date.now(), id)
  return result.changes === 1
}

export function confirmQueuedInput(id: number): boolean {
  const result = getChatDb()
    .prepare(
      `UPDATE chat_queued_input SET status = 'queued', updated_at = ?
       WHERE id = ? AND status = 'restored'`
    )
    .run(Date.now(), id)
  return result.changes === 1
}

export function claimQueuedInput(ids: number[], now: number): number[] {
  const db = getChatDb()
  const claim = db.prepare(`UPDATE chat_queued_input
SET status='claimed', claimed_at=?, updated_at=?
WHERE id=? AND status IN ('queued','restored');`)
  return db.transaction((candidateIds: number[]) => {
    const claimed: number[] = []
    for (const id of candidateIds) {
      if (claim.run(now, now, id).changes === 1) claimed.push(id)
    }
    return claimed
  })(ids)
}

export function revertClaimed(ids: number[]): number {
  const db = getChatDb()
  const update = db.prepare(
    `UPDATE chat_queued_input SET status = 'queued', claimed_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed'`
  )
  const now = Date.now()
  return db.transaction((rowIds: number[]) =>
    rowIds.reduce((count, id) => count + update.run(now, id).changes, 0)
  )(ids)
}

export function markSent(sessionId: number, ids: number[], deliveredMessageId: number): number {
  if (ids.length === 0) return 0
  const db = getChatDb()
  const markFirst = db.prepare(
    `UPDATE chat_queued_input
     SET status = 'sent', delivered_message_id = ?, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND session_id = ?`
  )
  const markRemaining = db.prepare(
    `UPDATE chat_queued_input
     SET status = 'sent', delivered_message_id = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND session_id = ?`
  )
  const now = Date.now()
  return db.transaction((rowIds: number[]) => {
    let changed = markFirst.run(deliveredMessageId, now, rowIds[0], sessionId).changes
    for (const id of rowIds.slice(1)) changed += markRemaining.run(now, id, sessionId).changes
    return changed
  })(ids)
}

export function restoreForSession(sessionId: number): number {
  return getChatDb()
    .prepare(
      `UPDATE chat_queued_input
       SET status = 'restored', claimed_at = NULL, updated_at = ?
       WHERE session_id = ? AND status IN ('queued','claimed')`
    )
    .run(Date.now(), sessionId).changes
}

/** 0903 —— 一轮 run 结束时还留在 'claimed' 的行 = 那一轮没能把它送出去（送到了就已经 markSent）。
 *  还给用户，但落 'restored' 而不是 'queued'：restored 不进 listDispatchableQueuedInput，所以
 *  「上游一直报错 → 反复自动重发」这个循环在状态机层面就不成立 —— 每行最多自动派发一次，之后
 *  只有用户按「发送」才会再走一次。与 /run/stop 的 restoreForSession 同一套词汇，只是范围收窄到
 *  claimed（还排着队、用户随时可改可撤的 queued 行不该被降级）。 */
export function restoreClaimedForSession(sessionId: number): number {
  return getChatDb()
    .prepare(
      `UPDATE chat_queued_input
       SET status = 'restored', claimed_at = NULL, updated_at = ?
       WHERE session_id = ? AND status = 'claimed'`
    )
    .run(Date.now(), sessionId).changes
}

export function restoreAllStale(): number {
  return getChatDb()
    .prepare(
      `UPDATE chat_queued_input
       SET status = 'restored', claimed_at = NULL, updated_at = ?
       WHERE status IN ('queued','claimed')`
    )
    .run(Date.now()).changes
}
