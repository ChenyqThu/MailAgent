// chat-panel post-cutover M0 — memory tools (AI SDK Gateway), parity restore.
//
// The v0.20.0 cutover moved the desktop default runtime to the AI SDK Gateway but the
// gateway tool set never included the four memory tools (they only existed in the legacy
// harness, shared/chat/tools/builtin/memory.ts) — so the default agent could no longer
// read/write durable user facts via tools. This module restores them on the gateway:
//   - memory_list / memory_get  = silent READS  (auditedReadTool, email.ts pattern).
//   - memory_write / memory_delete = preview WRITES (auditedWriteTool, write.ts pattern):
//     HITL approval (needsApproval → ApprovalGuard) so a durable fact is never written /
//     forgotten without the user confirming (the legacy tools were 'preview' tier too).
//
// Each tool runs against the injected MailAgentDomainClient → serve-api /chat/memory*
// (Python ChatDb.agent_memory_kv is the authoritative store; Python side is unchanged).
// inputSchema / descriptions / default scope='user' / priority handling are reused VERBATIM
// from the legacy memory tools so the model's tool surface + outputs are byte-for-byte parity.
//
// 🔴 Gated behind MAILAGENT_AI_SDK_MEMORY_TOOLS (buildGatewayTools memoryToolsEnabled) — off
//    → these are not registered, byte-identical to the cutover tool set. write/delete also
//    need the ApprovalGuard (a write tool cannot exist without its guard), like email writes.
//
// Provenance (parity caveat): the legacy memory_write recorded source_session_id /
// source_message_id / source_tool_use_id from ToolExecCtx. The gateway tool layer can't reach
// any of them — buildTools(collector) isn't handed the sessionId, the assistant message id is
// assigned later in onFinish, and auditedWriteTool's run ctx exposes only {userEdited, signal}
// (not the toolCallId) — so this writes ALL provenance columns as null.
// 🔴 The Python upsert (src/chat/db.py ON CONFLICT) does NOT COALESCE provenance: only `priority`
// is COALESCE-preserved; the four source_* columns are set to excluded.* — so a gateway
// memory_write that OVERWRITES an existing key resets that row's provenance to null (including any
// provenance a prior legacy write stamped). Accepted for M0: provenance is audit-only, the
// load-bearing value/priority are preserved, and auditedWriteTool still records this call's
// toolCallId in the chat_tool_call audit row. Wiring real provenance (thread toolCallId through the
// run ctx, or COALESCE the source_* columns in the Python upsert) is deferred to M1 (auto-capture).
// The per-call output shape is unchanged (the ids read back null).

import type { Tool } from 'ai'
import type { z } from 'zod'

import type { ApprovalGuard } from '../security/approval'
import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolAuditCollector
} from './types'
import { memoryDeleteSchema, memoryGetSchema, memoryListSchema, memoryWriteSchema } from './schemas'

/** Names of the memory tools the gateway exposes when MAILAGENT_AI_SDK_MEMORY_TOOLS is on. */
export const GATEWAY_MEMORY_TOOL_NAMES = [
  'memory_list',
  'memory_get',
  'memory_write',
  'memory_delete'
] as const

/** Default scope when the model doesn't name one. 'user' = long-term personal facts.
 *  Mirrors the legacy memory.ts DEFAULT_SCOPE. */
const DEFAULT_SCOPE = 'user'

/** Serialize an arbitrary `value` to value_json (a string becomes a JSON string).
 *  Verbatim from the legacy memory.ts toValueJson. */
function toValueJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(String(value))
  }
}

/** Mirror the legacy asStr: non-empty string → itself, else undefined. */
function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}

/** Reject an invalid argument the same way the legacy handler did (E_INVALID_ARG) —
 *  mirrors write.ts invalidArg so the tool-error code matches the legacy tool. */
function invalidArg(message: string): never {
  throw new DomainError('E_INVALID_ARG', message)
}

/**
 * Build the four memory tools bound to the injected domain client + audit collector
 * (+ approval guard for the two writes). memory_list/get are silent reads; memory_write/
 * delete are preview-tier approval-gated writes — identical tiers to the legacy tools.
 */
