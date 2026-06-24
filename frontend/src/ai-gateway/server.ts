// chat-panel P4 Phase 02 — embedded AI SDK Gateway (formalized from the Phase 00
// spike `ai_gateway_poc.ts`). A loopback Node HTTP server that the Electron main
// process embeds (NOT a separate OS process — architecture §13.3 form A). It
// exposes an AI SDK UIMessage-compatible chat endpoint so the assistant-ui
// `useChatRuntime` runtime can stream text from a model through one provider path.
//
// 🔴 Design discipline (so the core is harness-testable in plain Node): this file
//    depends ONLY on `node:http` + `ai` + `@ai-sdk/anthropic`. It NEVER imports
//    electron / keytar / chat_db. The LLM key, the persistence writer, and the
//    model factory all arrive via AiGatewayConfig (config.ts). The impure wiring
//    (keytar key, chat_db dual-write, lifecycle) lives in
//    electron/main/ai_gateway_lifecycle.ts; `scripts/poc/run-ai-gateway-poc.ts`
//    and frontend/tests/ai-gateway/* drive this core directly.
//
// 🔴 flag-gated: index.ts only imports this when MAILAGENT_AI_SDK_GATEWAY==='true',
//    so flag-off (default) the `ai` / `@ai-sdk/anthropic` chunk never loads and
//    default behaviour is byte-for-byte unchanged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { createAnthropic } from '@ai-sdk/anthropic'
import { convertToModelMessages, stepCountIs, streamText, type LanguageModel } from 'ai'

import { anthropicBaseUrl, type AiGatewayConfig, type PersistTurnInput } from './config'
import type { GatewayToolAuditEntry } from './tools/types'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'

const GATEWAY_VERSION = '0.2.0'

/** Default tool-loop ceiling (matches the legacy harness AGENT_MAX_ITER default). */
const DEFAULT_MAX_STEPS = 8

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // loopback same-origin in production; opening CORS only eases harness/browser
  // direct connection (Electron consumes same-origin in Phase 02).
  'Access-Control-Allow-Origin': '*'
} as const

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const

export interface AiGatewayHandle {
  server: Server
  /** actual listening port (kernel-assigned when cfg.port === 0). */
  port: number
  close: () => Promise<void>
}

/** Read a request JSON body (64KB cap). Malformed / oversized → {} (callers
 *  validate the shape and answer E_INVALID_ARG so a bad body never throws). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    let tooBig = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (tooBig) return
      body += chunk
      if (body.length > 65_536) {
        tooBig = true
        body = ''
      }
    })
    req.on('end', () => {
      if (tooBig || body.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(body) as unknown
        resolve(
          typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
        )
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Monotonic-ish id generator for response message ids (transient — reload
 *  re-stamps the persisted row id). Not security-sensitive. */
function makeIdGenerator(): () => string {
  let seq = 0
  const boot = Date.now().toString(36)
  return () => `asst-${boot}-${(seq++).toString(36)}`
}

/** Resolve the LanguageModel factory: injected (tests / mock) else the default
 *  @ai-sdk/anthropic provider wired to the normalized baseURL + key. */
function resolveModelFactory(cfg: AiGatewayConfig): (modelId: string) => LanguageModel {
  if (cfg.createModel) return cfg.createModel
  const anthropic = createAnthropic({
    apiKey: cfg.apiKey ?? '',
    baseURL: anthropicBaseUrl(cfg.baseUrl)
  })
  return (modelId: string) => anthropic(modelId)
}

/** Pick the last user UIMessage of an incoming turn (the fresh message that
 *  triggered this response — what we persist alongside the assistant reply). */
