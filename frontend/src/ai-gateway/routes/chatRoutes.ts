// Interactive chat, IM chat, and detached active-run SSE stream handlers.
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { UI_MESSAGE_STREAM_HEADERS } from 'ai'
import { formatStreamError, reportStreamError } from '../streamError'
import { type AiGatewayConfig, type SessionAgentIdentity } from '../config'
import { GroupOrchestrator } from '../groupOrchestrator'
import {
  chatMessageToUIMessage,
  type MailAgentUIMessageMetadata
} from '@shared/assistant/uiMessage'
import { lastUserMessage, makeIdGenerator, makePersistOnFinish, prepareChatRun } from '../chatRun'
import { isPrivacyMaskError } from '../providerRef'
import { corsHeadersFor, isBodyTooLarge, readJsonBody, writeJson } from '../httpUtil'
import { shouldRecoverContextOverflow } from '../compact'

function observeStreamChunkStage(
  cfg: AiGatewayConfig,
  sessionId: number,
  runId: string,
  chunk: unknown
): void {
  if (!cfg.activeRuns || chunk === null || typeof chunk !== 'object') return
  const rec = chunk as { type?: unknown; toolName?: unknown }
  if (rec.type === 'reasoning-start' || rec.type === 'reasoning-delta') {
    cfg.activeRuns.updateStage(sessionId, runId, { stage: 'thinking' })
    return
  }
  if (rec.type === 'tool-input-start' || rec.type === 'tool-input-available') {
    cfg.activeRuns.updateStage(sessionId, runId, {
      stage: 'calling-tool',
      toolName: typeof rec.toolName === 'string' ? rec.toolName : undefined
    })
    return
  }
  if (rec.type === 'tool-output-available' || rec.type === 'tool-output-error') {
    cfg.activeRuns.updateStage(sessionId, runId, { stage: 'thinking' })
    return
  }
  if (rec.type === 'text-start' || rec.type === 'text-delta') {
    cfg.activeRuns.updateStage(sessionId, runId, { stage: 'writing' })
  }
}

