// 0804 dogfood —「重启后第一轮 connector 不可用」(WP1).
//
// Root cause: the gateway's startup prewarm of the connector manifest fires ~1.2s BEFORE serve-api
// accepts requests; the failed pull cached `null` for the FULL 30s success TTL, and the
// owner-present tool registration (manual_chat / im_chat) read that cache SYNCHRONOUSLY without
// ever awaiting the warm-up (only the one-shot headless path awaited). So the first turn after a
// restart registered zero mcp__* tools and the model honestly answered「不可用」.
//
// Pinned here:
//   ① prepareChatRun AWAITS cfg.ensureConnectorManifest BEFORE cfg.buildTools for owner-present
//      venues (manual_chat / im_chat) — the ordering IS the fix;
//   ② a FAILED pull is fresh for CONNECTOR_MANIFEST_FAILURE_TTL_MS (3s), a successful one for the
//      30s steady-state TTL;
//   ③ connectorManifestSkipReason names why an admitted run registered nothing (the lifecycle logs
//      it as `connector_tools_skipped` — the failure used to be entirely silent);
//   ④ no hook (MAILAGENT_MCP_CONNECTORS off / test cfgs) → nothing is awaited, and a headless run
//      is left to agentRun.ts's grant-aware warm-up (no double work, grant-less runs stay at zero
//      connector work).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { simulateReadableStream, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import type { AgentContextMode, AgentRunContext } from '../../src/ai-gateway/tools/policy'
import {
  CONNECTOR_MANIFEST_FAILURE_TTL_MS,
  CONNECTOR_MANIFEST_PREWARM_RETRIES_MS,
  CONNECTOR_MANIFEST_TTL_MS,
  connectorManifestSkipReason,
  createConnectorManifestCache,
  type ConnectorToolManifestEntry
} from '../../src/ai-gateway/tools/connector'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
}

function textModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          { type: 'text-delta' as const, id: '1', delta: 'ok' },
          { type: 'text-end' as const, id: '1' },
          { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
        ]
      })
    })
  })
}

/** cfg whose buildTools + ensure hook both append to a shared order log (so "awaited before" is a
 *  real assertion, not a call-count coincidence). */
function makeCfg(
  order: string[],
  opts: { ensure?: () => Promise<void>; agentRunContext?: AgentRunContext } = {}
): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => textModel(),
    ...(opts.ensure ? { ensureConnectorManifest: opts.ensure } : {}),
    ...(opts.agentRunContext ? { agentRunContext: opts.agentRunContext } : {}),
    buildTools: (): ToolSet => {
      order.push('buildTools')
      return {}
    }
  }
}