export function createMemoryTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: { a2uiEnabled?: boolean; approvalMode?: GatewayApprovalMode } = {}
): Record<string, Tool> {
  const makeRead = <I>(o: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    run: (input: I, signal: AbortSignal | undefined) => Promise<unknown>
  }): Tool => auditedReadTool(o, collector)

  const makeWrite = <I>(o: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined }
    ) => Promise<unknown>
  }): Tool =>
    auditedWriteTool(
      { ...o, risk: 'preview', a2uiEnabled: opts.a2uiEnabled, approvalMode: opts.approvalMode },
      collector,
      guard
    )

  const memory_list = makeRead({
    name: 'memory_list',
    description:
      'List durable memory entries the assistant has saved about the user (preferences, ' +
      'writing style, recurring instructions). Optionally filter by scope ("user" = personal, ' +
      '"skill:<name>" = skill-specific). Use at the start of a task to recall what you already ' +
      'know before asking the user to repeat themselves.',
    inputSchema: memoryListSchema,
    run: async (input, signal) => {
      const entries = await domain.listMemory(asStr(input.scope), signal)
      return { count: entries.length, entries }
    }
  })

  const memory_get = makeRead({
    name: 'memory_get',
    description:
      'Fetch one memory entry by scope + key. Returns found:false if nothing is stored under ' +
      'that (scope, key). Use when you need the exact stored value for a known key.',
    inputSchema: memoryGetSchema,
    run: async (input, signal) => {
      const key = input.key
      const entry = await domain.getMemory(asStr(input.scope) ?? DEFAULT_SCOPE, key, signal)
      if (!entry) return { found: false, key }
      return { found: true, ...entry }
    }
  })

  const memory_write = makeWrite({
    name: 'memory_write',
    description:
      'Save (or overwrite) a durable fact about the user under a (scope, key). Use ONLY for ' +
      'genuinely long-lived facts the user stated or confirmed (e.g. "always reply in English", ' +
      'preferred signature, recurring project context) — NOT transient task state. The user ' +
      'confirms every write (preview tier). Keep keys short + stable so future turns can recall ' +
      'them; put the fact in `value`. Set `priority` > 0 ONLY when the user explicitly says a ' +
      'preference is especially important / should always apply (it is recalled before others ' +
      'when context is tight); omit it otherwise to keep the existing priority. Before ' +
      'overwriting a key that may already exist, call memory_get first and show the change ' +
      'as old → new in your message so the user can confirm or correct it.',
    inputSchema: memoryWriteSchema,
    run: async (input, { userEdited, signal }) => {
      // The schema makes `value` optional (z.unknown); enforce "value required" here so the
      // error shape matches the legacy handler (E_INVALID_ARG).
      const key = asStr(input.key)
      if (!key) invalidArg('key is required (non-empty string)')
      if (input.value === undefined) invalidArg('value is required')
      const scope = asStr(input.scope) ?? DEFAULT_SCOPE
      // P2a — structured priority (user-explicit). Only forward a finite number; absent /
      // non-numeric stays undefined so the store keeps the existing priority (COALESCE) rather
      // than resetting it to 0. Clamp >= 0: the relevance rule sorts priority DESC, so a
      // negative value would sort BELOW the default 0. (Verbatim from the legacy tool.)
      const priority =
        typeof input.priority === 'number' && Number.isFinite(input.priority)
          ? Math.max(0, Math.trunc(input.priority))
          : undefined
      const entry = await domain.writeMemory(
        {
          scope,
          key,
          valueJson: toValueJson(input.value),
          priority,
          // Provenance best-effort → all null on the gateway path (the tool layer can't reach
          // sessionId/messageId/toolCallId; see the header note). 🔴 The Python upsert does NOT
          // COALESCE provenance — only `priority` is — so overwriting an existing key nulls its
          // source_* columns. Accepted for M0 (audit-only; toolCallId is kept in chat_tool_call);
          // real provenance is deferred to M1.
          sourceSessionId: null,
          sourceMessageId: null,
          sourceToolUseId: null,
          sourceWikiPath: null
        },
        signal
      )
      // Surface provenance + update time so it is visible wherever tool outputs render — SAME
      // shape as the legacy memory_write output (the source_* fields read back from the row).
      return {
        saved: true,
        scope: entry.scope,
        key: entry.key,
        priority: entry.priority,
        updated_at: entry.updated_at,
        source: {
          session_id: entry.source_session_id,
          message_id: entry.source_message_id,
          tool_use_id: entry.source_tool_use_id
        },
        user_edited: userEdited
      }
    }
  })

  const memory_delete = makeWrite({
    name: 'memory_delete',
    description:
      'Forget a stored memory entry by scope + key. Use when the user asks you to forget a ' +
      'preference or it is no longer true. The user confirms (preview tier).',
    inputSchema: memoryDeleteSchema,
    run: async (input, { signal }) => {
      const key = asStr(input.key)
      if (!key) invalidArg('key is required (non-empty string)')
      const deleted = await domain.deleteMemory(asStr(input.scope) ?? DEFAULT_SCOPE, key, signal)
      return { deleted, key }
    }
  })

  return { memory_list, memory_get, memory_write, memory_delete }
}