/**
 * `POST /api/ai/chat` — the canonical Phase 02 endpoint. prepareChatRun converts the incoming
 * UIMessages to model messages and runs `streamText` (with tools + approval when configured); we
 * pipe the AI SDK UIMessage stream straight to the Node response so the assistant-ui
 * `useChatRuntime` runtime consumes it natively. abortSignal cancels the upstream LLM call when the
 * client disconnects. On finish (non-aborted) makePersistOnFinish hands the turn to cfg.persistTurn
 * for the ai_chat.db dual-write. No key → 503 E_NO_LLM_KEY; empty messages → 400 E_INVALID_ARG.
 *
 * Stage 2 PR-1 — `entry` is the TRUSTED per-entrypoint shape: /api/ai/chat uses the default
 * (manual_chat, no session creation — byte-identical); /api/ai/im-chat (handleImChat) passes
 * { trustedMode: 'im_chat', createSession: cfg.createImSession }. The mode is NEVER read from the
 * body (S2 W0 discipline); the only structural additions for im are (a) first-turn session
 * pre-creation and (b) the x-mailagent-session-id response header.
 */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  entry: {
    trustedMode: 'manual_chat' | 'im_chat'
    createSession?: () => number | null
  } = { trustedMode: 'manual_chat' }
): Promise<void> {
  const controller = new AbortController()
  // B1 (harness-chat lane A, MAILAGENT_CHAT_DETACHED_RUNS) — detach-tolerant runs: with the flag on
  // (and the registry wired) a client disconnect NO LONGER aborts the upstream LLM call; the run
  // drains server-side to onFinish → persistTurn, so a session switch / popout close never loses the
  // turn. The explicit stop channel is POST /api/ai/run/stop. Flag off (env explicit false) → the
  // legacy close→abort DRAIN BEHAVIOUR below; the flag only governs the drain shape, not the
  // ActiveRunRegistry — codex r2 [A]: the registry is always created (approval-resume mutex), so
  // the off branch still takes the per-session slot (released on response close/abort) and keeps
  // the /decide↔chat 409 fence + /run/active truth (see CLAUDE.md 开关表 MAILAGENT_CHAT_DETACHED_RUNS).
  const detached = cfg.detachedRunsEnabled === true && cfg.activeRuns != null
  // P1-3 (codex r1) — arm client-disconnect tracking BEFORE the first await. A window closed while
  // the handler is still inside readJsonBody / prepareChatRun emits 'close' during those awaits; a
  // listener installed only at drain time would miss it, leave clientGone false, and the drain would
  // then wait forever on a 'drain'/'close' that already fired (res.write on a destroyed response
  // returns false) — stream unconsumed, onFinish/persistTurn never run, the registry slot wedged
  // until the stale sweep. Initial state honours a response already gone at dispatch time.
  let clientGone = false
  if (detached) {
    clientGone = res.destroyed || res.writableEnded
    res.on('close', () => {
      if (!res.writableFinished) clientGone = true
    })
    // A write racing a disconnect surfaces as a response 'error' — swallow it (the drain keeps going).
    res.on('error', () => {
      clientGone = true
    })
  }
  // task 08-20-notification-center M3 C3 — 「turn 落库时客户端已断开」信号，穿给 makePersistOnFinish
  // → PersistTurnInput.detached → chat run 完成通知的判据。🔴 getter（求值推迟到 onFinish），
  // 且与 `detached` 相与：flag off 时 clientGone 只是写路径上的一个 tail race（断开已 abort 掉这
  // 一回合），不是「后台完成」，恒不发通知。
  const isClientGone = (): boolean => detached && clientGone
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
  // Stage 2 PR-1 — first turn of an IM conversation (no sessionId in the body): pre-create the
  // origin='im' session BEFORE the concurrency pre-check / prepare so the whole pipeline (409
  // fence, eager persist, persistTurn, broadcast) sees the real session id. A create failure
  // degrades to an unsaved run (mirrors createAgentSession's degradation — the reply still
  // streams, only history + the session header are lost). /api/ai/chat never wires createSession.
  if (
    entry.createSession &&
    !(typeof body.sessionId === 'number' && Number.isInteger(body.sessionId))
  ) {
    try {
      const created = entry.createSession()
      if (created != null) body.sessionId = created
    } catch (err) {
      console.error('[ai-gateway] createImSession failed (run continues unsaved)', err)
    }
  }
  if (!detached) {
    // abort: client disconnect (or the renderer AbortController) cancels the upstream call — the
    // legacy close→abort drain behaviour (flag off governs ONLY this drain shape; the registry
    // slot below is taken either way and released on response close/abort, keeping the approval
    // mutex + 409 fence in the rollback configuration — codex r2 [A]).
    req.on('close', () => controller.abort())
  }

  // B1 — same-session concurrency fast-reject BEFORE prepareChatRun (streamText fires the upstream
  // call at prepare time, so a doomed second POST must be answered before we spend a model call).
  // register() below is the atomic gate; this is only the cheap pre-check. codex r2 [A] — keyed on
  // the registry's PRESENCE, not the detached flag: the lease is the always-on approval-resume
  // mutex, so a detached-off (rollback) gateway keeps the same 409 fence.
  const bodySessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (cfg.activeRuns && bodySessionId != null && cfg.activeRuns.hasActive(bodySessionId)) {
    writeJson(res, 409, {
      error: 'E_RUN_ACTIVE',
      hint: 'a chat run is already streaming for this session'
    })
    return
  }

  // S2 W0 (ADR-001 D1) — both entrypoints are owner-driven surfaces (local renderer / serve-api
  // owner-authenticated proxy, or the PR-3 IM bridge on loopback): the mode is asserted by each
  // entrypoint in trusted code (`entry.trustedMode` — /api/ai/chat pins 'manual_chat',
  // /api/ai/im-chat pins 'im_chat'). The body is never consulted for the mode.
  //
  // P4b — the session's TEAM identity (origin='team' rows) is likewise a SERVER fact: resolved
  // from the sessionId, never from the body. Non-team sessions (incl. the IM pre-created one)
  // resolve null → byte-identical. A resolver throw degrades to null EXCEPT for the recursion
  // guard — cfg.resolveSessionAgent's contract keeps the identity present on a config-fetch
  // failure (see config.ts), so a plain throw here can only mean "row unreadable", where no
  // identity exists to guard.
  let sessionAgent: SessionAgentIdentity | null = null
  if (bodySessionId != null && cfg.resolveSessionAgent) {
    try {
      sessionAgent = (await cfg.resolveSessionAgent(bodySessionId)) ?? null
    } catch (err) {
      console.warn('[ai-gateway] resolveSessionAgent failed (run continues as main agent)', err)
    }
  }
  const prepared = await prepareChatRun(
    body,
    cfg,
    controller.signal,
    entry.trustedMode,
    sessionAgent
  )
  if (!prepared.ok) {
    writeJson(res, prepared.status, prepared.body)
    return
  }
  let run = prepared.run

  // B1 — atomic same-session gate. A concurrent second POST that raced past the pre-check loses
  // here: its just-started upstream call is aborted and it answers 409 (封 §3.2 的行序交错 —
  // switching back mid-run and sending again must not interleave two turns' persistence).
  // codex r2 [A] — registered whenever the registry is wired (detached OR off): the slot is the
  // approval-resume mutex, which must hold in the rollback configuration too. From here on EVERY
  // early throw/return must release the slot (off branch: response 'close' + sync-throw catch;
  // detached branch: the try/finally below).
  let runToken: { runId: string } | null = null
  if (cfg.activeRuns && run.sessionId != null) {
    runToken = cfg.activeRuns.register(run.sessionId, controller, { streamable: detached })
    if (runToken == null) {
      controller.abort()
      writeJson(res, 409, {
        error: 'E_RUN_ACTIVE',
        hint: 'a chat run is already streaming for this session'
      })
      return
    }
    // codex r2 [C] — stamp the lease onto the run so makePersistOnFinish forwards it to the
    // 'chat:turn-persisted' broadcast (per-run settle dedup in the renderer).
    run.runId = runToken.runId
  }
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
  // Shared between the legacy pipe and the B1 detached drain so both paths carry identical
  // messageMetadata / reasoning / error semantics.
  const streamOptions = {
    originalMessages: run.rawMessages,
    generateMessageId: makeIdGenerator(),
    messageMetadata: ({
      part
    }: {
      part: { type: string }
    }): MailAgentUIMessageMetadata | undefined => {
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
      console.error('[ai-gateway] /api/ai/chat stream error', error)
      // HTTP 状态 + provider 返回体进气泡错误行，同一行落 ai-gateway.log（streamError.ts）。
      const text = formatStreamError(error)
      cfg.logEvent?.({
        event: 'chat_stream_error',
        mode: run.contextMode ?? null,
        sessionId: run.sessionId,
        model: run.modelId,
        error: text
      })
      return text
    },
    onFinish: makePersistOnFinish(cfg, run, { isClientGone })
  }

  // codex r2 [C] — the response advertises the run's lease id so the renderer transport can record
  // its OWN runs (own-run attribution for the settle door). Exposed for CORS readers (the local
  // renderer origin + dev server are cross-origin to the loopback gateway).
  // Stage 2 PR-1 — an im run ALSO advertises the session id (same header mechanism): the first
  // turn's pre-created origin='im' session must reach the IM bridge (PR-3) so later turns carry
  // sessionId and the conversation stays one thread. Manual runs never add it → the header set
  // stays byte-identical to the pre-PR-1 shape.
  const exposeHeaders: string[] = []
  const runIdHeaders: Record<string, string> = {}
  if (runToken) {
    runIdHeaders['x-mailagent-run-id'] = runToken.runId
    exposeHeaders.push('x-mailagent-run-id')
  }
  if (entry.trustedMode === 'im_chat' && run.sessionId != null) {
    runIdHeaders['x-mailagent-session-id'] = String(run.sessionId)
    exposeHeaders.push('x-mailagent-session-id')
  }
  if (exposeHeaders.length > 0) {
    runIdHeaders['access-control-expose-headers'] = exposeHeaders.join(', ')
  }

  if (
    entry.trustedMode === 'manual_chat' &&
    cfg.compactCoordinator != null &&
    cfg.compactPersistence != null
  ) {
    let responseStarted = false
    let streamPublished = false
    const writeHeaders = (): void => {
      if (responseStarted || clientGone || res.destroyed) return
      res.writeHead(200, {
        ...UI_MESSAGE_STREAM_HEADERS,
        ...corsHeadersFor(req.headers.origin),
        ...runIdHeaders
      })
      responseStarted = true
    }
    const writeChunk = async (chunk: unknown): Promise<void> => {
      streamPublished = true
      if (runToken != null && run.sessionId != null) {
        cfg.activeRuns?.appendChunk(run.sessionId, runToken.runId, chunk)
      }
      if (clientGone || res.destroyed || res.writableEnded) {
        clientGone = true
        return
      }
      writeHeaders()
      if (!responseStarted) return
      const ok = res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (!ok && !clientGone && !res.destroyed) {
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            res.off('drain', settle)
            res.off('close', settle)
            resolve()
          }
          res.once('drain', settle)
          res.once('close', settle)
        })
      }
    }
    const flushChunks = async (chunks: readonly unknown[]): Promise<void> => {
      for (const chunk of chunks) await writeChunk(chunk)
    }
    const isPrelude = (chunk: unknown): boolean => {
      const type =
        chunk !== null && typeof chunk === 'object' ? (chunk as { type?: unknown }).type : undefined
      return type === 'start' || type === 'start-step' || type === 'message-metadata'
    }
    type FinishEvent = Parameters<ReturnType<typeof makePersistOnFinish>>[0]
    const drainAttempt = async (
      attempt: number
    ): Promise<{
      recover: boolean
      deferred: unknown[]
      error: unknown
      endedWithJson?: boolean
    }> => {
      const deferred: unknown[] = []
      let rawError: unknown = null
      let finishEvent: FinishEvent | null = null
      // M3 C3 — 同一份 isClientGone：manual_chat + 自动压缩（两开关均默认 on）走的是**这条**
      // overflow-aware drain，streamOptions.onFinish 在此被 finishEvent 收集器覆盖，漏传这里
      // 等于主路径上 detached 恒 false。
      const persistFinish = makePersistOnFinish(cfg, run, { isClientGone })
      try {
        const stream = run.result.toUIMessageStream({
          ...streamOptions,
          originalMessages: run.rawMessages,
          onError: (error: unknown) => {
            rawError = error
            console.error('[ai-gateway] /api/ai/chat stream error', error)
            return reportStreamError(
              cfg.logEvent,
              'chat_stream_error',
              { mode: run.contextMode ?? null, sessionId: run.sessionId, model: run.modelId },
              error
            )
          },
          onFinish: (event) => {
            finishEvent = event
          }
        })
        for await (const chunk of stream) {
          if (runToken != null && run.sessionId != null) {
            observeStreamChunkStage(cfg, run.sessionId, runToken.runId, chunk)
          }
          const type =
            chunk !== null && typeof chunk === 'object'
              ? (chunk as { type?: unknown }).type
              : undefined
          if (!streamPublished && type === 'error') {
            if (isPrivacyMaskError(rawError)) {
              responseStarted = true
              writeJson(res, 503, { error: 'E_PRIVACY_MASK_FAILED', hint: rawError.message })
              return { recover: false, deferred: [], error: rawError, endedWithJson: true }
            }
            deferred.push(chunk)
            if (
              shouldRecoverContextOverflow({
                attempt,
                hasWrittenBytes: false,
                error: rawError,
                protocol: run.protocol
              })
            ) {
              return { recover: true, deferred, error: rawError }
            }
            await flushChunks(deferred)
            deferred.length = 0
            continue
          }
          if (!streamPublished && isPrelude(chunk)) {
            deferred.push(chunk)
            continue
          }
          if (deferred.length > 0) {
            await flushChunks(deferred)
            deferred.length = 0
          }
          await writeChunk(chunk)
        }
        if (deferred.length > 0) await flushChunks(deferred)
        if (finishEvent != null) await persistFinish(finishEvent)
        return { recover: false, deferred: [], error: rawError }
      } catch (error) {
        if (
          shouldRecoverContextOverflow({
            attempt,
            hasWrittenBytes: streamPublished,
            error,
            protocol: run.protocol
          })
        ) {
          return { recover: true, deferred, error }
        }
        throw error
      }
    }

    if (!detached) {
      res.on('close', () => {
        if (runToken != null && run.sessionId != null) {
          cfg.activeRuns?.release(run.sessionId, runToken.runId)
        }
      })
    }
    let wroteJsonError = false
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await drainAttempt(attempt)
        if (outcome.endedWithJson) {
          wroteJsonError = true
          break
        }
        if (!outcome.recover) break
        if (attempt > 0 || run.sessionId == null) {
          await flushChunks(
            outcome.deferred.length > 0
              ? outcome.deferred
              : [
                  {
                    type: 'error',
                    errorText: formatStreamError(outcome.error)
                  }
                ]
          )
          break
        }
        try {
          const compactResult = await cfg.compactCoordinator.run(run.sessionId, {
            reason: 'overflow',
            contextWindow: run.contextWindow ?? null
          })
          if (compactResult.status !== 'completed') {
            await flushChunks(outcome.deferred)
            break
          }
          cfg.onCompactCompleted?.(run.sessionId)
          const retryMessages = cfg.compactPersistence
            .listSessionMessages(run.sessionId)
            .map(chatMessageToUIMessage)
          const retryPrepared = await prepareChatRun(
            { ...body, messages: retryMessages },
            cfg,
            controller.signal,
            entry.trustedMode,
            // P4b — the compact-retry replays the SAME session; keep its team identity.
            sessionAgent
          )
          if (!retryPrepared.ok) {
            await flushChunks(outcome.deferred)
            break
          }
          const previousRunId = run.runId
          run = retryPrepared.run
          run.runId = previousRunId
        } catch (error) {
          console.warn('[ai-gateway] context overflow recovery failed', error)
          await flushChunks(
            outcome.deferred.length > 0
              ? outcome.deferred
              : [
                  {
                    type: 'error',
                    errorText: formatStreamError(outcome.error)
                  }
                ]
          )
          break
        }
      }
      if (!wroteJsonError && responseStarted && !clientGone && !res.destroyed) {
        res.write('data: [DONE]\n\n')
      }
    } catch (error) {
      if (!responseStarted && isPrivacyMaskError(error) && !res.destroyed && !res.writableEnded) {
        writeJson(res, 503, { error: 'E_PRIVACY_MASK_FAILED', hint: error.message })
      } else {
        console.error('[ai-gateway] /api/ai/chat overflow-aware drain failed', error)
      }
    } finally {
      if (runToken != null && run.sessionId != null) {
        cfg.activeRuns?.release(run.sessionId, runToken.runId)
      }
      try {
        res.end()
      } catch {
        /* already destroyed */
      }
    }
    return
  }

  if (!detached) {
    // codex r2 [A] — off-branch slot lifecycle: attached mode couples the run to the response
    // (completion ends res; a client disconnect fires close→abort above), so the response 'close'
    // is the single release point — abort 即释放, the session is immediately free for a fresh turn.
    // A client that disconnected DURING the prepare awaits already emitted 'close' before we could
    // listen → release inline (the req-close abort already cancelled the upstream call).
    if (runToken != null && run.sessionId != null) {
      const releaseSessionId = run.sessionId
      const releaseRunId = runToken.runId
      const release = (): boolean => cfg.activeRuns!.release(releaseSessionId, releaseRunId)
      if (res.destroyed || res.writableEnded) release()
      else res.on('close', release)
    }
    try {
      run.result.pipeUIMessageStreamToResponse(res, {
        ...streamOptions,
        // Phase 06a — loopback-only CORS on the main chat stream too (the AI SDK pipe sets no ACAO by
        // default; reflect the renderer's loopback / null origin, omit for a remote cross-origin page).
        headers: { ...corsHeadersFor(req.headers.origin), ...runIdHeaders }
      })
    } catch (err) {
      // codex r2 [B]-adjacent — a sync pipe throw must not strand the slot until the client socket
      // times out: release now, abort the upstream call, and tear the response down.
      console.error('[ai-gateway] /api/ai/chat pipe failed', err)
      if (runToken != null && run.sessionId != null) {
        cfg.activeRuns!.release(run.sessionId, runToken.runId)
      }
      controller.abort()
      try {
        res.destroy()
      } catch {
        /* already gone */
      }
    }
    return
  }

  // B1 — detached drain. ai@7's pipeUIMessageStreamToResponse stops consuming (and can wedge on a
  // never-firing 'drain') once the client is gone, which would leave streamText unconsumed and
  // onFinish never firing — exactly the data loss this mode exists to prevent. So the gateway owns
  // the drain (mirrors approvalResume's server-side drain): it consumes the UIMessage stream to
  // completion (driving the tool loop + onFinish → persistTurn) and writes SSE frames only while the
  // client is still connected. Wire format is byte-identical to the pipe (UI_MESSAGE_STREAM_HEADERS +
  // `data: {json}\n\n` frames + terminal `data: [DONE]`; JsonToSseTransformStream's encoding).
  // P1-3 (codex r1) — writeHead + the whole drain live inside one try/finally so the registry slot
  // is ALWAYS released (a wedged slot would 409 the session for 15 min). The 'close'/'error'
  // listeners were armed at the top of the handler (before any await) so a pre-header disconnect is
  // already reflected in clientGone here. codex r2 [B] — toUIMessageStream() itself lives INSIDE
  // the protected region too: a synchronous throw from it (post-register, pre-drain) previously
  // skipped the finally and stranded the slot for 15 min.
  try {
    const stream = run.result.toUIMessageStream(streamOptions)
    // A client gone before headers → skip writeHead entirely (writing a header to a destroyed
    // socket is pointless and may throw); a racing destroy that still slips through must NOT kill
    // the drain — the whole point is that the stream keeps draining to onFinish → persistTurn
    // without a client.
    try {
      if (!clientGone && !res.destroyed) {
        res.writeHead(200, {
          ...UI_MESSAGE_STREAM_HEADERS,
          ...corsHeadersFor(req.headers.origin),
          ...runIdHeaders
        })
      } else {
        clientGone = true
      }
    } catch {
      clientGone = true
    }
    for await (const chunk of stream) {
      if (runToken && run.sessionId != null) {
        observeStreamChunkStage(cfg, run.sessionId, runToken.runId, chunk)
        cfg.activeRuns?.appendChunk(run.sessionId, runToken.runId, chunk)
      }
      if (clientGone || res.destroyed || res.writableEnded) {
        clientGone = true
        continue
      }
      let ok = true
      try {
        ok = res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      } catch {
        // write on a just-destroyed response — treat as disconnect, keep draining.
        clientGone = true
        continue
      }
      if (!ok && !clientGone && !res.destroyed) {
        // Backpressure parity with writeToServerResponse — but a disconnect mid-wait must not hang
        // the drain ('drain' never fires on a destroyed response), so 'close' also resolves. The
        // destroyed re-check above (and the loop guard on the next iteration) brackets the wait.
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            res.off('drain', settle)
            res.off('close', settle)
            resolve()
          }
          res.once('drain', settle)
          res.once('close', settle)
        })
      }
    }
    if (!clientGone && !res.destroyed) res.write('data: [DONE]\n\n')
  } catch (err) {
    console.error('[ai-gateway] /api/ai/chat detached drain failed', err)
  } finally {
    if (runToken && run.sessionId != null) {
      cfg.activeRuns!.release(run.sessionId, runToken.runId)
    }
    try {
      res.end()
    } catch {
      /* already destroyed */
    }
  }
}

