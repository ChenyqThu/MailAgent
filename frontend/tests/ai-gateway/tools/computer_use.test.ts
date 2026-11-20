// WS-4 (`computer_use_run`) — sub-agent isolation, sliding-window screenshot pruning,
// App/Domain Scope Guard, `stop_before_submit` dock, `auto_scope_grant`, and venue isolation.

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream, tool, type ModelMessage, type Tool, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { prepareChatRun } from '../../../src/ai-gateway/chatRun'
import { agentRunContextFromSpec, wrapCfgForAgentRun } from '../../../src/ai-gateway/agentRun'
import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createConnectorTools, type ConnectorToolManifestEntry } from '../../../src/ai-gateway/tools/connector'
import {
  createComputerUseTools,
  evaluateComputerUsePolicy,
  isBoundedScopeForAutoGrant,
  matchesAllowedApp,
  pruneSlidingWindowScreenshots,
  selectComputerUseChildTools,
  validateNavigationUrl
} from '../../../src/ai-gateway/tools/computer_use'
import { resetRuntimeToolClasses } from '../../../src/ai-gateway/tools/policy'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { TOOL_DISPLAY_NAMES_ZH } from '../../../src/shared/assistant/toolDisplayNames'
import type { AgentRunSpec } from '../../../src/shared/api/types'
import { mockDomain, okEnvelope } from './_helpers'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
} as const

const PNG_PREFIX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function invokeCuTool(
  t: Tool,
  input: Record<string, unknown>,
  toolCallId: string,
  abortSignal?: AbortSignal
): Promise<{ approvalRequired: boolean | undefined; output: unknown }> {
  const approvalRequired =
    typeof t.needsApproval === 'function'
      ? await t.needsApproval(input as never, { toolCallId, messages: [] } as never)
      : t.needsApproval
  const output = await t.execute!(
    input as never,
    { toolCallId, messages: [], ...(abortSignal ? { abortSignal } : {}) } as never
  )
  return { approvalRequired, output }
}

function cuEntry(
  connectorId: 'browser_use' | 'desktop_use',
  toolName: string,
  crudType: 'read' | 'write' = 'write',
  mode: 'auto' | 'ask' = 'auto'
): ConnectorToolManifestEntry {
  return {
    connectorId,
    connectorName: connectorId,
    toolName,
    description: `${connectorId} ${toolName}`,
    inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: true }),
    crudType,
    mode,
    destructive: false,
    orphan: false
  }
}

function makeToolImageStep(stepTag: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `tc-${stepTag}`,
        toolName: 'mcp__browser_use__browser_take_screenshot',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: `Captured ${stepTag}` },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: `IMG_${stepTag}` }
            }
          ]
        }
      }
    ]
  } as unknown as ModelMessage
}

afterEach(() => {
  resetRuntimeToolClasses()
})

