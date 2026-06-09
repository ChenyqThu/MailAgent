// @vitest-environment node
//
// V2.1 阶段 3 — 3c-2：ChatRuntime mock-fetch 单测。
//
// ChatRuntime = chat 引擎的「完整 ChatApi」组装层（dispatcher + HttpChatPlatform + 进程内
// emitter sink）。3c-2 仅 mock-fetch 测（不接 renderer transport，那是 3c-3）。覆盖：
//   - lazy config 预取（GET /chat/config，首跑一次 + 缓存）+ 预取失败 graceful（DEFAULT）
//   - start 端到端（legacy 单遍 custom-api）：config→getOrCreate→append→loadEmailContext→
//     backend llmFetch→SSE 解析→streamContent/finalize→sink→emitter→onStream 收 chunk/done
//   - confirmTool 同进程 resolveConfirmation（空 / 无 pending / 有 pending resolve）
//   - newSession / deleteSession / 读 graceful / kosAvailable / abort 未 start / openPopout no-op
//
// fetch 全 mock：envelope 端点用真 Response（http_client.request 解析）；llm-proxy SSE 用
// 手构造 fake Response（body.getReader 分块）。reads（工具读委托）注入 fake MailApi。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createChatRuntime } from '@shared/chat/runtime'
import { __resetConfirmations, awaitConfirmation } from '@shared/chat/tools/confirmation'
import type { MailApi } from '@shared/api/types'
import type { ChatMessage } from '@shared/chat/model'
import type { ChatStreamEnvelope } from '@shared/chat/types'

// ── helpers ──────────────────────────────────────────────────────────────

/** 成功 envelope 真 Response（http_client.request 调 .text() 解析）。 */
function env(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** fake streaming Response（llm-proxy）：body.getReader() 按序 yield 预设 chunk。 */
function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const reader = {
    read: async () =>
      i < chunks.length
        ? { done: false, value: encoder.encode(chunks[i++]) }
        : { done: true, value: undefined },
    releaseLock: () => {}
  }
  return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response
}

function minimalMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    session_id: 5,
    role: 'user',
    content: 'hi',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    created_at: 0,
    updated_at: 0,
    ...over
  }
}

/** 假 reads（loadEmailContext：email.get + body；其余 cast 省略）。 */
function makeReads(): MailApi {
  return {
    email: {
      get: vi.fn().mockResolvedValue({
        internal_id: 1,
        subject: 'S',
        sender: 'a@b.c',
        sender_name: 'A',
        date_received: '2026-01-01',
        notion_page_id: null
      }),
      body: vi.fn().mockResolvedValue({
        internal_id: 1,
        content: 'BODY',
        size_bytes: 4,
        format: 'markdown'
      })
    },
    attachment: { list: vi.fn().mockResolvedValue([]) }
  } as unknown as MailApi
}

/** /chat/config 快照（legacy：harnessEnabled false → dispatcher 走 legacy 单遍，
 *  避免 harness 多轮复杂度；harness gate 由 dispatcher.test 覆盖）。 */
const CONFIG_LEGACY = {
  maxIter: 8,
  maxCostUsd: 0.5,
  harnessEnabled: false,
  kosL1HotBlockEnabled: false,
  defaultModel: 'claude-sonnet-4-6',
  kosConsumerEnabled: false,
  kosConfigured: false,
  kosTimeDecayEnabled: true,
  userContext: ''
}

const SESSION_ROW = {
  id: 5,
  email_id: 1,
  backend_kind: 'custom-api',
  backend_model: null,
  backend_agent_page_id: null,
  created_at: 0,
  updated_at: 0
}

// custom_api anthropic SSE 样本（cf. custom_api_backend.test.ts）：chunk×2 + usage + done。
const ANTHROPIC_SSE = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12},"model":"claude-sonnet-4-6"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
  'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
  'data: {"type":"message_stop"}\n\n'
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  __resetConfirmations()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── start 端到端（legacy 单遍）──────────────────────────────────────────────