/**
 * `POST /api/ai/im-chat` — stage 2 PR-1 (task 08-01 messenger, MAILAGENT_IM_FEISHU): the owner-
 * via-IM chat surface (the PR-3 飞书 bridge is its only production caller, on loopback like every
 * other gateway client). The ONE semantic difference from /api/ai/chat is the trusted context
 * mode: 'im_chat' is asserted HERE, in trusted code (S2 W0 — never from the body), which drives
 * the whole tool-face: reads/domain writes/connectors register (writes 恒 HITL — mayAutoApprove
 * is manual-only), web only under MAILAGENT_IM_WEB_ENABLED, exec/capability_change/outbound are
 * structurally absent. Everything else reuses handleChat's structure verbatim: 413 cap, detached
 * drain, per-session 409 (E_RUN_ACTIVE), chat:turn-persisted broadcast, approval stash. Body shape
 * = /api/ai/chat ({messages[], model?, sessionId?, system?, thinking?, contextSnapshot?});
 * sessionId absent/null = first turn → cfg.createImSession pre-creates the origin='im' session
 * and the response carries it back in the `x-mailagent-session-id` header (the same header
 * mechanism /api/ai/chat uses for x-mailagent-run-id). Registered ONLY when cfg.imFeishuEnabled —
 * flag off → 404, gateway byte-identical.
 */
