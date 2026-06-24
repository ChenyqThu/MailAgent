// chat-panel P4 Phase 02 — AI SDK Gateway config + injection contracts.
//
// The gateway core (server.ts) is PURE: only node:http + ai + @ai-sdk/anthropic.
// Everything environment-specific (the LLM key from keytar, chat persistence via
// better-sqlite3, the Electron lifecycle) is injected through this config so the
// core stays harness-testable in plain Node. The Electron wrapper
// (electron/main/ai_gateway_lifecycle.ts) builds a concrete AiGatewayConfig; the
// harness / vitest build a minimal one (in-memory persist + mock model).

import type { LanguageModel, ToolSet } from 'ai'

import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
// 🔴 type-only import — fully erased, so config.ts keeps ZERO runtime dependency on
// tools/types (which DOES import `tool` from 'ai'). index.ts statically imports
// config.ts for resolveAiGatewayPort; this must never pull the heavy `ai` chunk into
// the main bundle when MAILAGENT_AI_SDK_GATEWAY is off (Phase 02 invariant).
import type { GatewayToolAuditEntry } from './tools/types'

/** Default loopback port. serve-api=8200, local SSE gate=9200 — pick 8300 to dodge
 *  both. Overridable via env MAILAGENT_AI_GATEWAY_PORT (createWindow injects the
 *  same resolved value as `?aiGatewayPort=` so the renderer discovers it). */
export const AI_GATEWAY_DEFAULT_PORT = 8300

/** Resolve the gateway port from env (pure — index.ts + harness share one source). */
export function resolveAiGatewayPort(): number {
  const raw = process.env.MAILAGENT_AI_GATEWAY_PORT
  const n = raw != null ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : AI_GATEWAY_DEFAULT_PORT
}

/**
 * Normalize an LLM-gateway base URL into the form `@ai-sdk/anthropic` expects
 * (must end with `/v1`).
 *
 * 🔴 Spike-discovered contract drift (architecture §13.2): the Python chat.py
 * appends `/v1/messages` to a base like `https://crs.chenge.ink/api`, but the AI
 * SDK anthropic provider only appends `/messages` to its baseURL (whose default
 * already carries `/v1`). So the AI SDK baseURL must be `.../api/v1`, otherwise it
 * hits `.../api/messages` → CRS 404 (we hit and fixed this in the spike).
 */
export function anthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/** One AI SDK turn ready to persist. The gateway hands this to `persistTurn` in
 *  onFinish; the Electron wrapper writes it to ai_chat.db (dual-write ui_message_json
 *  + extracted content). sessionId null → caller skips persistence (unsaved temp
 *  session). userMessage null → the turn carried no fresh user message (rare). */
export interface PersistTurnInput {
  sessionId: number | null
  model: string
  userMessage: MailAgentUIMessage | null
  responseMessage: MailAgentUIMessage
  usage?: { inputTokens?: number | null; outputTokens?: number | null }
  /** Phase 03a/03b/04a — the tool calls executed this turn (collected by the gateway via a
   *  closure-bound per-request collector, NOT streamText experimental_context). The
   *  wrapper writes each to chat_tool_call keyed to the persisted assistant message;
   *  write tools carry their tier + approval audit + (04a) the A2UI ui_payload_json.
   *  Empty / omitted when no tools ran. */
  toolCalls?: GatewayToolAuditEntry[]
}

export interface AiGatewayConfig {
  /** bind port. host is always 127.0.0.1 (loopback). 0 = kernel-assigned (tests). */
  port: number
  /** LLM gateway base URL (e.g. https://crs.chenge.ink/api). Normalized via anthropicBaseUrl. */
  baseUrl: string
  /** LLM API key. null/empty → /api/ai/chat returns 503 E_NO_LLM_KEY (renderer never sees it). */
  apiKey: string | null
  /** Default model id (e.g. claude-sonnet-4-6). */
  model: string
  /** Persist a finished turn (Electron wrapper → chat_db). Omitted → no persistence. */
  persistTurn?: (turn: PersistTurnInput) => void | Promise<void>
  /** Build the LanguageModel for a model id. Injected by tests (mock model); the
   *  default wires @ai-sdk/anthropic + the normalized baseURL + apiKey. */
  createModel?: (modelId: string) => LanguageModel
  /** Phase 03a — factory that builds the AI SDK read tools bound to a per-request
   *  audit collector (closure). The gateway calls it once per /api/ai/chat with a
   *  fresh `collector` array, runs a multi-step tool loop (streamText { tools,
   *  stopWhen }), and drains the collector into chat_tool_call in onFinish. Bound by
   *  closure (NOT streamText experimental_context — see tools/types.ts) so audit is
   *  robust + directly testable. Omitted / empty result → text-only (Phase 02
   *  behaviour, byte-identical). */
  buildTools?: (collector: GatewayToolAuditEntry[]) => ToolSet
  /** Max tool-loop steps (stopWhen: stepCountIs). Default 8 (legacy AGENT_MAX_ITER). */
  maxSteps?: number
  /** Phase 03b — HMAC secret for streamText `experimental_toolApprovalSecret`. When set,
   *  ai@6 signs each tool-approval-request at issuance and verifies the signature (binding
   *  approvalId+toolCallId+toolName+input) when the approval is replayed on the second
   *  call → InvalidToolApprovalSignatureError on a forged / input-swapped approval. This
   *  is the built-in layer that stacks on the domain ApprovalGuard (the Electron wrapper
   *  generates a per-process random secret; tests inject a fixed one). Omitted → no
   *  signing (write tools still need approval, just unsigned — dev/test only). */
  toolApprovalSecret?: string
  /** Phase 04a — apply a UI edit to a pending edit-tier approval (POST /api/ai/approval/resolve).
   *  The Electron wrapper implements this as `approvalGuard.applyEdit(toolCallId, editedFields)`:
   *  it overlays the editable fields onto the original input (identity pinned) so the next
   *  streamText call's execute runs the edited input WITHOUT changing the ai@6 history input
   *  (the signed approval stays valid). Throws an ApprovalError-shaped error (`.code`) on
   *  not-found / expired / not-editable, which the server maps to a typed HTTP error. Omitted →
   *  /api/ai/approval/resolve returns 501 (edit cards not wired — read-only / 03b config). */
  resolveEditedApproval?: (
    toolCallId: string,
    editedFields: Record<string, unknown>
  ) => { approvalId: string; toolName: string }
}
