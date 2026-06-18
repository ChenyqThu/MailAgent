// @vitest-environment node
//
// F2 — headless agentic 搜索引擎 runSearchAgent 单测。
//
// 覆盖（设计 §3.2 / impl-plan F2 验收）：
//   - 正常路：backend emit tool_use(email_search_fulltext)→harness 跑真工具(reads.email.search
//     返 [#1,#2,#3])→tool_result 入候选池→backend emit tool_use(present_results, ids:[2,3,999])
//     → 断言 hits==[#2,#3]（999 被丢=防幻觉）、summary 提取、abort 触发。
//   - fallback：backend 直接 done 无 present_results → 断言调了 reads.email.nlToDsl、返 fallbackDsl。
//   - 无 key：nlToDsl 返 E_NO_LLM_KEY → 断言 error.code==='E_NO_LLM_KEY'。
//   - E_UNSUPPORTED：searchAgent:false 的 runtime.runSearchAgent。
//   - 永不 throw：backend 抛异常 → 返 ok:false（harness 内 catch → error 事件 → fallback）。
//
// backend 经 vi.mock('createCustomApiBackend') 注入假 ChatBackend（精确控制 stream 事件，
// 不走真 SSE）。reads 注入 fake MailApi（email.search / nlToDsl / report.getConfig / settings.get）。
// fetch 全 mock（runSearchAgent 内 HttpChatPlatform 构造不触网 —— 工具读全经 reads，无 fetch）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { MailApi, SearchHit } from '@shared/api/types'
import type { ChatBackend, ChatStreamEvent, ChatStreamRequest } from '@shared/chat/types'

// ── 假 backend 注入 ─────────────────────────────────────────────────────────
//
// 每次 backend.stream() 调用 = harness 一次迭代。fakeBackendScript 是「每迭代 yield
// 的事件数组」列表；第 N 次 stream() yield 第 N 组。abort 后 harness 不再调 stream。

let backendScript: ChatStreamEvent[][] = []
let backendThrows = false
let streamCallCount = 0
// 每次 backend.stream(req) 被调时回调（测试用来截获 harness 传入的 request）。
let streamRequestSpy: ((req: ChatStreamRequest) => void) | null = null

vi.mock('@shared/chat/backends/custom_api', () => ({
  createCustomApiBackend: (): ChatBackend => ({
    kind: 'custom-api',
    stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      streamRequestSpy?.(req)
      const iter = streamCallCount++
      async function* gen(): AsyncGenerator<ChatStreamEvent> {
        if (backendThrows) throw new Error('boom backend exploded')
        const events = backendScript[iter] ?? [
          { type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }
        ]
        for (const e of events) yield e
      }
      return gen()
    }
  })
}))

// import 在 mock 之后（vi.mock hoist 保证 mock 先于实际 import 生效）。
import { runSearchAgent, type SearchAgentDeps } from '@shared/chat/search_agent'
import { createChatRuntime } from '@shared/chat/runtime'

// ── helpers ─────────────────────────────────────────────────────────────────

function hit(internal_id: number, subject: string): SearchHit {
  return {
    internal_id,
    subject,
    sender: `s${internal_id}@x.com`,
    date_received: '2026-06-01',
    mailbox: '收件箱',
    rank: -internal_id,
    snippet: `snip ${internal_id}`
  } as SearchHit
}

interface MakeReadsOpts {
  searchItems?: SearchHit[]
  nlToDsl?: () => Promise<{ dsl: string; error?: string; message?: string }>
  reportConfig?: () => Promise<unknown[]>
}

function makeReads(opts: MakeReadsOpts = {}): {
  reads: MailApi
  searchSpy: ReturnType<typeof vi.fn>
  nlSpy: ReturnType<typeof vi.fn>
} {
  const searchSpy = vi.fn().mockResolvedValue({
    items: opts.searchItems ?? [],
    total_indexed: 100
  })
  const nlSpy = vi.fn(opts.nlToDsl ?? (async () => ({ dsl: 'from:alice' })))
  const reads = {
    email: {
      search: searchSpy,
      nlToDsl: nlSpy,
      get: vi.fn().mockResolvedValue(null),
      body: vi.fn().mockResolvedValue(null)
    },
    attachment: { list: vi.fn().mockResolvedValue([]) },
    settings: {
      get: vi.fn().mockResolvedValue({ userEmail: 'me@x.com' })
    },
    report: {
      getConfig: vi.fn(opts.reportConfig ?? (async () => []))
    }
  } as unknown as MailApi
  return { reads, searchSpy, nlSpy }
}

function makeDeps(reads: MailApi): SearchAgentDeps {
  return { reads, baseUrl: '/api' }
}