export async function handleImChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  return handleChat(req, res, cfg, {
    trustedMode: 'im_chat',
    createSession: cfg.createImSession
  })
}

/**
 * `GET /api/ai/run/active?sessionId=N` — B1 truth probe: is a detached chat run still streaming for
 * this session? A panel remounting a session uses it to render the "AI 仍在后台输出…" placeholder and
 * to reload when the run settles (active→gone transition). Read-only. miss (nothing running /
 * registry unwired) → 404 { active:false } — the fail-closed truth, mirroring /approval/pending.
 */
export function handleRunActive(
  res: ServerResponse,
  cfg: AiGatewayConfig,
  url: string,
  groupScheduler: GroupOrchestrator | null
): void {
  const raw = new URL(url, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  const entry = cfg.activeRuns ? cfg.activeRuns.getActive(sessionId) : null
  if (!entry) {
    // 群：registry 无租约但 调度器 还有人在写 / 准备中 / 排队 → 群里仍在跑（停止钮在两 turn 间隙
    // 与单候选的准备窗口都不消失）。三者都空 → 404 不变。
    const live = groupScheduler ? groupScheduler.liveState(sessionId) : null
    if (live && (live.inFlight != null || live.preparing != null || live.queued.length > 0)) {
      writeJson(res, 200, { active: true, runId: null, group: live })
      return
    }
    writeJson(res, 404, { active: false })
    return
  }
  writeJson(res, 200, {
    active: true,
    runId: entry.runId,
    ageMs: Date.now() - entry.startedAt,
    ...(entry.liveStage ? { liveStage: entry.liveStage } : {})
  })
}

/**
 * `GET /api/ai/run/stream?sessionId=N` — replay buffered SSE frames for a live in-flight run
 * and continue streaming new chunks in real time until the run finishes or subscriber disconnects.
 */
export function handleRunStream(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  url: string
): void {
  const raw = new URL(url, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  const entry = cfg.activeRuns ? cfg.activeRuns.isStreamable(sessionId) : null
  if (!entry) {
    res.writeHead(204, corsHeadersFor(req.headers.origin))
    res.end()
    return
  }
  res.writeHead(200, {
    ...UI_MESSAGE_STREAM_HEADERS,
    ...corsHeadersFor(req.headers.origin),
    'x-mailagent-run-id': entry.runId,
    'access-control-expose-headers': 'x-mailagent-run-id'
  })
  const sub = cfg.activeRuns!.subscribe(sessionId, {
    write: (frame: string) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(frame)
      }
    },
    end: () => {
      try {
        if (!res.destroyed && !res.writableEnded) res.end()
      } catch {
        /* already closed */
      }
    }
  })
  if (!sub) {
    try {
      if (!res.destroyed && !res.writableEnded) res.end()
    } catch {
      /* already closed */
    }
    return
  }
  if (!res.destroyed && !res.writableEnded) {
    res.flushHeaders()
  }
  const cleanup = (): void => {
    sub.unsubscribe()
  }
  res.on('close', cleanup)
  req.on('aborted', cleanup)
  req.on('error', cleanup)
}