describe('pruneSlidingWindowScreenshots — latest <= 2 visual steps retained', () => {
  test('prunes older tool-result files, image-data, and user/assistant image parts cleanly', () => {
    const msgs: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at step 1' },
          { type: 'image', image: 'USER_IMG_1', mediaType: 'image/png' }
        ]
      } as unknown as ModelMessage,
      makeToolImageStep('step2'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Legacy image-data step 3' },
          { type: 'image-data', data: 'LEG_IMG_3', mediaType: 'image/png' }
        ]
      } as unknown as ModelMessage,
      makeToolImageStep('step4')
    ]

    const pruned = pruneSlidingWindowScreenshots(msgs, 2)
    expect(pruned).toHaveLength(4)

    // Visual steps #1 (msg 0) and #2 (msg 1) must be omitted with numbered placeholders
    const msg0Json = JSON.stringify(pruned[0])
    expect(msg0Json).not.toContain('USER_IMG_1')
    expect(msg0Json).toContain('[screenshot from step #1 omitted: see action summary]')

    const msg1Json = JSON.stringify(pruned[1])
    expect(msg1Json).not.toContain('IMG_step2')
    expect(msg1Json).toContain('Captured step2')
    expect(msg1Json).toContain('[screenshot from step #2 omitted: see action summary]')

    // Visual steps #3 (msg 2) and #4 (msg 3) must retain full images
    expect(JSON.stringify(pruned[2])).toContain('LEG_IMG_3')
    expect(JSON.stringify(pruned[3])).toContain('IMG_step4')

    // Original input objects stay unmutated
    expect(JSON.stringify(msgs[0])).toContain('USER_IMG_1')
    expect(JSON.stringify(msgs[1])).toContain('IMG_step2')
  })

  test('child streamText prepareStep prunes visual steps > 2 before model prompt delivery', async () => {
    const seenPrompts: string[] = []
    let shotCount = 0
    const childTools: ToolSet = {
      mcp__browser_use__browser_take_screenshot: tool({
        description: 'Take screenshot',
        inputSchema: z.object({}),
        execute: async () => {
          shotCount += 1
          return {
            content: `shot-${shotCount}`,
            images: [{ media_type: 'image/png', data: `SHOT_DATA_${shotCount}_${PNG_PREFIX}` }]
          }
        },
        toModelOutput: ({ output }) => {
          const o = output as { content: string; images: Array<{ media_type: string; data: string }> }
          return {
            type: 'content',
            value: [
              { type: 'text', text: o.content },
              ...o.images.map((img) => ({
                type: 'file' as const,
                mediaType: img.media_type,
                data: { type: 'data' as const, data: img.data }
              }))
            ]
          }
        }
      })
    }

    let step = 0
    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        seenPrompts.push(JSON.stringify(opts.prompt))
        const cur = step++
        if (cur < 3) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: `tc-${cur}`,
                  toolName: 'mcp__browser_use__browser_take_screenshot',
                  input: '{}'
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage: USAGE
                }
              ]
            })
          }
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: 'Observed 3 shots cleanly.' },
              { type: 'text-end' as const, id: 't1' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: undefined },
                usage: USAGE
              }
            ]
          })
        }
      }
    })

    const guard = new ApprovalGuard()
    const collector: GatewayToolAuditCollector = []
    const built = buildGatewayTools(
      {
        domain: mockDomain(() => okEnvelope([])),
        contextMode: 'manual_chat',
        approvalGuard: guard,
        approvalMode: 'bypass',
        computerUse: { model, childTools }
      },
      collector
    )

    const { output } = await invokeCuTool(
      built.computer_use_run,
      { goal: 'Take 3 viewport screenshots', target_hint: 'browser', stop_before_submit: true, max_steps: 5 },
      'cu-win-1'
    )
    const out = output as { status: string; final_screenshot_ref?: string }

    expect(out.status).toBe('completed')
    expect(seenPrompts).toHaveLength(4)
    // On step 4 (after 3 screenshot tool results), shot 1 must be pruned while shots 2 & 3 stay
    const finalPrompt = seenPrompts[3]!
    expect(finalPrompt).not.toContain('SHOT_DATA_1_')
    expect(finalPrompt).toContain('[screenshot from step #1 omitted: see action summary]')
    expect(finalPrompt).toContain('SHOT_DATA_2_')
    expect(finalPrompt).toContain('SHOT_DATA_3_')
    // Parent return value keeps concise ref only, never raw base64
    expect(JSON.stringify(out)).not.toContain(PNG_PREFIX)
  })
})

