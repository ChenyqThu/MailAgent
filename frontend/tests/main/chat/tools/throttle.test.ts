// Sprint 19 M1 polish #2 — per-tool throttle tests.
//
// Verify the sliding-window rate limiter in dispatch.ts:
//   - default 30/min for tools without throttlePerMinute
//   - explicit throttlePerMinute honored
//   - throttled call surfaces as E_THROTTLED tool_result (not exception)
//   - per-(session, tool) isolation (one session hitting limit doesn't
//     block another)
//   - reset seam works

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  dispatchTools,
  __resetThrottleForTests,
  type DispatchContext,
  type ToolUseRequest
} from '../../../../src/shared/chat/tools/dispatch'
import {
  createToolRegistry,
  type ToolDef,
  type ToolResult
} from '../../../../src/shared/chat/tools/registry'

beforeEach(() => {
  __resetThrottleForTests()
})

afterEach(() => {
  __resetThrottleForTests()
})

function makeReadTool(name: string, throttle?: number): ToolDef {
  return {
    name,
    description: 'silent read tool for throttle tests',
    inputSchema: { type: 'object', properties: {}, required: [] },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    timeoutMs: 5000,
    throttlePerMinute: throttle,
    handler: async (): Promise<ToolResult> => ({
      ok: true,
      output: { x: 1 },
      durationMs: 1
    })
  }
}

function makeDispatchCtx(sessionId: number = 1): DispatchContext {
  return {
    sessionId,
    emailId: null,
    signal: new AbortController().signal
  }
}

function makeUseRequest(toolName: string, idSeed: number): ToolUseRequest {
  return {
    toolUseId: `toolu_${idSeed}`,
    name: toolName,
    input: {}
  }
}

