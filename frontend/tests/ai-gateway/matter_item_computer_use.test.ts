// WS-5 Mock/Replay E2E: `matter_item_run` + `propose_only` Computer Use Draft Closure:
//   - Belt 1 (`agentRun.ts`): `agentRunContextFromSpec` + `wrapCfgForAgentRun` itemReadFace admits
//     ONLY `computer_use_run` (not raw `mcp__*` / `run_command` / `file_*` / `email_send`)
//   - Belt 2 (`policy.ts` + `types.ts` + `computer_use.ts`): `isToolAllowedInContext` admits
//     `computer_use_run` under verified `propose_only`, hard-locks `stop_before_submit = true`,
//     rejects widened domains/apps (`E_SCOPE_VIOLATION`), audits `auto_scope_grant`
//   - Child Connector Isolation (`connector.ts` + `domainClient.ts`): `createComputerUseChildConnectorTools`
//     forwards `{ contextMode: 'matter_followup', agentId, jobId, dispatchId, childTool: 'computer_use_run' }`
//     and strips `destructive: true` tools
//   - Full closure: `matter_item_run` -> `computer_use_run` -> `awaiting_confirmation` ->
//     `matter_item_report` -> `/api/matters/.../item-dispatches/.../report` -> `/today` visibility
//   - Negative fail-closed: `autonomous` mode, `stopBeforeSubmit: false`, wildcard `'*'`, empty lists

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import {
  agentRunContextFromSpec,
  deriveContextMode,
  runHeadlessAgent,
  wrapCfgForAgentRun
} from '../../src/ai-gateway/agentRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import {
  createComputerUseChildConnectorTools,
  type ConnectorToolManifestEntry
} from '../../src/ai-gateway/tools/connector'
import { isToolClassAllowedInMode, resetRuntimeToolClasses } from '../../src/ai-gateway/tools/policy'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { AgentRunSpec } from '../../src/shared/api/types'
import { mockDomain, okEnvelope } from './tools/_helpers'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 6, text: 6, reasoning: 0 }
} as const

afterEach(() => {
  resetRuntimeToolClasses()
})

function makeItemSpec(overrides: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    jobId: 701,
    agentId: 'builtin',
    agentTitle: 'Matter Item Executor',
    runKind: 'matter_item_run',
    trigger: { kind: 'manual', firedAt: '2026-11-20T09:00:00Z' },
    prompt: { taskPrompt: 'Fill OA reimbursement form and stop before submit.' },
    sessionTitle: 'OA Draft Run',
    model: null,
    toolPolicy: { allowedTools: ['run_command', 'file_write'], skills: [] },
    matterItem: {
      matterId: 12,
      publicId: 'MAT-000012',
      matterTitle: 'OA Reimbursement Matter',
      itemId: 34,
      itemTitle: 'Submit OA Expense Draft',
      dispatchId: 88
    },
    computerUsePolicy: {
      enabled: true,
      mode: 'propose_only',
      stopBeforeSubmit: true,
      allowedApps: [],
      allowedDomains: ['oa.company.test'],
      connectors: ['browser_use']
    },
    budget: { maxRunSeconds: 120 },
    ...overrides
  }
}

function browserEntry(
  connectorId: 'browser_use' | 'desktop_use',
  toolName: string,
  destructive = false
): ConnectorToolManifestEntry {
  return {
    connectorId,
    connectorName: connectorId,
    toolName,
    description: `${connectorId}:${toolName}`,
    inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: true }),
    crudType: 'write',
    mode: 'ask', // Belt 3 permits active running propose_only computer_use_run child despite ask mode
    destructive,
    orphan: false
  }
}

