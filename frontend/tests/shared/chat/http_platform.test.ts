// @vitest-environment node
//
// V2.1 阶段 3 — 3b-5：HttpChatPlatform mock-fetch 单测。
//
// HttpChatPlatform 是 chat 引擎的远程实现（fetch serve-api），3b-5 仅 mock-fetch 测
// （不接 renderer，生产单 writer，electron 路径继续零回归）。覆盖：
//   - persist 12 法的端点 + body 形状（镜像 chat_db 写 → 3b-3 端点）
//   - streamContent debounce（~1/s 合并 PATCH）+ finalizeMessage flush 先于终态 + abort 清 pending
//   - llmFetch protocol（成功 passthrough / E_NO_LLM_KEY throw / 上游 status 返回 Response）
//   - notionAgentStream SSE 解析（data: {ChatStreamEvent} 行 / pre-stream error / abort 静默）
//   - 工具板 8 读委托 httpApi + searchAttachments 裸 fetch + flag/draftReply/kos
//   - config 快照（resolveConfig/modelConfig/kosConfig 默认 + 覆盖）
//   - createBuiltinTools 集成（kosConfigured 决定工具数）+ createHttpNotionAgentBackend
//
// fetch 全 mock：envelope 端点用真 Response（http_client.request 解析）；SSE/llmFetch 用
// 手构造 fake Response（完全控制 body reader 分块 + clone）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createHttpNotionAgentBackend } from '@shared/chat/backends/notion_agent_http'
import {
  DEFAULT_HTTP_CONFIG,
  HttpChatPlatform,
  STREAM_DEBOUNCE_MS
} from '@shared/chat/http_platform'
import { createBuiltinTools } from '@shared/chat/tools/builtin'
import type { MailApi } from '@shared/api/types'
import type { ChatMessage } from '@shared/chat/model'
import type { ChatStreamEvent } from '@shared/chat/types'

// ── helpers ──────────────────────────────────────────────────────────────

/** 成功 envelope 真 Response（node global；http_client.request 调 .text() 解析）。 */
function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** fake streaming Response：body.getReader() 按序 yield 预设 chunk（不依赖 ReadableStream
 *  实现，完全控制 SSE 分块 —— 跨 \n\n 边界 / 一 chunk 多事件）。 */
function sseStreamResponse(
  chunks: string[],
  opts: { ok?: boolean; status?: number } = {}
): Response {
  const encoder = new TextEncoder()
  let i = 0
  const reader = {
    read: async () =>
      i < chunks.length
        ? { done: false, value: encoder.encode(chunks[i++]) }
        : { done: true, value: undefined },
    releaseLock: () => {}
  }
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: { getReader: () => reader }
  } as unknown as Response
}

/** 假 MailApi（仅 email.* + attachment.list，工具板委托用；其余成员 cast 省略）。 */
function makeHttpApi(): MailApi {
  return {
    email: {
      list: vi.fn().mockResolvedValue([{ internal_id: 1 }]),
      get: vi.fn().mockResolvedValue({
        internal_id: 1,
        subject: 'S',
        sender: 'a@b.c',
        sender_name: 'A',
        date_received: '2026-01-01',
        notion_page_id: 'pg'
      }),
      body: vi.fn().mockResolvedValue({
        internal_id: 1,
        content: 'BODY',
        size_bytes: 4,
        format: 'markdown'
      }),
      aiFields: vi.fn().mockResolvedValue({ internal_id: 1 }),
      listByThread: vi.fn().mockResolvedValue([{ internal_id: 2 }]),
      search: vi.fn().mockResolvedValue({ items: [], total_indexed: 0 }),
      flag: vi.fn().mockResolvedValue({ updated_ids: [1] })
    },
    attachment: {
      list: vi.fn().mockResolvedValue([{ id: 7 }])
    }
  } as unknown as MailApi
}

function minimalMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    session_id: 1,
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

/** 收集 async generator 全部事件。 */
async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── persist 端点 + body 形状（镜像 chat_db 写 → 3b-3）─────────────────────────

