/**
 * chat-panel P4 — AI Gateway 验证 harness（纯 Node，经 tsx 运行）。manual lane（不进 CI）。
 *
 * 用法：
 *   cd frontend && node_modules/.bin/tsx scripts/poc/run-ai-gateway-poc.ts
 *
 * 它 import 与 Electron main 完全相同的 `src/ai-gateway/server.ts` 规范核心（Phase 02 把
 * Phase 00 spike 的 ai_gateway_poc.ts 收编为此正式模块），在临时端口拉起 server，验证 4 条
 * 命题（无需启动整个 Electron）：
 *   [1] GET /health 返回 ok + 配置可观测；
 *   [2] POST /api/ai/echo-stream 把 prompt 逐 token SSE 回吐（transport 通）；
 *   [3] echo-stream 在 client abort 后立即停止（abort 生效）；
 *   [4] POST /api/ai/chat 经 @ai-sdk/anthropic + CRS 跑真实 streamText → AI SDK UIMessage 流，
 *       重建出非空文本。
 *
 * key/base/model 从 repo 根 .env 读（与后端 bootstrapDotenv 同源）。无 key → [4] 标 SKIP。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startAiGatewayServer } from '../../src/ai-gateway/server'
import { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import { buildGatewayTools } from '../../src/ai-gateway/tools'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..')

/** 最小 .env 解析（只取本 harness 要的三个 key；不覆盖已存在的 process.env）。 */
function loadDotenv(): void {
  try {
    const raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      const [, key, valRaw] = m
      if (process.env[key] != null) continue
      const val = valRaw.replace(/^["']|["']$/g, '')
      if (val.length > 0) process.env[key] = val
    }
  } catch {
    /* 无 .env 也能跑（[4] 会 SKIP）。 */
  }
}

/** 读一个 SSE 响应为帧数组。onDelta 可用于在中途 abort。 */
async function readSse(
  res: Response,
  onFrame?: (frame: Record<string, unknown>, count: number) => void
): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let count = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.replace(/^data: /, '').trim()
      if (!line) continue
      try {
        const frame = JSON.parse(line) as Record<string, unknown>
        frames.push(frame)
        count += 1
        onFrame?.(frame, count)
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
  return frames
}

const results: Array<{ id: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }> = []
function record(id: string, status: 'PASS' | 'FAIL' | 'SKIP', detail: string): void {
  results.push({ id, status, detail })
  const icon = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌'
  console.log(`${icon} [${id}] ${detail}`)
}

async function main(): Promise<void> {
  loadDotenv()
  const apiKey = process.env.LLM_API_KEY ?? null
  const baseUrl = process.env.LLM_API_BASE ?? 'https://crs.chenge.ink/api'
  const model = process.env.LLM_MODEL ?? 'claude-sonnet-4-6'

  const handle = await startAiGatewayServer({ port: 0, apiKey, baseUrl, model })
  const base = `http://127.0.0.1:${handle.port}`
  console.log(`\n— AI Gateway PoC 起于 ${base} (model=${model}, hasKey=${Boolean(apiKey)}) —\n`)

  try {
    // [1] health
    const health = await fetch(`${base}/health`).then(
      (r) => r.json() as Promise<Record<string, unknown>>
    )
    if (health.status === 'ok' && health.service === 'mailagent-ai-gateway') {
      record('1-health', 'PASS', `GET /health → ${JSON.stringify(health)}`)
    } else {
      record('1-health', 'FAIL', `意外响应 ${JSON.stringify(health)}`)
    }

    // [2] echo-stream 完整流
    const echoPrompt = 'MailAgent assistant-ui spike 验证'
    const echoRes = await fetch(`${base}/api/ai/echo-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: echoPrompt })
    })
    const echoFrames = await readSse(echoRes)
    const echoText = echoFrames
      .filter((f) => f.type === 'text-delta')
      .map((f) => String(f.delta))
      .join('')
    const echoFinished = echoFrames.some((f) => f.type === 'finish')
    if (echoText === echoPrompt && echoFinished) {
      record('2-echo', 'PASS', `${echoFrames.length} 帧重建出原文「${echoText}」+ finish`)
    } else {
      record('2-echo', 'FAIL', `重建「${echoText}」finished=${echoFinished}`)
    }

    // [3] echo-stream abort：收到 2 帧即 abort，断言后续帧停止
    const ac = new AbortController()
    let seen = 0
    try {
      const abRes = await fetch(`${base}/api/ai/echo-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '一 二 三 四 五 六 七 八 九 十' }),
        signal: ac.signal
      })
      await readSse(abRes, (_f, count) => {
        seen = count
        if (count === 2) ac.abort()
      })
      record('3-abort', 'FAIL', `未抛 abort（收到 ${seen} 帧）`)
    } catch (err) {
      const aborted =
        err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
      if (aborted && seen <= 4) {
        record('3-abort', 'PASS', `abort 后 ~${seen} 帧即停（共 10 token，证明未跑完）`)
      } else {
        record('3-abort', 'FAIL', `seen=${seen} err=${String(err)}`)
      }
    }

    // [4] 真实 streamText
    if (!apiKey) {
      record('4-streamText', 'SKIP', '无 LLM_API_KEY，跳过真实调用（echo 已证明 transport）')
    } else {
      // Phase 02: /api/ai/chat now takes UIMessage[] and emits an AI SDK UIMessage
      // stream (text-delta chunks carry { id, delta }); parse them back to text.
      const chatRes = await fetch(`${base}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model,
          messages: [
            {
              id: 'u1',
              role: 'user',
              parts: [{ type: 'text', text: '用一句话（≤20字）介绍你自己。' }]
            }
          ]
        })
      })
      if (chatRes.status === 503) {
        record('4-streamText', 'SKIP', '503 E_NO_LLM_KEY')
      } else {
        const chatFrames = await readSse(chatRes)
        const chatText = chatFrames
          .filter((f) => f.type === 'text-delta')
          .map((f) => String(f.delta))
          .join('')
        const errFrame = chatFrames.find((f) => f.type === 'error')
        if (errFrame) {
          record(
            '4-streamText',
            'FAIL',
            `error 帧：${String(errFrame.errorText ?? errFrame.message)}`
          )
        } else if (chatText.length > 0) {
          record(
            '4-streamText',
            'PASS',
            `UIMessage 流出 ${chatFrames.length} 帧、重建文本「${chatText}」`
          )
        } else {
          record('4-streamText', 'FAIL', `空文本（${chatFrames.length} 帧）`)
        }
      }
    }

    // [5] Phase 03a — read-tool loop end-to-end: a gateway with email_list_filter bound to
    // a MOCK domain (canned email, no real serve-api) + the REAL model. The model
    // should call email_list_filter, get the result, and answer — exercising the full
    // experimental_context → tool execute → audit → persistTurn wiring with a real
    // model (the part a mock model can't reliably drive).
    if (!apiKey) {
      record('5-readtool-loop', 'SKIP', '无 LLM_API_KEY，跳过真实工具循环')
    } else {
      const cannedEmail = {
        internal_id: 42,
        subject: 'redis 超时排查',
        sender: 'alice@x.test',
        date_received: '2026-06-20'
      }
      const toolDomain = new MailAgentDomainClient({
        baseUrl: 'http://127.0.0.1:1/api',
        localToken: null,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ status: 'success', data: [cannedEmail] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })) as unknown as typeof fetch
      })
      const toolPersisted: Array<Record<string, unknown>> = []
      const toolHandle = await startAiGatewayServer({
        port: 0,
        apiKey,
        baseUrl,
        model,
        buildTools: (collector) => buildGatewayTools({ domain: toolDomain }, collector),
        persistTurn: (turn) => {
          toolPersisted.push(turn as unknown as Record<string, unknown>)
        }
      })
      try {
        const toolRes = await fetch(`http://127.0.0.1:${toolHandle.port}/api/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            sessionId: 7,
            model,
            messages: [
              {
                id: 'u1',
                role: 'user',
                parts: [
                  {
                    type: 'text',
                    text: '用 email_list_filter 工具搜索主题包含 "redis" 的邮件，然后用一句话告诉我找到了什么主题的邮件。'
                  }
                ]
              }
            ]
          })
        })
        const frames = await readSse(toolRes)
        const text = frames
          .filter((f) => f.type === 'text-delta')
          .map((f) => String(f.delta))
          .join('')
        const toolFrames = frames.filter((f) => String(f.type).startsWith('tool-'))
        const calls = (toolPersisted[0]?.toolCalls ?? []) as Array<Record<string, unknown>>
        const searchCall = calls.find((c) => c.toolName === 'email_list_filter')
        if (searchCall && searchCall.status === 'ok' && text.length > 0) {
          record(
            '5-readtool-loop',
            'PASS',
            `模型调 email_list_filter（audit status=ok, ${toolFrames.length} 个 tool 帧）→ 答「${text}」`
          )
        } else if (calls.length === 0 && toolFrames.length === 0) {
          record('5-readtool-loop', 'FAIL', `模型未调用工具（${frames.length} 帧，答「${text}」）`)
        } else {
          record(
            '5-readtool-loop',
            'FAIL',
            `工具调用异常：audit=${JSON.stringify(calls)} text="${text}"`
          )
        }
      } finally {
        await toolHandle.close()
      }
    }
  } finally {
    await handle.close()
  }

  const fail = results.filter((r) => r.status === 'FAIL').length
  const pass = results.filter((r) => r.status === 'PASS').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  console.log(`\n— 结果：${pass} PASS / ${fail} FAIL / ${skip} SKIP —\n`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
