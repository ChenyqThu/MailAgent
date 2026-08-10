// 07-16 approval-mode switcher + 08-05 WP-11 per-tool tiers — prepareChatRun's injection points.
//
// Pins the ONE funnel every entrypoint passes through (chatRun.ts):
//   - manual_chat + resolver 'bypass' → the effective approvalMode handed to cfg.buildTools is
//     the global mode (server-resolved, never from the body);
//   - 08-05 WP-11: 'acceptEdits' is RETIRED — a stale resolver value is ignored (fail-closed to
//     the request-level semantics), and a body can never inject it either;
//   - manual_chat + resolver 'manual' → the request-level 'always'|'auto-reversible' semantics
//     stand byte-identical (Manual parity);
//   - WP-11: manual_chat resolves cfg.resolveToolApprovalPrefs and hands the prefs to
//     cfg.buildTools' 5TH slot (4th = agentRunContext, undefined for manual); Matters P3 adds the
//     6th (sessionId, undefined without a session) and 7th (matterScopeFilter, null without a
//     matter-anchored contextSnapshot) slots — inert here, asserted as undefined/null; headless modes
//     consult NEITHER resolver (custom-agent runs are governed solely by their per-agent grants
//     matrix — the load-bearing isolation gate);
//   - resolver failure / absence fail-closes (mode → request-level; prefs → null = ask);
//   - a request body carrying approvalMode:'bypass'/'acceptEdits' cannot inject the global values
//     (only 'auto-reversible' is ever honored from a body).

import { describe, expect, test, vi } from 'vitest'
import { simulateReadableStream, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import type { GatewayToolApprovalPrefs, GlobalApprovalMode } from '../../src/ai-gateway/tools/types'

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

function makeCfg(overrides: Partial<AiGatewayConfig> = {}): {
  cfg: AiGatewayConfig
  buildTools: ReturnType<typeof vi.fn>
} {
  const buildTools = vi.fn((): ToolSet => ({}))
  const cfg: AiGatewayConfig = {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => textModel(),
    buildTools,
    ...overrides
  }
  return { cfg, buildTools }
}

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    ...extra
  }
}

async function runPrepared(
  cfg: AiGatewayConfig,
  b: Record<string, unknown>,
  mode: 'manual_chat' | 'untrusted_trigger' | 'cron_headless'
): Promise<void> {
  const out = await prepareChatRun(b, cfg, new AbortController().signal, mode)
  expect(out.ok).toBe(true)
  if (out.ok) await out.run.result.consumeStream()
}

const PREFS: GatewayToolApprovalPrefs = {
  tools: { email_draft_reply: { tier: 'auto', source: 'default' } },
  sendRecipientWhitelist: ['@corp.test']
}

describe('prepareChatRun — owner-global approval mode injection (manual_chat only)', () => {
  test("manual_chat + global 'bypass' → buildTools receives the global mode", async () => {
    const resolver = vi.fn(async (): Promise<GlobalApprovalMode> => 'bypass')
    const { cfg, buildTools } = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(cfg, body(), 'manual_chat')
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'bypass',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })

  test("08-05 WP-11 — a stale resolver 'acceptEdits' is IGNORED (mode retired, fail-closed)", async () => {
    const resolver = vi.fn(async () => 'acceptEdits' as unknown as GlobalApprovalMode)
    const { cfg, buildTools } = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(cfg, body(), 'manual_chat')
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })

  test("Manual parity: global 'manual' keeps the request-level semantics byte-identical", async () => {
    const resolver = vi.fn(async (): Promise<GlobalApprovalMode> => 'manual')
    // absent body field → 'always'
    const a = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(a.cfg, body(), 'manual_chat')
    expect(a.buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
    // body 'auto-reversible' → honored unchanged
    const b = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(b.cfg, body({ approvalMode: 'auto-reversible' }), 'manual_chat')
    expect(b.buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'auto-reversible',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    'headless (%s): the resolver is NEVER consulted and the mode stays request-level',
    async (mode) => {
      const resolver = vi.fn(async (): Promise<GlobalApprovalMode> => 'bypass')
      const { cfg, buildTools } = makeCfg({ resolveGlobalApprovalMode: resolver })
      await runPrepared(cfg, body(), mode)
      expect(resolver).not.toHaveBeenCalled()
      expect(buildTools).toHaveBeenCalledWith(
        expect.any(Array),
        'always',
        mode,
        undefined,
        null,
        undefined,
        null
      )
    }
  )

  test('resolver failure fail-closes to the request-level (manual) semantics — the run still starts', async () => {
    const resolver = vi.fn(async (): Promise<GlobalApprovalMode> => {
      throw new Error('serve-api down')
    })
    const { cfg, buildTools } = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(cfg, body(), 'manual_chat')
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })

  test('resolver absent (harness/test cfgs) → byte-identical request-level behaviour', async () => {
    const { cfg, buildTools } = makeCfg()
    await runPrepared(cfg, body(), 'manual_chat')
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })

  test("a request body can NEVER inject the global values (body approvalMode:'bypass' → 'always')", async () => {
    const resolver = vi.fn(async (): Promise<GlobalApprovalMode> => 'manual')
    const { cfg, buildTools } = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(cfg, body({ approvalMode: 'bypass' }), 'manual_chat')
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
    const b = makeCfg({ resolveGlobalApprovalMode: resolver })
    await runPrepared(b.cfg, body({ approvalMode: 'acceptEdits' }), 'manual_chat')
    expect(b.buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })
})

describe('prepareChatRun — 08-05 WP-11 per-tool approval prefs injection (manual_chat only)', () => {
  test('manual_chat resolves the prefs and hands them to buildTools (5th slot)', async () => {
    const prefsResolver = vi.fn(async (): Promise<GatewayToolApprovalPrefs | null> => PREFS)
    const { cfg, buildTools } = makeCfg({ resolveToolApprovalPrefs: prefsResolver })
    await runPrepared(cfg, body(), 'manual_chat')
    expect(prefsResolver).toHaveBeenCalledTimes(1)
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      PREFS,
      undefined,
      null
    )
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    '🔴 headless (%s): the prefs resolver is NEVER consulted (per-tool convenience never leaks into unattended runs)',
    async (mode) => {
      const prefsResolver = vi.fn(async (): Promise<GatewayToolApprovalPrefs | null> => PREFS)
      const { cfg, buildTools } = makeCfg({ resolveToolApprovalPrefs: prefsResolver })
      await runPrepared(cfg, body(), mode)
      expect(prefsResolver).not.toHaveBeenCalled()
      expect(buildTools).toHaveBeenCalledWith(
        expect.any(Array),
        'always',
        mode,
        undefined,
        null,
        undefined,
        null
      )
    }
  )

  test('prefs resolver failure fail-closes to null (= every write asks) — the run still starts', async () => {
    const prefsResolver = vi.fn(async (): Promise<GatewayToolApprovalPrefs | null> => {
      throw new Error('serve-api down')
    })
    const { cfg, buildTools } = makeCfg({ resolveToolApprovalPrefs: prefsResolver })
    await runPrepared(cfg, body(), 'manual_chat')
    expect(buildTools).toHaveBeenCalledWith(
      expect.any(Array),
      'always',
      'manual_chat',
      undefined,
      null,
      undefined,
      null
    )
  })
})