beforeEach(() => {
  backendScript = []
  backendThrows = false
  streamCallCount = 0
  streamRequestSpy = null
  // 任何意外的 fetch（不应发生 —— 工具读全经 reads）→ 立即失败暴露。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('unexpected fetch in search_agent test')
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── 正常路：候选池交集 + 防幻觉 + abort ──────────────────────────────────────

describe('runSearchAgent — 正常路（候选池 ∩ matched_internal_ids）', () => {
  test('hits=[#2,#3]（999 编造被丢），summary 提取，abort 触发', async () => {
    const { reads, searchSpy } = makeReads({ searchItems: [hit(1, 'A'), hit(2, 'B'), hit(3, 'C')] })

    // iter0：backend 提一个 email_search_fulltext tool_use；harness 跑真工具（searchSpy）
    //        → tool_result(items=[#1,#2,#3]) 入候选池。
    // iter1：backend 提 present_results（ids=[2,3,999]）→ sink 读 input + abort。
    backendScript = [
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_search_1',
          name: 'email_search_fulltext',
          input: { query: 'from:alice 报告' }
        },
        { type: 'done', finalContent: '', model: 'claude-sonnet-4-6', stopReason: 'tool_use' }
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_present_1',
          name: 'present_results',
          input: { matched_internal_ids: [2, 3, 999], summary: 'x' }
        },
        { type: 'done', finalContent: '', model: 'claude-sonnet-4-6', stopReason: 'tool_use' }
      ]
    ]

    const phases: string[] = []
    const res = await runSearchAgent(makeDeps(reads), {
      query: 'echo 这几天发我的关于新人培训的邮件',
      onPhase: (p) => phases.push(p)
    })

    expect(res.ok).toBe(true)
    expect(res.hits.map((h) => h.internal_id)).toEqual([2, 3])
    expect(res.summary).toBe('x')
    // 真工具被实际调用（候选池有来源）。
    expect(searchSpy).toHaveBeenCalledTimes(1)
    // present_results 出现后未再发起第 3 次 backend.stream（abort 生效）。
    expect(streamCallCount).toBe(2)
    // onPhase 顺序：searching（首个 search）→ summarizing（present_results）。
    expect(phases).toEqual(['searching', 'summarizing'])
  })

  test('matched_internal_ids 顺序决定 hits 顺序（保序）', async () => {
    const { reads } = makeReads({ searchItems: [hit(1, 'A'), hit(2, 'B'), hit(3, 'C')] })
    backendScript = [
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_s',
          name: 'email_search_fulltext',
          input: { query: 'q' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_p',
          name: 'present_results',
          input: { matched_internal_ids: [3, 1], summary: 's' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ]
    ]
    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })
    expect(res.ok).toBe(true)
    expect(res.hits.map((h) => h.internal_id)).toEqual([3, 1])
  })

  test('matched_internal_ids 非整数/浮点/null 被丢（Number.isInteger 过滤）', async () => {
    const { reads } = makeReads({ searchItems: [hit(1, 'A'), hit(2, 'B'), hit(3, 'C')] })
    backendScript = [
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_s',
          name: 'email_search_fulltext',
          input: { query: 'q' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_p',
          name: 'present_results',
          // 字符串 "3"、浮点 3.5、null 全被 Number.isInteger 丢；只留整数 2、1（保序）。
          input: { matched_internal_ids: [2, '3', 3.5, null, 1], summary: 'x' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ]
    ]
    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })
    expect(res.ok).toBe(true)
    expect(res.hits.map((h) => h.internal_id)).toEqual([2, 1])
  })

  test('summary >500 字符按 schema maxLength 截断到 500', async () => {
    const { reads } = makeReads({ searchItems: [hit(1, 'A')] })
    const longSummary = 'a'.repeat(800)
    backendScript = [
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_s',
          name: 'email_search_fulltext',
          input: { query: 'q' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_p',
          name: 'present_results',
          input: { matched_internal_ids: [1], summary: longSummary }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ]
    ]
    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })
    expect(res.ok).toBe(true)
    expect(res.summary?.length).toBe(500)
  })
})

// ── 预取消：入口 signal 已 aborted → E_ABORTED，不发 nlToDsl ──────────────────

describe('runSearchAgent — 预取消短路', () => {
  test('入口 signal 已 aborted → error.code===E_ABORTED 且未调用 nlToDsl', async () => {
    const { reads, nlSpy } = makeReads({ nlToDsl: async () => ({ dsl: 'from:x' }) })
    // backend 直接 done 无工具（aborted 信号下 harness 不应产出 present_results）。
    backendScript = [[{ type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }]]
    const controller = new AbortController()
    controller.abort()

    const res = await runSearchAgent(makeDeps(reads), { query: 'q', signal: controller.signal })

    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_ABORTED')
    expect(res.hits).toEqual([])
    // 预取消短路 → 不落 fallback，不发 nlToDsl。
    expect(nlSpy).not.toHaveBeenCalled()
  })
})

// ── input.mailbox 接进系统 prompt ────────────────────────────────────────────