/**
 * `POST /api/ai/run/stop { sessionId }` — B1 explicit stop channel. With detached runs a client
 * fetch-abort no longer cancels the upstream call, so the composer stop button's transport wrapper
 * POSTs here: the registry aborts the run's controller (streamText aborts → onFinish isAborted →
 * nothing persisted) and frees the session for a fresh turn. Registered unconditionally;
 * cfg.activeRuns gates it (404 only when the registry is unwired — hand-built harness cfgs; codex
 * r2 [A] made the production registry unconditional, and in detached-off the stop is equivalent to
 * the close→abort the legacy wiring already performs).
 */
export async function handleRunStop(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  groupScheduler: GroupOrchestrator | null
): Promise<void> {
  if (!cfg.activeRuns) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'detached chat runs not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  const out = cfg.activeRuns.stop(sessionId)
  // g1 (父设计拍板 E) — a group session's stop also clears the whole family's queues and writes
  // one `group_stop` system row per family session. Idempotent with the registry abort above:
  // the aborted turn's own stop call finds the family already stopped and writes nothing.
  const groupStop = groupScheduler ? groupScheduler.stopFamily(sessionId) : { stopped: false }
  if (cfg.queuedInputStore) {
    cfg.queuedInputStore.restoreForSession(sessionId)
    cfg.onQueuedInputChanged?.(sessionId)
  }
  writeJson(res, 200, { stopped: out.stopped || groupStop.stopped })
}