describe('ChatRuntime.start — 端到端 legacy 单遍', () => {
  function wireHappyPath(): void {
    const userMsg = minimalMessage({ id: 10, role: 'user', content: 'hi', status: 'complete' })
    const asstMsg = minimalMessage({ id: 11, role: 'assistant', content: '', status: 'streaming' })
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url).split('?')[0]
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      if (method === 'GET' && path === '/api/chat/config') return env(CONFIG_LEGACY)
      if (method === 'POST' && path === '/api/chat/sessions') return env(SESSION_ROW)
      if (method === 'POST' && path === '/api/chat/sessions/5/messages') {
        return env(body?.role === 'user' ? userMsg : asstMsg)
      }
      if (method === 'GET' && path === '/api/chat/sessions/5/messages') {
        return env([userMsg, asstMsg])
      }
      if (method === 'POST' && path === '/api/chat/llm-proxy') return sse(ANTHROPIC_SSE)
      if (method === 'PATCH' && path === '/api/chat/messages/11/stream') return env({ ok: true })
      if (method === 'PATCH' && path === '/api/chat/messages/11') return env({ ok: true })
      throw new Error(`unexpected fetch: ${method} ${path}`)
    })
  }

  test('预取 config → 跑 backend → onStream 收 chunk/done + 返回 ids', async () => {
    wireHappyPath()
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const events: ChatStreamEnvelope[] = []
    runtime.onStream((e) => events.push(e))

    const result = await runtime.start({
      emailId: 1,
      message: 'hi',
      backendKind: 'custom-api',
      backendModel: null,
      backendAgentPageId: null
    })
    expect(result).toEqual({ sessionId: 5, userMessageId: 10, assistantMessageId: 11 })

    // runStream 背景跑 → 等 done forward 出来。
    await vi.waitFor(() => expect(events.some((e) => e.event.type === 'done')).toBe(true), {
      timeout: 5000
    })

    const chunks = events.filter((e) => e.event.type === 'chunk')
    expect(chunks.map((e) => (e.event as { delta: string }).delta)).toEqual(['Hello ', 'world'])
    // envelope 带正确 session/message id（emitter 透传 dispatcher 包的 envelope）。
    expect(chunks[0]).toMatchObject({ sessionId: 5, messageId: 11 })
    // 预取 config 恰一次。
    const configCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/chat/config'))
    expect(configCalls.length).toBe(1)
  })

  test('config 预取在 engine 内缓存：两次 start 只 fetch config 一次', async () => {
    wireHappyPath()
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const events: ChatStreamEnvelope[] = []
    runtime.onStream((e) => events.push(e))

    await runtime.start({
      emailId: 1,
      message: 'a',
      backendKind: 'custom-api',
      backendModel: null,
      backendAgentPageId: null
    })
    await vi.waitFor(() => expect(events.some((e) => e.event.type === 'done')).toBe(true), {
      timeout: 5000
    })
    await runtime.start({
      emailId: 1,
      message: 'b',
      backendKind: 'custom-api',
      backendModel: null,
      backendAgentPageId: null
    })
    const configCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/chat/config'))
    expect(configCalls.length).toBe(1)
  })
})

// ── config 预取失败 graceful ────────────────────────────────────────────────

describe('ChatRuntime — config 预取失败降级', () => {
  test('config 预取失败 → 用 DEFAULT 仍构造 engine（newSession 成功 + warn）', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url).split('?')[0]
      if (path === '/api/chat/config') throw new Error('config endpoint down')
      if (method === 'POST' && path === '/api/chat/sessions/new') return env(SESSION_ROW)
      throw new Error(`unexpected fetch: ${method} ${path}`)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })

    const session = await runtime.newSession({ emailId: 1, backendKind: 'custom-api' })
    expect(session.id).toBe(5)
    expect(warn).toHaveBeenCalled() // "config prefetch failed, using DEFAULT_HTTP_CONFIG"
  })
})

// ── confirmTool 同进程 resolveConfirmation ─────────────────────────────────

describe('ChatRuntime.confirmTool', () => {
  test('空 toolUseId → E_INVALID_ARG（不触发 engine 构造）', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const res = await runtime.confirmTool('', true)
    expect(res).toEqual({ ok: false, code: 'E_INVALID_ARG', message: 'toolUseId required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('无 pending → E_NOT_PENDING', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const res = await runtime.confirmTool('toolu_missing', true)
    expect(res).toMatchObject({ ok: false, code: 'E_NOT_PENDING' })
  })

  test('有 pending → resolve outcome（approved + editedInput）+ ok:true', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const ac = new AbortController()
    const pending = awaitConfirmation('toolu_1', 99, ac.signal)

    const res = await runtime.confirmTool('toolu_1', true, { subject: 'edited' })
    expect(res).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({
      approved: true,
      editedInput: { subject: 'edited' }
    })
  })

  test('approved=false → editedInput 丢弃（对齐 ElectronChatApi）', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const ac = new AbortController()
    const pending = awaitConfirmation('toolu_2', 99, ac.signal)

    await runtime.confirmTool('toolu_2', false, { ignored: true })
    await expect(pending).resolves.toEqual({ approved: false, editedInput: undefined })
  })
})

// ── newSession / deleteSession ─────────────────────────────────────────────

