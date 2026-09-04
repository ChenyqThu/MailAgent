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

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

// B1 (detached runs) — the exact header set ai@7's pipeUIMessageStreamToResponse sends, so the manual
// server-side drain below stays wire-identical for the client (content-type text/event-stream +
// x-vercel-ai-ui-message-stream: v1 + no-buffering hints).
import { APICallError, UI_MESSAGE_STREAM_HEADERS } from 'ai'

import type { AiGatewayConfig, GroupSessionFacts, SessionAgentIdentity } from './config'
// task 09-02 — the generate_image store's id → path mapper (shared with the tool, single source).
import { GENERATED_IMAGE_ROUTE_PREFIX, resolveGeneratedFilePath } from './tools/image'
// T2 群附件 — body.attachments 的校验 + metadata 编码（单源，renderer 与投影侧共用同一份）。
import { encodeAttachmentsMetadata, validateAttachmentsInput } from './groupAttachments'
import { encodeLibraryRefsMetadata, readLibraryRefsInput } from './groupLibraryRefs'
// v30（群聊）— server-side history assembly for a group speaker run (pure helper).
import { assembleGroupHistory, type GroupTranscriptRow } from './groupChat'
import { isSilence } from './groupFloors'
// g1 — the server-side group run 调度器 (pure Node; deps injected from the cfg group hooks below).
import { GroupOrchestrator, type GroupSpeakInput, type GroupSpeakResult } from './groupOrchestrator'
import {
  chatMessageToUIMessage,
  type MailAgentUIMessageMetadata
} from '@shared/assistant/uiMessage'
import {
  extractApprovalStashInput,
  generateSessionTitle,
  lastUserMessage,
  llmCredentialsMissing,
  makeIdGenerator,
  makePersistOnFinish,
  prepareChatRun,
  resolveApprovalPreview
} from './chatRun'
// HIGH-1 (batch1 review) — SDK-free typed credentials error (the registry resolver throws it when
// the selected provider row lacks a required key); mapped back to 503 E_NO_LLM_KEY below.
import { isProviderCredentialsError } from './providerRef'
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
import { APPROVAL_REASON_MAX_CHARS, resumeApprovalRun } from './approvalResume'
// 发版终审 M3 — registry 语境下 title 的 E_UPSTREAM hint + 日志走固定形状脱敏
// （上游错误正文可能回显凭证）；flag off 保持原 message 形状（字节级纪律）。
import { sanitizedUpstreamErrorMessage } from './upstreamError'
import { runHeadlessSearchAgent } from './searchAgentRun'
import { resolveAgentRunSeconds, runHeadlessAgent } from './agentRun'
import type { HeadlessAgentResult } from '../shared/api/types'
import { CompactCoordinator, shouldRecoverContextOverflow } from './compact'

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
 *
 * Stage 2 PR-1 — `entry` is the TRUSTED per-entrypoint shape: /api/ai/chat uses the default
 * (manual_chat, no session creation — byte-identical); /api/ai/im-chat (handleImChat) passes
 * { trustedMode: 'im_chat', createSession: cfg.createImSession }. The mode is NEVER read from the
 * body (S2 W0 discipline); the only structural additions for im are (a) first-turn session
 * pre-creation and (b) the x-mailagent-session-id response header.
 */
