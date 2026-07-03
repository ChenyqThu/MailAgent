// S4 W3 — headless custom-agent run on the gateway: runHeadlessAgent + POST /api/ai/agent-run.
//
// Pure-Node: a MockLanguageModelV3 is injected via cfg.createModel and cfg.buildTools returns the
// REAL buildGatewayTools output, so the run drives the SAME prepareChatRun + streamText + tools +
// ApprovalGuard + makePersistOnFinish as /api/ai/chat — WITHOUT a provider or serve-api. Asserts:
// contextMode derivation (email→untrusted_trigger / cron→cron_headless / else→fail-closed) + the
// MATRIX in headless (capability_change/exec/outbound stripped under the derived mode) + allowedTools
// intersection (only reduce) + the three drain outcomes (completed / paused_handoff [island on stashes,
// off does not] / budget-abort → E_BUDGET_TIME) + the endpoint (flag-off 404, bad body 400, spec-fetch
// error passthrough, createAgentSession wiring). This wave adds ZERO gateway tools — agent-run is an
// endpoint, not a tool.

import { afterEach, describe, expect, test } from 'vitest'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import {
  deriveContextMode,
  intersectAllowedTools,
  runHeadlessAgent
} from '../../src/ai-gateway/agentRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { AgentRunSpec } from '../../src/shared/api/types'
import type { AgentContextMode } from '../../src/ai-gateway/tools/policy'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

const handles: AiGatewayHandle[] = []
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
}

/** A model that streams closing text (a text-only, tool-free turn → completed). */
function mockTextModel(parts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: '1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
          { type: 'text-end' as const, id: '1' },
          { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
        ]
      })
    })
  })
}

/** A model that requests a write tool (SDK pauses at its approval gate via needsApproval). */
function mockToolCallModel(toolName: string, input: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'tool-call' as const, toolCallId: 'tc1', toolName, input: JSON.stringify(input) },
          { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE }
        ]
      })
    })
  })
}

/** A model that captures the tool NAMES it was shown (proves the ToolSet reaching streamText), then
 *  ends with plain text. */
function captureToolsModel(sink: string[][]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (opts) => {
      sink.push((opts.tools ?? []).map((t) => (t as { name: string }).name))
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'ok' },
            { type: 'text-end' as const, id: '1' },
            { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
          ]
        })
      }
    }
  })
}

/** Minimal spy domain — the write tool never executes on a pause, so draftReply is unused here. */
function minimalDomain(): MailAgentDomainClient {
  return {
    draftReply: async () => ({ internalId: 5, mailbox: '草稿箱', accountName: 'a', draftId: 'd1' })
  } as unknown as MailAgentDomainClient
}

function makeSpec(over?: Partial<AgentRunSpec>): AgentRunSpec {
  return {
    jobId: 7,
    agentId: 'dms',
    trigger: { kind: 'cron', firedAt: '2026-07-03T09:00:00Z' },
    prompt: { taskPrompt: '总结今天的邮件' },
    model: 'claude-sonnet-4-6',
    toolPolicy: {},
    budget: { maxSteps: 8, maxRunSeconds: 300 },
    sessionTitle: 'DMS · 2026-07-03 09:00',
    ...over
  }
}

// ── deriveContextMode (pure) ──────────────────────────────────────────────────────────────────────

describe('deriveContextMode', () => {
  test('email_filter → untrusted_trigger', () => {
    expect(deriveContextMode(makeSpec({ trigger: { kind: 'email_filter', firedAt: 'x' } }))).toBe(
      'untrusted_trigger'
    )
  })
  test('cron → cron_headless', () => {
    expect(deriveContextMode(makeSpec({ trigger: { kind: 'cron', firedAt: 'x' } }))).toBe(
      'cron_headless'
    )
  })
  test('unknown/missing kind → untrusted_trigger (fail-closed)', () => {
    expect(deriveContextMode(makeSpec({ trigger: { kind: 'weird', firedAt: 'x' } }))).toBe(
      'untrusted_trigger'
    )
    expect(
      deriveContextMode({ ...makeSpec(), trigger: undefined as unknown as AgentRunSpec['trigger'] })
    ).toBe('untrusted_trigger')
  })
})

// ── intersectAllowedTools (pure) ──────────────────────────────────────────────────────────────────

