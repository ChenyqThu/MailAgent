// chat-panel P4 Phase 02 — embedded AI SDK Gateway (formalized from the Phase 00
// spike `ai_gateway_poc.ts`). A loopback Node HTTP server that the Electron main
// process embeds (NOT a separate OS process — architecture §13.3 form A). It
// exposes an AI SDK UIMessage-compatible chat endpoint so the assistant-ui
// `useChatRuntime` runtime can stream text from a model through one provider path.
//
// 🔴 Design discipline (so the core is harness-testable in plain Node): this file
//    depends ONLY on `node:http` + the pure gateway internals (chatRun / httpUtil /
//    agui). It NEVER imports electron / keytar / chat_db. The LLM key, the persistence
//    writer, and the model factory all arrive via AiGatewayConfig (config.ts).
//
// 🔴 flag-gated: index.ts only imports this when MAILAGENT_AI_SDK_GATEWAY==='true',
//    so flag-off (default) the `ai` / `@ai-sdk/anthropic` chunk never loads and
//    default behaviour is byte-for-byte unchanged.
//
// Phase 05 — the /api/ai/chat preamble (validate → build streamText with tools + approval) lives in
// chatRun.ts, shared with the AG-UI mirror (agui/aguiRoute.ts) so both endpoints run the SAME
// streamText + tools + double-guard approval. The mirror route is registered only when
// cfg.aguiMirrorEnabled (MAILAGENT_AG_UI_MIRROR) — flag-off it is unreachable (404).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { AiGatewayConfig } from './config'
import type { MailAgentUIMessageMetadata } from '@shared/assistant/uiMessage'
import {
  approvalInputPreview,
  extractApprovalStashInput,
  generateFollowups,
  generateSessionTitle,
  lastUserMessage,
  makeIdGenerator,
  makePersistOnFinish,
  prepareChatRun
} from './chatRun'
import {
  corsHeadersFor,
  delay,
  isBodyTooLarge,
  readJsonBody,
  writeJson,
  writeSse,
  SSE_HEADERS
} from './httpUtil'
import { handleAguiChat } from './agui/aguiRoute'
import { resumeApprovalRun } from './approvalResume'
import { runHeadlessSearchAgent } from './searchAgentRun'
import { runHeadlessAgent } from './agentRun'
import type { HeadlessAgentResult } from '../shared/api/types'

const GATEWAY_VERSION = '0.2.0'

export interface AiGatewayHandle {
  server: Server
  /** actual listening port (kernel-assigned when cfg.port === 0). */
  port: number
  close: () => Promise<void>
}

/**
 * `POST /api/ai/echo-stream` — no key, echoes the prompt back token-by-token as
 * SSE. Proves transport (SSE frames) + abort (client close stops it) decoupled
 * from the AI SDK. Retained from the spike for the harness's transport check.
 */
async function handleEchoStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const prompt =
    typeof body.prompt === 'string' && body.prompt.length > 0 ? body.prompt : 'hello from echo'
  let aborted = false
  req.on('close', () => {
    aborted = true
  })
  res.writeHead(200, { ...SSE_HEADERS, ...corsHeadersFor(req.headers.origin) })
  writeSse(res, { type: 'start', route: 'echo-stream' })
  const tokens = prompt.match(/\S+\s*|\s+/g) ?? [prompt]
  for (const tok of tokens) {
    if (aborted) break
    writeSse(res, { type: 'text-delta', delta: tok })
    await delay(40)
  }
  if (!aborted) writeSse(res, { type: 'finish', reason: 'stop' })
  res.end()
}

