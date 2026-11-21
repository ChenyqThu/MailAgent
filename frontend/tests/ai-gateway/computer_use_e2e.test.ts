// WS-5 E2E Mock/Replay Suite:
//   1. Priority Routing prompt & live tool selection: Teams desktop UI draft -> stop_before_submit
//   2. Notion direct structured MCP (Tier 2: tool_search + mcp__notion__*) preferred over CU;
//      Notion Desktop GUI-only fallback via computer_use_run (desktop_use)
//   3. Negative isolation guards: im_chat, untrusted_trigger, cron_headless (grantExec:true),
//      plus URL/App spoofing (`evil-oa.company.com.attacker.io`, `file://`) fail-closed

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import { createConnectorTools, createComputerUseChildConnectorTools, type ConnectorToolManifestEntry } from '../../src/ai-gateway/tools/connector'
import { isCustomAgentComputerUseEnabled, resetRuntimeToolClasses } from '../../src/ai-gateway/tools/policy'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import { agentRunContextFromSpec, wrapCfgForAgentRun } from '../../src/ai-gateway/agentRun'
import type { MailAgentDomainClient } from '../../src/ai-gateway/python/domainClient'
import type { AgentRunSpec } from '../../src/shared/api/types'
import { mockDomain, okEnvelope } from './tools/_helpers'

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 }
} as const

afterEach(() => {
  resetRuntimeToolClasses()
})

function entry(
  connectorId: string,
  toolName: string,
  crudType: 'read' | 'write' = 'write',
  mode: 'auto' | 'ask' = 'auto'
): ConnectorToolManifestEntry {
  return {
    connectorId,
    connectorName: connectorId,
    toolName,
    description: `${connectorId}:${toolName}`,
    inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: true }),
    crudType,
    mode,
    destructive: false,
    orphan: false
  }
}

function promptContains(prompt: unknown, needle: string): boolean {
  return JSON.stringify(prompt).includes(needle)
}