async function handleChat(
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
    runToken = cfg.activeRuns.register(run.sessionId, controller)
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
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[ai-gateway] /api/ai/chat stream error', error)
      // task 09-02 — provider 拒绝的**判据**在 APICallError.responseBody 里，message 往往只有
      // 一句「Bad Request」。不带上它，UI 那句「响应出错」就没有任何可查线索（DeepSeek 拒收一
      // 份工具 JSON Schema 时，说清是哪个 schema 哪一条的整句都只在 responseBody 中）。压平换行
      // 并截到 400 字符 —— 它进的是聊天气泡里的错误行，不是日志。
      const responseBody = APICallError.isInstance(error) ? error.responseBody : undefined
      const detail = responseBody?.replace(/\s+/g, ' ').trim().slice(0, 400)
      return detail ? `${msg} — ${detail}` : msg
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
    ): Promise<{ recover: boolean; deferred: unknown[]; error: unknown }> => {
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
            const message = error instanceof Error ? error.message : String(error)
            console.error('[ai-gateway] /api/ai/chat stream error', error)
            return message
          },
          onFinish: (event) => {
            finishEvent = event
          }
        })
        for await (const chunk of stream) {
          const type =
            chunk !== null && typeof chunk === 'object'
              ? (chunk as { type?: unknown }).type
              : undefined
          if (!responseStarted && type === 'error') {
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
          if (!responseStarted && isPrelude(chunk)) {
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
            hasWrittenBytes: responseStarted,
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
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await drainAttempt(attempt)
        if (!outcome.recover) break
        if (attempt > 0 || run.sessionId == null) {
          await flushChunks(
            outcome.deferred.length > 0
              ? outcome.deferred
              : [
                  {
                    type: 'error',
                    errorText:
                      outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
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
                    errorText:
                      outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
                  }
                ]
          )
          break
        }
      }
      if (responseStarted && !clientGone && !res.destroyed) res.write('data: [DONE]\n\n')
    } catch (error) {
      console.error('[ai-gateway] /api/ai/chat overflow-aware drain failed', error)
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
      const release = (): void => cfg.activeRuns!.release(releaseSessionId, releaseRunId)
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
async function handleImChat(
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
function handleRunActive(
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
    ageMs: Date.now() - entry.startedAt
  })
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
async function handleRunStop(
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

function queuedInputNotImplemented(res: ServerResponse): void {
  writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'queued input not enabled' })
}

function parsePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

async function handleQueuedInputList(
  res: ServerResponse,
  cfg: AiGatewayConfig,
  rawUrl: string
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const raw = new URL(rawUrl, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw == null ? null : Number.parseInt(raw, 10)
  if (sessionId == null || !Number.isInteger(sessionId) || sessionId <= 0) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  writeJson(res, 200, { items: cfg.queuedInputStore.list(sessionId) })
}

async function handleQueuedInputEnqueue(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const body = await readJsonBody(req)
  const sessionId = parsePositiveInteger(body.sessionId)
  if (sessionId == null || typeof body.content !== 'string') {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
    return
  }
  try {
    const item = cfg.queuedInputStore.enqueue(sessionId, body.content)
    cfg.onQueuedInputChanged?.(sessionId)
    if (!cfg.activeRuns?.hasActive(sessionId)) cfg.dispatchQueuedInputIfIdle?.(sessionId)
    writeJson(res, 200, { item })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'E_INVALID_ARG'
    writeJson(res, 400, { error: code === 'E_QUEUE_FULL' ? code : 'E_INVALID_ARG' })
  }
}

async function handleQueuedInputMutation(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  action: 'update' | 'cancel' | 'send'
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const body = await readJsonBody(req)
  const id = parsePositiveInteger(body.id)
  if (id == null || (action === 'update' && typeof body.content !== 'string')) {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
    return
  }
  const existing = cfg.queuedInputStore.get(id)
  if (!existing) {
    writeJson(res, 409, { error: 'E_QUEUED_INPUT_STATE' })
    return
  }
  try {
    const changed =
      action === 'update'
        ? cfg.queuedInputStore.update(id, body.content as string)
        : action === 'cancel'
          ? cfg.queuedInputStore.cancel(id)
          : cfg.queuedInputStore.confirm(id)
    if (!changed) {
      writeJson(res, 409, { error: 'E_QUEUED_INPUT_STATE' })
      return
    }
    cfg.onQueuedInputChanged?.(existing.sessionId)
    if (action === 'send') cfg.dispatchQueuedInputIfIdle?.(existing.sessionId)
    writeJson(res, 200, { ok: true })
  } catch {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
  }
}

/**
 * `POST /api/ai/queued-input/interrupt { id }` — stop the session's current run and send this one
 * queued row now. Unlike /run/stop nothing is restored: the other queued rows stay queued and the
 * interrupt run's own onFinish drains them afterwards. Rows the stopped run had already claimed
 * (a dispatch run being interrupted) are handed to the dispatcher to CAS back to queued — an
 * aborted run never persists them — unless an approval is pending for the session, in which case
 * the claimed rows belong to the paused run and get marked sent on its resume. The dedup gate is
 * claim() alone: the dispatcher runs on the per-session post-turn chain, so an onFinish drain
 * racing this endpoint claims the row first and the interrupt dispatch then finds nothing to send.
 */
async function handleQueuedInputInterrupt(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const body = await readJsonBody(req)
  const id = parsePositiveInteger(body.id)
  if (id == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
    return
  }
  const existing = cfg.queuedInputStore.get(id)
  if (
    !existing ||
    (existing.status !== 'queued' && existing.status !== 'restored') ||
    (existing.status === 'restored' && !cfg.queuedInputStore.confirm(id))
  ) {
    writeJson(res, 409, { error: 'E_QUEUED_INPUT_STATE' })
    return
  }
  const sessionId = existing.sessionId
  const stopped = cfg.activeRuns?.stop(sessionId).stopped === true
  const approvalPending = cfg.approvalStash?.peekBySession(sessionId) != null
  const revertIds =
    stopped && !approvalPending
      ? cfg.queuedInputStore
          .list(sessionId)
          .filter((item) => item.status === 'claimed')
          .map((item) => item.id)
      : []
  cfg.onQueuedInputChanged?.(sessionId)
  cfg.dispatchQueuedInputInterrupt?.(sessionId, id, revertIds)
  writeJson(res, 200, { ok: true, stopped })
}

async function handleCompact(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  coordinator: CompactCoordinator | null
): Promise<void> {
  if (!coordinator) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'chat compact not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  if (cfg.activeRuns?.hasActive(sessionId)) {
    writeJson(res, 409, { error: 'E_RUN_ACTIVE', hint: 'chat run active for session' })
    return
  }
  if (coordinator.hasActive(sessionId)) {
    writeJson(res, 409, { error: 'E_COMPACT_ACTIVE', hint: 'compact active for session' })
    return
  }
  try {
    writeJson(res, 200, await coordinator.run(sessionId))
  } catch (err) {
    if (err instanceof Error && err.message === 'E_COMPACT_ACTIVE') {
      writeJson(res, 409, { error: 'E_COMPACT_ACTIVE', hint: 'compact active for session' })
      return
    }
    writeJson(res, 500, {
      error: 'E_COMPACT_FAILED',
      hint: err instanceof Error ? err.message : String(err)
    })
  }
}

async function handleCompactStop(
  req: IncomingMessage,
  res: ServerResponse,
  coordinator: CompactCoordinator | null
): Promise<void> {
  if (!coordinator) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'chat compact not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  writeJson(res, 200, { stopped: coordinator.stop(sessionId) })
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
 *
 * L4 批次2 — a second body shape `{ approvalId, editedInput }` for the in-panel decide card, the
 * SAME id-resolution /decide already does (S6 W2 P9): that surface only ever learns the approvalId
 * from GET /pending, never the internal toolCallId. The gateway peeks the stash by approvalId
 * (read-only — the claim still happens later, inside /decide) and drives the identical applyEdit.
 * A miss → 404, so a stale card cannot edit anything. 🔴 Order matters for the caller: /resolve
 * FIRST, /decide second — /decide claims the stash, after which the approvalId no longer resolves.
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
  const bodyToolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  const editedInput =
    body.editedInput && typeof body.editedInput === 'object' && !Array.isArray(body.editedInput)
      ? (body.editedInput as Record<string, unknown>)
      : null
  // L4 批次2 — resolve the { approvalId } shape to the internal toolCallId through the stash
  // (peek = read-only; the entry stays claimable for the /decide that follows). No stash wired or
  // no live entry → 404 not_found, the same fail-closed shape /decide answers for a stale id.
  let toolCallId = bodyToolCallId
  if (!toolCallId && approvalId) {
    const entry = cfg.approvalStash?.peekByApprovalId(approvalId) ?? null
    if (!entry) {
      writeJson(res, 404, { error: 'E_APPROVAL_NOT_FOUND', hint: 'no live pending approval' })
      return
    }
    toolCallId = entry.toolCallId
  }
  if (!toolCallId || !editedInput) {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'toolCallId (or approvalId) + editedInput{} required'
    })
    return
  }
  try {
    const out = cfg.resolveEditedApproval(toolCallId, editedInput)
    writeJson(res, 200, { status: 'ok', ...out })
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const message = e instanceof Error ? e.message : String(e)
    if (typeof code === 'string') {
      if (code === 'E_APPROVAL_EXPIRED') cfg.markApprovalExpired?.(toolCallId)
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
  const body = await readJsonBody(req)
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  // S6 W3-3 — the { approvalId } shape is the in-record web_fetch "always allow this domain" PIN:
  // derive a per-agent web origin rule from the STASHED headless approval (agent-run-only; a manual
  // web_fetch never stashes). Distinct hook from the exec { toolCallId } path (manual approvalGuard,
  // context_mode pinned to manual_chat) — a web remember keys the agent + server-derived context.
  if (approvalId) {
    if (!cfg.rememberWebApproval) {
      writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'web tools not enabled' })
      return
    }
    try {
      const rule = await cfg.rememberWebApproval(approvalId)
      writeJson(res, 200, { status: 'ok', rule })
    } catch (e) {
      const code = (e as { code?: unknown }).code
      const message = e instanceof Error ? e.message : String(e)
      if (typeof code === 'string') {
        writeJson(res, approvalErrorStatus(code), { error: code, hint: message })
      } else {
        console.error('[ai-gateway] /api/ai/policy/remember (web) failed unexpectedly', e)
        writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
      }
    }
    return
  }
  // Exec { toolCallId } path — byte-identical to S2 W1.
  if (!cfg.rememberExecApproval) {
    writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'exec tools not enabled' })
    return
  }
  if (!toolCallId) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'toolCallId or approvalId required' })
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
async function handleSearchAgent(
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
    (phase) => {
      if (!controller.signal.aborted) writeSse(res, { type: 'phase', phase })
    }
  )
  if (!controller.signal.aborted) writeSse(res, { type: 'result', result })
  res.end()
}