/**
 * `POST /api/ai/chat` — the canonical Phase 02 endpoint. prepareChatRun converts the incoming
 * UIMessages to model messages and runs `streamText` (with tools + approval when configured); we
 * pipe the AI SDK UIMessage stream straight to the Node response so the assistant-ui
 * `useChatRuntime` runtime consumes it natively. abortSignal cancels the upstream LLM call when the
 * client disconnects. On finish (non-aborted) makePersistOnFinish hands the turn to cfg.persistTurn
 * for the ai_chat.db dual-write. No key → 503 E_NO_LLM_KEY; empty messages → 400 E_INVALID_ARG.
 */
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  const body = await readJsonBody(req)
  // Phase 06-parity — session reload + a 12k context snapshot can push a legit turn past the old
  // 64KB cap; answer an explicit 413 rather than a misleading "messages[] required" 400 (codex review).
  if (isBodyTooLarge(body)) {
    writeJson(res, 413, {
      error: 'E_PAYLOAD_TOO_LARGE',
      hint: 'chat request body exceeds the gateway size limit'
    })
    return
  }
  // abort: client disconnect (or the renderer AbortController) cancels the upstream call.
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  // S2 W0 (ADR-001 D1) — /api/ai/chat is an owner-driven surface (local renderer direct on
  // loopback, or remote web through serve-api's owner-authenticated proxy): assert 'manual_chat'
  // here, in trusted code. The body is never consulted for the mode.
  const prepared = await prepareChatRun(body, cfg, controller.signal, 'manual_chat')
  if (!prepared.ok) {
    writeJson(res, prepared.status, prepared.body)
    return
  }
  const run = prepared.run
  // #12 (dogfood session-history) — eager-persist: write the user message at turn START so the
  // session row appears in history even when the first turn is HITL-paused and onFinish skips
  // persistTurn. Best-effort: a failure is logged and the stream continues (persistTurn's onFinish
  // falls back to writing the user message so no data is lost). The Electron lifecycle's
  // persistTurn tracks eagerly-written user messages (Set keyed by session + message id) to
  // avoid double-writing.
  try {
    cfg.onTurnStart?.(run.sessionId, lastUserMessage(run.rawMessages))
  } catch (err) {
    console.error('[ai-gateway] onTurnStart failed (stream will continue)', err)
  }
  // dogfood (codex root-cause) — client-visible「答复时间」timing. WHY server-side messageMetadata and
  // not react-ai-sdk's runtime messageTiming: @assistant-ui/core's converter caches conversions by the
  // AI SDK message OBJECT in a WeakMap; the runtime injects timing as a metadata-only update AFTER the
  // stream ends (same message object) → the converter cache hits the stale result, never re-runs, and
  // `message.metadata.timing` stays empty → the badge never shows (reasoning rendered fine because it's
  // a streamed part = object changes). Emitting timing on the FINISH chunk makes the AI SDK client clone
  // the message → cache miss → metadata.timing lands, AND it's persisted in ui_message_json so a history
  // reload keeps the badge. Wall-clock measured client-perceived from just-before-pipe (LLM already in
  // flight) — a reasonable approximation for a response-time badge.
  const streamStartTime = Date.now()
  let firstTokenTime: number | undefined
  let totalChunks = 0
  let outputChars = 0
  const timingToolCallIds = new Set<string>()
  run.result.pipeUIMessageStreamToResponse(res, {
    originalMessages: run.rawMessages,
    generateMessageId: makeIdGenerator(),
    messageMetadata: ({ part }): MailAgentUIMessageMetadata | undefined => {
      if (part.type === 'text-delta') {
        totalChunks += 1
        if ('text' in part && typeof part.text === 'string') outputChars += part.text.length
        if (firstTokenTime === undefined) firstTokenTime = Date.now() - streamStartTime
        return undefined
      }
      if ('toolCallId' in part && typeof part.toolCallId === 'string') {
        timingToolCallIds.add(part.toolCallId)
      }
      if (part.type !== 'finish') return undefined
      const totalStreamTime = Date.now() - streamStartTime
      // ~4 chars/token rough estimate (no server tokenizer here); drives the optional tok/s tooltip only.
      const tokenCount = outputChars > 0 ? Math.ceil(outputChars / 4) : undefined
      return {
        timing: {
          streamStartTime,
          totalStreamTime,
          totalChunks,
          toolCallCount: timingToolCallIds.size,
          ...(firstTokenTime !== undefined ? { firstTokenTime } : {}),
          ...(tokenCount !== undefined ? { tokenCount } : {}),
          ...(tokenCount !== undefined && totalStreamTime > 0
            ? { tokensPerSecond: tokenCount / (totalStreamTime / 1000) }
            : {})
        }
      }
    },
    // composer-parity dogfood-2 #2 — forward extended-thinking reasoning parts to the UIMessage
    // stream. The AG-UI mirror (aguiRoute.ts) already sets this; the canonical route was missing it,
    // and ai@7 defaults sendReasoning to false → the thinking block never reached the renderer even
    // when the model produced one. Off-thinking turns carry no reasoning parts, so this is inert there.
    sendReasoning: true,
    // composer-parity dogfood-2 #4 — surface a stream/resume error to the client instead of ai@7's
    // default masked generic. Without it a failed approval-resume turn ended the stream with a
    // swallowed error and the rich card silently vanished ("卡执行中然后没了"); now the card renders a
    // real error and the cause is logged for forensics (mirrors the AG-UI route's RunError emit).
    onError: (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[ai-gateway] /api/ai/chat stream error', error)
      return msg
    },
    onFinish: makePersistOnFinish(cfg, run),
    // Phase 06a — loopback-only CORS on the main chat stream too (the AI SDK pipe sets no ACAO by
    // default; reflect the renderer's loopback / null origin, omit for a remote cross-origin page).
    headers: corsHeadersFor(req.headers.origin)
  })
}