describe('ChatRuntime.newSession / deleteSession', () => {
  test('newSession → POST /chat/sessions/new（backendModel/PageId 归一 null）', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/chat/config') return env(CONFIG_LEGACY)
      if (path === '/api/chat/sessions/new') return env(SESSION_ROW)
      throw new Error(`unexpected ${String(url)}`)
    })
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const s = await runtime.newSession({ emailId: 1, backendKind: 'custom-api' })
    expect(s.id).toBe(5)
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/chat/sessions/new')!
    expect(JSON.parse(call[1].body)).toEqual({
      emailId: 1,
      backendKind: 'custom-api',
      backendModel: null,
      backendAgentPageId: null
    })
  })

  test('deleteSession → DELETE /chat/sessions/{id}（fire-and-forget）', async () => {
    fetchMock.mockResolvedValue(env({ deleted: true }))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    runtime.deleteSession(42)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 5000 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/sessions/42')
    expect(init.method).toBe('DELETE')
  })

  test('deleteSession 非法 id → 不 fetch（不构造 engine）', () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    runtime.deleteSession(-1)
    runtime.deleteSession(Number.NaN)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── 读 graceful + kosAvailable ─────────────────────────────────────────────

describe('ChatRuntime — 读 graceful（fetch 失败返 []/false，不触发 engine）', () => {
  test('listSessions reject → []', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(await runtime.listSessions(1)).toEqual([])
  })

  test('listMessages reject → []', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(await runtime.listMessages(5)).toEqual([])
  })

  test('listAllSessions reject → []', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(await runtime.listAllSessions()).toEqual([])
  })

  test('listToolCalls reject → []', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(await runtime.listToolCalls(11)).toEqual([])
  })

  test('listSessions 成功 → 透传 + query emailId', async () => {
    fetchMock.mockResolvedValue(env([SESSION_ROW]))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const out = await runtime.listSessions(1)
    expect(out).toEqual([SESSION_ROW])
    expect(String(fetchMock.mock.calls[0][0])).toContain('emailId=1')
  })

  test('kosAvailable: 成功透传 true / reject → false', async () => {
    fetchMock.mockResolvedValue(env(true))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(await runtime.kosAvailable()).toBe(true)

    fetchMock.mockRejectedValue(new Error('down'))
    expect(await runtime.kosAvailable()).toBe(false)
  })
})

// ── abort / openPopout 边界 ─────────────────────────────────────────────────

describe('ChatRuntime — abort / openPopout 边界', () => {
  test('abort 未 start（engine 未建）→ 不 fetch、不抛', () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(() => runtime.abort(5)).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('openPopout → no-op（不 fetch、不抛）', () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    expect(() => runtime.openPopout(1)).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('onStream 返回 unsubscribe（解订后不再收到）', async () => {
    fetchMock.mockResolvedValue(env({ deleted: true }))
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    const seen: ChatStreamEnvelope[] = []
    const off = runtime.onStream((e) => seen.push(e))
    off()
    // 无活跃 stream 时 emitter 无投递；解订仅验证返回了可调用的 disposer。
    expect(typeof off).toBe('function')
    expect(seen).toEqual([])
  })

  test('abort: engine 已建时非法 id 不触发 /abort（合法 id 触发）', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url).split('?')[0]
      if (path === '/api/chat/config') return env(CONFIG_LEGACY)
      if (path === '/api/chat/sessions/new') return env(SESSION_ROW)
      if (method === 'POST' && path === '/api/chat/sessions/5/abort') return env({ aborted: 0 })
      throw new Error(`unexpected ${method} ${path}`)
    })
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    await runtime.newSession({ emailId: 1, backendKind: 'custom-api' }) // 建 engine
    const abortCalls = (): number =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/abort')).length
    runtime.abort(-1)
    runtime.abort(Number.NaN)
    await Promise.resolve()
    expect(abortCalls()).toBe(0) // 非法 id 不 fetch（LOW-1 guard）
    runtime.abort(5)
    await vi.waitFor(() => expect(abortCalls()).toBe(1), { timeout: 5000 }) // 合法 id 触发
  })
})

// ── dispatcher 失败 → Error&{code} 归一化（MEDIUM-1）─────────────────────────

describe('ChatRuntime — start/editMessage 错误归一化', () => {
  test('editMessage session 不存在 → 保留 dispatcher 的 E_NOT_FOUND', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url).split('?')[0]
      if (path === '/api/chat/config') return env(CONFIG_LEGACY)
      if (path === '/api/chat/sessions/77') return env(null) // getSession → null
      throw new Error(`unexpected ${String(url)}`)
    })
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    await expect(
      runtime.editMessage({
        sessionId: 77,
        editingMessageId: 1,
        newContent: 'x',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      })
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  test('start stale sessionId（不存在）→ 无 code dispatcher 错误归一化 E_DISPATCH', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url).split('?')[0]
      if (path === '/api/chat/config') return env(CONFIG_LEGACY)
      if (path === '/api/chat/sessions/88') return env(null) // getSession → null（dispatcher throw 无 code）
      throw new Error(`unexpected ${String(url)}`)
    })
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    await expect(
      runtime.start({
        emailId: 1,
        message: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null,
        sessionId: 88
      })
    ).rejects.toMatchObject({ code: 'E_DISPATCH' })
  })

  test('start 非法 emailId → E_INVALID_ARG（前置校验，不触发 engine/fetch）', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    await expect(
      runtime.start({
        emailId: -1,
        message: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('start 空 message → E_INVALID_ARG', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    await expect(
      runtime.start({
        emailId: 1,
        message: '',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
  })

  test('editMessage 空 newContent → E_INVALID_ARG', async () => {
    const runtime = createChatRuntime({ reads: makeReads(), baseUrl: '/api' })
    await expect(
      runtime.editMessage({
        sessionId: 1,
        editingMessageId: 2,
        newContent: '',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