describe('HttpChatPlatform.persist — 端点 + body 形状', () => {
  test('getOrCreateSession → POST /chat/sessions（body=OpenSessionInput）', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ id: 5, email_id: 1, backend_kind: 'custom-api' })
    )
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const sess = await p.persist.getOrCreateSession({ emailId: 1, backendKind: 'custom-api' })
    expect(sess.id).toBe(5)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/sessions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ emailId: 1, backendKind: 'custom-api' })
    expect(init.credentials).toBe('include')
  })

  test('createNewSession → POST /chat/sessions/new', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ id: 6, email_id: 1, backend_kind: 'custom-api' })
    )
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await p.persist.createNewSession({ emailId: 1, backendKind: 'custom-api' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/sessions/new')
  })

  test('getSession → GET /chat/sessions/{id}（null 透传不 404）', async () => {
    fetchMock.mockResolvedValue(envelopeResponse(null))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const s = await p.persist.getSession(42)
    expect(s).toBeNull()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/sessions/42')
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })

  test('getMessage → GET /chat/messages/{id}', async () => {
    fetchMock.mockResolvedValue(envelopeResponse(minimalMessage({ id: 9 })))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const m = await p.persist.getMessage(9)
    expect(m?.id).toBe(9)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/messages/9')
  })

  test('listLastNMessages → GET 全量 + 客户端 slice(-limit)', async () => {
    const all = [1, 2, 3, 4, 5].map((id) => minimalMessage({ id }))
    fetchMock.mockResolvedValue(envelopeResponse(all))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const last2 = await p.persist.listLastNMessages(1, 2)
    expect(last2.map((m) => m.id)).toEqual([4, 5])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/sessions/1/messages')
  })

  test('listLastNMessages limit≥total → 返回全部', async () => {
    const all = [1, 2].map((id) => minimalMessage({ id }))
    fetchMock.mockResolvedValue(envelopeResponse(all))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    expect((await p.persist.listLastNMessages(1, 20)).map((m) => m.id)).toEqual([1, 2])
  })

  test('appendMessage → POST /chat/sessions/{id}/messages（body 去 sessionId）', async () => {
    fetchMock.mockResolvedValue(envelopeResponse(minimalMessage({ id: 11, role: 'assistant' })))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const m = await p.persist.appendMessage({
      sessionId: 3,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: 'claude-sonnet-4-6'
    })
    expect(m.id).toBe(11)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/sessions/3/messages')
    const body = JSON.parse(init.body)
    expect(body).not.toHaveProperty('sessionId')
    expect(body).toMatchObject({
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: 'claude-sonnet-4-6'
    })
  })

  test('deleteMessagesFromId → DELETE …/from/{id}（{deleted}→number）', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ deleted: 3 }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const n = await p.persist.deleteMessagesFromId(2, 10)
    expect(n).toBe(3)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/sessions/2/messages/from/10')
    expect(init.method).toBe('DELETE')
  })

  test('abortStreamingMessages → POST …/abort（{aborted}→number）', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ aborted: 1 }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const n = await p.persist.abortStreamingMessages(7)
    expect(n).toBe(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/sessions/7/abort')
  })

  test('appendToolCall → POST /chat/messages/{id}/tool-calls（返回 {id}）', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ id: 88, message_id: 5, tool_use_id: 'toolu_x', tool_name: 'email_get' })
    )
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const r = await p.persist.appendToolCall({
      messageId: 5,
      toolUseId: 'toolu_x',
      toolName: 'email_get',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'running'
    })
    expect(r).toEqual({ id: 88 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/messages/5/tool-calls')
    expect(JSON.parse(init.body)).not.toHaveProperty('messageId')
  })

  test('updateToolCall → PATCH /chat/tool-calls/{id}', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ok: true }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await p.persist.updateToolCall(88, { status: 'ok', outputJson: '{"x":1}' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/tool-calls/88')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ status: 'ok', outputJson: '{"x":1}' })
  })

  test('getToolCallByUseId → GET（命中 {id} / 未命中 null）', async () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    fetchMock.mockResolvedValueOnce(
      envelopeResponse({ id: 88, message_id: 5, tool_use_id: 'toolu_x' })
    )
    expect(await p.persist.getToolCallByUseId(5, 'toolu_x')).toEqual({ id: 88 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/messages/5/tool-calls/toolu_x')
    fetchMock.mockResolvedValueOnce(envelopeResponse(null))
    expect(await p.persist.getToolCallByUseId(5, 'nope')).toBeNull()
  })
})

// ── streamContent debounce ─────────────────────────────────────────────────