describe('intersectAllowedTools', () => {
  const set = (): ToolSet => ({
    email_search: tool({ description: 'a', inputSchema: z.object({}), execute: async () => ({}) }),
    email_flag: tool({ description: 'b', inputSchema: z.object({}), execute: async () => ({}) })
  })
  test('undefined allow-list → full set unchanged', () => {
    expect(Object.keys(intersectAllowedTools(set(), undefined)).sort()).toEqual([
      'email_flag',
      'email_search'
    ])
  })
  test('subset allow-list → intersection', () => {
    expect(Object.keys(intersectAllowedTools(set(), ['email_search']))).toEqual(['email_search'])
  })
  test('empty allow-list → empty (owner selected zero tools)', () => {
    expect(Object.keys(intersectAllowedTools(set(), []))).toEqual([])
  })
  test('only reduce — a name not in the set stays absent (never added)', () => {
    expect(Object.keys(intersectAllowedTools(set(), ['email_search', 'run_command']))).toEqual([
      'email_search'
    ])
  })
})

// ── the matrix runs in a headless run (derived mode strips the dangerous classes) ─────────────────

describe('runHeadlessAgent — matrix under the derived context mode', () => {
  /** Build the FULL flag-on set so the dangerous classes WOULD exist in manual_chat — proving they
   *  vanish comes from the derived mode, not from flags-off. */
  function fullFlagOnCfg(seen: { mode: AgentContextMode | undefined; keys: string[] }[]): AiGatewayConfig {
    const guard = new ApprovalGuard()
    return {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockTextModel(['done']),
      buildTools: (collector, _am, mode) => {
        const t = buildGatewayTools(
          {
            domain: minimalDomain(),
            writeToolsEnabled: true,
            approvalGuard: guard,
            sendToolEnabled: true,
            sendSigningSecret: 'secret',
            skillGatingEnabled: true,
            webToolsEnabled: true,
            execToolsEnabled: true,
            skillInstallToolsEnabled: true,
            contextMode: mode
          },
          collector
        )
        seen.push({ mode, keys: Object.keys(t) })
        return t
      },
      persistTurn: () => {}
    }
  }

  const DANGEROUS = [
    'set_skill_enabled',
    'update_system_md',
    'skill_install',
    'run_command',
    'file_write',
    'web_fetch',
    'email_prepare_send'
  ]

  test('email_filter run (untrusted_trigger): capability_change/exec/outbound stripped, domain_write survives', async () => {
    const seen: { mode: AgentContextMode | undefined; keys: string[] }[] = []
    await runHeadlessAgent(
      fullFlagOnCfg(seen),
      {
        jobId: 7,
        spec: makeSpec({ trigger: { kind: 'email_filter', firedAt: 'x', emailInternalId: 5 } }),
        sessionId: null
      },
      new AbortController().signal
    )
    expect(seen.length).toBeGreaterThan(0)
    const build = seen[seen.length - 1]
    expect(build.mode).toBe('untrusted_trigger')
    for (const name of DANGEROUS) {
      expect(build.keys, `${name} must be stripped in a headless run`).not.toContain(name)
    }
    expect(build.keys).toContain('email_flag') // domain_write is allowed in every mode
  })

  test('cron run (cron_headless): the SAME strip applies — cron is headless, not manual', async () => {
    // W3-check: the intersection test's cron spec ran with exec/web flags OFF, so "run_command absent"
    // there can't be attributed to the matrix. This asserts the matrix itself under cron_headless with
    // every dangerous flag ON.
    const seen: { mode: AgentContextMode | undefined; keys: string[] }[] = []
    await runHeadlessAgent(
      fullFlagOnCfg(seen),
      { jobId: 7, spec: makeSpec({ trigger: { kind: 'cron', firedAt: 'x' } }), sessionId: null },
      new AbortController().signal
    )
    expect(seen.length).toBeGreaterThan(0)
    const build = seen[seen.length - 1]
    expect(build.mode).toBe('cron_headless')
    for (const name of DANGEROUS) {
      expect(build.keys, `${name} must be stripped in a cron_headless run`).not.toContain(name)
    }
    expect(build.keys).toContain('email_flag')
  })
})

// ── allowedTools narrows the ToolSet the model actually sees ───────────────────────────────────────