describe('WS-5 matter_item_run (propose_only) Belt 1 + Belt 2 + Belt 3 caller + closure', () => {
  test('Full E2E closure: headless matter_item_run -> computer_use_run (hard stop_before_submit) -> awaiting_confirmation -> matter_item_report', async () => {
    const guard = new ApprovalGuard()
    const auditEntries: GatewayToolAuditEntry[] = []
    const seenOuterTools: string[][] = []
    const invokeCalls: Array<{
      connectorId: string
      toolName: string
      args: unknown
      caller: unknown
    }> = []
    const reportCalls: Array<{ publicId: string; dispatchId: number; body: unknown }> = []

    const domain = {
      ...mockDomain(() => okEnvelope([])),
      invokeConnectorTool: async (
        connectorId: string,
        toolName: string,
        args: Record<string, unknown> | undefined,
        _signal?: AbortSignal,
        caller?: unknown
      ) => {
        invokeCalls.push({ connectorId, toolName, args, caller })
        if (toolName === 'browser_navigate') {
          return {
            connector_id: connectorId,
            tool_name: toolName,
            content: 'current_url: https://oa.company.test/expense/42\nStatus: Form Loaded',
            is_error: false,
            truncated: false
          }
        }
        return {
          connector_id: connectorId,
          tool_name: toolName,
          content: 'Filled amount=1200',
          is_error: false,
          truncated: false
        }
      },
      reportItemDispatch: async (
        publicId: string,
        dispatchId: number,
        body: Record<string, unknown>
      ) => {
        reportCalls.push({ publicId, dispatchId, body })
        return {
          dispatch_id: dispatchId,
          state: 'proposed',
          update_id: 901,
          accepted: ['needs_input'],
          dropped: []
        }
      }
    } as unknown as MailAgentDomainClient

    const manifest: ConnectorToolManifestEntry[] = [
      browserEntry('browser_use', 'browser_navigate', false),
      browserEntry('browser_use', 'browser_fill_form', false),
      browserEntry('browser_use', 'browser_click', false),
      browserEntry('browser_use', 'browser_wipe_account', true),
      browserEntry('desktop_use', 'desktop_click', false)
    ]

    let outerStep = 0
    let childStep = 0
    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        const promptStr = JSON.stringify(opts.prompt)
        if (promptStr.includes('# Computer Use Sub-Agent Policy')) {
          childStep += 1
          if (childStep === 1) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'cu-nav',
                    toolName: 'mcp__browser_use__browser_navigate',
                    input: JSON.stringify({ url: 'https://oa.company.test/expense/42' })
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
          if (childStep === 2) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'cu-fill',
                    toolName: 'mcp__browser_use__browser_fill_form',
                    input: JSON.stringify({ fields: [{ name: 'amount', value: '1200' }] })
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
                  toolCallId: 'cu-submit',
                  toolName: 'mcp__browser_use__browser_click',
                  input: JSON.stringify({ element: 'Submit' })
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

        outerStep += 1
        if (outerStep === 1) {
          seenOuterTools.push((opts.tools ?? []).map((t) => t.name))
          // Model even tries passing stop_before_submit: false; Belt 2 MUST force true!
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'outer-cu-1',
                  toolName: 'computer_use_run',
                  input: JSON.stringify({
                    goal: 'Fill expense #42 on oa.company.test',
                    target_hint: 'browser',
                    allowed_domains: ['oa.company.test'],
                    stop_before_submit: false,
                    max_steps: 6
                  })
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
        if (outerStep === 2) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'outer-rep-2',
                  toolName: 'matter_item_report',
                  input: JSON.stringify({
                    summary: 'OA reimbursement draft prepared; awaiting human confirmation before Submit.',
                    needs_input: {
                      question: '已填好 oa.company.test 报销单（金额 1200），是否确认提交？',
                      options: ['确认提交', '取消修改']
                    }
                  })
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
              { type: 'text-start' as const, id: 'done-1' },
              {
                type: 'text-delta' as const,
                id: 'done-1',
                delta: 'Draft ready in OA portal; proposed awaiting_confirmation.'
              },
              { type: 'text-end' as const, id: 'done-1' },
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

    let manifestEnsureCount = 0
    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => model,
      ensureConnectorManifest: async () => {
        manifestEnsureCount += 1
      },
      buildTools: (collector, approvalMode, contextMode, agentRunContext) => {
        const matterCuPolicy = agentRunContext?.modeGrants?.matterItemComputerUse
        const childTools: ToolSet | undefined = matterCuPolicy
          ? createComputerUseChildConnectorTools(domain, collector, manifest, {
              connectors: matterCuPolicy.connectors,
              agentId: agentRunContext?.agentId,
              jobId: matterCuPolicy.jobId ?? agentRunContext?.jobId,
              dispatchId: matterCuPolicy.dispatchId
            })
          : undefined
        // Capture audit entries directly so we can assert approvalStatus
        const built = buildGatewayTools(
          {
            domain,
            writeToolsEnabled: true,
            execToolsEnabled: true,
            approvalGuard: guard,
            approvalMode,
            contextMode,
            agentRunContext,
            computerUse: childTools
              ? {
                  childTools,
                  forceStopBeforeSubmit: true,
                  matterItemPolicy: matterCuPolicy
                }
              : undefined
          },
          collector
        )
        // Mirror collector into outer auditEntries after run completes via Proxy-free push on finish?
        // Actually wrap collector or attach reference cleanly:
        const origPush = collector.push.bind(collector)
        collector.push = (...items) => {
          auditEntries.push(...items)
          return origPush(...items)
        }
        return built
      },
      persistTurn: () => {}
    }

    const spec = makeItemSpec()
    expect(deriveContextMode(spec)).toBe('matter_followup')

    const result = await runHeadlessAgent(
      cfg,
      { jobId: 701, spec, sessionId: null },
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.outcome).toBe('completed')
    expect(manifestEnsureCount).toBe(1)

    // Belt 1 verification: outer tool face has computer_use_run + matter_item_report,
    // ZERO raw mcp__browser_use__*, ZERO desktop_use, ZERO run_command/file_write/email_send.
    expect(seenOuterTools[0]).toContain('computer_use_run')
    expect(seenOuterTools[0]).toContain('matter_item_report')
    expect(seenOuterTools[0].some((n) => n.startsWith('mcp__'))).toBe(false)
    expect(seenOuterTools[0]).not.toContain('run_command')
    expect(seenOuterTools[0]).not.toContain('file_write')

    // Belt 3 caller forwarding + Submit docked BEFORE backend click + destructive tool omitted
    expect(invokeCalls.map((c) => c.toolName)).toEqual(['browser_navigate', 'browser_fill_form'])
    for (const c of invokeCalls) {
      expect(c.caller).toEqual({
        contextMode: 'matter_followup',
        agentId: 'builtin',
        jobId: 701,
        dispatchId: 88,
        childTool: 'computer_use_run'
      })
    }

    // matter_item_report closed the loop back to dispatch #88 on MAT-000012
    expect(reportCalls).toHaveLength(1)
    expect(reportCalls[0].publicId).toBe('MAT-000012')
    expect(reportCalls[0].dispatchId).toBe(88)

    // Audit recorded auto_scope_grant (no interactive card stall inside headless)
    const cuAudit = auditEntries.find((a) => a.toolName === 'computer_use_run')
    expect(cuAudit?.approvalStatus).toBe('auto_scope_grant')
    expect(cuAudit?.outputJson).toContain('"status":"awaiting_confirmation"')
    expect(cuAudit?.outputJson).toContain('"pending_action":"browser_click: Submit"')
  })

  test('Fail-closed guards: autonomous / stopBeforeSubmit:false / wildcards / scope widening reject', async () => {
    // 1. Spoofed autonomous / stopBeforeSubmit:false / wildcard / empty specs never mint matterItemComputerUse
    const badSpecs = [
      makeItemSpec({
        computerUsePolicy: {
          enabled: true,
          mode: 'autonomous' as never,
          stopBeforeSubmit: true,
          allowedDomains: ['oa.company.test'],
          connectors: ['browser_use']
        }
      }),
      makeItemSpec({
        computerUsePolicy: {
          enabled: true,
          mode: 'propose_only',
          stopBeforeSubmit: false,
          allowedDomains: ['oa.company.test'],
          connectors: ['browser_use']
        }
      }),
      makeItemSpec({
        computerUsePolicy: {
          enabled: true,
          mode: 'propose_only',
          stopBeforeSubmit: true,
          allowedApps: ['*'],
          allowedDomains: [],
          connectors: ['desktop_use']
        }
      }),
      makeItemSpec({
        computerUsePolicy: {
          enabled: true,
          mode: 'propose_only',
          stopBeforeSubmit: true,
          allowedApps: [],
          allowedDomains: [],
          connectors: ['browser_use']
        }
      })
    ]

    const guard = new ApprovalGuard()
    const domain = mockDomain(() => okEnvelope([]))

    for (const bad of badSpecs) {
      const ctx = agentRunContextFromSpec(bad, 701)
      expect(ctx.matterItemComputerUse).toBeUndefined()
      expect(ctx.modeGrants?.matterItemComputerUse).toBeUndefined()
      expect(isToolClassAllowedInMode('exec', 'matter_followup', ctx.modeGrants)).toBe(false)

      const wrapped = wrapCfgForAgentRun(
        {
          port: 0,
          baseUrl: 'https://crs.example/api',
          apiKey: 'sk-test',
          model: 'claude-sonnet-4-6',
          createModel: () =>
            new MockLanguageModelV3({
              doStream: async () => ({ stream: simulateReadableStream({ chunks: [] }) })
            }),
          buildTools: (collector, approvalMode, cm, runCtx) =>
            buildGatewayTools(
              {
                domain,
                contextMode: cm,
                approvalMode,
                approvalGuard: guard,
                agentRunContext: runCtx,
                computerUse: { forceStopBeforeSubmit: true }
              },
              collector
            )
        },
        ctx
      )
      const built = wrapped.buildTools!([], 'always', 'matter_followup', ctx)
      expect(built.computer_use_run).toBeUndefined()
    }

    // 2. Scope widening inside authorized matter_followup throws E_SCOPE_VIOLATION at runtime
    const validCtx = agentRunContextFromSpec(makeItemSpec(), 701)
    const builtValid = buildGatewayTools({
      domain,
      contextMode: 'matter_followup',
      approvalGuard: guard,
      agentRunContext: validCtx,
      computerUse: {
        forceStopBeforeSubmit: true,
        matterItemPolicy: validCtx.modeGrants!.matterItemComputerUse,
        childTools: createComputerUseChildConnectorTools(
          domain,
          [],
          [browserEntry('browser_use', 'browser_navigate', false)],
          { connectors: ['browser_use'], agentId: 'builtin', jobId: 701, dispatchId: 88 }
        )
      }
    })
    const widenInput = {
      goal: 'Visit external attacker domain',
      target_hint: 'browser',
      allowed_domains: ['attacker.example'],
      stop_before_submit: true,
      max_steps: 4
    }
    if (typeof builtValid.computer_use_run.needsApproval === 'function') {
      await builtValid.computer_use_run.needsApproval(
        widenInput as never,
        { toolCallId: 'cu-widen-1', messages: [] } as never
      )
    }
    await expect(
      builtValid.computer_use_run.execute!(
        widenInput as never,
        { toolCallId: 'cu-widen-1', messages: [] } as never
      )
    ).rejects.toThrow(/exceeds matter dispatch bounds|E_SCOPE_VIOLATION/i)
  })
})
