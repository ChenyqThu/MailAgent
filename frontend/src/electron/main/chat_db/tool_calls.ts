import { getChatDb } from './connection'

import type { AppendToolCallInput, ChatToolCall, UpdateToolCallPatch } from '@shared/chat_model'

// ── chat_tool_call (Sprint 19) ──────────────────────────────────────────

export function appendToolCall(input: AppendToolCallInput): ChatToolCall {
  const db = getChatDb()
  const now = Date.now()
  const contentOffset = input.contentOffset ?? null
  const result = db
    .prepare(
      `INSERT INTO chat_tool_call
        (message_id, tool_use_id, tool_name, input_json,
         user_edited_input_json, output_json,
         status, duration_ms, confirmation_tier, confirmed_at,
         content_offset, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?)`
    )
    .run(
      input.messageId,
      input.toolUseId,
      input.toolName,
      input.inputJson,
      input.status,
      input.confirmationTier,
      contentOffset,
      now,
      now
    )
  return {
    id: Number(result.lastInsertRowid),
    message_id: input.messageId,
    tool_use_id: input.toolUseId,
    tool_name: input.toolName,
    input_json: input.inputJson,
    user_edited_input_json: null,
    output_json: null,
    status: input.status,
    duration_ms: null,
    confirmation_tier: input.confirmationTier,
    confirmed_at: null,
    content_offset: contentOffset,
    approval_status: null,
    approval_hash: null,
    // v11 — A2UI render payload, set on update (like approval_*); insert default NULL.
    ui_payload_json: null,
    // v12 — outbound-send content hash + idempotency key, set on update; insert default NULL.
    content_hash: null,
    idempotency_key: null,
    // v18 — exec whitelist rule id (approval_status='auto_whitelist'), set on update; insert NULL.
    whitelist_rule_id: null,
    created_at: now,
    updated_at: now
  }
}

export function updateToolCall(toolCallId: number, patch: UpdateToolCallPatch): void {
  const db = getChatDb()
  const now = Date.now()
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.status !== undefined) {
    fields.push('status = ?')
    params.push(patch.status)
  }
  if (patch.outputJson !== undefined) {
    fields.push('output_json = ?')
    params.push(patch.outputJson)
  }
  if (patch.durationMs !== undefined) {
    fields.push('duration_ms = ?')
    params.push(patch.durationMs)
  }
  if (patch.userEditedInputJson !== undefined) {
    fields.push('user_edited_input_json = ?')
    params.push(patch.userEditedInputJson)
  }
  if (patch.confirmedAt !== undefined) {
    fields.push('confirmed_at = ?')
    params.push(patch.confirmedAt)
  }
  // v10 (Phase 03b) — write-tool approval audit.
  if (patch.approvalStatus !== undefined) {
    fields.push('approval_status = ?')
    params.push(patch.approvalStatus)
  }
  if (patch.approvalHash !== undefined) {
    fields.push('approval_hash = ?')
    params.push(patch.approvalHash)
  }
  // v11 (Phase 04a) — A2UI render payload (ui_payload_json).
  if (patch.uiPayloadJson !== undefined) {
    fields.push('ui_payload_json = ?')
    params.push(patch.uiPayloadJson)
  }
  // v12 (Phase 04b) — outbound-send content hash + idempotency key.
  if (patch.contentHash !== undefined) {
    fields.push('content_hash = ?')
    params.push(patch.contentHash)
  }
  if (patch.idempotencyKey !== undefined) {
    fields.push('idempotency_key = ?')
    params.push(patch.idempotencyKey)
  }
  // v18 (S2 W1) — exec whitelist rule id.
  if (patch.whitelistRuleId !== undefined) {
    fields.push('whitelist_rule_id = ?')
    params.push(patch.whitelistRuleId)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(now)
  params.push(toolCallId)
  db.prepare(`UPDATE chat_tool_call SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

export function markToolCallApprovalExpired(toolUseId: string): void {
  getChatDb()
    .prepare(
      `UPDATE chat_tool_call SET approval_status='approval_expired', updated_at=?
       WHERE id = (
         SELECT id FROM chat_tool_call WHERE tool_use_id=? ORDER BY created_at DESC, id DESC LIMIT 1
       )`
    )
    .run(Date.now(), toolUseId)
}

export function listToolCallsForMessage(messageId: number): ChatToolCall[] {
  return getChatDb()
    .prepare('SELECT * FROM chat_tool_call WHERE message_id = ? ORDER BY created_at ASC, id ASC')
    .all(messageId) as ChatToolCall[]
}

export function getToolCallByUseId(messageId: number, toolUseId: string): ChatToolCall | null {
  const row = getChatDb()
    .prepare('SELECT * FROM chat_tool_call WHERE message_id = ? AND tool_use_id = ?')
    .get(messageId, toolUseId) as ChatToolCall | undefined
  return row ?? null
}

// agent_memory_kv CRUD 已于 v16 (M5b, 2026-06-30) 随表一并退役。
// 记忆终态 = user.md(M3 恒注入) + mem0(M1/M2 capture/召回)。