describe('HttpChatPlatform.persist.streamContent — debounce（~1/s 合并 PATCH）', () => {
  test('流式期间多次 streamContent → 1 次 PATCH（最新全量覆盖）', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(envelopeResponse({ ok: true }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    p.persist.streamContent(10, 'a')
    p.persist.streamContent(10, 'ab')
    p.persist.streamContent(10, 'abc')
    expect(fetchMock).not.toHaveBeenCalled() // 未到窗口，不发
    await vi.advanceTimersByTimeAsync(STREAM_DEBOUNCE_MS)
    const patches = fetchMock.mock.calls.filter((c) => c[1].method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).toBe('/api/chat/messages/10/stream')
    expect(JSON.parse(patches[0][1].body)).toEqual({ content: 'abc' })
  })

  test('连续两窗口 → 两次 PATCH（trailing throttle，非单次 debounce）', async () => {
    vi.useFakeTimers()
    // 两次 fetch（两窗各一次 flush）→ 每次新建 Response（body 一次性）。
    fetchMock.mockImplementation(async () => envelopeResponse({ ok: true }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    p.persist.streamContent(10, 'a')
    await vi.advanceTimersByTimeAsync(STREAM_DEBOUNCE_MS) // 第一窗 fire → 'a'
    p.persist.streamContent(10, 'ab')
    await vi.advanceTimersByTimeAsync(STREAM_DEBOUNCE_MS) // 第二窗 fire → 'ab'
    const bodies = fetchMock.mock.calls
      .filter((c) => c[1].method === 'PATCH')
      .map((c) => JSON.parse(c[1].body).content)
    expect(bodies).toEqual(['a', 'ab'])
  })

  test('PATCH /stream 失败 → console.warn 不抛（终态 content=buffer 双保险）', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValue(new Error('network down')) // request() → E_NETWORK
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    p.persist.streamContent(10, 'a')
    await expect(vi.advanceTimersByTimeAsync(STREAM_DEBOUNCE_MS)).resolves.not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('HttpChatPlatform.persist.finalizeMessage — flush 先于终态', () => {
  test('有待发增量 → 先 PATCH /stream 再 PATCH /messages/{id}（顺序）', async () => {
    vi.useFakeTimers()
    // 多次 fetch（flush + 终态）→ 每次新建 Response（body 一次性，复用会读到空 body）。
    fetchMock.mockImplementation(async () => envelopeResponse({ ok: true }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    p.persist.streamContent(10, 'partial') // arm timer，未 fire
    await p.persist.finalizeMessage(10, { status: 'complete', content: 'partial' })
    const seq = fetchMock.mock.calls.map((c) => [c[0], c[1].method])
    expect(seq).toEqual([
      ['/api/chat/messages/10/stream', 'PATCH'],
      ['/api/chat/messages/10', 'PATCH']
    ])
    // timer 已清：advance 不再补发 PATCH（防晚到 stream 覆盖终态）
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(STREAM_DEBOUNCE_MS * 2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('无待发增量 → 只写终态', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ok: true }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await p.persist.finalizeMessage(10, { status: 'error', content: 'x', errorMessage: 'boom' })
    expect(fetchMock.mock.calls).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/messages/10')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      status: 'error',
      content: 'x',
      errorMessage: 'boom'
    })
  })

  test('空增量（latest=""）→ 跳过 flush，只写终态', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ok: true }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    p.persist.streamContent(10, '') // latest='' → finalize 不 flush
    await p.persist.finalizeMessage(10, { status: 'complete', content: '' })
    const streamPatches = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/stream'))
    expect(streamPatches).toHaveLength(0)
  })

  test('abortStreamingMessages 清 pending timer（不 flush 增量）', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(envelopeResponse({ aborted: 1 }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    p.persist.streamContent(10, 'partial') // arm
    await p.persist.abortStreamingMessages(7)
    const streamPatches = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/stream'))
    expect(streamPatches).toHaveLength(0)
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(STREAM_DEBOUNCE_MS * 2)
    expect(fetchMock).not.toHaveBeenCalled() // timer 已清，无泄漏
  })
})

// ── 模型板：llmFetch protocol ───────────────────────────────────────────────

describe('HttpChatPlatform.llmFetch — POST /chat/llm-proxy', () => {
  test('成功（resp.ok）→ 原样返回 Response + body={protocol,body} + signal 透传', async () => {
    const fakeResp = { ok: true, status: 200 } as Response
    fetchMock.mockResolvedValue(fakeResp)
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const ac = new AbortController()
    const resp = await p.llmFetch({
      protocol: 'anthropic',
      body: { model: 'claude-sonnet-4-6', stream: true },
      signal: ac.signal
    })
    expect(resp).toBe(fakeResp)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/llm-proxy')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      protocol: 'anthropic',
      body: { model: 'claude-sonnet-4-6', stream: true }
    })
    expect(init.signal).toBe(ac.signal)
    expect(init.credentials).toBe('include')
  })

  test('E_NO_LLM_KEY envelope（HTTP 500）→ throw Error&{code}', async () => {
    const fakeResp = {
      ok: false,
      status: 500,
      clone: () => ({
        json: async () => ({ status: 'error', error: { code: 'E_NO_LLM_KEY' } })
      })
    } as unknown as Response
    fetchMock.mockResolvedValue(fakeResp)
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await expect(
      p.llmFetch({ protocol: 'anthropic', body: {}, signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'E_NO_LLM_KEY' })
  })

  test('上游透传 429（空 body）→ 原样返回 Response（custom_api 读 status 分类 E_QUOTA）', async () => {
    const fakeResp = {
      ok: false,
      status: 429,
      clone: () => ({
        json: async () => {
          throw new Error('empty body')
        }
      })
    } as unknown as Response
    fetchMock.mockResolvedValue(fakeResp)
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const resp = await p.llmFetch({
      protocol: 'openai',
      body: {},
      signal: new AbortController().signal
    })
    expect(resp).toBe(fakeResp)
  })

  test('上游透传 502 + 非 E_NO_LLM_KEY envelope → 原样返回 Response（不误 throw）', async () => {
    const fakeResp = {
      ok: false,
      status: 502,
      clone: () => ({ json: async () => ({ status: 'error', error: { code: 'E_UPSTREAM' } }) })
    } as unknown as Response
    fetchMock.mockResolvedValue(fakeResp)
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const resp = await p.llmFetch({
      protocol: 'anthropic',
      body: {},
      signal: new AbortController().signal
    })
    expect(resp).toBe(fakeResp)
  })
})

// ── 模型板②：notionAgentStream SSE 解析 ─────────────────────────────────────

describe('HttpChatPlatform.notionAgentStream — SSE 解析', () => {
  test('解析 tool_call/chunk/done 事件 + body 去 signal/tools/iterHistory', async () => {
    const chunks = [
      'data: {"type":"tool_call","name":"notion-agent chat","args":{},"status":"running"}\n\n',
      'data: {"type":"chunk","delta":"Hello"}\n\n',
      // 一 chunk 含两事件（含跨边界 'done'）
      'data: {"type":"chunk","delta":" world"}\n\ndata: {"type":"done","finalContent":"Hello world","model":null}\n\n'
    ]
    fetchMock.mockResolvedValue(sseStreamResponse(chunks))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const ac = new AbortController()
    const events = await collect(
      p.notionAgentStream({
        history: [minimalMessage({ content: 'q' })],
        model: null,
        agentPageId: null,
        emailContext: null,
        signal: ac.signal,
        tools: [{ name: 'x', description: 'd', input_schema: {} }]
      })
    )
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'chunk', 'chunk', 'done'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/notion-agent')
    const body = JSON.parse(init.body)
    expect(body).toEqual({
      history: [minimalMessage({ content: 'q' })],
      model: null,
      agentPageId: null,
      emailContext: null
    })
    expect(body).not.toHaveProperty('signal')
    expect(body).not.toHaveProperty('tools')
  })

  test('SSE 跨 read() 边界（半个事件分两 chunk）正确重组', async () => {
    const chunks = ['data: {"type":"chunk","del', 'ta":"hi"}\n\n']
    fetchMock.mockResolvedValue(sseStreamResponse(chunks))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const events = await collect(
      p.notionAgentStream({
        history: [],
        model: null,
        agentPageId: null,
        emailContext: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([{ type: 'chunk', delta: 'hi' }])
  })

  test('pre-stream 错误（!ok envelope）→ yield error（code/message 透传）', async () => {
    const fakeResp = {
      ok: false,
      status: 400,
      body: null,
      json: async () => ({ status: 'error', error: { code: 'E_INVALID_ARG', message: 'bad' } })
    } as unknown as Response
    fetchMock.mockResolvedValue(fakeResp)
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const events = await collect(
      p.notionAgentStream({
        history: [],
        model: null,
        agentPageId: null,
        emailContext: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([{ type: 'error', code: 'E_INVALID_ARG', message: 'bad' }])
  })

  test('已 abort（fetch reject + signal.aborted）→ 静默退出无事件', async () => {
    const ac = new AbortController()
    ac.abort()
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const events = await collect(
      p.notionAgentStream({
        history: [],
        model: null,
        agentPageId: null,
        emailContext: null,
        signal: ac.signal
      })
    )
    expect(events).toEqual([])
  })

  test('fetch 失败（非 abort）→ yield E_NETWORK error', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const events = await collect(
      p.notionAgentStream({
        history: [],
        model: null,
        agentPageId: null,
        emailContext: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'E_NETWORK' })
  })
})

// ── 基础设施板：loadEmailContext ────────────────────────────────────────────

describe('HttpChatPlatform.loadEmailContext — /email/{id} + /body 投影', () => {
  test('拼元数据 + markdown 正文，ai 字段 degrade null', async () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const ctx = await p.loadEmailContext(1)
    expect(ctx).toEqual({
      internalId: 1,
      subject: 'S',
      senderName: 'A',
      senderAddr: 'a@b.c',
      dateIso: '2026-01-01',
      bodyMarkdown: 'BODY',
      notionPageId: 'pg',
      aiPriority: null,
      aiAction: null,
      processingStatus: null
    })
  })

  test('email 缺失（get→null）→ 返回 null', async () => {
    const api = makeHttpApi()
    ;(api.email.get as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const p = new HttpChatPlatform(api, '/api')
    expect(await p.loadEmailContext(99)).toBeNull()
  })

  test('正文取不到（body reject）不致命 → bodyMarkdown null + 元数据仍在', async () => {
    const api = makeHttpApi()
    ;(api.email.body as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no body'))
    const p = new HttpChatPlatform(api, '/api')
    const ctx = await p.loadEmailContext(1)
    expect(ctx?.bodyMarkdown).toBeNull()
    expect(ctx?.subject).toBe('S')
  })

  test('get 抛（serve-api 不可达）→ 返回 null（chat 仍可跑）', async () => {
    const api = makeHttpApi()
    ;(api.email.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('502'))
    const p = new HttpChatPlatform(api, '/api')
    expect(await p.loadEmailContext(1)).toBeNull()
  })
})

// ── 工具板：读委托 + 写 + KOS ───────────────────────────────────────────────

describe('HttpChatPlatform tool board — 委托 httpApi + 端点', () => {
  test('8 读委托 httpApi.email.* / attachment.list', async () => {
    const api = makeHttpApi()
    const p = new HttpChatPlatform(api, '/api')
    expect(await p.listEmails({ subject: 'x', limit: 10 })).toEqual([{ internal_id: 1 }])
    expect(api.email.list).toHaveBeenCalledWith({ subject: 'x', limit: 10 })

    await p.getEmail(1)
    expect(api.email.get).toHaveBeenCalledWith(1)

    await p.getEmailBody(1)
    expect(api.email.body).toHaveBeenCalledWith(1, { format: 'markdown' })

    await p.getAiFields(1)
    expect(api.email.aiFields).toHaveBeenCalledWith(1)

    await p.listEmailsByThread('t1')
    expect(api.email.listByThread).toHaveBeenCalledWith('t1')

    await p.searchEmailsFulltext({ query: 'redis', limit: 20 })
    expect(api.email.search).toHaveBeenCalledWith({ query: 'redis', limit: 20 })

    expect(await p.listAttachments(1)).toEqual([{ id: 7 }])
    expect(api.attachment.list).toHaveBeenCalledWith(1)
  })

  test('searchAttachments → GET /attachment/search（q/mailbox/since/until/limit）', async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ hits: [] }))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await p.searchAttachments({
      query: 'redis',
      mailbox: 'Inbox',
      since: '2026-01-01',
      until: '2026-02-01',
      limit: 5
    })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url.startsWith('/api/attachment/search?')).toBe(true)
    expect(url).toContain('q=redis')
    expect(url).toContain('mailbox=Inbox')
    expect(url).toContain('since=2026-01-01')
    expect(url).toContain('limit=5')
  })

  test('flagEmail 委托 httpApi.email.flag', async () => {
    const api = makeHttpApi()
    const p = new HttpChatPlatform(api, '/api')
    const r = await p.flagEmail(1, { isFlagged: true })
    expect(api.email.flag).toHaveBeenCalledWith(1, { isFlagged: true })
    expect(r).toEqual({ updated_ids: [1] })
  })

  test('draftReply → reject E_NOT_IMPLEMENTED（host-local，远程推迟）', async () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await expect(p.draftReply(1, 'body')).rejects.toMatchObject({ code: 'E_NOT_IMPLEMENTED' })
  })

  test('kosCallTool → POST /chat/kos-call {name,args}', async () => {
    fetchMock.mockResolvedValue(envelopeResponse([{ slug: 'people/bob', score: 0.9 }]))
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const out = await p.kosCallTool('query', { query: 'bob', limit: 10 })
    expect(out).toEqual([{ slug: 'people/bob', score: 0.9 }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/kos-call')
    expect(JSON.parse(init.body)).toEqual({ name: 'query', args: { query: 'bob', limit: 10 } })
  })

  test('kosCallTool 502 envelope（E_KOS_*）→ throw ApiError{code}（工具 duck-type fallback）', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'error', error: { code: 'E_KOS_UNREACHABLE', message: 'down' } }),
        {
          status: 502,
          headers: { 'content-type': 'application/json' }
        }
      )
    )
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    await expect(p.kosCallTool('query', {})).rejects.toMatchObject({ code: 'E_KOS_UNREACHABLE' })
  })

  test('saveToKos → POST /chat/save-to-kos（返回 {slug,status,contentBytes}）', async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ slug: 'chat-history/x', status: 'created', contentBytes: 512 })
    )
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const r = await p.saveToKos({ messageId: 9 })
    expect(r).toEqual({ slug: 'chat-history/x', status: 'created', contentBytes: 512 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat/save-to-kos')
    expect(JSON.parse(init.body)).toEqual({ messageId: 9 })
  })
})

// ── config 快照 ─────────────────────────────────────────────────────────────

describe('HttpChatPlatform config 快照', () => {
  test('默认快照对齐 electron chat/config.ts 默认', async () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    expect(await p.resolveConfig()).toEqual({
      maxIter: 8,
      maxCostUsd: 0.5,
      kosL1HotBlockEnabled: false,
      harnessEnabled: true
    })
    expect(p.modelConfig()).toEqual({
      defaultModel: 'claude-sonnet-4-6',
      kosConsumerEnabled: false,
      kosL1HotBlockEnabled: false,
      userContext: null
    })
    expect(p.kosConfig()).toEqual({ configured: false, timeDecayEnabled: true })
  })

  test('config 部分覆盖（kosConfigured 真实值），未覆盖字段保留默认', async () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api', {
      kosConfigured: true,
      harnessEnabled: false,
      maxIter: 3
    })
    expect(p.kosConfig().configured).toBe(true)
    expect(p.kosConfig().timeDecayEnabled).toBe(true) // 未覆盖 → 默认
    const cfg = await p.resolveConfig()
    expect(cfg.harnessEnabled).toBe(false)
    expect(cfg.maxIter).toBe(3)
    expect(cfg.maxCostUsd).toBe(0.5) // 未覆盖 → 默认
  })

  test('DEFAULT_HTTP_CONFIG 导出可供 3c 组装快照基线', () => {
    expect(DEFAULT_HTTP_CONFIG.harnessEnabled).toBe(true)
    expect(DEFAULT_HTTP_CONFIG.kosConfigured).toBe(false)
  })

  test('getCachedSenderDigest → null / prefetchSenderDigest → no-op（L1 OFF）', () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    expect(p.getCachedSenderDigest('a@b.c')).toBeNull()
    expect(() => p.prefetchSenderDigest('a@b.c')).not.toThrow()
  })
})

// ── createBuiltinTools 集成 + createHttpNotionAgentBackend ───────────────────

describe('HttpChatPlatform 工具板满足 createBuiltinTools', () => {
  test('kosConfigured=false → 11 工具（无 KOS）', () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    expect(createBuiltinTools(p).length).toBe(11)
  })

  test('kosConfigured=true → 20 工具（+9 KOS）', () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api', { kosConfigured: true })
    expect(createBuiltinTools(p).length).toBe(20)
  })
})

describe('createHttpNotionAgentBackend', () => {
  test('kind=notion-agent + stream 委托 notionAgentStream', async () => {
    const p = new HttpChatPlatform(makeHttpApi(), '/api')
    const backend = createHttpNotionAgentBackend(p)
    expect(backend.kind).toBe('notion-agent')
    fetchMock.mockResolvedValue(
      sseStreamResponse(['data: {"type":"done","finalContent":"hi","model":null}\n\n'])
    )
    const events = await collect(
      backend.stream({
        history: [],
        model: null,
        agentPageId: null,
        emailContext: null,
        signal: new AbortController().signal
      })
    )
    expect(events).toEqual([{ type: 'done', finalContent: 'hi', model: null }])
  })
})
