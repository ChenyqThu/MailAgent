// chat-panel P4 Phase 00 spike — Node AI SDK Gateway 最小 PoC（S0.2 + S0.3）。
//
// 目的：用最小代价回答 go/no-go 的两个技术问题：
//   1. 能否在 **Electron main 进程内嵌**一个 Node HTTP server，对 renderer 暴露
//      AI SDK 兼容的 chat endpoint（端口发现 / 生命周期 / 健康检查可行性）？
//   2. Vercel AI SDK v6 的 `streamText` 能否经现有 LLM 网关（CRS, Anthropic-native）
//      打通纯文本流，且 abort 生效？
//
// 🔴 本文件是 **flag-gated PoC**，默认永不启动（见 index.ts 的 MAILAGENT_AI_SDK_GATEWAY
//    门控）。架构定位见 docs/plans/chat-panel-ai-sdk-assistant-ui-refactor/architecture.md §4.3：
//    「Phase 2 PoC = 在 Electron main 内启动一个 Node HTTP server」。Phase 3+ 若稳定再抽成
//    独立 `mailagent-ai-gateway` 进程 —— 那时才是真正的「第三常驻进程」，成本评估见 roadmap.md。
//
// 🔴 设计纪律（为可独立 harness 验证）：本模块**只**依赖 `node:http` + `ai` + `@ai-sdk/anthropic`，
//    **不** import electron `app` / keytar / llm_settings —— 配置全部经参数注入。这样
//    `scripts/poc/run-ai-gateway-poc.mjs` 可在纯 Node 下 import 并验证 /health + echo + streamText，
//    无需启动整个 Electron。Electron 侧的接线（读 flag + llm key + 生命周期）留在 index.ts，
//    复用 llm_settings 的 getter，与 BackendLifecycleManager 的 SIGTERM 钩子对称。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText } from 'ai'

/** PoC 默认端口。serve-api=8200、本地 SSE 门=9200，避开两者取 8300。
 *  可经 env MAILAGENT_AI_GATEWAY_PORT 覆盖（与 resolveApiPort 的范式一致）。 */
export const AI_GATEWAY_POC_DEFAULT_PORT = 8300

/** 读 PoC 端口（env 覆盖，纯函数，便于 index.ts 与 harness 共用单一真源）。 */
export function resolveAiGatewayPocPort(): number {
  const raw = process.env.MAILAGENT_AI_GATEWAY_PORT
  const n = raw != null ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : AI_GATEWAY_POC_DEFAULT_PORT
}

export interface AiGatewayPocConfig {
  /** bind 端口。host 恒 127.0.0.1（loopback，公网不可达）。0 = 让内核分配临时端口（单测用）。 */
  port: number
  /** LLM 网关 base URL（如 https://crs.chenge.ink/api）。 */
  baseUrl: string
  /** LLM API key。null/空 → /api/ai/chat 返回 503 E_NO_LLM_KEY（echo-stream 仍可用）。 */
  apiKey: string | null
  /** 默认模型（如 claude-sonnet-4-6）。 */
  model: string
}

export interface AiGatewayPocHandle {
  server: Server
  /** 实际监听端口（port=0 时为内核分配值）。 */
  port: number
  /** 优雅关闭（停止 accept + 等在途连接）。 */
  close: () => Promise<void>
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // PoC 同源 loopback；放开 CORS 只为 harness/浏览器直连方便（真实 Phase 02 由 Electron 同源消费）。
  'Access-Control-Allow-Origin': '*'
} as const

/** 读取请求 JSON body（带 64KB 上限，防异常大 body）。失败/超限 → 解析为 {}。 */
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

/** 写一帧 SSE。frame 形如 `data: {json}\n\n`，与前端 EventSource / fetch-stream 消费契约一致。 */
function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 把 LLM 网关 base URL 归一成 `@ai-sdk/anthropic` 期望的形态（须含 `/v1`）。
 *
 * 🔴 路径契约差异：Python 侧 chat.py 对 base `https://crs.chenge.ink/api` 拼 `/v1/messages`；
 * 而 AI SDK 的 anthropic provider 只对 baseURL 追加 `/messages`（默认 baseURL 本就含 `/v1`）。
 * 故 AI SDK 的 baseURL 必须是 `.../api/v1`，否则命中 `.../api/messages` → CRS 404（实测踩过）。
 */
function anthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/**
 * S0.2 路由：`POST /api/ai/echo-stream` —— 不读真实 key，把 prompt 逐 token 回吐成 SSE。
 * 证明 transport（SSE 帧）+ abort（client 断开即停）+ 背压可控，与 AI SDK 解耦。
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
  // 按字符切片模拟 token 流（中文逐字、英文逐词都走同一路径，PoC 不做分词）。
  const tokens = prompt.match(/\S+\s*|\s+/g) ?? [prompt]
  for (const tok of tokens) {
    if (aborted) break // client 断开 → 立即停（abort 生效证据）
    writeSse(res, { type: 'text-delta', delta: tok })
    await delay(40)
  }
  if (!aborted) {
    writeSse(res, { type: 'finish', reason: 'stop' })
    res.end()
  } else {
    res.end()
  }
}

/**
 * S0.3 路由：`POST /api/ai/chat` —— 经 `@ai-sdk/anthropic` + 现有 CRS 网关跑真实 `streamText`，
 * 把 `result.textStream` 逐块转成 SSE。证明 AI SDK 纯文本流端到端打通 + abortSignal 生效。
 *
 * 无 key → 503 E_NO_LLM_KEY（不静默假装成功）。生产 Phase 02 可直接换成
 * `result.toUIMessageStreamResponse()` / `result.pipeUIMessageStreamToResponse(res)`
 * 让 assistant-ui 的 useChat runtime 原生消费（本 PoC 手工转 SSE 只为与 echo 帧统一、便于取证）。
 */
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayPocConfig
): Promise<void> {
  const body = await readJsonBody(req)
  if (!cfg.apiKey || cfg.apiKey.length === 0) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' }))
    return
  }
  const prompt =
    typeof body.prompt === 'string' && body.prompt.length > 0 ? body.prompt : '用一句话自我介绍'
  const system = typeof body.system === 'string' ? body.system : undefined
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : cfg.model

  // abort：client 断开（或前端 AbortController）→ 取消上游 LLM 请求，省 token。
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  const anthropic = createAnthropic({ apiKey: cfg.apiKey, baseURL: anthropicBaseUrl(cfg.baseUrl) })

  res.writeHead(200, SSE_HEADERS)
  writeSse(res, { type: 'start', route: 'chat', model })
  try {
    const result = streamText({
      model: anthropic(model),
      system,
      prompt,
      abortSignal: controller.signal
    })
    for await (const delta of result.textStream) {
      writeSse(res, { type: 'text-delta', delta })
    }
    const usage = await Promise.resolve(result.usage).catch(() => undefined)
    writeSse(res, { type: 'finish', reason: 'stop', usage })
    res.end()
  } catch (err) {
    // abort 触发的取消是预期路径，不当错误上报。
    if (controller.signal.aborted) {
      res.end()
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    writeSse(res, { type: 'error', message })
    res.end()
  }
}

/**
 * 创建（但不 listen）PoC HTTP server。纯函数式工厂：所有外部依赖经 cfg 注入，
 * 故可在 Electron main 内嵌，也可被 scripts/poc 的纯 Node harness 直接拉起验证。
 */
export function createAiGatewayPocServer(cfg: AiGatewayPocConfig): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const path = url.split('?')[0]

    // CORS 预检（harness/浏览器直连用）。
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end()
      return
    }

    if (method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'mailagent-ai-gateway-poc',
          model: cfg.model,
          hasKey: Boolean(cfg.apiKey && cfg.apiKey.length > 0),
          baseUrl: cfg.baseUrl
        })
      )
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

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not_found', path }))
  })
}

/**
 * 创建 + listen（127.0.0.1）。返回实际端口（port=0 时为内核分配）+ 优雅 close。
 * Electron 侧在 app.whenReady（flag-on 时）调用；harness 亦复用此入口。
 */
export function startAiGatewayPocServer(cfg: AiGatewayPocConfig): Promise<AiGatewayPocHandle> {
  const server = createAiGatewayPocServer(cfg)
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