/**
 * `POST /api/ai/group-chat` — L4 群聊 (CHAT_DB v30): custom-agent group-chat writes. Two modes,
 * both requiring the session to BE a group (cfg.resolveGroupSession non-null; anything else →
 * 400 E_NOT_GROUP — /api/ai/chat never consults these hooks, so a group sessionId posted THERE
 * keeps today's main-agent semantics and a `speakAsAgentId` in that body is simply never read):
 *
 *   • `{ sessionId, userText, attachments? }` — append the owner's user message (speaker NULL) →
 *     JSON. T2: `attachments`（renderer 已读出正文；图片 text=null）落 `metadata.attachments`，
 *     形状不合格 / 超过条数上限 → 400 E_INVALID_ARG（写侧不静默丢）。
 *   • `{ sessionId, speakAsAgentId, model? }` — ONE member's speaking turn. 🔴 Membership is
 *     validated HERE in server code against the server-resolved members_json (the body only picks
 *     among server facts — it can never mint an identity; non-member → 403 E_NOT_GROUP_MEMBER).
 *     The run reads the FULL persisted transcript server-side (cfg.listGroupHistory →
 *     assembleGroupHistory: own rows → assistant, everyone else → `[名字]`-prefixed user),
 *     carries the member's identity + group roster into prepareChatRun (group block replaces the
 *     team block; 🔴 ToolSet structurally EMPTY — chatRun's isGroupSpeakerRun guard), streams
 *     `{type:'text-delta'}` SSE frames, then persists the finished reply with speaker_agent_id
 *     and emits the terminal `{type:'done'}` frame. A failed / client-aborted run persists
 *     NOTHING (the frontend marks the bubble failed and moves to the next member — 成本护栏:
 *     the server has NO fan-out; one POST = at most one member reply, sequencing lives in the
 *     renderer loop, so an agent reply can never trigger another agent).
 *
 * Registered unconditionally; the three cfg hooks gate it (404 on hand-built harness cfgs).
 *
 * g1 (labs `groupAgents` on, 调度器 built) — the append branch answers FIRST, then hands the new
 * row to `groupScheduler.onGroupMessage` (the chain runs detached, never tied to `req`); the
 * speaker branch is refused 409 E_LABS_ORCHESTRATED (the two drivers are mutually exclusive).
 * labs off / 调度器 absent → both branches byte-identical to v30 (`orchestrated:false`).
 */