/** Map an ApprovalError-shaped `.code` to an HTTP status for the resolve endpoint. */
function approvalErrorStatus(code: string): number {
  switch (code) {
    case 'E_APPROVAL_NOT_FOUND':
      return 404
    case 'E_APPROVAL_EXPIRED':
      return 410
    case 'E_APPROVAL_NOT_EDITABLE':
      return 400
    default:
      return 400
  }
}

/**
 * `POST /api/ai/approval/resolve` — Phase 04a edit-tier side-channel. The rich DraftReplyCard
 * POSTs the user's edited fields here BEFORE replaying the ai@6 approval. The gateway overlays
 * the editable fields onto the pending approval's original input (via cfg.resolveEditedApproval
 * → ApprovalGuard.applyEdit) so the next streamText call's execute runs the edited input — all
 * WITHOUT changing the ai@6 history input, so the signed approval stays valid (architecture
 * §13.10.2(1)). Identity fields are pinned domain-side. Errors are typed: 404 not-found / 410
 * expired / 400 not-editable / 501 when no resolver is wired (read-only / 03b config).
 */
async function handleApprovalResolve(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.resolveEditedApproval) {
    writeJson(res, 501, {
      error: 'E_NOT_IMPLEMENTED',
      hint: 'edit-tier approval cards not enabled'
    })
    return
  }
  const body = await readJsonBody(req)
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const editedInput =
    body.editedInput && typeof body.editedInput === 'object' && !Array.isArray(body.editedInput)
      ? (body.editedInput as Record<string, unknown>)
      : null
  if (!toolCallId || !editedInput) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'toolCallId + editedInput{} required' })
    return
  }
  try {
    const out = cfg.resolveEditedApproval(toolCallId, editedInput)
    writeJson(res, 200, { status: 'ok', ...out })
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const message = e instanceof Error ? e.message : String(e)
    if (typeof code === 'string') {
      writeJson(res, approvalErrorStatus(code), { error: code, hint: message })
    } else {
      // Unexpected non-ApprovalError on a security-adjacent endpoint — log for forensics
      // (never executes a write; the resolver only records an override).
      console.error('[ai-gateway] /api/ai/approval/resolve failed unexpectedly', e)
      writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
    }
  }
}

/**
 * `POST /api/ai/policy/remember` — S2 W1 exec whitelist "always allow" side-channel. The exec
 * approval card POSTs { toolCallId } when the user ticks "always allow" and approves. The gateway
 * peeks the pending exec approval (guard.peek — the SAME approved argv/cwd/path), derives a
 * full-PIN structured PolicyRule, and persists it via the owner policy API (cfg.rememberExecApproval).
 * This is the ONLY rule-creation path besides Settings; no gateway TOOL can reach it. Typed errors:
 * 404 not-found / 400 bad-arg (non-exec / derivation) / 501 when exec tools aren't wired.
 */