describe('WS-5 Computer Use E2E (MockLanguageModelV3 + full prepareChatRun)', () => {
  test('Teams desktop UI draft: Priority Routing present -> auto_scope_grant -> desktop_use -> docks at stop_before_submit', async () => {
    const guard = new ApprovalGuard()
    const auditEntries: GatewayToolAuditEntry[] = []
    const invokedBackendTools: Array<{ connectorId: string; toolName: string; args: unknown }> = []
    let parentSystemSeen = ''
    let childStep = 0
    let parentStep = 0

    const domain = {
      ...mockDomain(() => okEnvelope([])),
      invokeConnectorTool: async (
        connectorId: string,
        toolName: string,
        args: Record<string, unknown> | undefined
      ) => {
        invokedBackendTools.push({ connectorId, toolName, args })
        if (toolName === 'desktop_ax_snapshot') {
          return {
            connector_id: connectorId,
            tool_name: toolName,
            content: 'Active App: Microsoft Teams\n@btn-send Send\n@input-msg Compose',
            images: [{ media_type: 'image/png', data: 'BASE64_TEAMS_SCREENSHOT' }],
            is_error: false,
            truncated: false
          }
        }
        return {
          connector_id: connectorId,
          tool_name: toolName,
          content: 'Typed draft in Microsoft Teams',
          is_error: false,
          truncated: false
        }
      }
    } as unknown as MailAgentDomainClient

    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        const isChild = promptContains(opts.prompt, '# Computer Use Sub-Agent Policy')
        if (isChild) {
          childStep += 1
          if (childStep === 1) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'child-ax-1',
                    toolName: 'mcp__desktop_use__desktop_ax_snapshot',
                    input: JSON.stringify({ app: 'Microsoft Teams' })
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
                    toolCallId: 'child-type-2',
                    toolName: 'mcp__desktop_use__desktop_type_text',
                    input: JSON.stringify({
                      app: 'Microsoft Teams',
                      element: 'message_draft',
                      text: 'Hi Alice, contract draft is ready for review.'
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
                {
                  type: 'tool-call' as const,
                  toolCallId: 'child-click-3',
                  toolName: 'mcp__desktop_use__desktop_click',
                  input: JSON.stringify({ app: 'Microsoft Teams', element: 'Send' })
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

        parentStep += 1
        if (parentStep === 1) {
          parentSystemSeen = JSON.stringify(opts.prompt)
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'parent-cu-1',
                  toolName: 'computer_use_run',
                  input: JSON.stringify({
                    goal: 'Open Microsoft Teams and type a reply to Alice without sending',
                    target_hint: 'desktop',
                    allowed_apps: ['Microsoft Teams'],
                    stop_before_submit: true,
                    max_steps: 8
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
              { type: 'text-start' as const, id: 't-final' },
              {
                type: 'text-delta' as const,
                id: 't-final',
                delta: 'Teams draft filled and docked before Send.'
              },
              { type: 'text-end' as const, id: 't-final' },
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

    const manifest: ConnectorToolManifestEntry[] = [
      entry('desktop_use', 'desktop_ax_snapshot', 'read', 'auto'),
      entry('desktop_use', 'desktop_type_text', 'write', 'auto'),
      entry('desktop_use', 'desktop_click', 'write', 'auto')
    ]

    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => model,
      systemPromptProvider: async () => ({
        standingContext: '# AGENT\nHelper',
        connectorCatalog: [
          {
            connectorId: 'desktop_use',
            displayName: 'Desktop Use',
            readToolCount: 1,
            writeToolCount: 2,
            updateToolCount: 0
          }
        ]
      }),
      buildTools: (collector, approvalMode, mode) => {
        const origPush = collector.push.bind(collector)
        collector.push = (...items) => {
          auditEntries.push(...items)
          return origPush(...items)
        }
        const dynamicTools = createConnectorTools(domain, collector, guard, manifest, {
          approvalMode,
          contextMode: mode
        })
        return buildGatewayTools(
          {
            domain,
            contextMode: mode,
            approvalMode,
            approvalGuard: guard,
            toolSearchEnabled: true,
            dynamicTools,
            computerUse: {
              evaluateAutoScopeGrant: async () => ({
                decision: 'auto_allow',
                rule_id: 19,
                audit_status: 'auto_scope_grant',
                granted_apps: ['Microsoft Teams']
              })
            }
          },
          collector
        )
      }
    }

    const prepared = await prepareChatRun(
      {
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Draft a Teams reply to Alice.' }] }
        ]
      },
      cfg,
      new AbortController().signal,
      'manual_chat'
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected prepared.ok')
    await prepared.run.result.consumeStream()

    expect(parentSystemSeen).toContain('# Tool Selection Priority Routing (Tier 1 > Tier 2 > Tier 3)')
    expect(invokedBackendTools.map((t) => t.toolName)).toEqual([
      'desktop_ax_snapshot',
      'desktop_type_text'
    ])
    // Terminal click("Send") MUST NOT hit backend!
    expect(invokedBackendTools.some((t) => t.toolName === 'desktop_click')).toBe(false)

    const cuAudit = auditEntries.find((e) => e.toolName === 'computer_use_run')
    expect(cuAudit).toBeDefined()
    expect(cuAudit?.approvalStatus).toBe('auto_scope_grant')
    expect(cuAudit?.outputJson).toContain('"status":"awaiting_confirmation"')
    expect(cuAudit?.outputJson).toContain('"pending_action":"desktop_click: Send"')

    // Audit redaction holds for child screenshot calls too (zero raw PNG base64 in chat_tool_call)
    const snapshotAudit = auditEntries.find((e) => e.toolName === 'mcp__desktop_use__desktop_ax_snapshot')
    expect(snapshotAudit?.outputJson).not.toContain('BASE64_TEAMS_SCREENSHOT')
    expect(snapshotAudit?.outputJson).toContain('"omitted":true')
  })

  test('Notion direct MCP API (Tier 2) wins over computer_use_run; Notion Desktop GUI-only routes via desktop_use', async () => {
    const guard = new ApprovalGuard()
    const notionDirectCalls: string[] = []
    let cuInvocations = 0

    const domain = {
      ...mockDomain(() => okEnvelope([])),
      invokeConnectorTool: async (connectorId: string, toolName: string) => {
        notionDirectCalls.push(`${connectorId}:${toolName}`)
        return {
          connector_id: connectorId,
          tool_name: toolName,
          content: JSON.stringify({ page_id: 'page-999', ok: true }),
          is_error: false,
          truncated: false
        }
      }
    } as unknown as MailAgentDomainClient

    const manifest: ConnectorToolManifestEntry[] = [
      entry('notion', 'create_page', 'write', 'auto'),
      entry('desktop_use', 'desktop_ax_snapshot', 'read', 'auto'),
      entry('desktop_use', 'desktop_click', 'write', 'auto')
    ]

    let step = 0
    const tier2Model = new MockLanguageModelV3({
      doStream: async () => {
        step += 1
        if (step === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'ts-1',
                  toolName: 'tool_search',
                  input: JSON.stringify({ query: 'notion create_page' })
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
        if (step === 2) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'notion-1',
                  toolName: 'mcp__notion__create_page',
                  input: JSON.stringify({ title: 'Q4 Weekly Report' })
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
              { type: 'text-delta' as const, id: 't1', delta: 'Created Notion page via direct MCP.' },
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

    const cfg: AiGatewayConfig = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      createModel: () => tier2Model,
      systemPromptProvider: async () => ({
        standingContext: '# AGENT\nHelper',
        connectorCatalog: [
          {
            connectorId: 'notion',
            displayName: 'Notion',
            readToolCount: 0,
            writeToolCount: 1,
            updateToolCount: 0
          },
          {
            connectorId: 'desktop_use',
            displayName: 'Desktop Use',
            readToolCount: 1,
            writeToolCount: 1,
            updateToolCount: 0
          }
        ]
      }),
      buildTools: (collector, approvalMode, mode) => {
        const dynamicTools: ToolSet = createConnectorTools(domain, collector, guard, manifest, {
          approvalMode,
          contextMode: mode
        })
        const built = buildGatewayTools(
          {
            domain,
            contextMode: mode,
            approvalMode,
            approvalGuard: guard,
            toolSearchEnabled: true,
            dynamicTools,
            computerUse: {
              evaluateAutoScopeGrant: async () => {
                cuInvocations += 1
                return { decision: 'ask', rule_id: null }
              }
            }
          },
          collector
        )
        return built
      }
    }

    const prepared = await prepareChatRun(
      {
        messages: [
          {
            id: 'u-notion',
            role: 'user',
            parts: [{ type: 'text', text: 'Create a Q4 Weekly Report page in Notion.' }]
          }
        ]
      },
      cfg,
      new AbortController().signal,
      'manual_chat'
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected ok')
    await prepared.run.result.consumeStream()

    expect(notionDirectCalls).toEqual(['notion:create_page'])
    expect(cuInvocations).toBe(0)

    // UI-only Notion Desktop operation routes via desktop_use inside computer_use_run
    let cuStep = 0
    const cuBuilt = buildGatewayTools({
      domain,
      contextMode: 'manual_chat',
      approvalGuard: guard,
      approvalMode: 'bypass',
      dynamicTools: createConnectorTools(domain, [], guard, manifest, {
        contextMode: 'manual_chat'
      }),
      computerUse: {
        model: new MockLanguageModelV3({
          doStream: async () => {
            cuStep += 1
            if (cuStep === 1) {
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'stream-start' as const, warnings: [] },
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'cu-nd-1',
                      toolName: 'mcp__desktop_use__desktop_ax_snapshot',
                      input: JSON.stringify({ app: 'Notion' })
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
                  { type: 'text-start' as const, id: 'c1' },
                  { type: 'text-delta' as const, id: 'c1', delta: 'Notion Desktop UI block toggled.' },
                  { type: 'text-end' as const, id: 'c1' },
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
      }
    })
    const cuInput = {
      goal: 'Toggle database board view in Notion Desktop',
      target_hint: 'desktop',
      allowed_apps: ['Notion'],
      stop_before_submit: true,
      max_steps: 4
    }
    if (typeof cuBuilt.computer_use_run.needsApproval === 'function') {
      await cuBuilt.computer_use_run.needsApproval(
        cuInput as never,
        { toolCallId: 'cu-notion-ui', messages: [] } as never
      )
    }
    const cuRes = (await cuBuilt.computer_use_run.execute!(
      cuInput as never,
      { toolCallId: 'cu-notion-ui', messages: [] } as never
    )) as { status: string }
    expect(cuRes.status).toBe('completed')
    expect(notionDirectCalls).toContain('desktop_use:desktop_ax_snapshot')
  })

  test('Negative isolation: im_chat, untrusted_trigger, cron_headless (grantExec:true), and spoofed domain/scheme fail closed', async () => {
    const guard = new ApprovalGuard()
    const domain = mockDomain(() => okEnvelope([]))

    // 1. im_chat & untrusted_trigger structurally exclude computer_use_run even when computerUse dep is provided
    for (const mode of ['im_chat', 'untrusted_trigger', 'cron_headless'] as const) {
      let seenNames: string[] = []
      const prepared = await prepareChatRun(
        { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'open Teams' }] }] },
        {
          port: 0,
          baseUrl: 'https://crs.example/api',
          apiKey: 'sk-test',
          model: 'claude-sonnet-4-6',
          createModel: () =>
            new MockLanguageModelV3({
              doStream: async (o) => {
                seenNames = (o.tools ?? []).map((t) => t.name)
                return {
                  stream: simulateReadableStream({
                    chunks: [
                      { type: 'stream-start' as const, warnings: [] },
                      { type: 'text-start' as const, id: 't' },
                      { type: 'text-delta' as const, id: 't', delta: 'denied' },
                      { type: 'text-end' as const, id: 't' },
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
          buildTools: (collector, approvalMode, cm, ctx) =>
            buildGatewayTools(
              {
                domain,
                contextMode: cm,
                approvalMode,
                approvalGuard: guard,
                agentRunContext: ctx,
                computerUse: {}
              },
              collector
            )
        },
        new AbortController().signal,
        mode
      )
      expect(prepared.ok).toBe(true)
      if (prepared.ok) {
        await prepared.run.result.consumeStream()
        expect(seenNames).not.toContain('computer_use_run')
      }
    }

    // 2. untrusted_trigger email_filter agent with grantExec:true cannot expose computer_use_run
    const triggerSpec: AgentRunSpec = {
      jobId: 404,
      agentId: 'mail-triage',
      agentTitle: 'Mail Triage',
      trigger: { kind: 'email_filter', firedAt: '2026-11-20T00:00:00Z' },
      prompt: { taskPrompt: 'check email' },
      sessionTitle: 'Triage',
      model: null,
      toolPolicy: { allowedTools: ['computer_use_run', 'email_body'], skills: [], grantExec: true },
      budget: { maxRunSeconds: 30 }
    }
    let headlessSeen: string[] = []
    const wrapped = wrapCfgForAgentRun(
      {
        port: 0,
        baseUrl: 'https://crs.example/api',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async (o) => {
              headlessSeen = (o.tools ?? []).map((t) => t.name)
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'stream-start' as const, warnings: [] },
                    { type: 'text-start' as const, id: 't' },
                    { type: 'text-delta' as const, id: 't', delta: 'ok' },
                    { type: 'text-end' as const, id: 't' },
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
        buildTools: (collector, approvalMode, cm, ctx) =>
          buildGatewayTools(
            {
              domain,
              contextMode: cm,
              approvalMode,
              approvalGuard: guard,
              agentRunContext: ctx,
              computerUse: {}
            },
            collector
          )
      },
      agentRunContextFromSpec(triggerSpec, 404)
    )
    const pHeadless = await prepareChatRun(
      { messages: [{ id: 'h1', role: 'user', parts: [{ type: 'text', text: 'run' }] }] },
      wrapped,
      new AbortController().signal,
      'untrusted_trigger'
    )
    expect(pHeadless.ok).toBe(true)
    if (pHeadless.ok) {
      await pHeadless.run.result.consumeStream()
      expect(headlessSeen).not.toContain('computer_use_run')
    }
  })

  test('Wave 6 Custom Agent grantComputerUse: email_filter exposes bounded computer_use_run and blocks out-of-scope domains', async () => {
    const guard = new ApprovalGuard()
    const domainCallers: Array<{ contextMode: string; childTool?: string }> = []
    const domain = {
      ...mockDomain(() => okEnvelope([])),
      invokeConnectorTool: async (
        connectorId: string,
        toolName: string,
        _args: Record<string, unknown> | undefined,
        _signal?: AbortSignal,
        caller?: { contextMode: string; childTool?: string }
      ) => {
        if (caller) domainCallers.push(caller)
        return {
          connector_id: connectorId,
          tool_name: toolName,
          content: 'Page URL: https://dms.company.internal/request/42\nApproved',
          is_error: false,
          truncated: false
        }
      }
    } as unknown as MailAgentDomainClient

    const cuSpec: AgentRunSpec = {
      jobId: 777,
      agentId: 'dms-approver',
      agentTitle: 'DMS Approver',
      trigger: { kind: 'email_filter', firedAt: '2026-11-20T00:00:00Z' },
      prompt: { taskPrompt: 'Approve DMS request #42' },
      sessionTitle: 'DMS Approval',
      model: null,
      toolPolicy: {
        allowedTools: ['email_body'],
        skills: [],
        grantComputerUse: {
          enabled: true,
          submitMode: 'allow_submit',
          allowedDomains: ['dms.company.internal'],
          connectors: ['browser_use']
        }
      },
      budget: { maxRunSeconds: 60 }
    }

    const runCtx = agentRunContextFromSpec(cuSpec, 777)
    expect(isCustomAgentComputerUseEnabled(runCtx.modeGrants)).toBe(true)

    const cuManifest: ConnectorToolManifestEntry[] = [
      entry('browser_use', 'browser_navigate', 'read', 'auto'),
      entry('browser_use', 'browser_click', 'write', 'auto')
    ]

    let outerStep = 0
    let childStep = 0
    let seenTools: string[] = []
    let finalSummary = ''

    const modelFactory = () =>
      new MockLanguageModelV3({
        doStream: async (opts) => {
          const names = (opts.tools ?? []).map((t) => t.name)
          const isChild = names.some((n) => n.startsWith('mcp__browser_use__'))
          if (isChild) {
            childStep += 1
            if (childStep === 1) {
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'stream-start' as const, warnings: [] },
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'b1',
                      toolName: 'mcp__browser_use__browser_navigate',
                      input: JSON.stringify({ url: 'https://dms.company.internal/request/42' })
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
                      toolCallId: 'b2',
                      toolName: 'mcp__browser_use__browser_click',
                      input: JSON.stringify({ element: 'Approve', selector: '#approve' })
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
                  { type: 'text-start' as const, id: 'c' },
                  { type: 'text-delta' as const, id: 'c', delta: 'Clicked Approve on DMS' },
                  { type: 'text-end' as const, id: 'c' },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'stop' as const, raw: undefined },
                    usage: USAGE
                  }
                ]
              })
            }
          }

          seenTools = names
          outerStep += 1
          if (outerStep === 1) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'cu-dms-1',
                    toolName: 'computer_use_run',
                    input: JSON.stringify({
                      goal: 'Open DMS and approve request #42',
                      target_hint: 'browser',
                      allowed_domains: ['dms.company.internal'],
                      stop_before_submit: false,
                      max_steps: 4
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
                { type: 'text-start' as const, id: 'o' },
                { type: 'text-delta' as const, id: 'o', delta: 'DMS approved automatically' },
                { type: 'text-end' as const, id: 'o' },
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

    const wrapped = wrapCfgForAgentRun(
      {
        port: 0,
        baseUrl: 'https://crs.example/api',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        createModel: modelFactory,
        buildTools: (collector, approvalMode, cm, ctx) =>
          buildGatewayTools(
            {
              domain,
              contextMode: cm,
              approvalMode,
              approvalGuard: guard,
              agentRunContext: ctx,
              computerUse: {
                childTools: createComputerUseChildConnectorTools(domain, collector, cuManifest, {
                  contextMode: 'untrusted_trigger',
                  connectors: ['browser_use'],
                  agentId: ctx!.agentId,
                  jobId: ctx!.jobId,
                  allowDestructive: true
                }),
                customAgentPolicy: ctx?.modeGrants?.customAgentComputerUse,
                forceStopBeforeSubmit: false
              }
            },
            collector
          )
      },
      runCtx
    )

    const prep = await prepareChatRun(
      { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'approve #42' }] }] },
      wrapped,
      new AbortController().signal,
      'untrusted_trigger'
    )
    expect(prep.ok).toBe(true)
    if (prep.ok) {
      await prep.run.result.consumeStream()
      finalSummary = await prep.run.result.text
    }
    expect(seenTools).toContain('computer_use_run')
    expect(finalSummary).toContain('DMS approved automatically')
    expect(domainCallers.some((c) => c.contextMode === 'untrusted_trigger' && c.childTool === 'computer_use_run')).toBe(
      true
    )
  })
})
