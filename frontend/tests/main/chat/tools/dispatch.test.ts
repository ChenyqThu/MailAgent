// Sprint 19 PR-1b — Tool dispatch contract tests.

import { describe, expect, test } from 'vitest'
import {
  dispatchTools,
  type ToolUseRequest
} from '../../../../src/electron/main/chat/tools/dispatch'
import {
  createToolRegistry,
  type ToolDef,
  type ToolResult
} from '../../../../src/electron/main/chat/tools/registry'

function makeTool(name: string, overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object' },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    handler: async (input, _ctx): Promise<ToolResult> => ({
      ok: true,
      output: { echoed: input },
      durationMs: 0
    }),
    ...overrides
  }
}

function makeCtx(signal: AbortSignal = new AbortController().signal) {
  return { sessionId: 1, emailId: null, signal }
}

describe('dispatchTools — silent tier', () => {
  test('runs registered tool and returns ok result with output', async () => {
    const r = createToolRegistry()
    r.register(makeTool('echo'))
    const uses: ToolUseRequest[] = [{ toolUseId: 'toolu_1', name: 'echo', input: { x: 1 } }]
    const out = await dispatchTools(uses, makeCtx(), r)
    expect(out).toHaveLength(1)
    expect(out[0]?.status).toBe('ok')
    expect(out[0]?.toolUseId).toBe('toolu_1')
    expect(out[0]?.output).toEqual({ echoed: { x: 1 } })
    expect(out[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('runs multiple silent tools in PARALLEL (not serial)', async () => {
    const r = createToolRegistry()
    const SLEEP_MS = 80
    r.register(
      makeTool('slow1', {
        handler: async () => {
          await new Promise((res) => setTimeout(res, SLEEP_MS))
          return { ok: true, output: 'slow1', durationMs: SLEEP_MS }
        }
      })
    )
    r.register(
      makeTool('slow2', {
        handler: async () => {
          await new Promise((res) => setTimeout(res, SLEEP_MS))
          return { ok: true, output: 'slow2', durationMs: SLEEP_MS }
        }
      })
    )
    const uses: ToolUseRequest[] = [
      { toolUseId: 't1', name: 'slow1', input: {} },
      { toolUseId: 't2', name: 'slow2', input: {} }
    ]
    const start = Date.now()
    const out = await dispatchTools(uses, makeCtx(), r)
    const wallMs = Date.now() - start
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.status === 'ok')).toBe(true)
    // Parallel: total wall time should be ≈ SLEEP_MS, not 2×SLEEP_MS.
    // Allow generous slack (1.6× SLEEP_MS) to dodge CI scheduler noise.
    expect(wallMs).toBeLessThan(SLEEP_MS * 1.6)
  })

  test('unknown tool name → error result, does NOT crash dispatch', async () => {
    const r = createToolRegistry()
    r.register(makeTool('known'))
    const uses: ToolUseRequest[] = [
      { toolUseId: 't1', name: 'known', input: {} },
      { toolUseId: 't2', name: 'mystery', input: {} }
    ]
    const out = await dispatchTools(uses, makeCtx(), r)
    expect(out).toHaveLength(2)
    const known = out.find((r) => r.toolUseId === 't1')
    const mystery = out.find((r) => r.toolUseId === 't2')
    expect(known?.status).toBe('ok')
    expect(mystery?.status).toBe('error')
    expect(mystery?.errorMessage).toMatch(/Unknown tool "mystery"/)
  })

  test('handler returning ok:false surfaces structured code+message', async () => {
    const r = createToolRegistry()
    r.register(
      makeTool('fails', {
        handler: async () => ({
          ok: false,
          code: 'E_NOT_FOUND',
          message: 'no such row',
          durationMs: 5
        })
      })
    )
    const out = await dispatchTools(
      [{ toolUseId: 't1', name: 'fails', input: {} }],
      makeCtx(),
      r
    )
    expect(out[0]?.status).toBe('error')
    expect(out[0]?.errorMessage).toBe('E_NOT_FOUND: no such row')
  })

  test('handler throwing an exception surfaces E_INTERNAL (not crash)', async () => {
    const r = createToolRegistry()
    r.register(
      makeTool('throws', {
        handler: async () => {
          throw new Error('boom')
        }
      })
    )
    const out = await dispatchTools(
      [{ toolUseId: 't1', name: 'throws', input: {} }],
      makeCtx(),
      r
    )
    expect(out[0]?.status).toBe('error')
    expect(out[0]?.errorMessage).toMatch(/E_INTERNAL: boom/)
  })

  test('per-tool timeoutMs causes E_TIMEOUT after threshold', async () => {
    const r = createToolRegistry()
    r.register(
      makeTool('stuck', {
        timeoutMs: 30,
        handler: async (_input, ctx) => {
          // Honour the signal — wait for it to abort.
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('aborted')
        }
      })
    )
    const out = await dispatchTools(
      [{ toolUseId: 't1', name: 'stuck', input: {} }],
      makeCtx(),
      r
    )
    expect(out[0]?.status).toBe('error')
    expect(out[0]?.errorMessage).toMatch(/E_TIMEOUT/)
  })

  test('session abort signal cancels in-flight tool → status=canceled', async () => {
    const r = createToolRegistry()
    r.register(
      makeTool('listens', {
        timeoutMs: 5000,
        handler: async (_input, ctx) => {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('aborted')
        }
      })
    )
    const sessionAc = new AbortController()
    const dispatchPromise = dispatchTools(
      [{ toolUseId: 't1', name: 'listens', input: {} }],
      makeCtx(sessionAc.signal),
      r
    )
    // Abort before the handler returns.
    setTimeout(() => sessionAc.abort('user_aborted'), 20)
    const out = await dispatchPromise
    expect(out[0]?.status).toBe('canceled')
  })
})

describe('dispatchTools — preview / edit tiers (PR-1b stub)', () => {
  test('preview-tier tool short-circuits with confirmation-not-wired error', async () => {
    const r = createToolRegistry()
    r.register(makeTool('email_flag', { confirmationTier: 'preview', category: 'write' }))
    const out = await dispatchTools(
      [{ toolUseId: 't1', name: 'email_flag', input: { internal_id: 1 } }],
      makeCtx(),
      r
    )
    expect(out[0]?.status).toBe('error')
    expect(out[0]?.errorMessage).toMatch(/requires user confirmation/)
    expect(out[0]?.errorMessage).toMatch(/PR-1d/)
  })

  test('edit-tier tool also short-circuits in PR-1b', async () => {
    const r = createToolRegistry()
    r.register(
      makeTool('email_draft_reply', { confirmationTier: 'edit', category: 'write' })
    )
    const out = await dispatchTools(
      [{ toolUseId: 't1', name: 'email_draft_reply', input: {} }],
      makeCtx(),
      r
    )
    expect(out[0]?.status).toBe('error')
    expect(out[0]?.errorMessage).toMatch(/requires user confirmation/)
  })

  test('mixed batch — silent runs, preview short-circuits, unknown errors, no interference', async () => {
    const r = createToolRegistry()
    r.register(makeTool('read1', { confirmationTier: 'silent' }))
    r.register(makeTool('write1', { confirmationTier: 'preview', category: 'write' }))
    const out = await dispatchTools(
      [
        { toolUseId: 't1', name: 'read1', input: {} },
        { toolUseId: 't2', name: 'write1', input: {} },
        { toolUseId: 't3', name: 'unknown', input: {} }
      ],
      makeCtx(),
      r
    )
    expect(out).toHaveLength(3)
    expect(out.find((r) => r.toolUseId === 't1')?.status).toBe('ok')
    expect(out.find((r) => r.toolUseId === 't2')?.status).toBe('error')
    expect(out.find((r) => r.toolUseId === 't2')?.errorMessage).toMatch(/confirmation/)
    expect(out.find((r) => r.toolUseId === 't3')?.status).toBe('error')
    expect(out.find((r) => r.toolUseId === 't3')?.errorMessage).toMatch(/Unknown tool/)
  })
})