describe('runHeadlessAgent — allowedTools intersection reaches streamText', () => {
  test('the model sees only allowed ∩ (matrix set); a stripped name stays absent', async () => {
    const seenTools: string[][] = []
    const guard = new ApprovalGuard()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => captureToolsModel(seenTools),
      buildTools: (collector, _am, mode) =>
        buildGatewayTools(
          { domain: minimalDomain(), writeToolsEnabled: true, approvalGuard: guard, contextMode: mode },
          collector
        ),
      persistTurn: () => {}
    }
    // allow email_search (read) + email_flag (domain_write) + run_command (exec, matrix-stripped under
    // cron_headless → never reachable).
    const spec = makeSpec({ toolPolicy: { allowedTools: ['email_search', 'email_flag', 'run_command'] } })
    await runHeadlessAgent(cfg, { jobId: 7, spec, sessionId: null }, new AbortController().signal)
    expect(seenTools.length).toBeGreaterThan(0)
    expect(seenTools[0].sort()).toEqual(['email_flag', 'email_search'])
  })
})

// ── the three drain outcomes ──────────────────────────────────────────────────────────────────────

describe('runHeadlessAgent — drain outcomes', () => {
  test('completed: text-only run → outcome completed with steps + summary + usage', async () => {
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockTextModel(['已总结完成。']),
      buildTools: (collector, _am, mode) =>
        buildGatewayTools({ domain: minimalDomain(), contextMode: mode }, collector),
      persistTurn: () => {}
    }
    const result = await runHeadlessAgent(
      cfg,
      { jobId: 7, spec: makeSpec(), sessionId: 99 },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.outcome).toBe('completed')
    expect(result.sessionId).toBe(99)
    expect(result.steps).toBeGreaterThanOrEqual(1)
    expect(result.summary).toContain('已总结')
    expect(result.usage).toBeDefined()
  })

  test('paused_handoff (island ON): a write approval pause → paused_handoff + stash called', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockToolCallModel('email_draft_reply', { internal_id: 5, body_markdown: 'x' }),
      buildTools: (collector, _am, mode) =>
        buildGatewayTools(
          {
            domain: minimalDomain(),
            writeToolsEnabled: true,
            approvalGuard: guard,
            oneShotWrites: true,
            contextMode: mode
          },
          collector
        ),
      islandAgentEnabled: true,
      approvalStash: stash,
      announceApprovalToIsland: () => {},
      persistTurn: () => {}
    }
    const result = await runHeadlessAgent(
      cfg,
      { jobId: 7, spec: makeSpec(), sessionId: 55 },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.outcome).toBe('paused_handoff')
    expect(result.sessionId).toBe(55)
    expect(stash.size()).toBe(1) // island on → stashed for server-side (island) resume
  })

  test('paused_handoff (island OFF): still paused_handoff but the stash is NOT touched', async () => {
    const guard = new ApprovalGuard()
    const stash = new ApprovalRunStash()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => mockToolCallModel('email_draft_reply', { internal_id: 5, body_markdown: 'x' }),
      buildTools: (collector, _am, mode) =>
        buildGatewayTools(
          { domain: minimalDomain(), writeToolsEnabled: true, approvalGuard: guard, contextMode: mode },
          collector
        ),
      // island OFF: approvalStash present but islandAgentEnabled undefined → maybeStashAndAnnounce is inert.
      approvalStash: stash,
      persistTurn: () => {}
    }
    const result = await runHeadlessAgent(
      cfg,
      { jobId: 7, spec: makeSpec(), sessionId: 55 },
      new AbortController().signal
    )
    expect(result.outcome).toBe('paused_handoff')
    expect(stash.size()).toBe(0) // island off → no decision surface → nothing stashed
  })

  test('upstream APICallError 429 (no abort) → outcome error E_QUOTA, never mislabeled completed', async () => {
    // W3-check: streamText SWALLOWS a thrown upstream error into an error chunk (the drain loop does
    // NOT throw), so this exercises the errorText/streamError branch — not the catch. Without the
    // onError capture the code collapsed to E_AGENT and ai@7 masked the message to "An error occurred.".
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async () => {
            throw new APICallError({
              message: 'rate limited by upstream',
              url: 'https://crs.example/api/v1/messages',
              requestBodyValues: {},
              statusCode: 429,
              responseHeaders: {},
              responseBody: '{"error":"rate_limited"}',
              isRetryable: false,
              data: undefined
            })
          }
        }),
      buildTools: (collector, _am, mode) =>
        buildGatewayTools({ domain: minimalDomain(), contextMode: mode }, collector),
      persistTurn: () => {}
    }
    const result = await runHeadlessAgent(
      cfg,
      { jobId: 7, spec: makeSpec(), sessionId: null },
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('error') // the load-bearing assertion: never 'completed'
    expect(result.error?.code).toBe('E_QUOTA') // structured, not collapsed to E_AGENT
    expect(result.error?.message).toContain('rate limited') // real cause, not ai@7's masked generic
  })

  test('budget deadline abort → outcome error E_BUDGET_TIME (never throws)', async () => {
    const ac = new AbortController()
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      // Abort mid-flight then throw — mirrors search_agent_run's abort test.
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async () => {
            ac.abort()
            const e = new Error('deadline')
            e.name = 'AbortError'
            throw e
          }
        }),
      buildTools: (collector, _am, mode) =>
        buildGatewayTools({ domain: minimalDomain(), contextMode: mode }, collector),
      persistTurn: () => {}
    }
    const result = await runHeadlessAgent(cfg, { jobId: 7, spec: makeSpec(), sessionId: null }, ac.signal)
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('error')
    expect(result.error?.code).toBe('E_BUDGET_TIME')
  })
})

