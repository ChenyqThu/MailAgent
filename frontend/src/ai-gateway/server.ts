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
import { makeIdGenerator, makePersistOnFinish, prepareChatRun } from './chatRun'
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

  const prepared = await prepareChatRun(body, cfg, controller.signal)
  if (!prepared.ok) {
    writeJson(res, prepared.status, prepared.body)
    return
  }
  const run = prepared.run
  run.result.pipeUIMessageStreamToResponse(res, {
    originalMessages: run.rawMessages,
    generateMessageId: makeIdGenerator(),
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
