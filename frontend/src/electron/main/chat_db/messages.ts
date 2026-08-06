import { getChatDb } from './connection'

import type { AppendMessageInput, ChatMessage, UpdateMessagePatch } from '@shared/chat_model'

// ── messages ────────────────────────────────────────────────────────────

export function appendMessage(input: AppendMessageInput): ChatMessage {
  const db = getChatDb()
  const now = Date.now()
  const result = db
    .prepare(
      `INSERT INTO ai_chat_messages
        (session_id, role, content, tokens_input, tokens_output, cost_usd,
         model, status, error_message, metadata, ui_message_json, context_tokens,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sessionId,
      input.role,
      input.content,
      input.tokensInput ?? null,
      input.tokensOutput ?? null,
      input.costUsd ?? null,
      input.model ?? null,
      input.status,
      input.errorMessage ?? null,
      input.metadata ?? null,
      // v9 — AI SDK UIMessage canonical JSON (gateway runtime dual-writes it;
      // legacy runtime omits → NULL → reload synthesizes from `content`).
      input.uiMessageJson ?? null,
      // v23 (WP-15) — 末 step 的 inputTokens = 上下文占用（≠ tokens_input 的多 step 求和）。
      input.contextTokens ?? null,
      now,
      now
    )
  // Bump session updated_at so list ordering reflects fresh activity.
  db.prepare('UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId)

  return {
    id: Number(result.lastInsertRowid),
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    tokens_input: input.tokensInput ?? null,
    tokens_output: input.tokensOutput ?? null,
    cost_usd: input.costUsd ?? null,
    model: input.model ?? null,
    status: input.status,
    error_message: input.errorMessage ?? null,
    metadata: input.metadata ?? null,
    ui_message_json: input.uiMessageJson ?? null,
    context_tokens: input.contextTokens ?? null,
    // task 06-08-chat 需求 5 — appendMessage never seeds thinking (finalizeMessage
    // writes it on终态 via updateMessage); the inserted row column defaults to NULL.
    thinking: null,
    created_at: now,
    updated_at: now
  }
}

/** Find the row id of a message by role + the UIMessage id stored in its canonical
 *  `ui_message_json` (`$.id`). Session-scoped; newest row wins. JSON1 `json_extract` on a
 *  per-session scan — session message counts are small, no index needed. Survives app restarts
 *  (no in-memory state), unlike a Set-based dedup. */
function findMessageRowIdByUiId(
  sessionId: number,
  uiMessageId: string,
  role: 'user' | 'assistant'
): number | null {
  const row = getChatDb()
    .prepare(
      `SELECT id FROM ai_chat_messages
         WHERE session_id = ? AND role = ?
           AND ui_message_json IS NOT NULL
           AND json_extract(ui_message_json, '$.id') = ?
         ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, role, uiMessageId) as { id: number } | undefined
  return row?.id ?? null
}

/** R2-3 (paused-assistant persist) — assistant lookup used by the gateway lifecycle to make the
 *  resume turn's persistTurn REPLACE the eagerly-persisted paused assistant row (same merged
 *  UIMessage id) instead of appending a duplicate. */
export function findAssistantMessageRowIdByUiId(
  sessionId: number,
  uiMessageId: string
): number | null {
  return findMessageRowIdByUiId(sessionId, uiMessageId, 'assistant')
}

/** MEDIUM-1 (rebase 复审) — user lookup that makes onTurnStart's eager user write DB-idempotent.
 *  The in-memory eagerWrittenUserMessages Set is only a fast path: an island /decide resume's
 *  persistTurn clears the key, so a LATER renderer resume of the same (stale) approval card would
 *  re-append the same user message. Checking the DB by (session, ui id, role='user') before
 *  appending closes that — and also the pre-existing #12 edge where a gateway restart empties
 *  the Set. */
export function findUserMessageRowIdByUiId(sessionId: number, uiMessageId: string): number | null {
  return findMessageRowIdByUiId(sessionId, uiMessageId, 'user')
}