describe('Scope Guard — unsafe scheme blocker, domain suffix defense & output drift abort', () => {
  test('rejects unsafe schemes and suffix spoofing while admitting exact/subdomains', () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings'
    ]) {
      expect(validateNavigationUrl(bad).allowed, bad).toBe(false)
    }

    expect(validateNavigationUrl('https://oa.company.com/form', ['company.com']).allowed).toBe(true)
    expect(validateNavigationUrl('https://company.com', ['company.com']).allowed).toBe(true)
    expect(
      validateNavigationUrl('https://evil-oa.company.com.attacker.io/phish', ['company.com']).allowed
    ).toBe(false)
    expect(validateNavigationUrl('https://evilcompany.com', ['company.com']).allowed).toBe(false)

    expect(matchesAllowedApp('Microsoft Teams', ['Microsoft Teams'])).toBe(true)
    expect(matchesAllowedApp('1Password', ['Microsoft Teams'])).toBe(false)
    expect(matchesAllowedApp('Fake Microsoft Teams', ['Microsoft Teams'])).toBe(false)
  })

  test('pre-flight blocks file:// and suffix-spoofed domain with status=scope_violation', async () => {
    let innerExecuted = false
    const guard = new ApprovalGuard()
    const collector: GatewayToolAuditCollector = []
    const built = buildGatewayTools(
      {
        domain: mockDomain(() => okEnvelope([])),
        contextMode: 'manual_chat',
        approvalGuard: guard,
        approvalMode: 'bypass',
        computerUse: {
          model: new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'nav-1',
                    toolName: 'mcp__browser_use__browser_navigate',
                    input: JSON.stringify({ url: 'https://evil-oa.company.com.attacker.io/login' })
                  },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'tool-calls' as const, raw: undefined },
                    usage: USAGE
                  }
                ]
              })
            })
          }),
          childTools: {
            mcp__browser_use__browser_navigate: tool({
              description: 'Navigate',
              inputSchema: z.object({ url: z.string() }),
              execute: async () => {
                innerExecuted = true
                return { ok: true }
              }
            })
          }
        }
      },
      collector
    )

    const args = {
      goal: 'Open OA',
      target_hint: 'browser' as const,
      allowed_domains: ['company.com'],
      stop_before_submit: true,
      max_steps: 5
    }
    const { output } = await invokeCuTool(built.computer_use_run, args, 'cu-scope-1')
    const res = output as { status: string; reason: string; observed: string }

    expect(innerExecuted).toBe(false)
    expect(res.status).toBe('scope_violation')
    expect(res.reason).toBe('domain_not_allowed')
    expect(res.observed).toContain('attacker.io')
  })
})

describe('stop_before_submit terminal dock + parent-child isolation', () => {
  test('intercepts Submit click, persists child session decoupled from customAgentCallEnabled, isolates child tools', async () => {
    let submitClicked = false
    const createdSessions: Array<{ agentId: string; parentSessionId: number; invokedBy: string }> = []
    const seenChildTools: string[][] = []

    const dynamicTools = createConnectorTools(
      mockDomain((url) =>
        /\/invoke$/.test(url)
          ? okEnvelope({
              connector_id: 'browser_use',
              tool_name: 'browser_fill',
              content: 'Page URL: https://oa.company.com/expense\nFilled amount=250',
              images: [],
              is_error: false,
              truncated: false,
              elapsed_ms: 4
            })
          : okEnvelope({})
      ),
      [],
      new ApprovalGuard(),
      [
        cuEntry('browser_use', 'browser_fill', 'write', 'ask'),
        cuEntry('browser_use', 'browser_click', 'write', 'ask'),
        cuEntry('desktop_use', 'desktop_snapshot', 'read', 'auto')
      ],
      { contextMode: 'manual_chat' }
    )

    let step = 0
    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        seenChildTools.push((opts.tools ?? []).map((t) => t.name))
        const cur = step++
        if (cur === 0) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'c-fill',
                  toolName: 'mcp__browser_use__browser_fill',
                  input: JSON.stringify({ element: 'Amount', text: '250' })
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage: USAGE
                }
              ]
            })
          }
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'tool-call' as const,
                toolCallId: 'c-submit',
                toolName: 'mcp__browser_use__browser_click',
                input: JSON.stringify({ element: 'Submit Expense Button' })
              },
              {
                type: 'finish' as const,
                finishReason: { unified: 'tool-calls' as const, raw: undefined },
                usage: USAGE
              }
            ]
          })
        }
      }
    })

    // Wrap click so we observe whether underlying execution was prevented
    const clickTool = dynamicTools.mcp__browser_use__browser_click
    dynamicTools.mcp__browser_use__browser_click = {
      ...clickTool,
      execute: async (...a) => {
        submitClicked = true
        return clickTool.execute!(...a)
      }
    }

    const guard = new ApprovalGuard()
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      // Explicitly OFF to verify customAgentCallEnabled decoupling
      customAgentCallEnabled: false,
      parentSessionId: 42,
      findSessionByParentToolCall: () => null,
      createAgentCallSession: (inp) => {
        createdSessions.push(inp)
        return 9001
      },
      dynamicTools,
      computerUse: { model }
    })

    const input = {
      goal: 'Fill expense report 250 on OA and prepare for confirmation',
      target_hint: 'browser' as const,
      allowed_domains: ['company.com'],
      stop_before_submit: true,
      max_steps: 10
    }
    const { output } = await invokeCuTool(built.computer_use_run, input, 'cu-dock-1')
    const out = output as {
      status: string
      child_session_id: number
      filled_fields: Record<string, string>
      pending_action: string
      current_url_or_app: string
    }

    expect(submitClicked).toBe(false)
    expect(out.status).toBe('awaiting_confirmation')
    expect(out.child_session_id).toBe(9001)
    expect(out.filled_fields.Amount).toBe('250')
    expect(out.pending_action).toContain('Submit Expense Button')
    expect(out.current_url_or_app).toBe('https://oa.company.com/expense')
    expect(createdSessions).toEqual([
      expect.objectContaining({
        agentId: 'computer_use',
        parentSessionId: 42,
        invokedBy: 'main_agent'
      })
    ])
    // Child ToolSet contains ONLY browser tools matching target_hint='browser' (no desktop, no computer_use_run, no email tools)
    expect(seenChildTools[0]?.sort()).toEqual([
      'mcp__browser_use__browser_click',
      'mcp__browser_use__browser_fill'
    ])
    expect(selectComputerUseChildTools(built, 'auto')).not.toHaveProperty('computer_use_run')
  })

  test('fails with actionable /connectors error when no browser_use or desktop_use tools are active', async () => {
    const guard = new ApprovalGuard()
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      computerUse: {
        model: new MockLanguageModelV3({ doStream: async () => { throw new Error('unused') } })
      }
    })
    const args = { goal: 'Check app', target_hint: 'auto' as const, stop_before_submit: true, max_steps: 5 }
    await expect(invokeCuTool(built.computer_use_run, args, 'cu-missing')).rejects.toMatchObject({
      code: 'E_CONNECTOR_UNAVAILABLE',
      message: expect.stringContaining('/connectors')
    })
  })
})