// ── POST /api/ai/agent-run endpoint ───────────────────────────────────────────────────────────────

async function startWith(cfg: Partial<AiGatewayConfig>): Promise<string> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    createModel: () => mockTextModel(['done']),
    buildTools: (collector, _am, mode) =>
      buildGatewayTools({ domain: minimalDomain(), contextMode: mode }, collector),
    persistTurn: () => {},
    ...cfg
  })
  handles.push(handle)
  return `http://127.0.0.1:${handle.port}`
}

const postAgentRun = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/ai/agent-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('POST /api/ai/agent-run', () => {
  test('flag-off (hooks unwired) → 404', async () => {
    // No fetchAgentRunSpec / createAgentSession → the feature is off.
    const base = await startWith({})
    const res = await postAgentRun(base, { jobId: 7, claimToken: 'tok' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
  })

  test('bad body (missing jobId / claimToken) → 400', async () => {
    const base = await startWith({
      fetchAgentRunSpec: async () => makeSpec(),
      createAgentSession: () => 1
    })
    expect((await postAgentRun(base, {})).status).toBe(400)
    expect((await postAgentRun(base, { jobId: 7 })).status).toBe(400)
    expect((await postAgentRun(base, { claimToken: 'x' })).status).toBe(400)
  })

  test('spec-fetch error → forwarded with the serve-api status + code (worker records it)', async () => {
    const base = await startWith({
      fetchAgentRunSpec: async () => {
        throw Object.assign(new Error('already claimed'), {
          code: 'E_SPEC_ALREADY_CLAIMED',
          httpStatus: 409
        })
      },
      createAgentSession: () => 1
    })
    const res = await postAgentRun(base, { jobId: 7, claimToken: 'tok' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('E_SPEC_ALREADY_CLAIMED')
  })

  test('happy path: pulls spec, creates the agent session, returns the completed result', async () => {
    const createCalls: Array<{ agentId: string; jobId: number; title: string }> = []
    const base = await startWith({
      fetchAgentRunSpec: async (jobId, claimToken) => {
        expect(jobId).toBe(7)
        expect(claimToken).toBe('tok')
        return makeSpec()
      },
      createAgentSession: (input) => {
        createCalls.push(input)
        return 55
      }
    })
    const res = await postAgentRun(base, { jobId: 7, claimToken: 'tok' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; outcome: string; sessionId: number }
    expect(body.ok).toBe(true)
    expect(body.outcome).toBe('completed')
    expect(body.sessionId).toBe(55)
    expect(createCalls).toEqual([{ agentId: 'dms', jobId: 7, title: 'DMS · 2026-07-03 09:00' }])
  })

  test('createAgentSession failure → run continues unsaved (sessionId null), still 200', async () => {
    const base = await startWith({
      fetchAgentRunSpec: async () => makeSpec(),
      createAgentSession: () => {
        throw new Error('db locked')
      }
    })
    const res = await postAgentRun(base, { jobId: 7, claimToken: 'tok' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { outcome: string; sessionId: number | null }
    expect(body.outcome).toBe('completed')
    expect(body.sessionId).toBeNull()
  })
})