export function updateMessage(messageId: number, patch: UpdateMessagePatch): void {
  const db = getChatDb()
  const now = Date.now()
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) {
    fields.push('content = ?')
    params.push(patch.content)
  }
  if (patch.status !== undefined) {
    fields.push('status = ?')
    params.push(patch.status)
  }
  if (patch.tokensInput !== undefined) {
    fields.push('tokens_input = ?')
    params.push(patch.tokensInput)
  }
  if (patch.tokensOutput !== undefined) {
    fields.push('tokens_output = ?')
    params.push(patch.tokensOutput)
  }
  if (patch.costUsd !== undefined) {
    fields.push('cost_usd = ?')
    params.push(patch.costUsd)
  }
  if (patch.errorMessage !== undefined) {
    fields.push('error_message = ?')
    params.push(patch.errorMessage)
  }
  if (patch.model !== undefined) {
    fields.push('model = ?')
    params.push(patch.model)
  }
  if (patch.metadata !== undefined) {
    fields.push('metadata = ?')
    params.push(patch.metadata)
  }
  // task 06-08-chat 需求 5 — thinking summary (finalizeMessage on a thinking turn).
  if (patch.thinking !== undefined) {
    fields.push('thinking = ?')
    params.push(patch.thinking)
  }
  // v9 (P4 Phase 02) — AI SDK UIMessage canonical JSON, finalized on turn end
  // (the gateway onFinish writes the streamed assistant text's UIMessage here).
  if (patch.uiMessageJson !== undefined) {
    fields.push('ui_message_json = ?')
    params.push(patch.uiMessageJson)
  }
  // v23 (WP-15 context 环) — 上下文占用。审批暂停的行是先 append（无占用）、resume 时
  // updateMessage 补写，故 update 面必须能写这一列。
  if (patch.contextTokens !== undefined) {
    fields.push('context_tokens = ?')
    params.push(patch.contextTokens)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(now)
  params.push(messageId)
  db.prepare(`UPDATE ai_chat_messages SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

export function listMessages(sessionId: number): ChatMessage[] {
  return getChatDb()
    .prepare('SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC')
    .all(sessionId) as ChatMessage[]
}

/**
 * Sprint 19 P1 — sliding window history loader. Returns the last N messages
 * in chronological order (oldest → newest), used by the harness to cap
 * per-turn input tokens. Without this the harness sees full history and
 * a 100-turn session bills ~$0.6/turn (vs $0.015 for a 1-turn fresh session).
 *
 * Algorithm: SELECT … ORDER BY created_at DESC LIMIT N (newest first) →
 * .reverse() into chronological order for the LLM. id is the secondary
 * sort key to break created_at ties deterministically.
 *
 * Caller passes the window size (dispatcher uses HISTORY_WINDOW_SIZE
 * const so tuning is one place). limit <= 0 returns all messages (same
 * as listMessages — escape hatch for debugging / tests that want full
 * history without changing the call site).
 */
export function listLastNMessages(sessionId: number, limit: number): ChatMessage[] {
  if (limit <= 0) return listMessages(sessionId)
  const rows = getChatDb()
    .prepare(
      'SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(sessionId, limit) as ChatMessage[]
  // Reverse in-place so LLM sees chronological order (oldest → newest).
  return rows.reverse()
}

export function getMessage(messageId: number): ChatMessage | null {
  const row = getChatDb().prepare('SELECT * FROM ai_chat_messages WHERE id = ?').get(messageId) as
    | ChatMessage
    | undefined
  return row ?? null
}

/**
 * Sprint 14 PR B — delete `fromMessageId` and every message in the same
 * session that came after it (inclusive of `fromMessageId`). Used by
 * inline edit: editing a user message truncates the conversation back
 * to that turn so the dispatcher can re-stream a fresh assistant reply.
 *
 * Returns the number of rows removed. Idempotent — calling on an empty
 * range silently returns 0 instead of throwing.
 *
 * Why `>= ?` rather than `> ?`: the caller appends a fresh user message
 * via `appendMessage` after this returns; keeping the old user row would
 * leave duplicate user turns in the history. We delete the whole tail
 * and recreate the edit as a new row to keep `created_at` ordering
 * truthful.
 */
export function deleteMessagesFromId(sessionId: number, fromMessageId: number): number {
  const db = getChatDb()
  const result = db
    .prepare('DELETE FROM ai_chat_messages WHERE session_id = ? AND id >= ?')
    .run(sessionId, fromMessageId)
  return result.changes
}

/**
 * Mark any in-flight (streaming / pending) message in this session as
 * aborted. Called when the renderer switches the active email or the
 * panel is closed mid-stream. Returns the number of rows flipped (used
 * by tests + by the IPC handler to know whether an abort actually had
 * something to abort).
 */
export function abortStreamingMessages(sessionId: number): number {
  const db = getChatDb()
  const now = Date.now()
  const result = db
    .prepare(
      `UPDATE ai_chat_messages
         SET status = 'aborted', updated_at = ?
       WHERE session_id = ?
         AND status IN ('pending', 'streaming')`
    )
    .run(now, sessionId)
  return result.changes
}