function lastUserMessage(messages: MailAgentUIMessage[]): MailAgentUIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
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
  res.writeHead(200, SSE_HEADERS)
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
 * `POST /api/ai/chat` — the canonical Phase 02 endpoint. Converts the incoming
 * UIMessages to model messages, runs `streamText`, and pipes an AI SDK UIMessage
 * stream straight to the Node response so the assistant-ui `useChatRuntime`
 * runtime consumes it natively. abortSignal cancels the upstream LLM call when
 * the client disconnects (saves tokens). On finish (non-aborted) it hands the
 * assistant `responseMessage` + the triggering user message to `cfg.persistTurn`
 * for the ai_chat.db dual-write (ui_message_json canonical + extracted content).
 *
 * No key → 503 E_NO_LLM_KEY (typed, before any stream). Empty messages →
 * 400 E_INVALID_ARG. The provider key NEVER reaches the renderer — it lives only
 * in cfg.apiKey (main-process keytar/env via the Electron wrapper).
 */
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  const body = await readJsonBody(req)

  if (!cfg.apiKey || cfg.apiKey.length === 0) {
    writeJson(res, 503, { error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' })
    return
  }

  const rawMessages = Array.isArray(body.messages) ? (body.messages as MailAgentUIMessage[]) : []
  if (rawMessages.length === 0) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'messages[] required' })
    return
  }
  const modelId = typeof body.model === 'string' && body.model.length > 0 ? body.model : cfg.model
  const system = typeof body.system === 'string' && body.system.length > 0 ? body.system : undefined
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null

  // abort: client disconnect (or the renderer AbortController) cancels the upstream call.
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  // 🔴 ai@6 convertToModelMessages is ASYNC (returns a Promise) — must await,
  // else streamText.standardizePrompt receives a Promise and throws
  // "messages.some is not a function".
  let modelMessages
  try {
    modelMessages = await convertToModelMessages(rawMessages)
  } catch {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'messages[] not convertible to model messages'
    })
    return
  }

  // Phase 03a — when a tool factory is injected, build the read tools bound to a
  // fresh per-request audit collector (closure) and run a multi-step tool loop
  // (streamText { tools, stopWhen }). The collector is captured by the tools' execute
  // closures (NOT streamText experimental_context — robust + testable, see
  // tools/types.ts); the gateway drains it into the persisted turn in onFinish. No
  // tools → text-only (Phase 02 behaviour, byte-identical).
  const auditEntries: GatewayToolAuditEntry[] = []
  const tools = cfg.buildTools?.(auditEntries)
  const hasTools = tools != null && Object.keys(tools).length > 0

  const result = streamText({
    model: resolveModelFactory(cfg)(modelId),
    system,
    messages: modelMessages,
    abortSignal: controller.signal,
    ...(hasTools
      ? {
          tools,
          stopWhen: stepCountIs(cfg.maxSteps ?? DEFAULT_MAX_STEPS)
        }
      : {})
  })

  result.pipeUIMessageStreamToResponse(res, {
    originalMessages: rawMessages,
    generateMessageId: makeIdGenerator(),
    onFinish: async ({ responseMessage, isAborted }) => {
      if (isAborted || !cfg.persistTurn) return
      // usage resolves after generation completes; best-effort (persist still
      // writes the turn even if usage is unavailable).
      const usage = await Promise.resolve(result.usage).catch(() => undefined)
      const turn: PersistTurnInput = {
        sessionId,
        model: modelId,
        userMessage: lastUserMessage(rawMessages),
        responseMessage: responseMessage as MailAgentUIMessage,
        usage: usage
          ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null }
          : undefined,
        // read-tool audit entries collected this turn (empty when no tools ran).
        toolCalls: auditEntries
      }
      try {
        await cfg.persistTurn(turn)
      } catch (err) {
        // persistence is best-effort in Phase 02 — a write failure must not break
        // the already-streamed reply. Surface to the main log, never to the stream.
        console.error('[ai-gateway] persistTurn failed (turn streamed OK)', err)
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
  return createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const path = url.split('?')[0]

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
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
        persistence: Boolean(cfg.persistTurn)
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