describe('runSearchAgent — input.mailbox 透传 prompt', () => {
  test('input.mailbox 非空 → backend 收到的 request 含该 mailbox 文案', async () => {
    const { reads } = makeReads({ searchItems: [hit(1, 'A')] })
    let capturedRequest: string | undefined
    backendScript = [
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_s',
          name: 'email_search_fulltext',
          input: { query: 'q' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'tu_p',
          name: 'present_results',
          input: { matched_internal_ids: [1], summary: 'ok' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ]
    ]
    // 截首次 backend.stream 的 request：systemPrompt 进首条 user content（history 或
    // harness 翻译的 iterHistory），stringify 整 request 跨形态稳健断言。
    streamRequestSpy = (req) => {
      if (capturedRequest === undefined) {
        capturedRequest = JSON.stringify({ history: req.history, iterHistory: req.iterHistory })
      }
    }

    const res = await runSearchAgent(makeDeps(reads), { query: 'q', mailbox: '存档' })
    expect(res.ok).toBe(true)
    expect(capturedRequest).toContain('存档')
    expect(capturedRequest).toContain('限定在「存档」文件夹检索')
  })
})

// ── fallback：无 present_results → nlToDsl ────────────────────────────────────

describe('runSearchAgent — fallback（agent 无 present_results）', () => {
  test('backend 直接 done → 调 nlToDsl、返 fallbackDsl + E_NO_OUTPUT', async () => {
    const { reads, nlSpy } = makeReads({ nlToDsl: async () => ({ dsl: 'from:bob is:unread' }) })
    backendScript = [
      [{ type: 'done', finalContent: 'done no tools', model: null, stopReason: 'end_turn' }]
    ]

    const res = await runSearchAgent(makeDeps(reads), { query: 'bob 未读' })

    expect(res.ok).toBe(false)
    expect(nlSpy).toHaveBeenCalledTimes(1)
    expect(res.fallbackDsl).toBe('from:bob is:unread')
    expect(res.error?.code).toBe('E_NO_OUTPUT')
    expect(res.hits).toEqual([])
  })

  test('无 key：nlToDsl 返 E_NO_LLM_KEY → error.code===E_NO_LLM_KEY，无 fallbackDsl', async () => {
    const { reads } = makeReads({
      nlToDsl: async () => ({ dsl: '', error: 'E_NO_LLM_KEY', message: 'no key' })
    })
    backendScript = [[{ type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }]]

    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })

    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_NO_LLM_KEY')
    expect(res.fallbackDsl).toBeUndefined()
  })

  test('harness error 事件（如 E_QUOTA）优先于 nlToDsl 错误透传', async () => {
    const { reads } = makeReads({ nlToDsl: async () => ({ dsl: 'from:x' }) })
    backendScript = [[{ type: 'error', code: 'E_QUOTA', message: 'quota exceeded' }]]

    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })

    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_QUOTA')
    // nlToDsl 仍给了 dsl → 附 fallbackDsl 供前端降级。
    expect(res.fallbackDsl).toBe('from:x')
  })
})

// ── 永不 throw ───────────────────────────────────────────────────────────────

describe('runSearchAgent — 永不 throw', () => {
  test('backend 抛异常 → 返 ok:false 而非 reject', async () => {
    const { reads } = makeReads({ nlToDsl: async () => ({ dsl: 'from:y' }) })
    backendThrows = true

    // 不应 reject —— resolve 成 ok:false。
    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })
    expect(res.ok).toBe(false)
    // harness catch backend throw → emit E_BACKEND_CRASH error 事件 → fallback 透传。
    expect(res.error?.code).toBe('E_BACKEND_CRASH')
  })

  test('createChatRuntime({searchAgent:false}).runSearchAgent → E_UNSUPPORTED（远程 web scope 外）', async () => {
    const { reads } = makeReads()
    // searchAgent 未传（= false）→ 远程 web；runSearchAgent 早返 E_UNSUPPORTED，不触
    // backend/fetch（甚至不预取 /chat/config）。
    const runtime = createChatRuntime({ reads, baseUrl: '/api' })
    const res = await runtime.runSearchAgent({ query: 'q' })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_UNSUPPORTED')
    expect(res.hits).toEqual([])
    // 未发起任何 backend 迭代。
    expect(streamCallCount).toBe(0)
  })

  test('reads.report.getConfig 抛错不致命（用内置默认 prompt 继续）', async () => {
    const { reads } = makeReads({
      searchItems: [hit(1, 'A')],
      reportConfig: async () => {
        throw new Error('report config endpoint down')
      }
    })
    backendScript = [
      [
        { type: 'tool_use', toolUseId: 'ts', name: 'email_search_fulltext', input: { query: 'q' } },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'tp',
          name: 'present_results',
          input: { matched_internal_ids: [1], summary: 'ok' }
        },
        { type: 'done', finalContent: '', model: null, stopReason: 'tool_use' }
      ]
    ]
    const res = await runSearchAgent(makeDeps(reads), { query: 'q' })
    expect(res.ok).toBe(true)
    expect(res.hits.map((h) => h.internal_id)).toEqual([1])
  })
})