async function handlePolicyRemember(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.rememberExecApproval) {
    writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'exec tools not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  if (!toolCallId) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'toolCallId required' })
    return
  }
  try {
    const rule = await cfg.rememberExecApproval(toolCallId)
    writeJson(res, 200, { status: 'ok', rule })
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const message = e instanceof Error ? e.message : String(e)
    if (typeof code === 'string') {
      writeJson(res, approvalErrorStatus(code), { error: code, hint: message })
    } else {
      console.error('[ai-gateway] /api/ai/policy/remember failed unexpectedly', e)
      writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
    }
  }
}

/**
 * `POST /api/ai/title` — Phase 10b configurable LLM auto-title. The renderer POSTs { sessionId,
 * model? } after the FIRST turn of a brand-new conversation WHEN the user enabled LLM auto-title in
 * settings (default off → first-message preview is the title, no call here). The gateway reads the
 * session's first user message (cfg.getTitleContext), generates a short title via the chosen model
 * (generateSessionTitle), persists it (cfg.saveSessionTitle), and returns it so the renderer refreshes
 * the unified history → the title updates live. IDEMPOTENT: a session that already has a title (manual
 * rename OR a prior auto-title) is returned unchanged (skipped) so a manual title is never overwritten.
 * 501 when auto-title isn't wired (read-only config); 503 no key; 400 bad arg; 404 no user message.
 */
async function handleTitle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.getTitleContext || !cfg.saveSessionTitle) {
    writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'auto-title not enabled' })
    return
  }
  if (!cfg.apiKey || cfg.apiKey.length === 0) {
    writeJson(res, 503, { error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId required' })
    return
  }
  const ctx = cfg.getTitleContext(sessionId)
  if (!ctx) {
    writeJson(res, 404, { error: 'E_NOT_FOUND', hint: 'session not found' })
    return
  }
  // Idempotent: an already-titled session (manual rename / prior auto-title) is never regenerated.
  if (ctx.title && ctx.title.trim().length > 0) {
    writeJson(res, 200, { title: ctx.title, skipped: true })
    return
  }
  if (!ctx.firstUserText || ctx.firstUserText.trim().length === 0) {
    writeJson(res, 404, { error: 'E_NOT_FOUND', hint: 'session has no user message' })
    return
  }
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : cfg.model
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  try {
    const title = await generateSessionTitle(cfg, ctx.firstUserText, model, controller.signal)
    if (title) {
      cfg.saveSessionTitle(sessionId, title)
      writeJson(res, 200, { title })
    } else {
      // The model returned nothing usable — leave the session untitled (preview keeps showing).
      writeJson(res, 200, { title: null, skipped: true })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[ai-gateway] /api/ai/title failed', e)
    writeJson(res, 502, { error: 'E_UPSTREAM', hint: message })
  }
}

/**
 * `POST /api/ai/followups` — dogfood-3 dynamic follow-up suggestions. After a turn completes the
 * renderer POSTs { sessionId, model? }; the gateway reads the last turn (cfg.getFollowupContext),
 * generates 2-3 short next-questions via the chosen model (generateFollowups), and returns them so the
 * renderer renders tappable chips above the composer. Per-turn (NOT idempotent — each turn gets fresh
 * ones), best-effort: no turn yet → { followups: [] } (200, not an error). 501 when not wired; 503 no
 * key; 400 bad arg; 502 upstream. Never persists, never blocks the chat.
 */
async function handleFollowups(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.getFollowupContext) {
    writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'follow-ups not enabled' })
    return
  }
  if (!cfg.apiKey || cfg.apiKey.length === 0) {
    writeJson(res, 503, { error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId required' })
    return
  }
  const ctx = cfg.getFollowupContext(sessionId)
  if (!ctx || !ctx.userText || !ctx.assistantText) {
    // No completed turn yet — empty is a normal state, not an error.
    writeJson(res, 200, { followups: [] })
    return
  }
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : cfg.model
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  try {
    const followups = await generateFollowups(
      cfg,
      ctx.userText,
      ctx.assistantText,
      model,
      controller.signal
    )
    writeJson(res, 200, { followups })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[ai-gateway] /api/ai/followups failed', e)
    writeJson(res, 502, { error: 'E_UPSTREAM', hint: message })
  }
}

/**
 * `POST /api/ai/search-agent` — S3 W1 headless agentic search (the ⌘K "AI 理解" palette entry,
 * re-homed from the legacy harness). Body `{ userContent, mailbox?, model? }` — the renderer client
 * assembles the prompt+query user content and the trimmed mailbox filter. Streams SSE frames:
 * `{type:'phase', phase:'searching'|'summarizing'}` progress events (the palette's thinking-phrase
 * groups) then one terminal `{type:'result', result}` carrying the structured SearchAgentResult
 * (minus the renderer-side nlToDsl fallbackDsl). Loopback-trusted like the other gateway endpoints;
 * the loop only ever sees the four read tools (defensive whitelist in searchAgentRun), so there is
 * no approval surface. Client disconnect aborts the upstream LLM call. No persistence — a headless
 * search never touches ai_chat.db (legacy parity). No key → 503; empty userContent → 400.
 */
async function handleSearchAgent(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.apiKey || cfg.apiKey.length === 0) {
    writeJson(res, 503, { error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' })
    return
  }
  const body = await readJsonBody(req)
  const userContent =
    typeof body.userContent === 'string' && body.userContent.length > 0 ? body.userContent : ''
  if (userContent.length === 0) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'userContent required' })
    return
  }
  const mailbox =
    typeof body.mailbox === 'string' && body.mailbox.length > 0 ? body.mailbox : undefined
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  res.writeHead(200, { ...SSE_HEADERS, ...corsHeadersFor(req.headers.origin) })
  const result = await runHeadlessSearchAgent(
    cfg,
    { userContent, mailbox, model },
    controller.signal,
    (phase) => {
      if (!controller.signal.aborted) writeSse(res, { type: 'phase', phase })
    }
  )
  if (!controller.signal.aborted) writeSse(res, { type: 'result', result })
  res.end()
}

