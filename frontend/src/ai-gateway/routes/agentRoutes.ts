// Echo stream, auto-title, headless search agent, custom-agent run, and generated image routes.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type AiGatewayConfig } from '../config'
import { GENERATED_IMAGE_ROUTE_PREFIX, resolveGeneratedFilePath } from '../tools/image'
import { generateSessionTitle, llmCredentialsMissing } from '../chatRun'
import { isPrivacyMaskError, isProviderCredentialsError } from '../providerRef'
import { corsHeadersFor, delay, readJsonBody, writeJson, writeSse, SSE_HEADERS } from '../httpUtil'
import { sanitizedUpstreamErrorMessage } from '../upstreamError'
import { runHeadlessSearchAgent } from '../searchAgentRun'
import { resolveAgentRunSeconds, runHeadlessAgent } from '../agentRun'
import { type HeadlessAgentResult } from '../../shared/api/types'

/**
 * `POST /api/ai/echo-stream` — no key, echoes the prompt back token-by-token as
 * SSE. Proves transport (SSE frames) + abort (client close stops it) decoupled
 * from the AI SDK. Retained from the spike for the harness's transport check.
 */
export async function handleEchoStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
 * `POST /api/ai/title` — Phase 10b configurable LLM auto-title. The renderer POSTs { sessionId,
 * model? } after the FIRST turn of a brand-new conversation WHEN the user enabled LLM auto-title in
 * settings (default off → first-message preview is the title, no call here). The gateway reads the
 * session's first user message (cfg.getTitleContext), generates a short title via the chosen model
 * (generateSessionTitle), persists it (cfg.saveSessionTitle), and returns it so the renderer refreshes
 * the unified history → the title updates live. IDEMPOTENT: a session that already has a title (manual
 * rename OR a prior auto-title) is returned unchanged (skipped) so a manual title is never overwritten.
 * 501 when auto-title isn't wired (read-only config); 503 no key; 400 bad arg; 404 no user message.
 */
export async function handleTitle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.getTitleContext || !cfg.saveSessionTitle) {
    writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'auto-title not enabled' })
    return
  }
  // HIGH-1 — shared credential pre-gate: flag-off byte-identical; registry path defers to the
  // resolver (typed failure mapped in the catch below).
  if (llmCredentialsMissing(cfg)) {
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
    if (isProviderCredentialsError(e)) {
      writeJson(res, 503, { error: 'E_NO_LLM_KEY', hint: e.message })
      return
    }
    if (isPrivacyMaskError(e)) {
      writeJson(res, 503, { error: 'E_PRIVACY_MASK_FAILED', hint: e.message })
      return
    }
    // M3 — registry 路径：hint 与日志都不得携带上游错误原文（可能回显凭证）；flag off
    // 保持既有 message/完整错误对象日志形状（nl_search.ts 同款分叉手法）。
    if (cfg.providerRegistryEnabled) {
      const sanitized = sanitizedUpstreamErrorMessage(e)
      console.error('[ai-gateway] /api/ai/title failed:', sanitized)
      writeJson(res, 502, { error: 'E_UPSTREAM', hint: sanitized })
      return
    }
    const message = e instanceof Error ? e.message : String(e)
    console.error('[ai-gateway] /api/ai/title failed', e)
    writeJson(res, 502, { error: 'E_UPSTREAM', hint: message })
  }
}

// (W6 — POST /api/ai/followups was removed: follow-ups are now an in-turn suggest_followups tool
// call inside /api/ai/chat itself; see tools/followups.ts. No second generation per turn.)

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
export async function handleSearchAgent(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  // HIGH-1 — shared credential pre-gate: flag-off byte-identical. On the registry path the SSE has
  // already started when the resolver runs, so a per-provider key failure surfaces as the terminal
  // {type:'result'} error frame (normalizeLoopError maps it to code E_NO_LLM_KEY).
  if (llmCredentialsMissing(cfg)) {
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
    (phase, detail) => {
      if (!controller.signal.aborted) {
        writeSse(res, { type: 'phase', phase, ...(detail ? { detail } : {}) })
      }
    },
    (phase, detail) => {
      if (!controller.signal.aborted) writeSse(res, { type: 'progress', phase, detail })
    }
  )
  if (!controller.signal.aborted) writeSse(res, { type: 'result', result })
  res.end()
}

/** S4 W3 — map a HeadlessAgentResult to the wire JSON the AgentRunWorker consumes. The worker reads
 *  a STRING `error` code (AgentRunResult._map_response str()s it into last_error), so we flatten
 *  error.code; sessionId/steps/summary/usage pass through into the worker's result_json.
 *
 *  0813 dogfood #17 — `errorMessage` is ADDITIVE alongside that string code. The code alone (the
 *  only thing that ever reached the worker) is undiagnosable in the field: `E_AGENT` is the catch-all
 *  for every non-APICallError drain failure, and the real cause only went to console.error, which
 *  goes NOWHERE in a packaged app (see ai_gateway_lifecycle's on-disk log rationale). Loopback-only
 *  audience (Python worker → local DB → the owner's own run row), same trust boundary as that log
 *  line. Existing readers are untouched: `_map_response` / `_map_matter_response` still read `error`. */
