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
import type { GatewayApprovalMode, GatewayToolAuditEntry } from './tools/types'
// 🔴 type-only — same erasure discipline. The runtime policy functions live in tools/policy.ts
// (pure, type-only `ai` import) and are consumed by chatRun/tools, never here.
import type { AgentContextMode } from './tools/policy'
// 🔴 type-only imports — fully erased (same discipline as GatewayToolAuditEntry above), so the
// AG-UI mirror types never pull the `ai` chunk into the main bundle when the gateway is off.
import type { ToolApprovalRequestPayload } from './agui/interruptMapper'
// 🔴 type-only — fully erased; the systemPrompt module (which imports the custom_api prompt
// assembly) is never pulled into the main bundle when the gateway is off (Phase 02 invariant).
import type { GatewaySystemPromptConfig } from './systemPrompt'
// 🔴 type-only — Part B island agent HITL. The stash module is only imported at runtime by the
// lifecycle (which constructs it) + approvalResume; config.ts stays type-only so flag-off keeps zero
// runtime pull of the Part B chunk.
import type { ApprovalRunStash } from './approvalStash'
// 🔴 type-only (erased) — S4 W3 headless custom-agent run. The spec type is the wire contract the
// gateway pulls from serve-api; config.ts stays type-only so the S4 chunk isn't pulled when off.
import type { AgentRunSpec } from '@shared/api/types'

/** Part B — what makePersistOnFinish tells the lifecycle when a turn pauses at an island-eligible
 *  approval gate (announce → serve-api). NO token/secret in here beyond the resumeToken, which is the
 *  gateway-minted capability the island round-trip must echo back on /decide. */
export interface IslandApprovalAnnounce {
  sessionId: number | null
  toolCallId: string
  toolName: string
  risk: string
  inputPreview: string
  resumeToken: string
}

/** Phase 05 — what the AG-UI mirror passes the approval-request resolver: the accumulated tool call
 *  + the ai@6 approval id/signature. The Electron wrapper looks toolCallId up in the ApprovalGuard
 *  (risk / reason / expiry) + optional A2UI and returns the full request payload (or null). */
