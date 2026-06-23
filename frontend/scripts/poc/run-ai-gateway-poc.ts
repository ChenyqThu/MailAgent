/**
 * chat-panel P4 Phase 00 spike — AI Gateway PoC 验证 harness（纯 Node，经 tsx 运行）。
 *
 * 用法：
 *   cd frontend && node_modules/.bin/tsx scripts/poc/run-ai-gateway-poc.ts
 *
 * 它 import 与 Electron main 完全相同的 `ai_gateway_poc.ts` 核心，在临时端口拉起 server，
 * 验证 4 条可行性命题（无需启动整个 Electron）：
 *   [1] GET /health 返回 ok + 配置可观测；
 *   [2] POST /api/ai/echo-stream 把 prompt 逐 token SSE 回吐（transport 通）；
 *   [3] echo-stream 在 client abort 后立即停止（abort 生效）；
 *   [4] POST /api/ai/chat 经 @ai-sdk/anthropic + CRS 跑真实 streamText，SSE 出非空文本。
 *
 * key/base/model 从 repo 根 .env 读（与后端 bootstrapDotenv 同源）。无 key → [4] 标 SKIP。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startAiGatewayPocServer } from '../../src/electron/main/ai_gateway_poc'

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

  const handle = await startAiGatewayPocServer({ port: 0, apiKey, baseUrl, model })
  const base = `http://127.0.0.1:${handle.port}`
  console.log(`\n— AI Gateway PoC 起于 ${base} (model=${model}, hasKey=${Boolean(apiKey)}) —\n`)

  try {
    // [1] health
    const health = await fetch(`${base}/health`).then(
      (r) => r.json() as Promise<Record<string, unknown>>
    )
    if (health.status === 'ok' && health.service === 'mailagent-ai-gateway-poc') {
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
      const chatRes = await fetch(`${base}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '用一句话（≤20字）介绍你自己。', model })
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
        const finish = chatFrames.find((f) => f.type === 'finish')
        if (errFrame) {
          record('4-streamText', 'FAIL', `error 帧：${String(errFrame.message)}`)
        } else if (chatText.length > 0) {
          record(
            '4-streamText',
            'PASS',
            `streamText 出 ${chatFrames.length} 帧文本「${chatText}」usage=${JSON.stringify(finish?.usage ?? {})}`
          )
        } else {
          record('4-streamText', 'FAIL', `空文本（${chatFrames.length} 帧）`)
        }
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