/** S4 W3 — map a HeadlessAgentResult to the wire JSON the AgentRunWorker consumes. The worker reads
 *  a STRING `error` code (AgentRunResult._map_response str()s it into last_error), so we flatten
 *  error.code; sessionId/steps/summary/usage pass through into the worker's result_json. */
function toAgentRunWire(result: HeadlessAgentResult): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ok: result.ok,
    outcome: result.outcome,
    sessionId: result.sessionId,
    steps: result.steps
  }
  if (result.summary) wire.summary = result.summary
  if (result.usage) wire.usage = result.usage
  if (result.error) wire.error = result.error.code
  return wire
}

/**
 * `POST /api/ai/agent-run` — S4 W3 headless custom-agent fresh-spawn (ADR-003 D2). The AgentRunWorker
 * (Python) pokes this with only `{ jobId, claimToken }` — never authoritative facts. The gateway PULLS
 * the權威 spec from serve-api (cfg.fetchAgentRunSpec, one-shot CAS), derives the context mode from the
 * spec's trigger.kind in trusted code, pre-creates the ai_chat.db session (cfg.createAgentSession), and
 * drains a headless run (runHeadlessAgent) under the derived mode. The synchronous response carries the
 * terminal result the worker maps to an async_jobs state. Loopback-trusted like the other gateway
 * endpoints (verify_local_token already gated the spec pull upstream). Both cfg hooks are injected only
 * when MAILAGENT_CUSTOM_AGENTS_ENABLED is on → off (default) → 404, byte-identical to S3.
 */