async function handleGroupChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  groupScheduler: GroupOrchestrator | null
): Promise<void> {
  const { resolveGroupSession, listGroupHistory, appendGroupMessage } = cfg
  if (!resolveGroupSession || !listGroupHistory || !appendGroupMessage) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'group chat feature not wired' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (int) required' })
    return
  }
  let facts: GroupSessionFacts | null = null
  try {
    facts = (await resolveGroupSession(sessionId)) ?? null
  } catch (err) {
    console.warn('[ai-gateway] resolveGroupSession failed', err)
  }
  if (facts == null) {
    writeJson(res, 400, { error: 'E_NOT_GROUP', hint: 'session is not a group chat' })
    return
  }
  const speakAs =
    typeof body.speakAsAgentId === 'string' && body.speakAsAgentId.length > 0
      ? body.speakAsAgentId
      : null
  const userText =
    typeof body.userText === 'string' && body.userText.length > 0 ? body.userText : null
  const orchestrating = groupScheduler != null && (await labsGroupAgentsOn(cfg))

  // Retry mode — `{ sessionId, retry: { agentId, chainId } }`: re-enqueue one member on its chain
  // (调度器.requeue). Only meaningful under server-side orchestration; membership is checked
  // against server facts inside requeue; a stopped chain is never revived (409 E_RUN_STOPPED).
  // Not gated on「上一条是不是 failed」: the UI only offers the button on a failed row and a
  // double click is folded by enqueueCoalesced.
  const retry = body.retry
  if (retry != null && typeof retry === 'object' && !Array.isArray(retry)) {
    const r = retry as { agentId?: unknown; chainId?: unknown }
    const agentId = typeof r.agentId === 'string' && r.agentId.length > 0 ? r.agentId : null
    const chainId = typeof r.chainId === 'number' && Number.isInteger(r.chainId) ? r.chainId : null
    if (agentId == null || chainId == null) {
      writeJson(res, 400, {
        error: 'E_INVALID_ARG',
        hint: 'retry.agentId + retry.chainId required'
      })
      return
    }
    if (!orchestrating || groupScheduler == null) {
      writeJson(res, 409, {
        error: 'E_LABS_ORCHESTRATED',
        hint: 'retry needs server-side orchestration (labs.groupAgents on)'
      })
      return
    }
    const out = await groupScheduler.requeue(sessionId, agentId, chainId)
    if (out.error === 'E_NOT_GROUP_MEMBER') {
      writeJson(res, 403, {
        error: 'E_NOT_GROUP_MEMBER',
        hint: `agent ${agentId} is not a member of this group`
      })
      return
    }
    if (out.error === 'E_RUN_STOPPED') {
      writeJson(res, 409, { error: 'E_RUN_STOPPED', hint: 'this chain was stopped' })
      return
    }
    if (out.error != null) {
      writeJson(res, 400, { error: 'E_NOT_GROUP', hint: 'session is not a group chat' })
      return
    }
    writeJson(res, 200, { ok: true, queued: out.queued })
    return
  }

  // Append mode — the owner's message enters the shared transcript once, BEFORE any speaker run.
  if (speakAs == null) {
    if (userText == null) {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'speakAsAgentId or userText required' })
      return
    }
    // T2 群附件 — 形状 / 条数校验在这里（写侧不静默丢，见 validateAttachmentsInput 头注）；
    // 正文由 renderer 读出，服务端只搬运 + 截断，从不去读文件。
    const attachments = validateAttachmentsInput(body.attachments)
    if (!attachments.ok) {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: attachments.hint })
      return
    }
    // P2-L13 群 @ 资料 — 同一纪律：形状不合格整条 400。落进同一个 metadata 对象的另一个键，
    // 两个编码器都保留 base 的其余键，所以链起来即可（都空 → metadata 恒 null，行字节不变）。
    const libraryRefs = readLibraryRefsInput(body)
    if (!libraryRefs.ok) {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: libraryRefs.hint })
      return
    }
    const metadata = encodeLibraryRefsMetadata(
      libraryRefs.items,
      encodeAttachmentsMetadata(attachments.items)
    )
    const messageId = appendGroupMessage(sessionId, {
      role: 'user',
      content: userText,
      speakerAgentId: null,
      // 🔴 无附件时**不传** metadata 键 —— 绝大多数消息走这条路径，它与改动前逐字节一致。
      ...(metadata != null ? { metadata } : {})
    })
    writeJson(res, 200, { ok: true, messageId, orchestrated: orchestrating })
    if (orchestrating) {
      const row: GroupTranscriptRow = {
        id: messageId,
        role: 'user',
        content: userText,
        speakerAgentId: null,
        status: 'complete',
        chainId: messageId,
        via: null,
        createdAt: Date.now(),
        // 这一行是刚落库那条的投影：带上附件 / 资料引用才与 listGroupHistory 之后读回来的形状一致。
        ...(attachments.items.length > 0 ? { attachments: attachments.items } : {}),
        ...(libraryRefs.items.length > 0 ? { libraryRefs: libraryRefs.items } : {})
      }
      groupScheduler.onGroupMessage(sessionId, row).catch((err: unknown) => {
        console.warn('[ai-gateway] group onGroupMessage failed', { sessionId, messageId, err })
      })
    }
    return
  }

  if (orchestrating) {
    writeJson(res, 409, {
      error: 'E_LABS_ORCHESTRATED',
      hint: 'group speaker turns are driven server-side while labs.groupAgents is on'
    })
    return
  }

  // Speaker mode — membership check against server facts (never the body).
  const member = facts.members.find((m) => m.agentId === speakAs)
  if (member == null) {
    writeJson(res, 403, {
      error: 'E_NOT_GROUP_MEMBER',
      hint: `agent ${speakAs} is not a member of this group`
    })
    return
  }
  const titleById = new Map(facts.members.map((m) => [m.agentId, m.title]))
  const messages = assembleGroupHistory(listGroupHistory(sessionId), speakAs, titleById)
  if (messages.length === 0) {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'group history empty — append a user message first'
    })
    return
  }
  const identity: SessionAgentIdentity = {
    agentId: member.agentId,
    agentTitle: member.title,
    duty: member.duty ?? null,
    model: member.model ?? null,
    scheduleLine: null,
    group: {
      members: facts.members.map((m) => ({ agentId: m.agentId, title: m.title })),
      // T4 (design M7) — labs off 也是减重态 + 沉默契约：群里有其他 agent 的半可信输出，
      // memory.md / 技能名单 / connector 名单不该进这个 prompt，且两态的 prompt 面必须一致。
      // sessionId 有意不带 → chatRun 不调 buildGroupSpeakerTools，v30 的零工具姿态不变。
      groupSpeakerRun: true
    }
  }
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  // 🔴 sessionId deliberately NOT in the prepared body: the group writer persists via
  // appendGroupMessage below, never via makePersistOnFinish / eager user persist (those would
  // double-write the assembled per-speaker view into the shared transcript).
  const prepared = await prepareChatRun(
    {
      messages,
      ...(typeof body.model === 'string' && body.model.length > 0 ? { model: body.model } : {})
    },
    cfg,
    controller.signal,
    'manual_chat',
    identity
  )
  if (!prepared.ok) {
    writeJson(res, prepared.status, prepared.body)
    return
  }
  res.writeHead(200, { ...SSE_HEADERS, ...corsHeadersFor(req.headers.origin) })
  try {
    for await (const delta of prepared.run.result.textStream) {
      if (controller.signal.aborted) break
      writeSse(res, { type: 'text-delta', delta })
    }
    const text = await prepared.run.result.text
    if (!controller.signal.aborted) {
      // 沉默契约的 v30 半边：按契约回 [沉默] 的 turn 不落行（落了会被 renderer 下一次 refetch
      // 当成一条发言显示，还会喂进其他成员的历史）。done 帧 messageId=null，groupChatClient
      // 本就按 number 判型。
      const messageId = isSilence(text)
        ? null
        : appendGroupMessage(sessionId, {
            role: 'assistant',
            content: text,
            speakerAgentId: speakAs,
            model: prepared.run.modelId
          })
      writeSse(res, { type: 'done', messageId, content: text, speakerAgentId: speakAs })
    }
  } catch (err) {
    // Stream OR persist failure — the reply is not durable, say so (never a silent truncation;
    // the renderer marks the bubble failed and continues with the next member).
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai-gateway] /api/ai/group-chat failed', { message })
    if (!controller.signal.aborted) writeSse(res, { type: 'error', errorText: message })
  }
  res.end()
}

/** g1 — labs `groupAgents` as the endpoints see it: hook absent (harness / not wired) or any
 *  failure → off (fail-closed, the hook's own contract restated at the call site). */
async function labsGroupAgentsOn(cfg: AiGatewayConfig): Promise<boolean> {
  if (!cfg.resolveLabsFlags) return false
  try {
    return (await cfg.resolveLabsFlags()).groupAgents === true
  } catch {
    return false
  }
}

/** 流式 delta 事件的最小间隔（≤ 10 帧/秒，红线 5）；尾帧不受节流。 */
const GROUP_DELTA_THROTTLE_MS = 100

