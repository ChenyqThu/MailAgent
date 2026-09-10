// chat-panel P4 Phase 02 — AI SDK UIMessage ↔ MailAgent chat persistence mapper.
//
// Pure functions shared by the AI SDK Gateway (persist side, Electron main) and
// the renderer (reload side). NO better-sqlite3 / electron / keytar imports — the
// gateway core stays harness-testable and the renderer can import it freely.
//
// Phase 02 persistence v1 (architecture §6, protocol-contracts §2):
//   - WRITE: the gateway's onFinish hands back the assistant `responseMessage`
//     (an AI SDK UIMessage). We persist `ui_message_json = JSON.stringify(msg)`
//     (canonical) + `content = extractTextFromUIMessage(msg)` (legacy text) +
//     usage/model into the row columns. Same for the triggering user message.
//   - READ: a persisted ChatMessage row converts back to a UIMessage. If
//     `ui_message_json` is present it is the SSoT (parse + reuse); otherwise we
//     synthesize a minimal text UIMessage from `content` (+ a reasoning part from
//     `thinking`) so legacy-runtime / pre-v9 rows still render in the AI SDK shell.

import type { UIMessage } from 'ai'
import type { MessageTiming } from '@assistant-ui/react'

/** The fields chatMessageToUIMessage reads, with `ui_message_json` OPTIONAL. Structural (not the
 *  chat_db ChatMessage) so BOTH a chat_db row (ui_message_json present = AI SDK canonical) AND a
 *  renderer api/types ChatMessage (no ui_message_json column on the read projection → content
 *  fallback) can be reloaded into the AI SDK runtime without a cast. */
export interface ReloadableChatMessageRow {
  id: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinking: string | null
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  ui_message_json?: string | null
}

/** Per-message metadata the gateway attaches to the AI SDK UIMessage stream.
 *  Kept light for Phase 02 (model + token usage); the full protocol-contracts §2
 *  MailAgentMetadata (anchor / cost / version) lands when tools migrate (phase-03+). */
export interface MailAgentUIMessageMetadata {
  model?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  /** dogfood (codex root-cause) — client-visible response timing, injected by the gateway on the
   *  finish chunk (messageMetadata) so it rides the UIMessage's own metadata. WHY not the
   *  react-ai-sdk `messageTiming` runtime path: @assistant-ui/core's converter caches by the AI SDK
   *  message OBJECT (WeakMap); the post-stream metadata-only timing update never re-runs the
   *  converter, so `message.metadata.timing` stayed empty and the badge never showed. A finish-chunk
   *  metadata write makes the client clone the message → cache miss → timing lands. Persisted into
   *  ui_message_json too, so a history reload keeps the badge. useMessageTiming() reads this. */
  timing?: MessageTiming
  queuedInputDispatch?: { rowIds: number[] }
}

export type MailAgentUIMessage = UIMessage<MailAgentUIMessageMetadata>

/** Concatenate the `text` parts of a UIMessage into the legacy `content` string.
 *  Mirrors protocol-contracts §2 `content_text_legacy = extractText(uiMessage)`.
 *  Non-text parts (reasoning / tool / file) are ignored — Phase 02 is text-only,
 *  and `content` is only the legacy/search projection, not the canonical SSoT. */
export function extractTextFromUIMessage(message: Pick<UIMessage, 'parts'>): string {
  if (!Array.isArray(message.parts)) return ''
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
    .map((part) => part.text)
    .join('')
}

/** Safely parse a persisted `ui_message_json` blob back into a UIMessage. Returns
 *  null on absent / malformed JSON / shape mismatch so the caller can fall back to
 *  synthesizing from `content` (a corrupt blob must never crash a session reload). */
export function parseUiMessageJson(raw: string | null): MailAgentUIMessage | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      'role' in parsed &&
      'parts' in parsed &&
      Array.isArray((parsed as { parts: unknown }).parts)
    ) {
      return parsed as MailAgentUIMessage
    }
  } catch {
    /* malformed blob → fall back to content synthesis */
  }
  return null
}

/** 压缩标记（compact.ts 写入的 canonical）是 role='system' + 一个 `data-compact` 数据块。
 *  🔴 assistant-ui 要求 system 消息**恰好一段文本**，原样交给运行时会在渲染前抛
 *  「System messages must have exactly one text message part」，整个对话面板崩掉（09-10 自动压缩
 *  后实测）。回放时规整成「一段摘要文本」：顶层 metadata 原样保留（网关 compactSelect 靠它认标记、
 *  取 valid），另复制一份到 `metadata.custom.compact` —— assistant-ui 的 system 消息只留 custom，
 *  压缩卡片从那里读。库里的 canonical 不改写，markCompactInvalid 等写侧照旧。 */
function normalizeCompactMarker(message: MailAgentUIMessage): MailAgentUIMessage {
  if (message.role !== 'system') return message
  const part = message.parts.find((p) => p.type === 'data-compact') as
    | { data?: { summary?: unknown } }
    | undefined
  if (!part) return message
  // 与网关 compactSelect.messageText 同一口径：文本段优先，没有才取数据块里的 summary。
  const summary =
    extractTextFromUIMessage(message) ||
    (typeof part.data?.summary === 'string' ? part.data.summary : '')
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  return {
    ...message,
    parts: [{ type: 'text', text: summary }],
    metadata: {
      ...metadata,
      custom: { compact: { metadata, summary } }
    } as MailAgentUIMessageMetadata
  }
}

/** Convert a persisted ChatMessage row to a UIMessage. The reload primitive used
 *  when re-hydrating a prior session into the AI SDK runtime. NOTE (Phase 02): the
 *  WRITE side (dual-write in the Gateway onFinish) is wired + tested; feeding these
 *  back as the AI SDK runtime's initial `messages` (so picking an existing session
 *  renders its history, not just freshly-streamed turns) is DEFERRED to phase-03 —
 *  the Phase 02 AI SDK path starts each thread empty (architecture §13.8.5, spec §9).
 *  Canonical path: a non-null `ui_message_json` is the SSoT (parsed verbatim, with
 *  the stable row id stamped so assistant-ui keying stays consistent). Fallback:
 *  synthesize a minimal UIMessage from `content` (+ a `reasoning` part from
 *  `thinking`) so legacy-runtime / pre-v9 rows still render. `tool`/`system` rows
 *  are not first-class UIMessage roles → folded to `assistant` text (Phase 02 is
 *  text-only; tool parts arrive when tools migrate in phase-03). */
export function chatMessageToUIMessage(row: ReloadableChatMessageRow): MailAgentUIMessage {
  const id = String(row.id)
  const canonical = parseUiMessageJson(row.ui_message_json ?? null)
  if (canonical) return normalizeCompactMarker({ ...canonical, id })

  const role: MailAgentUIMessage['role'] = row.role === 'user' ? 'user' : 'assistant'
  const parts: MailAgentUIMessage['parts'] = []
  if (role === 'assistant' && row.thinking && row.thinking.length > 0) {
    parts.push({ type: 'reasoning', text: row.thinking })
  }
  parts.push({ type: 'text', text: row.content })
  return {
    id,
    role,
    parts,
    metadata: {
      model: row.model,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output
    }
  }
}