export interface ApprovalRequestResolveInfo {
  toolCallId: string
  toolName: string | null
  input: unknown
  approvalId: string
  signature?: string
}

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
  /** M1c — fire-and-forget auto-capture trigger. Called in onFinish AFTER persistTurn with the
   *  finished turn; the Electron wrapper posts it to serve-api /api/chat/memory/capture (mem0.add
   *  auto-extracts durable prefs/facts). 🔴 MUST be fire-and-forget: the implementation returns
   *  void (NOT an awaited promise), so a slow / failed capture cannot block the already-streamed
   *  reply. Injected by the lifecycle ONLY when MAILAGENT_MEM0_CAPTURE is on; omitted (default) →
   *  no capture, byte-identical. */
  captureTurnMemory?: (turn: PersistTurnInput) => void
  /** Build the LanguageModel for a model id. Injected by tests (mock model); the
   *  default wires @ai-sdk/anthropic + the normalized baseURL + apiKey. */
  createModel?: (modelId: string) => LanguageModel
  /** Phase 03a — factory that builds the AI SDK read tools bound to a per-request
   *  audit collector (closure). The gateway calls it once per /api/ai/chat with a
   *  fresh `collector` array, runs a multi-step tool loop (streamText { tools,
   *  stopWhen }), and drains the collector into chat_tool_call in onFinish. Bound by
   *  closure (NOT streamText experimental_context — see tools/types.ts) so audit is
   *  robust + directly testable. Omitted / empty result → text-only (Phase 02
   *  behaviour, byte-identical).
   *
   *  `approvalMode` (from body.approvalMode, default 'always') controls whether reversible
   *  preview-tier writes skip the approval card ('auto-reversible') or always ask ('always');
   *  the blocking send always asks regardless. Absent → 'always' (byte-identical to pre-toggle).
   *
   *  `contextMode` (S2 W0, ADR-001 D1) is the run's SERVER-asserted provenance, threaded from
   *  prepareChatRun's trustedContextMode (never from the body). It governs which tool classes
   *  register (capability_change/exec/outbound are manual_chat-only) and whether auto-reversible
   *  may skip a card (domain_write + manual_chat only). Absent/unknown → the implementation
   *  fail-closes to 'untrusted_trigger'. */
  buildTools?: (
    collector: GatewayToolAuditEntry[],
    approvalMode?: GatewayApprovalMode,
    contextMode?: AgentContextMode
  ) => ToolSet
  /** Max tool-loop steps (stopWhen: stepCountIs). Default 8 (legacy AGENT_MAX_ITER). */
  maxSteps?: number
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
  /** S2 W1 (ADR-001 D4/D6) — the exec approval card's "always allow" affordance. POST
   *  /api/ai/policy/remember {toolCallId} calls this: the Electron wrapper peeks the pending exec
   *  approval (ApprovalGuard.peek — the SAME approved argv/cwd/path, so the model cannot forge a
   *  broader rule), derives a full-PIN structured PolicyRule (argv template / realpath scope), and
   *  persists it via the owner policy API (context_mode is pinned to manual_chat — a whitelist is
   *  manual-only, ADR-001 §9). This is the ONLY rule-creation path besides Settings; NO gateway tool
   *  can reach it. Returns the created rule (camelCase, incl. `dangerous`); throws an
   *  ApprovalError-shaped `.code` on a non-exec tool / no live record / a derivation failure. Omitted
   *  → /api/ai/policy/remember returns 501 (exec tools not wired). */
  rememberExecApproval?: (toolCallId: string) => Promise<Record<string, unknown>>
  /** Phase 05 — MAILAGENT_AG_UI_MIRROR. When true, the gateway registers the AG-UI mirror endpoint
   *  POST /api/ai/agui/chat (the SAME streamText + tools + approval as /api/ai/chat, re-encoded as an
   *  AG-UI event stream). Off (default) → the route is NOT registered (404), byte-identical to 04b. */
  aguiMirrorEnabled?: boolean
  /** Phase 05 — enrich an AG-UI `tool-approval-request` into a full ToolApprovalRequestPayload (the
   *  mirror then maps it to an AG-UI interrupt). The Electron wrapper implements it as a READ-ONLY
   *  ApprovalGuard.peek (risk / reason / expiry) + optional A2UI. Returns null when no record is
   *  found → the mirror falls back to a minimal fail-closed interrupt. Omitted → same fallback. */
  resolveApprovalRequest?: (info: ApprovalRequestResolveInfo) => ToolApprovalRequestPayload | null
  /** Phase 06 (context injection; always injected since S3). Returns the standing-context
   *  config (/chat/config projection) used to build streamText `system`. Set by the Electron wrapper
   *  ONLY when the flag is on; it fetches the SAME serve-api /chat/config the legacy runtime uses
   *  (TTL-cached). When set, prepareChatRun assembles the system from standingContext + the request's
   *  AgentContextSnapshot (buildGatewaySystemPrompt) instead of passing through body.system. Omitted
   *  (default) → body.system passthrough, byte-identical to Phase 02. A null RESULT (fetch failed) →
   *  context-light fallback (SOUL_MARKDOWN, no standing context). */
  systemPromptProvider?: () =>
    | Promise<GatewaySystemPromptConfig | null>
    | GatewaySystemPromptConfig
    | null
  /** Phase 10b (configurable LLM auto-title) — read the auto-title context for a session: its current
   *  title and the first user message text. A non-null `title` means the session is already named
   *  (manual rename OR a prior auto-title), so POST /api/ai/title returns it unchanged and skips
   *  regeneration → a manually-edited title is NEVER overwritten. `firstUserText` is the generation
   *  input. Returns null on a missing session. The Electron wrapper reads ai_chat.db (getSession +
   *  getFirstUserText). Omitted → POST /api/ai/title returns 501 (auto-title not wired). */
  getTitleContext?: (
    sessionId: number
  ) => { title: string | null; firstUserText: string | null } | null
  /** Phase 10b — persist a generated session title (Electron wrapper → chat_db.updateSessionTitle,
   *  which does NOT bump updated_at so the history order stays stable). Omitted → 501. */
  saveSessionTitle?: (sessionId: number, title: string) => void
  /** dogfood-3 (follow-ups) — read the last completed turn's user + assistant text for a session, used
   *  to generate next-question suggestions (POST /api/ai/followups). The Electron wrapper reads
   *  ai_chat.db (most-recent user message + most-recent assistant message content). Returns null when a
   *  turn isn't available yet. Omitted → POST /api/ai/followups returns 501 (follow-ups not wired). */
  getFollowupContext?: (sessionId: number) => { userText: string; assistantText: string } | null
  /** #12 (dogfood session-history) — eager-persist hook called at the START of a chat turn, before
   *  streaming begins. The Electron wrapper writes the user message immediately so the session appears
   *  in the history list even when the first turn is HITL-paused and onFinish's persistTurn is
   *  skipped. sessionId null → no-op; userMessage null when the turn carries no user message (rare).
   *  Best-effort: a failure is logged and the stream continues — persistTurn's onFinish falls back to
   *  writing the user message. Omitted → no eager persist, byte-identical to pre-#12 behaviour. */
  onTurnStart?: (sessionId: number | null, userMessage: MailAgentUIMessage | null) => void
  /** R2-3 (dogfood) — called when a turn PAUSES at an approval gate, with a DISPLAY-SAFE redacted
   *  copy of the paused assistant message (approval-requested tool parts stripped; see
   *  redactApprovalRequestedParts). The Electron wrapper upserts it into ai_chat.db keyed by the
   *  UIMessage id so switching to the session shows what the model already said; the resume turn's
   *  persistTurn REPLACES the row (the resume's merged responseMessage keeps the same id) instead of
   *  appending a duplicate. Best-effort + fire-and-forget (never awaited). Omitted → paused turns
   *  store nothing, byte-identical to the pre-R2-3 behaviour. */
  persistPausedAssistant?: (
    sessionId: number | null,
    redactedMessage: MailAgentUIMessage,
    modelId: string
  ) => void

  // ── Part B (harness agent 上岛) — full-offline island approval resume ────────────────────────────
  /** MAILAGENT_ISLAND_AGENT_ENABLED. Gates the whole Part B path: makePersistOnFinish only stashes +
   *  announces a paused approval when true; POST /api/ai/approval/decide 404s when false; the write
   *  tools become one-shot (see below). Off (default) → renderer-driven resume only, byte-identical. */
  islandAgentEnabled?: boolean
  /** Part B — the per-gateway stash of paused approval runs (approvalStash.ts). Injected by the
   *  lifecycle (constructed once, like the ApprovalGuard). makePersistOnFinish stashes into it when a
   *  turn pauses awaiting approval; POST /api/ai/approval/decide claims + resumes from it. Omitted →
   *  no server-side resume (renderer path only). */
  approvalStash?: ApprovalRunStash
  /** Part B — fire-and-forget announce a paused approval to the island (lifecycle → serve-api
   *  /api/island/agent/announce). Called by makePersistOnFinish AFTER stashing, with the resumeToken
   *  the stash minted. 🔴 MUST be fire-and-forget (returns void, never awaited) so a slow/failed
   *  announce can't block the already-streamed (paused) turn. Omitted → no island announce. */
  announceApprovalToIsland?: (info: IslandApprovalAnnounce) => void
  /** Part B — read whether an approval already reached a TERMINAL decision on ANY surface (approved
   *  +executed OR rejected — ApprovalGuard.isResolved). /api/ai/approval/decide short-circuits on this
   *  so it never re-runs an approval the RENDERER already resolved (in-app approve executed, or in-app
   *  reject) — no double execute, no double persist, and (critically) a renderer REJECT blocks a later
   *  island approve. Omitted → the resume runs regardless (the write-tool one-shot consume still
   *  prevents a double write, but a cross-surface reject would not be honored). */
  isApprovalResolved?: (toolCallId: string) => boolean
  /** Part B — TOMBSTONE an approval as rejected (ApprovalGuard.reject) so the OTHER surface can't
   *  approve+execute it. Called by makePersistOnFinish when a completed turn carries a REJECTED tool
   *  part (renderer or island reject), and by resumeApprovalRun on an island reject. Idempotent /
   *  never throws. Omitted (island agent off) → no cross-surface reject tombstoning (inert). */
  rejectApproval?: (toolCallId: string) => void
  /** Part B (dogfood live-refresh) — an island /decide server-side resume reached a TERMINAL state
   *  (completed / rejected / error) for a persisted session. The lifecycle broadcasts it to renderer
   *  windows ('chat:session-updated' IPC) so an OPEN chat panel showing the stale approval card can
   *  reload the session's messages from ai_chat.db instead of waiting for a manual session switch.
   *  NOT called on 'repaused' (a fresh island card owns the next hop — the panel still shows a live
   *  approval) nor 'not_found' (nothing ran). Fire-and-forget (server.ts wraps it in try/catch);
   *  omitted (island agent off) → inert, byte-identical. */
  onServerResumeSettled?: (sessionId: number, status: 'completed' | 'rejected' | 'error') => void

  // ── S4 W3 (custom-agent headless run, ADR-003) — POST /api/ai/agent-run fresh-spawn ─────────────
  /** ADR-003 D2 — pull the AUTHORITATIVE agent-run spec by jobId + claimToken. The gateway is poked
   *  with only {jobId, claimToken}; it fetches the权威 spec here so the POST body never carries
   *  prompt/toolPolicy/trigger.kind (a local process cannot forge a wide run). The Electron wrapper
   *  implements it via domainClient.fetchAgentRunSpec (GET /api/agent-runs/{id}/spec + X-Claim-Token,
   *  verify_local_token, one-shot CAS server-side). Throws a DomainError-shaped `.code` (E_SPEC_*) on
   *  forbidden / not-found / already-claimed → the endpoint maps it to a typed HTTP error the
   *  AgentRunWorker records as last_error. Injected ONLY when MAILAGENT_CUSTOM_AGENTS_ENABLED is on;
   *  omitted (default) → POST /api/ai/agent-run 404s (feature not wired), byte-identical to S3. */
  fetchAgentRunSpec?: (jobId: number, claimToken: string) => Promise<AgentRunSpec>
  /** ADR-003 D3 — pre-create the ai_chat.db session a headless run persists into (origin='agent' +
   *  agent_id/job_id, CHAT_DB v19) so the run is visible/auditable in the same history UI. The
   *  Electron wrapper calls chat_db.createAgentSession. Returns the new session id, or null if the
   *  create failed (the run then streams but persists nothing — degraded, not fatal). Injected ONLY
   *  when MAILAGENT_CUSTOM_AGENTS_ENABLED is on; omitted (default) → POST /api/ai/agent-run 404s. */
  createAgentSession?: (input: { agentId: string; jobId: number; title: string }) => number | null
}