async function runPrepared(cfg: AiGatewayConfig, mode: AgentContextMode): Promise<void> {
  const out = await prepareChatRun(
    { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
    cfg,
    new AbortController().signal,
    mode
  )
  expect(out.ok).toBe(true)
  if (out.ok) await out.run.result.consumeStream()
}

/** An ensure hook with a real async gap — a fire-and-forget caller would let buildTools win. */
function slowEnsure(order: string[], calls: { n: number }): () => Promise<void> {
  return async () => {
    calls.n += 1
    await new Promise((r) => setTimeout(r, 5))
    order.push('ensure')
  }
}

describe('prepareChatRun — connector manifest warm-up before buildTools', () => {
  test.each(['manual_chat', 'im_chat'] as const)(
    '%s: the ensure hook is AWAITED before buildTools (cold cache → first turn has tools)',
    async (mode) => {
      const order: string[] = []
      const calls = { n: 0 }
      await runPrepared(makeCfg(order, { ensure: slowEnsure(order, calls) }), mode)
      expect(calls.n).toBe(1)
      expect(order).toEqual(['ensure', 'buildTools'])
    }
  )

  test('a failing ensure hook never fails the run (degrades to no connector tools)', async () => {
    const order: string[] = []
    const cfg = makeCfg(order, {
      ensure: async () => {
        throw new Error('serve-api down')
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runPrepared(cfg, 'manual_chat')
    expect(order).toEqual(['buildTools'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('no hook (flag off / test cfgs) → nothing awaited, byte-identical', async () => {
    const order: string[] = []
    await runPrepared(makeCfg(order), 'manual_chat')
    expect(order).toEqual(['buildTools'])
  })

  test.each(['cron_headless', 'untrusted_trigger'] as const)(
    '%s: prepareChatRun never warms (agentRun.ts owns the grant-aware warm-up)',
    async (mode) => {
      const order: string[] = []
      const calls = { n: 0 }
      const cfg = makeCfg(order, {
        ensure: slowEnsure(order, calls),
        agentRunContext: { agentId: 'a1', modeGrants: { connectors: { notion: 'read' } } }
      })
      await runPrepared(cfg, mode)
      expect(calls.n).toBe(0)
      expect(order).toEqual(['buildTools'])
    }
  )

  test('a stray agentRunContext on a manual run is refused by the seam (no warm-up)', async () => {
    const order: string[] = []
    const calls = { n: 0 }
    const cfg = makeCfg(order, {
      ensure: slowEnsure(order, calls),
      agentRunContext: { agentId: 'a1' }
    })
    await runPrepared(cfg, 'manual_chat')
    expect(calls.n).toBe(0)
  })
})

function entry(toolName: string): ConnectorToolManifestEntry {
  return {
    connectorId: 'notion',
    connectorName: 'Notion',
    toolName,
    description: 'd',
    inputSchemaJson: null,
    crudType: 'read',
    destructive: false,
    effectiveEnabled: true,
    orphan: false
  }
}

describe('createConnectorManifestCache — TTLs, single-flight, prewarm retries', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a FAILED pull is fresh only for the short failure TTL (not the 30s success TTL)', async () => {
    vi.useFakeTimers()
    let calls = 0
    const cache = createConnectorManifestCache(async () => {
      calls += 1
      return null
    })
    await cache.refresh()
    expect(calls).toBe(1)
    expect(cache.peek()).toBeNull()

    // Inside the failure TTL → short-circuit (no fetch storm while serve-api is genuinely down).
    vi.setSystemTime(Date.now() + CONNECTOR_MANIFEST_FAILURE_TTL_MS - 1)
    await cache.refresh()
    expect(calls).toBe(1)

    // Past it → refetch. Under the OLD behaviour this window was 30s = the whole cold-start bug.
    vi.setSystemTime(Date.now() + 2)
    await cache.refresh()
    expect(calls).toBe(2)
  })

  test('a SUCCESSFUL pull keeps the 30s steady-state TTL', async () => {
    vi.useFakeTimers()
    let calls = 0
    const cache = createConnectorManifestCache(async () => {
      calls += 1
      return [entry('search')]
    })
    await cache.refresh()
    expect(cache.peek()).toHaveLength(1)

    vi.setSystemTime(Date.now() + CONNECTOR_MANIFEST_FAILURE_TTL_MS * 2)
    await cache.refresh()
    expect(calls).toBe(1)

    vi.setSystemTime(Date.now() + CONNECTOR_MANIFEST_TTL_MS)
    await cache.refresh()
    expect(calls).toBe(2)
  })

  test('single-flight: concurrent refreshes share ONE fetch', async () => {
    let calls = 0
    const cache = createConnectorManifestCache(async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 5))
      return [entry('search')]
    })
    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()])
    expect(calls).toBe(1)
  })

  test('force skips ONLY the freshness short-circuit (prewarm retries can re-try a cached null)', async () => {
    let calls = 0
    const cache = createConnectorManifestCache(async () => {
      calls += 1
      return null
    })
    await cache.refresh()
    await cache.refresh() // fresh negative entry → short-circuit
    expect(calls).toBe(1)
    await cache.refresh({ force: true })
    expect(calls).toBe(2)
  })

  test('prewarm retries a failed startup pull and STOPS as soon as it succeeds', async () => {
    vi.useFakeTimers()
    const log: Record<string, unknown>[] = []
    let calls = 0
    const cache = createConnectorManifestCache(async () => {
      calls += 1
      // Field shape: the gateway is up ~1.2s before serve-api → attempt #1 fails, #2 succeeds.
      return calls === 1 ? null : [entry('search')]
    }, log.push.bind(log))

    cache.prewarm()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(cache.peek()).toBeNull()

    await vi.advanceTimersByTimeAsync(CONNECTOR_MANIFEST_PREWARM_RETRIES_MS[0])
    expect(calls).toBe(2)
    expect(cache.peek()).toHaveLength(1)

    // Warm → no third attempt.
    await vi.advanceTimersByTimeAsync(CONNECTOR_MANIFEST_PREWARM_RETRIES_MS[1] + 1)
    expect(calls).toBe(2)
    expect(log.map((r) => r.event)).toEqual([
      'connector_manifest_refresh',
      'connector_manifest_refresh'
    ])
  })

  test('prewarm gives up after the bounded retry schedule (a down backend is not a retry storm)', async () => {
    vi.useFakeTimers()
    const log: Record<string, unknown>[] = []
    let calls = 0
    const cache = createConnectorManifestCache(async () => {
      calls += 1
      return null
    }, log.push.bind(log))

    cache.prewarm()
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of CONNECTOR_MANIFEST_PREWARM_RETRIES_MS) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(calls).toBe(1 + CONNECTOR_MANIFEST_PREWARM_RETRIES_MS.length)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1 + CONNECTOR_MANIFEST_PREWARM_RETRIES_MS.length)
    expect(log.at(-1)).toEqual({
      event: 'connector_manifest_prewarm_gave_up',
      attempts: 1 + CONNECTOR_MANIFEST_PREWARM_RETRIES_MS.length
    })
  })

  test('a throwing fetch is caught (belt) and cached as a failure', async () => {
    const cache = createConnectorManifestCache(async () => {
      throw new Error('boom')
    })
    await expect(cache.refresh()).resolves.toBeUndefined()
    expect(cache.peek()).toBeNull()
  })

  test('0805 dogfood: the give-up backoff window covers the observed serve-api cold-start range (4-34s)', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    let giveUpAtMs: number | null = null
    const cache = createConnectorManifestCache(
      async () => null,
      (rec) => {
        if (rec.event === 'connector_manifest_prewarm_gave_up') giveUpAtMs = Date.now() - start
      }
    )

    cache.prewarm()
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of CONNECTOR_MANIFEST_PREWARM_RETRIES_MS) {
      await vi.advanceTimersByTimeAsync(delay)
    }

    // The field's worst observed cold start was 34s — the schedule's cumulative backoff must clear
    // it with margin (35s), not merely the ~4s the pre-0805 [1s, 3s] schedule covered.
    expect(giveUpAtMs).not.toBeNull()
    expect(giveUpAtMs as number).toBeGreaterThanOrEqual(35_000)
  })

  test('0805 dogfood: prewarm quiets every retry after the first (a longer schedule must not multiply warn noise)', async () => {
    vi.useFakeTimers()
    const quietFlags: Array<boolean | undefined> = []
    const cache = createConnectorManifestCache(async (opts) => {
      quietFlags.push(opts?.quiet)
      return null
    })

    cache.prewarm()
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of CONNECTOR_MANIFEST_PREWARM_RETRIES_MS) {
      await vi.advanceTimersByTimeAsync(delay)
    }

    // First attempt (i=0) is loud (quiet:false); every retry after it is quiet:true. The caller
    // (ai_gateway_lifecycle.ts) threads this into fetchConnectorManifest's onWarn to suppress the
    // on-disk connector_manifest_warn line for the middle retries only.
    expect(quietFlags).toEqual([false, true, true, true, true, true])
  })
})

describe('connectorManifestSkipReason — why an admitted run registered nothing', () => {
  test('null manifest → manifest_unavailable', () => {
    expect(connectorManifestSkipReason(null)).toBe('manifest_unavailable')
    expect(connectorManifestSkipReason(undefined)).toBe('manifest_unavailable')
  })

  test('empty manifest → manifest_empty', () => {
    expect(connectorManifestSkipReason([])).toBe('manifest_empty')
  })

  test('usable manifest → null (caller registers)', () => {
    expect(connectorManifestSkipReason([entry('search')])).toBeNull()
  })
})