async function handleAgentRun(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.fetchAgentRunSpec || !cfg.createAgentSession) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'custom agents feature not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const jobId = typeof body.jobId === 'number' && Number.isInteger(body.jobId) ? body.jobId : null
  const claimToken = typeof body.claimToken === 'string' ? body.claimToken : ''
  if (jobId == null || claimToken.length === 0) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'jobId (int) + claimToken required' })
    return
  }

  // Pull the authoritative spec (one-shot CAS server-side). A DomainError-shaped `.code` (E_SPEC_*)
  // → forward it verbatim with the serve-api HTTP status so the worker records the exact code.
  let spec
  try {
    spec = await cfg.fetchAgentRunSpec(jobId, claimToken)
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const httpStatus = (e as { httpStatus?: unknown }).httpStatus
    const message = e instanceof Error ? e.message : String(e)
    const status = typeof httpStatus === 'number' && httpStatus >= 400 ? httpStatus : 502
    writeJson(res, status, {
      error: typeof code === 'string' ? code : 'E_SPEC_FETCH_FAILED',
      hint: message
    })
    return
  }

  // Pre-create the persist session (origin='agent'). A failure degrades to a non-persisted run
  // rather than aborting (the tool loop + approval still work; only the history row is missing).
  let sessionId: number | null = null
  try {
    sessionId = cfg.createAgentSession({ agentId: spec.agentId, jobId, title: spec.sessionTitle })
  } catch (err) {
    console.error(
      '[ai-gateway] /api/ai/agent-run createAgentSession failed (run continues unsaved)',
      err
    )
    sessionId = null
  }

  // Budget deadline (ADR-003 D7): merge the client (worker) disconnect with an AbortSignal.timeout at
  // maxRunSeconds. The worker's own http timeout has a +margin, so the timeout fires FIRST → a bounded
  // synchronous response. `clientClosed` distinguishes a worker disconnect (socket gone → skip the
  // write) from a budget timeout (socket open → write the E_BUDGET_TIME result so the worker records it).
  const maxRunSeconds =
    typeof spec.budget?.maxRunSeconds === 'number' && spec.budget.maxRunSeconds > 0
      ? spec.budget.maxRunSeconds
      : 300
  const clientAbort = new AbortController()
  let clientClosed = false
  req.on('close', () => {
    clientClosed = true
    clientAbort.abort()
  })
  const merged = AbortSignal.any([clientAbort.signal, AbortSignal.timeout(maxRunSeconds * 1000)])

  // runHeadlessAgent normalizes every drain failure, but prepareChatRun sits before its try block —
  // an unexpected throw there must still answer the worker (same belt handleApprovalDecide wears);
  // otherwise the poke would hang until the worker's own http timeout and the rejection goes unhandled.
  try {
    const result = await runHeadlessAgent(cfg, { jobId, spec, sessionId }, merged)
    if (!clientClosed) writeJson(res, 200, toAgentRunWire(result))
  } catch (err) {
    console.error('[ai-gateway] /api/ai/agent-run crashed', err)
    if (!clientClosed) writeJson(res, 500, { error: 'E_AGENT_RUN_CRASH' })
  }
}

/**
 * `POST /api/ai/approval/decide` — Part B (harness 上岛). The ISLAND approval callback lands here
 * (serve-api → gateway, loopback): the gateway resumes a stashed paused approval SERVER-SIDE so a
 * user fully off the app (renderer unmounted) can still approve on the island and have the tool run.
 * Body `{ toolCallId, decision:'approve'|'reject', resumeToken }`. The resumeToken is the gateway-
 * minted capability serve-api echoes back (approvalStash.claim rejects a wrong token). Registered
 * unconditionally; cfg.islandAgentEnabled + cfg.approvalStash gate it (404 when off → byte-identical
 * to pre-Part-B). Loopback-trusted like the other gateway endpoints; serve-api already validated the
 * island ack_token capability upstream before calling here.
 */