describe('per-tool throttle (M1 polish #2)', () => {
  test('explicit throttlePerMinute=2 → 3rd call within 60s surfaces E_THROTTLED', async () => {
    const tool = makeReadTool('email_search', 2)
    const reg = createToolRegistry()
    reg.register(tool)
    const ctx = makeDispatchCtx(1)

    // 3 个 use requests 同一 session 同一 tool
    const uses = [
      makeUseRequest('email_search', 1),
      makeUseRequest('email_search', 2),
      makeUseRequest('email_search', 3)
    ]
    const results = await dispatchTools(uses, ctx, reg)

    expect(results).toHaveLength(3)
    expect(results[0]?.status).toBe('ok')
    expect(results[1]?.status).toBe('ok')
    expect(results[2]?.status).toBe('error')
    expect(results[2]?.errorMessage).toMatch(/E_THROTTLED/)
    expect(results[2]?.errorMessage).toMatch(/email_search/)
    expect(results[2]?.errorMessage).toMatch(/exceeded 2 calls/)
  })

  test('default throttle 30/min — 31st call throttled', async () => {
    const tool = makeReadTool('email_get') // 默认 30/min
    const reg = createToolRegistry()
    reg.register(tool)
    const ctx = makeDispatchCtx(2)

    // 31 个 use requests
    const uses = Array.from({ length: 31 }, (_, i) => makeUseRequest('email_get', i + 1))
    const results = await dispatchTools(uses, ctx, reg)

    expect(results).toHaveLength(31)
    // 前 30 个 ok
    for (let i = 0; i < 30; i++) {
      expect(results[i]?.status).toBe('ok')
    }
    // 31 个 E_THROTTLED
    expect(results[30]?.status).toBe('error')
    expect(results[30]?.errorMessage).toMatch(/E_THROTTLED/)
  })

  test('throttlePerMinute=0 → opt-out (no limit)', async () => {
    const tool = makeReadTool('email_body', 0)
    const reg = createToolRegistry()
    reg.register(tool)
    const ctx = makeDispatchCtx(3)

    const uses = Array.from({ length: 100 }, (_, i) => makeUseRequest('email_body', i + 1))
    const results = await dispatchTools(uses, ctx, reg)

    expect(results).toHaveLength(100)
    for (const r of results) {
      expect(r.status).toBe('ok')
    }
  })

  test('per-session isolation — session A hitting limit does NOT block session B', async () => {
    const tool = makeReadTool('email_search', 2)
    const reg = createToolRegistry()
    reg.register(tool)

    // Session A: 3 calls → 3rd throttled
    const ctxA = makeDispatchCtx(10)
    const resA = await dispatchTools(
      [
        makeUseRequest('email_search', 100),
        makeUseRequest('email_search', 101),
        makeUseRequest('email_search', 102)
      ],
      ctxA,
      reg
    )
    expect(resA[2]?.status).toBe('error')

    // Session B: 2 calls 立刻 — 都应 ok (跟 A 隔离)
    const ctxB = makeDispatchCtx(11)
    const resB = await dispatchTools(
      [makeUseRequest('email_search', 200), makeUseRequest('email_search', 201)],
      ctxB,
      reg
    )
    expect(resB[0]?.status).toBe('ok')
    expect(resB[1]?.status).toBe('ok')
  })

  test('per-tool isolation — tool A hitting limit does NOT block tool B (same session)', async () => {
    const toolA = makeReadTool('email_search', 1)
    const toolB = makeReadTool('email_get', 5)
    const reg = createToolRegistry()
    reg.register(toolA)
    reg.register(toolB)
    const ctx = makeDispatchCtx(20)

    // 2× toolA + 1× toolB
    const results = await dispatchTools(
      [
        makeUseRequest('email_search', 300),
        makeUseRequest('email_search', 301), // toolA limit=1 → throttled
        makeUseRequest('email_get', 302) // toolB 独立, ok
      ],
      ctx,
      reg
    )

    expect(results[0]?.status).toBe('ok')
    expect(results[1]?.status).toBe('error')
    expect(results[1]?.errorMessage).toMatch(/email_search/)
    expect(results[2]?.status).toBe('ok')
  })

  test('error message includes retry-in hint', async () => {
    const tool = makeReadTool('email_archive', 1)
    const reg = createToolRegistry()
    reg.register(tool)
    const ctx = makeDispatchCtx(30)

    const results = await dispatchTools(
      [makeUseRequest('email_archive', 400), makeUseRequest('email_archive', 401)],
      ctx,
      reg
    )

    expect(results[1]?.errorMessage).toMatch(/retry in ~\d+s/)
  })

  test('__resetThrottleForTests clears state (used by test setup)', async () => {
    const tool = makeReadTool('email_body', 1)
    const reg = createToolRegistry()
    reg.register(tool)
    const ctx = makeDispatchCtx(40)

    await dispatchTools(
      [makeUseRequest('email_body', 500), makeUseRequest('email_body', 501)],
      ctx,
      reg
    )
    // 第二 call 被 throttle

    __resetThrottleForTests()

    const results = await dispatchTools([makeUseRequest('email_body', 502)], ctx, reg)
    expect(results[0]?.status).toBe('ok') // reset 后又 OK
  })

  test('__resetThrottleForTests(sessionId) clears only that session', async () => {
    const tool = makeReadTool('email_body', 1)
    const reg = createToolRegistry()
    reg.register(tool)

    // Session A 用满 quota
    await dispatchTools([makeUseRequest('email_body', 600)], makeDispatchCtx(50), reg)
    // Session B 用满 quota
    await dispatchTools([makeUseRequest('email_body', 601)], makeDispatchCtx(51), reg)

    // 只清 session 50
    __resetThrottleForTests(50)

    // Session 50 again ok, session 51 still throttled
    const a = await dispatchTools([makeUseRequest('email_body', 602)], makeDispatchCtx(50), reg)
    const b = await dispatchTools([makeUseRequest('email_body', 603)], makeDispatchCtx(51), reg)

    expect(a[0]?.status).toBe('ok')
    expect(b[0]?.status).toBe('error')
  })
})