/** g1 — one 调度器 member turn = one prepareChatRun with the member's identity + the group roster
 *  (same seams as the v30 speaker branch above: member model middle priority, <current_group_chat>
 *  block, 🔴 zero tools by construction), plus `groupSpeakerRun:true` for the prompt 减重门 and
 *  the 沉默契约. The run's text + usage go back to the 调度器, which decides silent / held_dup /
 *  spoke and does the persisting — nothing here writes the transcript.
 *  UX 批 — the text is drained from `textStream` (accumulated, throttled to `input.onDelta`, tail
 *  frame always sent) so the renderer can show the reply growing; `GroupSpeakResult` is unchanged.
 *  🔴 `config.modelOverride` (全群统一模型) is read HERE and nowhere else. */
export async function speakAsGroupMember(
  cfg: AiGatewayConfig,
  input: GroupSpeakInput
): Promise<GroupSpeakResult> {
  const identity: SessionAgentIdentity = {
    agentId: input.member.agentId,
    agentTitle: input.member.title,
    duty: input.member.duty ?? null,
    model: input.facts.config.modelOverride ?? input.member.model ?? null,
    scheduleLine: null,
    group: {
      members: input.facts.members.map((m) => ({ agentId: m.agentId, title: m.title })),
      sessionId: input.sessionId,
      isJudge:
        input.facts.config.judgeAgentId != null &&
        input.facts.config.judgeAgentId === input.agentId,
      familySessionIds: input.facts.familySessionIds,
      groupSpeakerRun: true,
      topic: input.facts.config.topic ?? null
    }
  }
  const prepared = await prepareChatRun(
    { messages: input.messages },
    cfg,
    input.signal,
    'manual_chat',
    identity
  )
  if (!prepared.ok) throw new Error(`${prepared.body.error}: ${prepared.body.hint}`)
  let text = ''
  let lastSentAt = 0
  let lastSent: string | null = null
  for await (const delta of prepared.run.result.textStream) {
    text += delta
    if (!input.onDelta) continue
    const now = Date.now()
    if (now - lastSentAt >= GROUP_DELTA_THROTTLE_MS) {
      lastSentAt = now
      lastSent = text
      input.onDelta(text)
    }
  }
  // 尾帧：保证末字到达（节流可能吞掉最后一段）。
  if (input.onDelta && text.length > 0 && lastSent !== text) input.onDelta(text)
  const usage = await prepared.run.result.usage
  return {
    text,
    modelId: prepared.run.modelId,
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null
    },
    protocol: prepared.run.protocol
  }
}

/** g1 — build the 调度器 from the cfg group hooks (all seven + activeRuns present), else null =
 *  orchestration impossible (endpoint stays v30 whatever labs says). Mirrors the CompactCoordinator
 *  construction point: cfg.groupScheduler (tests) wins over a fresh instance. */