describe('auto_scope_grant & venue isolation', () => {
  test('auto_scope_grant rejects empty lists, bare *, stop_before_submit=false, and non-manual modes', async () => {
    const mockEval = async () => ({
      decision: 'auto_allow' as const,
      rule_id: 77,
      audit_status: 'auto_scope_grant' as const,
      granted_apps: ['Microsoft Teams'],
      granted_domains: ['company.com']
    })
    const domain = mockDomain(() => okEnvelope({ decision: 'ask', rule_id: null }))

    // Rejects empty lists
    expect(
      isBoundedScopeForAutoGrant(
        { target_hint: 'auto', stop_before_submit: true },
        'manual_chat'
      )
    ).toBe(false)
    // Rejects bare '*' wildcard
    expect(
      isBoundedScopeForAutoGrant(
        { target_hint: 'browser', allowed_domains: ['*'], stop_before_submit: true },
        'manual_chat'
      )
    ).toBe(false)
    // Rejects stop_before_submit=false
    expect(
      isBoundedScopeForAutoGrant(
        { target_hint: 'browser', allowed_domains: ['company.com'], stop_before_submit: false },
        'manual_chat'
      )
    ).toBe(false)
    // Rejects non-manual contextMode
    expect(
      isBoundedScopeForAutoGrant(
        { target_hint: 'browser', allowed_domains: ['company.com'], stop_before_submit: true },
        'im_chat'
      )
    ).toBe(false)

    // Narrow manual_chat bounded scope matching rule returns auto_allow + auto_scope_grant
    const allowed = await evaluateComputerUsePolicy(
      {
        goal: 'Fill form',
        target_hint: 'browser',
        allowed_domains: ['company.com'],
        stop_before_submit: true,
        max_steps: 10
      },
      { contextMode: 'manual_chat', domain, evaluateAutoScopeGrant: mockEval }
    )
    expect(allowed).toEqual({
      decision: 'auto_allow',
      rule_id: 77,
      audit_status: 'auto_scope_grant'
    })

    // Exceeding owner rule's granted_domains fail-closes to ask
    const overWide = await evaluateComputerUsePolicy(
      {
        goal: 'Fill form',
        target_hint: 'browser',
        allowed_domains: ['external.org'],
        stop_before_submit: true,
        max_steps: 10
      },
      { contextMode: 'manual_chat', domain, evaluateAutoScopeGrant: mockEval }
    )
    expect(overWide).toEqual({ decision: 'ask', rule_id: null })
  })

  test('venue isolation strips computer_use_run outside manual_chat & in cron_headless even with grantExec', async () => {
    const guard = new ApprovalGuard()
    for (const mode of ['im_chat', 'untrusted_trigger', 'contact_governance', 'matter_followup', 'cron_headless'] as const) {
      const built = buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        contextMode: mode,
        approvalGuard: guard,
        computerUse: {}
      })
      expect(built.computer_use_run, `must strip in ${mode}`).toBeUndefined()
    }

    // Direct execute hard-rejects outside manual_chat
    const cuDirect = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      computerUse: {}
    })
    expect(String(cuDirect.computer_use_run.description)).toMatch(
      new RegExp(`^「${TOOL_DISPLAY_NAMES_ZH.computer_use_run}」`)
    )

    // cron_headless with grantExec:true must NOT expose computer_use_run through wrapCfgForAgentRun
    const spec: AgentRunSpec = {
      jobId: 1,
      agentId: 'exec_worker',
      agentTitle: 'Exec Worker',
      trigger: { kind: 'cron', firedAt: '2026-11-20T00:00:00Z' },
      prompt: { taskPrompt: 'Check workspace' },
      sessionTitle: 'Exec Worker Run',
      model: null,
      toolPolicy: { allowedTools: ['file_read'], skills: [], grantExec: true },
      budget: { maxRunSeconds: 60 }
    }
    let seenTools: string[] = []
    const wrapped = wrapCfgForAgentRun(
      {
        port: 0,
        baseUrl: 'https://crs.example/api',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async (opts) => {
              seenTools = (opts.tools ?? []).map((t) => t.name)
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'stream-start' as const, warnings: [] },
                    { type: 'text-start' as const, id: 't1' },
                    { type: 'text-delta' as const, id: 't1', delta: 'ok' },
                    { type: 'text-end' as const, id: 't1' },
                    {
                      type: 'finish' as const,
                      finishReason: { unified: 'stop' as const, raw: undefined },
                      usage: USAGE
                    }
                  ]
                })
              }
            }
          }),
        buildTools: (collector, approvalMode, mode, ctx) =>
          buildGatewayTools(
            {
              domain: mockDomain(() => okEnvelope([])),
              contextMode: mode,
              approvalMode,
              approvalGuard: guard,
              execToolsEnabled: true,
              agentRunContext: ctx,
              computerUse: {}
            },
            collector
          )
      },
      agentRunContextFromSpec(spec)
    )
    const prepared = await prepareChatRun(
      { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'run' }] }] },
      wrapped,
      new AbortController().signal,
      'cron_headless'
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected ok')
    await prepared.run.result.consumeStream()
    expect(seenTools).not.toContain('computer_use_run')

    // prepareChatRun with computerUseEnabled:false strips computer_use_run even in manual_chat
    const disabledPrepared = await prepareChatRun(
      { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'run' }] }] },
      {
        port: 0,
        baseUrl: 'https://crs.example/api',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        computerUseEnabled: false,
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  { type: 'text-start' as const, id: 't1' },
                  { type: 'text-delta' as const, id: 't1', delta: 'ok' },
                  { type: 'text-end' as const, id: 't1' },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'stop' as const, raw: undefined },
                    usage: USAGE
                  }
                ]
              })
            })
          }),
        buildTools: () => cuDirect
      },
      new AbortController().signal,
      'manual_chat'
    )
    expect(disabledPrepared.ok).toBe(true)
    if (disabledPrepared.ok) {
      expect(disabledPrepared.run.toolNames).not.toContain('computer_use_run')
    }
  })

  test('direct execute hard-rejects outside manual_chat and propagates parent AbortSignal', async () => {
    const guard = new ApprovalGuard()
    const untrustedTools = createComputerUseTools(
      mockDomain(() => okEnvelope([])),
      [],
      guard,
      { contextMode: 'untrusted_trigger' }
    )
    const args = { goal: 'steal', target_hint: 'browser' as const, stop_before_submit: true, max_steps: 5 }
    const denyNeed =
      typeof untrustedTools.computer_use_run.needsApproval === 'function'
        ? await untrustedTools.computer_use_run.needsApproval(args as never, {
            toolCallId: 'cu-deny',
            messages: []
          } as never)
        : untrustedTools.computer_use_run.needsApproval
    expect(denyNeed).toBe(false)
    await expect(invokeCuTool(untrustedTools.computer_use_run, args, 'cu-deny')).rejects.toMatchObject({
      code: 'E_CONTEXT_MODE_DENIED'
    })

    const ac = new AbortController()
    let childAborted = false
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      computerUse: {
        model: new MockLanguageModelV3({
          doStream: async (opts) => {
            opts.abortSignal?.addEventListener('abort', () => {
              childAborted = true
            })
            ac.abort(new Error('parent-cancelled'))
            throw new Error('aborted')
          }
        }),
        childTools: {
          mcp__browser_use__browser_snapshot: tool({
            description: 'Snapshot',
            inputSchema: z.object({}),
            execute: async () => ({ content: 'ok' })
          })
        }
      }
    })
    await expect(invokeCuTool(built.computer_use_run, args, 'cu-abort', ac.signal)).rejects.toThrow()
    expect(childAborted).toBe(true)
  })

  test('snake_case submit tool names dock at stop_before_submit & child stream failures throw instead of returning completed', async () => {
    const guard = new ApprovalGuard()
    let submitCalled = false
    const builtSubmit = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      computerUse: {
        model: new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'tc-snake-submit',
                  toolName: 'mcp__browser_use__browser_submit',
                  input: '{}'
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage: USAGE
                }
              ]
            })
          })
        }),
        childTools: {
          mcp__browser_use__browser_submit: tool({
            description: 'Submit form',
            inputSchema: z.object({}),
            execute: async () => {
              submitCalled = true
              return { ok: true }
            }
          })
        }
      }
    })
    const { output } = await invokeCuTool(
      builtSubmit.computer_use_run,
      { goal: 'Submit report', target_hint: 'browser', stop_before_submit: true, max_steps: 5 },
      'cu-snake-1'
    )
    expect(submitCalled).toBe(false)
    expect((output as { status: string; pending_action: string }).status).toBe(
      'awaiting_confirmation'
    )
    expect((output as { pending_action: string }).pending_action).toBe('browser_submit')

    // Upstream throw MUST reject cleanly (never swallow into status: 'completed')
    const builtThrow = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      computerUse: {
        model: new MockLanguageModelV3({
          doStream: async () => {
            throw new Error('upstream 500')
          }
        }),
        childTools: {
          mcp__browser_use__browser_snapshot: tool({
            description: 'Snapshot',
            inputSchema: z.object({}),
            execute: async () => ({ content: 'ok' })
          })
        }
      }
    })
    await expect(
      invokeCuTool(
        builtThrow.computer_use_run,
        { goal: 'Inspect page', target_hint: 'browser', stop_before_submit: true, max_steps: 5 },
        'cu-err-throw'
      )
    ).rejects.toThrow()

    // Stream error chunk MUST also reject cleanly
    const builtChunkErr = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      computerUse: {
        model: new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'error' as const, error: new Error('upstream rate limit 429') }
              ]
            })
          })
        }),
        childTools: {
          mcp__browser_use__browser_snapshot: tool({
            description: 'Snapshot',
            inputSchema: z.object({}),
            execute: async () => ({ content: 'ok' })
          })
        }
      }
    })
    await expect(
      invokeCuTool(
        builtChunkErr.computer_use_run,
        { goal: 'Inspect page', target_hint: 'browser', stop_before_submit: true, max_steps: 5 },
        'cu-err-chunk'
      )
    ).rejects.toThrow()
  })
})