async function handleApprovalDecide(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.islandAgentEnabled || !cfg.approvalStash) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'island agent resume not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const resumeToken = typeof body.resumeToken === 'string' ? body.resumeToken : ''
  const decision = body.decision === 'reject' ? 'reject' : 'approve'
  if (!toolCallId || !resumeToken) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'toolCallId + resumeToken required' })
    return
  }
  // The resume drives a real write tool; the fork's ack POST is fire-and-forget (5s, doesn't read the
  // body), and serve-api awaits us in a background task, so a long resume is fine. Abort if serve-api
  // disconnects.
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  try {
    const result = await resumeApprovalRun(
      cfg,
      { toolCallId, decision, resumeToken },
      controller.signal
    )
    // Part B (dogfood live-refresh) — a TERMINAL settle (completed / rejected / error) on a persisted
    // session notifies the lifecycle so an open chat panel reloads instead of showing the stale
    // approval card. 'repaused' is NOT terminal (a fresh island card owns the next hop; the panel's
    // card is still live) and 'not_found' ran nothing. Best-effort: a hook throw must not break the
    // HTTP response to serve-api.
    if (
      result.sessionId != null &&
      (result.status === 'completed' || result.status === 'rejected' || result.status === 'error')
    ) {
      try {
        cfg.onServerResumeSettled?.(result.sessionId, result.status)
      } catch (err) {
        console.error('[ai-gateway] onServerResumeSettled hook failed (resume settled OK)', err)
      }
    }
    const status = result.status === 'not_found' ? 404 : 200
    writeJson(res, status, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai-gateway] /api/ai/approval/decide failed', err)
    writeJson(res, 500, { ok: false, status: 'error', error: message })
  }
}

/**
 * `GET /api/ai/approval/pending?sessionId=N` — the pending-approval TRUTH probe. Two consumers:
 *   - Part B island notice (AiChatPanel): a reloaded session shows only the REDACTED paused turn
 *     (approval parts stripped, R2-3), but with island agent on the approval may still be live in
 *     the stash — the notice reads { pending, toolName } to say "act on the island".
 *   - S6 W1 in-record approval (record view): live-queries this to decide whether to render an
 *     actionable decide card (hit) or an honest "已失效（超时或应用重启）" state (miss).
 * Read-only: peekBySession never consumes / extends the stash.
 *
 * miss → 404 { pending:false } (S6 W1): the stash is process-memory (gateway restart drops it), so
 * a miss is the fail-closed truth "no live claimable approval" — an honest boundary the record view
 * needs. The island-notice consumer already treats !res.ok as pending:false, so the 404 is
 * backward-compatible there. Island agent off / stash unwired → also a miss (nothing is claimable).
 *
 * 🔴 SECURITY — the hit body enriches with approvalId/inputPreview/agentId/jobId/ageMs for the
 * decide card, but NEVER the resumeToken: that capability must only leave the gateway through the
 * serve-api announce leg. `pending:true` + `toolName` are kept verbatim for the island-notice
 * consumer (superset, zero-touch).
 */