function buildGroupScheduler(cfg: AiGatewayConfig): GroupOrchestrator | null {
  if (cfg.groupScheduler) return cfg.groupScheduler
  const {
    resolveGroupSession,
    listGroupHistory,
    appendGroupMessage,
    getSeenCursor,
    advanceSeenCursor,
    insertGroupTurn,
    groupUsage,
    activeRuns
  } = cfg
  if (
    !resolveGroupSession ||
    !listGroupHistory ||
    !appendGroupMessage ||
    !getSeenCursor ||
    !advanceSeenCursor ||
    !insertGroupTurn ||
    !groupUsage ||
    !activeRuns
  ) {
    return null
  }
  return new GroupOrchestrator({
    deps: {
      resolveFacts: async (sessionId) => {
        const facts = (await resolveGroupSession(sessionId)) ?? null
        if (!facts) return null
        return {
          members: facts.members,
          modes: facts.modes,
          config: facts.config,
          familySessionIds: [
            sessionId,
            ...(facts.parentSessionId != null ? [facts.parentSessionId] : []),
            ...facts.childSessionIds
          ],
          // T3 — 话题事实：三项在 GroupSessionFacts 上可缺，这里归一（`?? []` / `=== true`）。
          threadSessionIds: facts.threadSessionIds ?? [],
          isThread: facts.isThread === true,
          threadRootSpeakerAgentId: facts.threadRootSpeakerAgentId ?? null
        }
      },
      listHistory: listGroupHistory,
      appendMessage: appendGroupMessage,
      getSeenCursor,
      advanceSeenCursor,
      insertTurn: insertGroupTurn,
      groupUsage,
      resolveLabs: async () => ({ groupAgents: await labsGroupAgentsOn(cfg) }),
      speak: (input) => speakAsGroupMember(cfg, input),
      registerRun: (sessionId, controller) => activeRuns.register(sessionId, controller),
      releaseRun: (sessionId, runId) => activeRuns.release(sessionId, runId),
      mirrorRunLog: cfg.mirrorGroupRunLog,
      emitEvent: cfg.onGroupTurnEvent,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }
  })
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
 * `POST /api/ai/approval/decide` — server-side approval resume. Two callers, two body shapes:
 *   - ISLAND (Part B): `{ toolCallId, decision, resumeToken }`. serve-api echoes back the gateway-minted
 *     capability token; approvalStash.claim rejects a wrong one. Used when the user is fully off the app.
 *   - IN-RECORD (S6 W2, PRD P9): `{ approvalId, decision }` — NO resumeToken. The record view has no
 *     capability token (it must never leave the gateway); the gateway resolves the internal toolCallId +
 *     resumeToken from the stash by approvalId (peekByApprovalId) and drives the SAME resume. A
 *     wrong/stale approvalId → 404 not_found (fail-closed). Loopback-trusted like the other gateway
 *     endpoints (serve-api's ai_gateway_proxy fronts the remote-web parity, CF-Access-gated upstream).
 *
 * Registered unconditionally; cfg.approvalStash gates it (404 when server-side resume is off →
 * byte-identical to pre-S6; the stash presence, not the island flag, is the gate since S6 W2 P8).
 */
async function handleApprovalDecide(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  const stash = cfg.approvalStash
  if (!stash) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'approval resume not enabled' })
    return
  }
  const body = await readJsonBody(req)
  // P1-1 (codex r1) — the decision is a fail-closed security floor: ONLY the exact strings
  // 'approve' / 'reject' are accepted. Everything else — a missing field, 'rejected', case variants
  // ('Approve'), or a proxy-mangled value — answers 400 WITHOUT touching the stash (still claimable
  // by a corrected retry). The previous `=== 'reject' ? 'reject' : 'approve'` defaulted every
  // unknown shape to APPROVE, which with the always-on /pending + serverResumeEnabled would execute
  // a real write tool off a malformed request.
  const decision: 'approve' | 'reject' | null =
    body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null
  if (decision == null) {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: "decision must be exactly 'approve' or 'reject'"
    })
    return
  }
  // L4 批次2 — the optional REJECTION REASON (the「不批但给文字指导」response dimension). Validated
  // whenever present, whatever the decision, and BEFORE the stash is touched: a malformed field is a
  // malformed request, and a 400 here leaves the approval claimable by a corrected retry. It only
  // has an EFFECT on reject — ai@7's convertToModelMessages emits a tool-result only for
  // `approved === false` (`{type:'execution-denied', reason}`), so an approve-side reason would be
  // collected and never seen; approvalResume drops it rather than pretend otherwise.
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string') {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'reason must be a string' })
      return
    }
    if (body.reason.length > APPROVAL_REASON_MAX_CHARS) {
      writeJson(res, 400, {
        error: 'E_INVALID_ARG',
        hint: `reason must be at most ${APPROVAL_REASON_MAX_CHARS} characters`
      })
      return
    }
  }
  const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const resumeToken = typeof body.resumeToken === 'string' ? body.resumeToken : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  // Resolve to the island shape { toolCallId, resumeToken } either from the body (island) or from the
  // stash by approvalId (in-record — the token is read from the entry, never sent by the caller).
  // Strict discriminated shapes: island requires BOTH toolCallId and resumeToken; in-record requires
  // approvalId; anything else (partial island shape without approvalId) → 400.
  let resolved: { toolCallId: string; resumeToken: string } | null = null
  // P1-2 — the entry PEEKED (never claimed) so the session lease below can key off its sessionId; a
  // lease rejection must leave the stash claimable for a later retry.
  let peeked: ReturnType<typeof stash.peek> = null
  if (toolCallId && resumeToken) {
    resolved = { toolCallId, resumeToken }
    peeked = stash.peek(toolCallId)
  } else if (approvalId) {
    const entry = stash.peekByApprovalId(approvalId)
    // miss / wrong approvalId → fail-closed (no live claimable approval): 404 not_found, same shape the
    // resume returns for a miss, so the record-view client treats it identically.
    if (!entry) {
      writeJson(res, 404, { ok: false, status: 'not_found', error: 'no live pending approval' })
      return
    }
    resolved = { toolCallId: entry.toolCallId, resumeToken: entry.resumeToken }
    peeked = entry
  } else {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'either { toolCallId, resumeToken } or { approvalId } required'
    })
    return
  }
  // The resume drives a real write tool; the fork's ack POST is fire-and-forget (5s, doesn't read the
  // body), and serve-api awaits us in a background task, so a long resume is fine. Abort if serve-api
  // disconnects.
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  // P1-2 (codex r1) — the resume drives the SAME streamText + persistTurn pipeline as a normal
  // /api/ai/chat turn, so it must hold the SAME per-session lease (ActiveRunRegistry). Take the slot
  // BEFORE resumeApprovalRun claims the stash: a lease miss (a chat run is streaming for this
  // session) answers 409 with the stash INTACT — the decision is retryable once the run settles —
  // and while the resume runs, /run/active truthfully reports it (409-fencing new same-session
  // POSTs via handleChat's gate + driving the panel's background placeholder). The finally releases
  // by runId (runId-matched → a stale release can never evict a newer run). Registry unwired
  // (detached runs off) or an unsaved/unknown session → no lease domain, pre-P1-2 flow unchanged.
  const resumeSessionId = peeked?.sessionId ?? null
  let leaseToken: { runId: string } | null = null
  if (cfg.activeRuns && resumeSessionId != null) {
    leaseToken = cfg.activeRuns.register(resumeSessionId, controller)
    if (leaseToken == null) {
      writeJson(res, 409, {
        ok: false,
        status: 'error',
        error: 'E_RUN_ACTIVE: a chat run is already streaming for this session'
      })
      return
    }
  }
  try {
    const result = await resumeApprovalRun(
      cfg,
      {
        toolCallId: resolved.toolCallId,
        decision,
        resumeToken: resolved.resumeToken,
        ...(reason !== undefined ? { reason } : {}),
        // codex r2 [C] — the resume's persists broadcast under the lease's runId (per-run dedup).
        runId: leaseToken?.runId
      },
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
  } finally {
    if (leaseToken && resumeSessionId != null) {
      cfg.activeRuns!.release(resumeSessionId, leaseToken.runId)
    }
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
async function handleGeneratedImage(
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
 * backward-compatible there. Stash unwired (both server-resume flags off, S6 W2 P8) → also a miss
 * (nothing is claimable).
 *
 * 🔴 SECURITY — the hit body enriches with approvalId/inputPreview/agentId/jobId/ageMs for the
 * decide card, but NEVER the resumeToken: that capability must only leave the gateway through the
 * serve-api announce leg. `pending:true` + `toolName` are kept verbatim for the island-notice
 * consumer (superset, zero-touch).
 *
 * L4 批次2 — three more fields, all additive:
 *   - `input` — the EFFECTIVE input (guard `editedInput ?? input`; the stashed model proposal when
 *     no guard is wired). The decide card renders an editor over it for the editable fields.
 *   - `editableFields` — what the tool factory registered as editable (empty ⇒ approve/reject only,
 *     the same boundary ApprovalGuard.applyEdit enforces with E_APPROVAL_NOT_EDITABLE).
 *   - `contextMode` — the mode FROZEN at pause time. The card needs it to decide whether a
 *     「记住这类操作」affordance would be a live config or a dead one: `tool_approval_pref` is
 *     consulted ONLY in manual_chat (tools/types.ts:411 / tool_prefs.py 头注), so offering it on an
 *     im_chat or headless pause would promise something the ladder never reads. `null` = unknown
 *     (hand-built stash entry) → the card must fail closed and offer nothing.
 */
async function handleApprovalPending(
  res: ServerResponse,
  cfg: AiGatewayConfig,
  url: string
): Promise<void> {
  const raw = new URL(url, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  const entry = cfg.approvalStash ? cfg.approvalStash.peekBySession(sessionId) : null
  if (!entry) {
    writeJson(res, 404, { pending: false })
    return
  }
  const info = extractApprovalStashInput(entry.responseMessage)
  // L4 批次1 #6 — same preview source as the island announce leg (server-derived facts first,
  // the model's args second). Async now: this handler awaits serve-api, which is why it is
  // dispatched through the crash belt. Unreadable stash input (no approval part) keeps the bare
  // toolName — there is no input to describe, and inventing one is worse than saying less.
  const inputPreview = info
    ? await resolveApprovalPreview(cfg, entry.toolName, info.input)
    : entry.toolName
  // L4 批次2 — the guard record is the authority on BOTH new fields: it holds any editedInput a
  // previous /resolve overlaid (so a re-opened card edits from where the last edit left off) and the
  // editableFields the tool factory registered. No guard wired → the stashed proposal + no editor.
  const record = cfg.peekApprovalRecord?.(entry.toolCallId) ?? null
  writeJson(res, 200, {
    pending: true,
    approvalId: entry.approvalId,
    toolName: entry.toolName,
    inputPreview,
    input: record ? record.input : (info?.input ?? null),
    editableFields: record?.editableFields ?? [],
    contextMode: entry.contextMode ?? null,
    agentId: entry.agentRunContext?.agentId ?? null,
    jobId: entry.agentRunContext?.jobId ?? null,
    // Stage 2 PR-4 (task 08-01 messenger) — the frozen DESTRUCTIVE bit, so an out-of-app approval
    // surface (Feishu card) renders the same red warning the desktop McpApprovalCard does. Always
    // a boolean (never undefined) so a consumer can't mistake "absent" for "unknown"; pre-PR-4
    // stash rows / non-connector tools → false = no warning, the previous behaviour verbatim.
    destructive: entry.destructive === true,
    ageMs: Date.now() - entry.createdAt
  })
}

/**
 * 🔴 The dispatcher's ONE crash belt (08-04 im-chat hang).
 *
 * Every route below is an async handler launched fire-and-forget from the SYNC createServer
 * callback. The old `void handleX(...)` swallowed the rejection, so any throw a handler does not
 * catch itself left the response NEVER WRITTEN — no status, no body, socket held open — and the
 * client hung until its OWN timeout. Not theoretical: prepareChatRun re-throws every non-credential
 * resolver failure (providers.ts throws a bare `Error('No enabled LLM provider: X')` for an unknown
 * provider ref), nothing caught it, and /api/ai/chat + /api/ai/im-chat answered nothing at all —
 * the 飞书 bridge's CHAT_READ_TIMEOUT_SEC is 1800s, i.e. a 30-minute silent hang for a typo in a
 * model ref, and the desktop panel waits on its own timeout too.
 *
 * This is a STRUCTURAL floor, not an error re-classifier: handlers that map their own failures
 * (title → 502 E_UPSTREAM, agent-run → 500 E_AGENT_RUN_CRASH, decide/resolve/remember → 500
 * E_INTERNAL) answer first and never reach here, and prepareChatRun's 503-vs-throw split is
 * unchanged. Pre-headers → 500 E_INTERNAL through writeJson, so the entry's single-point CORS
 * reflection still applies. Mid-stream → best-effort `{type:'error'}` SSE frame + end (every
 * streaming route here is text/event-stream, and that is the AI SDK UI message stream's own error
 * shape) so a streaming client sees a failure instead of a truncated stream; if even that write
 * throws, destroy.
 *
 * The log is a SUMMARY (name + message), never the error object: SDK errors routinely carry the
 * request body — i.e. the user's message text — so `console.error(err)` writes chat content into
 * the log (PRD Technical Notes ①, LobeHub's describePlatformError lesson).
 */
function dispatch(route: string, res: ServerResponse, work: Promise<void>): void {
  void work.catch((err: unknown) => {
    const name = err instanceof Error ? err.name : typeof err
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[ai-gateway] ${route} handler crashed`, { name, message })
    if (res.destroyed || res.writableEnded) return
    try {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
        return
      }
      if (String(res.getHeader('content-type') ?? '').includes('text/event-stream')) {
        writeSse(res, { type: 'error', errorText: message })
      }
      res.end()
    } catch {
      try {
        res.destroy()
      } catch {
        /* already gone */
      }
    }
  })
}

/**
 * Create (but do not listen) the gateway HTTP server. Pure factory — all external
 * deps arrive via cfg, so the Electron main can embed it and the Node harness can
 * drive it directly.
 */
export function createAiGatewayServer(cfg: AiGatewayConfig): Server {
  const compactCoordinator =
    cfg.compactCoordinator ??
    (cfg.compactPersistence ? new CompactCoordinator(cfg, cfg.compactPersistence) : null)
  // g1 — one 调度器 per gateway process (single serial worker across every group session).
  const groupScheduler = buildGroupScheduler(cfg)
  // g2 — the ONE delivery seam the group tools (group_post / group_create) reach the 调度器
  // through: a narrow function written back onto the (mutable) cfg, so the lifecycle's tool hooks
  // can read it lazily at call time without ever holding the instance (stopFamily / requeue never
  // reach a tool). No 调度器 → the seam stays absent → the tools answer E_GROUP_NOT_ORCHESTRATED.
  if (groupScheduler) {
    cfg.deliverGroupMessage = (sessionId, row) => groupScheduler.onGroupMessage(sessionId, row)
  }
  return createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const path = url.split('?')[0]

    // Loopback-only CORS on EVERY response, from one spot. Phase 06a attached
    // corsHeadersFor to the SSE/chat writeHead sites but left the writeJson GET routes
    // (/health, /api/ai/config, /api/ai/run/active, …) without ACAO — the packaged
    // renderer tolerated that, but the DEV renderer (http://localhost:<vite>) is
    // cross-origin to this loopback server and the browser blocks the read → the
    // panel's health probe fails → spurious "engine unavailable" read-only face while
    // the gateway is healthy. corsHeadersFor stays restrictive (a remote origin gets
    // no ACAO), so reflecting here widens nothing; routes that already merge it just
    // re-set identical values. Array-form headers (unused here) pass through untouched.
    const cors = corsHeadersFor(req.headers.origin)
    if (Object.keys(cors).length > 0) {
      const origWriteHead = res.writeHead.bind(res)
      res.writeHead = ((status: number, arg2?: unknown, arg3?: unknown) => {
        if (typeof arg2 === 'string') {
          return Array.isArray(arg3)
            ? origWriteHead(status, arg2, arg3)
            : origWriteHead(status, arg2, { ...cors, ...(arg3 as object | undefined) })
        }
        return Array.isArray(arg2)
          ? origWriteHead(status, arg2)
          : origWriteHead(status, { ...cors, ...(arg2 as object | undefined) })
      }) as typeof res.writeHead
    }

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
      dispatch('/api/ai/echo-stream', res, handleEchoStream(req, res))
      return
    }

    if (method === 'POST' && path === '/api/ai/chat') {
      dispatch('/api/ai/chat', res, handleChat(req, res, cfg))
      return
    }

    if (method === 'POST' && path === '/api/ai/compact') {
      dispatch('/api/ai/compact', res, handleCompact(req, res, cfg, compactCoordinator))
      return
    }

    if (method === 'POST' && path === '/api/ai/compact/stop') {
      dispatch('/api/ai/compact/stop', res, handleCompactStop(req, res, compactCoordinator))
      return
    }

    // Stage 2 PR-1 — the im_chat entrypoint. Registered ONLY when MAILAGENT_IM_FEISHU is on
    // (cfg.imFeishuEnabled); flag-off the path falls through to 404 and the gateway stays
    // byte-identical (mirrors the AG-UI mirror's flag-gated registration).
    if (cfg.imFeishuEnabled === true && method === 'POST' && path === '/api/ai/im-chat') {
      dispatch('/api/ai/im-chat', res, handleImChat(req, res, cfg))
      return
    }

    // Phase 04a — edit-tier approval side-channel (DraftReplyCard edits before approve).
    if (method === 'POST' && path === '/api/ai/approval/resolve') {
      dispatch('/api/ai/approval/resolve', res, handleApprovalResolve(req, res, cfg))
      return
    }

    // Part B (island) + S6 W2 (in-record) — approval decision → server-side resume. Registered
    // unconditionally; cfg.approvalStash gates it (404 when server-side resume is off).
    if (method === 'POST' && path === '/api/ai/approval/decide') {
      dispatch('/api/ai/approval/decide', res, handleApprovalDecide(req, res, cfg))
      return
    }

    // S2 W1 — exec whitelist "always allow" side-channel. Registered unconditionally;
    // cfg.rememberExecApproval gates it (501 when exec tools aren't wired).
    if (method === 'POST' && path === '/api/ai/policy/remember') {
      dispatch('/api/ai/policy/remember', res, handlePolicyRemember(req, res, cfg))
      return
    }

    // S3 W1 — headless agentic search (⌘K palette). Registered unconditionally; no key → 503.
    if (method === 'POST' && path === '/api/ai/search-agent') {
      dispatch('/api/ai/search-agent', res, handleSearchAgent(req, res, cfg))
      return
    }

    // v30（群聊）— group-chat writes (user append + member speaker runs). Registered
    // unconditionally; the three group cfg hooks gate it (404 when not wired).
    if (method === 'POST' && path === '/api/ai/group-chat') {
      dispatch('/api/ai/group-chat', res, handleGroupChat(req, res, cfg, groupScheduler))
      return
    }

    // S4 W3 — headless custom-agent fresh-spawn (AgentRunWorker poke). Registered unconditionally;
    // cfg.fetchAgentRunSpec + cfg.createAgentSession gate it (404 when custom agents are off).
    if (method === 'POST' && path === '/api/ai/agent-run') {
      dispatch('/api/ai/agent-run', res, handleAgentRun(req, res, cfg))
      return
    }

    // Part B follow-up + S6 W1 — pending-approval truth probe. Registered unconditionally; a miss
    // (nothing stashed) → 404 { pending:false } (fail-closed truth), a hit → the enriched
    // decide-card body (never the resumeToken).
    if (method === 'GET' && path === '/api/ai/approval/pending') {
      // Async since #6 (the preview line is fetched from serve-api) → through the crash belt.
      dispatch('/api/ai/approval/pending', res, handleApprovalPending(res, cfg, url))
      return
    }

    // task 09-02 — generate_image's read-only file route (cfg.generatedImagesDir gates it: absent
    // → 404, same as an unknown path). Async (stat) → through the crash belt.
    if (method === 'GET' && path.startsWith(GENERATED_IMAGE_ROUTE_PREFIX)) {
      dispatch('/api/ai/generated', res, handleGeneratedImage(res, cfg, path))
      return
    }

    // B1 (harness-chat lane A) — detached-run truth probe + explicit stop channel. Registered
    // unconditionally; cfg.activeRuns gates them (miss/404 when detached runs are off).
    if (method === 'GET' && path === '/api/ai/run/active') {
      handleRunActive(res, cfg, url, groupScheduler)
      return
    }
    if (method === 'POST' && path === '/api/ai/run/stop') {
      dispatch('/api/ai/run/stop', res, handleRunStop(req, res, cfg, groupScheduler))
      return
    }

    if (method === 'GET' && path === '/api/ai/queued-input') {
      dispatch('/api/ai/queued-input', res, handleQueuedInputList(res, cfg, url))
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input') {
      dispatch('/api/ai/queued-input', res, handleQueuedInputEnqueue(req, res, cfg))
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/update') {
      dispatch(
        '/api/ai/queued-input/update',
        res,
        handleQueuedInputMutation(req, res, cfg, 'update')
      )
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/cancel') {
      dispatch(
        '/api/ai/queued-input/cancel',
        res,
        handleQueuedInputMutation(req, res, cfg, 'cancel')
      )
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/send') {
      dispatch('/api/ai/queued-input/send', res, handleQueuedInputMutation(req, res, cfg, 'send'))
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/interrupt') {
      dispatch('/api/ai/queued-input/interrupt', res, handleQueuedInputInterrupt(req, res, cfg))
      return
    }

    // Phase 10b — configurable LLM auto-title (renderer POSTs after the first turn when enabled).
    // Registered unconditionally; cfg.getTitleContext/saveSessionTitle gate it (501 when not wired).
    if (method === 'POST' && path === '/api/ai/title') {
      dispatch('/api/ai/title', res, handleTitle(req, res, cfg))
      return
    }

    // Phase 05 — AG-UI interop mirror. Registered ONLY when MAILAGENT_AG_UI_MIRROR is on
    // (cfg.aguiMirrorEnabled); flag-off the path falls through to 404 (byte-identical to 04b).
    if (cfg.aguiMirrorEnabled && method === 'POST' && path === '/api/ai/agui/chat') {
      dispatch('/api/ai/agui/chat', res, handleAguiChat(req, res, cfg))
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