function toAgentRunWire(result: HeadlessAgentResult): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ok: result.ok,
    outcome: result.outcome,
    sessionId: result.sessionId,
    steps: result.steps
  }
  if (result.model) wire.model = result.model
  if (result.costUsd !== undefined) wire.costUsd = result.costUsd
  if (result.summary) wire.summary = result.summary
  if (result.usage) wire.usage = result.usage
  if (result.error) {
    wire.error = result.error.code
    if (result.error.message) wire.errorMessage = result.error.message
  }
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
export async function handleAgentRun(
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
  let sessionId: number | null = spec.sessionId ?? null
  try {
    if (sessionId != null) {
      // custom_agent_call eagerly created the child session and stored it in the job spec.
    } else {
      const firedAt = Date.parse(spec.trigger.firedAt)
      // P4 (D7) — a follow-up run's session is ANCHORED to its Matter (CHAT_DB v27 already admits
      // matter+agent) and stamped trigger_kind='matter_followup' rather than the spec's 'manual',
      // so the Matter's run history is queryable off the session row and the P3 panel's
      // getOrCreate (origin='interactive' only) can never pick it up.
      // L4 批次3 — an ITEM-dispatch run anchors on its Matter too, and additionally stamps
      // `item_id` (CHAT_DB v28) so the 行动项 can list its own execution history
      // (listSessionsForItem). Its trigger_kind is stamped 'matter_item_run' to keep the two
      // unattended matter venues distinguishable in the history UI.
      const itemRun = spec.runKind === 'matter_item_run' ? spec.matterItem : undefined
      const matterAnchor =
        itemRun != null
          ? itemRun.matterId
          : spec.runKind === 'matter_followup' && spec.matter
            ? spec.matter.id
            : null
      sessionId = cfg.createAgentSession({
        agentId: spec.agentId,
        jobId,
        title: spec.sessionTitle,
        triggerId: spec.trigger.id ?? null,
        triggerKind:
          matterAnchor == null
            ? spec.trigger.kind
            : itemRun != null
              ? 'matter_item_run'
              : 'matter_followup',
        triggerFiredAt: Number.isFinite(firedAt) ? firedAt : null,
        ...(matterAnchor == null ? {} : { anchor: { type: 'matter' as const, id: matterAnchor } }),
        ...(itemRun != null ? { itemId: itemRun.itemId } : {})
      })
    }
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
  const maxRunSeconds = resolveAgentRunSeconds(spec.budget?.maxRunSeconds)
  const clientAbort = new AbortController()
  let clientClosed = false
  req.on('close', () => {
    clientClosed = true
    clientAbort.abort()
  })
  const stopController = new AbortController()
  const lease =
    sessionId != null ? (cfg.activeRuns?.register(sessionId, stopController) ?? null) : null
  const timeoutSignal = AbortSignal.timeout(maxRunSeconds * 1000)
  const merged = AbortSignal.any([clientAbort.signal, timeoutSignal, stopController.signal])

  // runHeadlessAgent normalizes every drain failure, but prepareChatRun sits before its try block —
  // an unexpected throw there must still answer the worker (same belt handleApprovalDecide wears);
  // otherwise the poke would hang until the worker's own http timeout and the rejection goes unhandled.
  try {
    const result = await runHeadlessAgent(cfg, { jobId, spec, sessionId }, merged)
    if (!clientClosed) writeJson(res, 200, toAgentRunWire(result))
  } catch (err) {
    console.error('[ai-gateway] /api/ai/agent-run crashed', err)
    if (!clientClosed) writeJson(res, 500, { error: 'E_AGENT_RUN_CRASH' })
  } finally {
    if (lease && sessionId != null) cfg.activeRuns?.release(sessionId, lease.runId)
  }
}

/**
 * `GET /api/ai/generated/:fileId` — task 09-02: the read-only file route for images the
 * generate_image tool wrote under cfg.generatedImagesDir. The tool result carries only
 * `{file_id, url}` (never bytes), and the renderer's ImageGenCard loads `<img src>` from here.
 *
 * Security posture: the id is validated by the SAME strict `<sessionId>-<uuid>.<ext>` regex the
 * tool uses to mint it (resolveGeneratedFilePath) — no separators / dots can reach the path — and
 * the resolved path must stay under the store root (second belt). Anything else, and any missing
 * file, is a plain 404 (no distinction between "bad id" and "gone": a probe learns nothing).
 * Registered unconditionally; a cfg without generatedImagesDir answers 404 like an unknown path.
 */
export async function handleGeneratedImage(
  res: ServerResponse,
  cfg: AiGatewayConfig,
  path: string
): Promise<void> {
  const notFound = (): void => writeJson(res, 404, { error: 'E_IMAGE_NOT_FOUND' })
  if (!cfg.generatedImagesDir) {
    notFound()
    return
  }
  let fileId: string
  try {
    fileId = decodeURIComponent(path.slice(GENERATED_IMAGE_ROUTE_PREFIX.length))
  } catch {
    notFound()
    return
  }
  const resolved = resolveGeneratedFilePath(cfg.generatedImagesDir, fileId)
  if (!resolved) {
    notFound()
    return
  }
  let size: number
  try {
    const st = await stat(resolved.path)
    if (!st.isFile()) {
      notFound()
      return
    }
    size = st.size
  } catch {
    notFound()
    return
  }
  res.writeHead(200, {
    'Content-Type': resolved.mime,
    'Content-Length': size,
    // The id is a uuid — the bytes behind it never change, so the renderer may cache forever.
    'Cache-Control': 'private, max-age=31536000, immutable'
  })
  const stream = createReadStream(resolved.path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