function handleApprovalPending(res: ServerResponse, cfg: AiGatewayConfig, url: string): void {
  const raw = new URL(url, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  const entry =
    cfg.islandAgentEnabled && cfg.approvalStash ? cfg.approvalStash.peekBySession(sessionId) : null
  if (!entry) {
    writeJson(res, 404, { pending: false })
    return
  }
  const info = extractApprovalStashInput(entry.responseMessage)
  writeJson(res, 200, {
    pending: true,
    approvalId: entry.approvalId,
    toolName: entry.toolName,
    inputPreview: info ? approvalInputPreview(entry.toolName, info.input) : entry.toolName,
    agentId: entry.agentRunContext?.agentId ?? null,
    jobId: entry.agentRunContext?.jobId ?? null,
    ageMs: Date.now() - entry.createdAt
  })
}

/**
 * Create (but do not listen) the gateway HTTP server. Pure factory — all external
 * deps arrive via cfg, so the Electron main can embed it and the Node harness can
 * drive it directly.
 */
export function createAiGatewayServer(cfg: AiGatewayConfig): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const path = url.split('?')[0]

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeadersFor(req.headers.origin),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end()
      return
    }

    const hasKey = Boolean(cfg.apiKey && cfg.apiKey.length > 0)

    if (method === 'GET' && path === '/health') {
      writeJson(res, 200, {
        status: 'ok',
        service: 'mailagent-ai-gateway',
        version: GATEWAY_VERSION,
        model: cfg.model,
        hasKey,
        baseUrl: cfg.baseUrl
      })
      return
    }

    // Observable runtime config (renderer may prefetch before constructing the
    // AI SDK transport). modelConfigured mirrors the spec §3 health shape.
    if (method === 'GET' && path === '/api/ai/config') {
      writeJson(res, 200, {
        service: 'mailagent-ai-gateway',
        version: GATEWAY_VERSION,
        model: cfg.model,
        modelConfigured: hasKey,
        baseUrl: cfg.baseUrl,
        persistence: Boolean(cfg.persistTurn),
        // Phase 05 — observable so a client can discover the mirror without probing 404.
        aguiMirror: Boolean(cfg.aguiMirrorEnabled)
      })
      return
    }

    if (method === 'POST' && path === '/api/ai/echo-stream') {
      void handleEchoStream(req, res)
      return
    }

    if (method === 'POST' && path === '/api/ai/chat') {
      void handleChat(req, res, cfg)
      return
    }

    // Phase 04a — edit-tier approval side-channel (DraftReplyCard edits before approve).
    if (method === 'POST' && path === '/api/ai/approval/resolve') {
      void handleApprovalResolve(req, res, cfg)
      return
    }

    // Part B (harness 上岛) — island approval callback → server-side resume. Registered
    // unconditionally; cfg.islandAgentEnabled + cfg.approvalStash gate it (404 when off).
    if (method === 'POST' && path === '/api/ai/approval/decide') {
      void handleApprovalDecide(req, res, cfg)
      return
    }

    // S2 W1 — exec whitelist "always allow" side-channel. Registered unconditionally;
    // cfg.rememberExecApproval gates it (501 when exec tools aren't wired).
    if (method === 'POST' && path === '/api/ai/policy/remember') {
      void handlePolicyRemember(req, res, cfg)
      return
    }

    // S3 W1 — headless agentic search (⌘K palette). Registered unconditionally; no key → 503.
    if (method === 'POST' && path === '/api/ai/search-agent') {
      void handleSearchAgent(req, res, cfg)
      return
    }

    // S4 W3 — headless custom-agent fresh-spawn (AgentRunWorker poke). Registered unconditionally;
    // cfg.fetchAgentRunSpec + cfg.createAgentSession gate it (404 when custom agents are off).
    if (method === 'POST' && path === '/api/ai/agent-run') {
      void handleAgentRun(req, res, cfg)
      return
    }

    // Part B follow-up + S6 W1 — pending-approval truth probe. Registered unconditionally; a miss
    // (island agent off / nothing stashed) → 404 { pending:false } (fail-closed truth), a hit → the
    // enriched decide-card body (never the resumeToken).
    if (method === 'GET' && path === '/api/ai/approval/pending') {
      handleApprovalPending(res, cfg, url)
      return
    }

    // Phase 10b — configurable LLM auto-title (renderer POSTs after the first turn when enabled).
    // Registered unconditionally; cfg.getTitleContext/saveSessionTitle gate it (501 when not wired).
    if (method === 'POST' && path === '/api/ai/title') {
      void handleTitle(req, res, cfg)
      return
    }

    // dogfood-3 — dynamic follow-up suggestions (renderer POSTs after each completed turn). Registered
    // unconditionally; cfg.getFollowupContext gates it (501 when not wired).
    if (method === 'POST' && path === '/api/ai/followups') {
      void handleFollowups(req, res, cfg)
      return
    }

    // Phase 05 — AG-UI interop mirror. Registered ONLY when MAILAGENT_AG_UI_MIRROR is on
    // (cfg.aguiMirrorEnabled); flag-off the path falls through to 404 (byte-identical to 04b).
    if (cfg.aguiMirrorEnabled && method === 'POST' && path === '/api/ai/agui/chat') {
      void handleAguiChat(req, res, cfg)
      return
    }

    writeJson(res, 404, { error: 'not_found', path })
  })
}

/** Create + listen (127.0.0.1). Returns the actual port + a graceful close. */
export function startAiGatewayServer(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const server = createAiGatewayServer(cfg)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      const actualPort = addr != null && typeof addr === 'object' ? addr.port : cfg.port
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          })
      })
    })
  })
}
