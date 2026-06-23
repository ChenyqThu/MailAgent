// chat-panel P4 Phase 01 — legacy ChatMessage → assistant-ui ThreadMessageLike.
//
// The ExternalStore adapter's `convertMessage` seam. The legacy chat hooks
// (useEmailChat / useGeneralChat) already fold the backend `ChatStreamEvent`
// stream into a `ChatMessage` state machine (chunk→content, thinking→thinking,
// tool_use/tool_result→liveToolCalls, usage→tokens, done→complete, error→error).
// So the assistant-ui shell never sees raw events — it sees `ChatMessage` rows
// plus the per-message tool steps. This module maps ONE such enriched row to a
// `ThreadMessageLike` (assistant-ui's input shape), which `fromThreadMessageLike`
// then normalizes into the rendered `ThreadMessage`.
//
// Mapping (protocol-contracts.md §4 — the §4 "UIMessage" column targets the
// Phase 02 AI SDK UIMessage layer; in the Phase 01 ExternalStore world the
// native equivalent of `data-thinking` is the built-in `reasoning` part, which
// renders collapsibly out of the box, so we map thinking → reasoning):
//
//   ChatMessage.content (chunk/done)   → assistant `text` part
//   ChatMessage.thinking               → assistant `reasoning` part (collapsible)
//   tool step (tool_use + tool_result) → assistant `tool-call` part (args/result/isError)
//   ChatMessage.status + isStreaming   → assistant message `status`
//
// Render order matches legacy AssistantBubble: reasoning → tool group → answer.
// `status` is set ONLY for assistant messages — fromThreadMessageLike throws if
// a non-assistant message carries `status`.

import type { MessageStatus, ThreadMessageLike } from '@assistant-ui/react'

import type { ChatMessage, ChatMessageStatus } from '@shared/api/types'
import type { ToolStepData } from '@shared/components/chat/tool_steps'

/** One legacy chat row plus the side-channel state the converter needs. The
 *  ExternalStore runtime feeds an array of these as its `messages`; the toolSteps
 *  are the normalized live (streaming) or persisted (settled) tool calls for the
 *  row (see tool_steps.ts liveSteps / auditSteps). */
export interface LegacyEnrichedMessage {
  message: ChatMessage
  /** Normalized tool steps for this message — empty when the row used no tools. */
  toolSteps: ReadonlyArray<ToolStepData>
  /** True iff this assistant row is the one currently streaming. Drives the
   *  `running` status so assistant-ui shows the live indicator + caret. */
  isStreaming: boolean
}

// Element type of an assistant ThreadMessageLike content array — the full part
// union (text / reasoning / tool-call / …). We only ever emit text / reasoning /
// tool-call, but typing against the canonical union keeps the literals checked.
type ContentArray = Exclude<ThreadMessageLike['content'], string>
type ContentPart = ContentArray[number]

/** Best-effort JSON.parse; returns undefined on non-JSON so callers can fall
 *  back to the raw text (tool input/output may be anything). */
function safeParse(json: string | null): unknown {
  if (json == null) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

/** A tool step is "in flight" when it has no terminal output yet. Mirrors the
 *  legacy ToolStep `running` predicate (running / pending / confirmed). */
function isStepRunning(status: ToolStepData['status']): boolean {
  return status === 'running' || status === 'pending' || status === 'confirmed'
}

/** ToolStepData → assistant-ui `tool-call` part. Running steps carry no
 *  `result` (assistant-ui renders them as in-progress); settled steps carry the
 *  parsed output + an `isError` flag for error/canceled terminal states. */
function toolStepToPart(step: ToolStepData): ContentPart {
  const parsedArgs = safeParse(step.inputJson)
  const args =
    parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
      ? (parsedArgs as Record<string, unknown>)
      : {}
  const base = {
    type: 'tool-call' as const,
    toolCallId: step.key,
    toolName: step.toolName,
    args,
    argsText: step.inputJson
  }
  // The tool-call part wants `args: ReadonlyJSONObject` / `result: JSONValue`; our
  // values come straight from JSON.parse so they ARE JSON, but TS can't prove
  // `Record<string, unknown>` ⊆ ReadonlyJSONObject. Cast the constructed part —
  // localized + safe (the shape is a valid tool-call part).
  if (isStepRunning(step.status) || step.outputJson === null) {
    return base as ContentPart
  }
  return {
    ...base,
    result: safeParse(step.outputJson) ?? step.outputJson,
    isError: step.status === 'error' || step.status === 'canceled'
  } as ContentPart
}

/** ChatMessage.status (+ live streaming flag) → assistant-ui MessageStatus.
 *  pending/streaming or the active streaming row → running; error → incomplete
 *  with the backend message; aborted → cancelled; otherwise complete. */
export function toAssistantStatus(status: ChatMessageStatus, isStreaming: boolean): MessageStatus {
  if (isStreaming || status === 'streaming' || status === 'pending') {
    return { type: 'running' }
  }
  if (status === 'error') {
    return { type: 'incomplete', reason: 'error' }
  }
  if (status === 'aborted') {
    return { type: 'incomplete', reason: 'cancelled' }
  }
  return { type: 'complete', reason: 'stop' }
}

/** Map one enriched legacy row to a ThreadMessageLike. Pure — no React, no IPC —
 *  so the golden test asserts exactly what the Thread renders. */
export function legacyMessageToThreadMessage(entry: LegacyEnrichedMessage): ThreadMessageLike {
  const { message, toolSteps, isStreaming } = entry
  const id = String(message.id)
  const createdAt = new Date(message.created_at)

  // Non-assistant rows: plain text bubble. NB fromThreadMessageLike forbids
  // `status` on user/system, so we never set it here. Legacy standalone `tool`
  // rows (sidecar JSON) are rare in the harness era; render as a system note so
  // nothing is silently dropped.
  if (message.role === 'user') {
    return { role: 'user', id, createdAt, content: [{ type: 'text', text: message.content }] }
  }
  if (message.role === 'system' || message.role === 'tool') {
    return { role: 'system', id, createdAt, content: [{ type: 'text', text: message.content }] }
  }

  // Assistant row: reasoning → tool steps → answer (legacy AssistantBubble order).
  const parts: ContentPart[] = []
  const thinking = message.thinking ?? ''
  if (thinking.trim().length > 0) {
    parts.push({ type: 'reasoning', text: thinking })
  }
  for (const step of toolSteps) {
    parts.push(toolStepToPart(step))
  }
  if (message.content.length > 0) {
    parts.push({ type: 'text', text: message.content })
  }

  return {
    role: 'assistant',
    id,
    createdAt,
    content: parts,
    status: toAssistantStatus(message.status, isStreaming)
  }
}
