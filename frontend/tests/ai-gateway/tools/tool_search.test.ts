// WS-2 Plane 1 (computer-use-mcp epic §3.1) — LLM Schema Lazy Loading (`tool_search` +
// `partitionToolsForLazyLoading` + `prepareStep` `activeTools` + `stable_prompt` L0 catalog).

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream, type ToolSet } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { prepareChatRun } from '../../../src/ai-gateway/chatRun'
import { agentRunContextFromSpec, wrapCfgForAgentRun } from '../../../src/ai-gateway/agentRun'
import type { AgentRunSpec } from '../../../src/shared/api/types'
import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createConnectorTools,
  type ConnectorToolManifestEntry
} from '../../../src/ai-gateway/tools/connector'
import { resetRuntimeToolClasses } from '../../../src/ai-gateway/tools/policy'
import {
  LAZY_EAGER_PIN_THRESHOLD,
  bindToolSearchPartition,
  createToolSearchTool,
  partitionToolsForLazyLoading,
  searchDeferredTools
} from '../../../src/ai-gateway/tools/tool_search'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { buildGatewaySystemPrompt } from '../../../src/ai-gateway/systemPrompt'
import { TOOL_DISPLAY_NAMES_ZH } from '../../../src/shared/assistant/toolDisplayNames'
import type { MailAgentUIMessage } from '../../../src/shared/assistant/uiMessage'
import { mockDomain, okEnvelope } from './_helpers'

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 6, text: 6, reasoning: 0 }
} as const

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function mcpEntry(
  connectorId: string,
  toolName: string,
  overrides: Partial<ConnectorToolManifestEntry> = {}
): ConnectorToolManifestEntry {
  return {
    connectorId,
    connectorName: connectorId,
    toolName,
    description: `${connectorId} tool ${toolName}`,
    inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
    crudType: 'read',
    mode: 'auto',
    destructive: false,
    orphan: false,
    ...overrides
  }
}

function makeMcpToolSet(count: number, connectorId = 'notion'): ToolSet {
  const entries = Array.from({ length: count }, (_, idx) =>
    mcpEntry(connectorId, `action_${idx}`, {
      description:
        idx === 2
          ? 'Search workspace pages and databases by title'
          : `${connectorId} operation number ${idx}`
    })
  )
  return createConnectorTools(
    mockDomain(() => okEnvelope({})),
    [],
    new ApprovalGuard(),
    entries,
    { contextMode: 'manual_chat' }
  )
}

afterEach(() => {
  resetRuntimeToolClasses()
})

describe('partitionToolsForLazyLoading — eager pin vs deferral + history pinning', () => {
  test(`<= ${LAZY_EAGER_PIN_THRESHOLD} mcp__* tools → eager-pinned on Step 0, tool_search hidden`, () => {
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      toolSearchEnabled: true,
      dynamicTools: makeMcpToolSet(LAZY_EAGER_PIN_THRESHOLD, 'notion')
    })

    const part = partitionToolsForLazyLoading(built, [])
    expect(part.deferredToolNames).toEqual([])
    expect(part.initialActiveTools).not.toContain('tool_search')
    for (let i = 0; i < LAZY_EAGER_PIN_THRESHOLD; i++) {
      expect(part.initialActiveTools).toContain(`mcp__notion__action_${i}`)
    }
  })

  test(`> ${LAZY_EAGER_PIN_THRESHOLD} mcp__* tools → deferred on Step 0, tool_search exposed`, () => {
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      toolSearchEnabled: true,
      dynamicTools: makeMcpToolSet(8, 'notion')
    })

    const part = partitionToolsForLazyLoading(built, [])
    expect(part.deferredToolNames).toHaveLength(8)
    expect(part.initialActiveTools).toContain('tool_search')
    expect(part.initialActiveTools).toContain('email_list_filter')
    for (const name of part.deferredToolNames) {
      expect(part.initialActiveTools).not.toContain(name)
      expect(part.activatedTools.has(name)).toBe(false)
    }
  })

  test('history references and pending approvals pin deferred tools without reviving denied tools', () => {
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      toolSearchEnabled: true,
      dynamicTools: makeMcpToolSet(7, 'notion')
    })

    const history = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-mcp__notion__action_1',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: {},
            output: { ok: true }
          },
          {
            type: 'dynamic-tool',
            toolName: 'mcp__notion__action_4',
            toolCallId: 'tc-2',
            state: 'approval-requested',
            input: {},
            approval: { id: 'ap-1' }
          },
          {
            // Blocked / un-admitted tool from an earlier turn must never be pinned.
            type: 'tool-mcp__notion__revoked_tool',
            toolCallId: 'tc-3',
            state: 'output-available',
            input: {},
            output: {}
          }
        ]
      }
    ] as unknown as MailAgentUIMessage[]

    const part = partitionToolsForLazyLoading(built, history)
    expect(part.historyPinnedTools.sort()).toEqual([
      'mcp__notion__action_1',
      'mcp__notion__action_4'
    ])
    expect(part.initialActiveTools).toContain('mcp__notion__action_1')
    expect(part.initialActiveTools).toContain('mcp__notion__action_4')
    expect(part.initialActiveTools).not.toContain('mcp__notion__revoked_tool')
    expect(part.deferredToolNames).toHaveLength(5)
    expect(part.initialActiveTools).toContain('tool_search')
  })

  test('toolSearchEnabled: false keeps every tool active and omits deferral', () => {
    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      toolSearchEnabled: true,
      dynamicTools: makeMcpToolSet(8, 'notion')
    })
    const part = partitionToolsForLazyLoading(built, [], { toolSearchEnabled: false })
    expect(part.deferredToolNames).toEqual([])
    expect(part.initialActiveTools.sort()).toEqual(Object.keys(built).sort())
  })
})

describe('searchDeferredTools & createToolSearchTool — ranking, caps, audit, and security', () => {
  test('empty query and connector_id reject with E_INVALID_ARG', async () => {
    const collector: GatewayToolAuditCollector = []
    const tool = createToolSearchTool({ deferredTools: {}, activatedTools: new Set() }, collector)
    await expect(
      tool.execute!({ query: '   ', category: 'all', limit: 5 }, {
        toolCallId: 'tc-bad',
        messages: []
      } as never)
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
  })

  test('scores English & Chinese queries, filters by connector_id/category, clamps summaries <= 160', async () => {
    const collector: GatewayToolAuditCollector = []
    const longDesc = 'Capture a full-page browser viewport screenshot '.repeat(8).trim()
    const mcpTools = createConnectorTools(
      mockDomain(() => okEnvelope({})),
      [],
      new ApprovalGuard(),
      [
        mcpEntry('chrome-devtools', 'take_screenshot', { description: longDesc }),
        mcpEntry('chrome-devtools', 'click_element', { description: 'Click a DOM element by selector' }),
        mcpEntry('notion', 'search_pages', { description: 'Search Notion workspace pages' })
      ],
      { contextMode: 'manual_chat' }
    )
    const allBuilt = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      configToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      toolSearchEnabled: true,
      dynamicTools: mcpTools
    })
    const partition = partitionToolsForLazyLoading(allBuilt, [], {
      eagerPinThreshold: 0,
      deferredBuiltinToolNames: ['agent_profile_read']
    })
    const ok = bindToolSearchPartition(allBuilt.tool_search, allBuilt, partition)
    expect(ok).toBe(true)

    // Tool display name injection applied in buildGatewayTools
    expect(String(allBuilt.tool_search.description)).toMatch(
      new RegExp(`^「${TOOL_DISPLAY_NAMES_ZH.tool_search}」`)
    )

    // Connector search accepts normalized dash/underscore connector_id
    const chromeMatches = searchDeferredTools(
      { deferredTools: Object.fromEntries(partition.deferredToolNames.map((n) => [n, allBuilt[n]])), activatedTools: partition.activatedTools },
      { connector_id: 'chrome-devtools', query: 'screenshot', category: 'connector', limit: 5 }
    )
    expect(chromeMatches.activated_tools[0]).toBe('mcp__chrome_devtools__take_screenshot')
    expect(chromeMatches.matches[0]?.summary.length).toBeLessThanOrEqual(160)
    expect(chromeMatches.matches[0]?.connector_id).toBe('chrome_devtools')
    expect(partition.activatedTools.has('mcp__chrome_devtools__take_screenshot')).toBe(true)

    // Chinese query over deferred builtin uses TOOL_DISPLAY_NAMES_ZH
    const builtinTool = createToolSearchTool(
      {
        deferredTools: Object.fromEntries(partition.deferredToolNames.map((n) => [n, allBuilt[n]])),
        activatedTools: partition.activatedTools
      },
      collector
    )
    const zhOut = (await builtinTool.execute!(
      { query: '身份文档', category: 'builtin', limit: 5 },
      { toolCallId: 'tc-zh', messages: [] } as never
    )) as { activated_tools: string[]; matches: Array<{ category: string }> }
    expect(zhOut.activated_tools).toEqual(['agent_profile_read'])
    expect(zhOut.matches[0]?.category).toBe('builtin')
    expect(collector.map((e) => e.toolName)).toContain('tool_search')
  })

  test('denied, per-tool off, and mode-blocked tools are never exposed in candidate index', () => {
    const mcpTools = createConnectorTools(
      mockDomain(() => okEnvelope({})),
      [],
      new ApprovalGuard(),
      [
        mcpEntry('notion', 'allowed_read'),
        mcpEntry('notion', 'turned_off_read', { mode: 'off' }),
        mcpEntry('notion', 'write_item', { crudType: 'write', mode: 'ask' }),
        mcpEntry('disabled_conn', 'hidden_tool')
      ],
      {
        contextMode: 'untrusted_trigger',
        connectorGrants: { notion: 'read' }
      }
    )
    const manualMutedMcp = createConnectorTools(
      mockDomain(() => okEnvelope({})),
      [],
      new ApprovalGuard(),
      [mcpEntry('disabled_conn', 'hidden_tool')],
      { contextMode: 'manual_chat', disabledConnectors: ['disabled_conn'] }
    )
    expect(manualMutedMcp.mcp__disabled_conn__hidden_tool).toBeUndefined()

    const built = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'untrusted_trigger',
      toolSearchEnabled: true,
      dynamicTools: mcpTools
    })

    const partition = partitionToolsForLazyLoading(built, [], { eagerPinThreshold: 0 })
    const deferredSet = Object.fromEntries(partition.deferredToolNames.map((n) => [n, built[n]]))
    const res = searchDeferredTools(
      { deferredTools: deferredSet, activatedTools: partition.activatedTools },
      { query: 'notion hidden write turned_off allowed', category: 'all', limit: 25 }
    )
    expect(res.activated_tools).toEqual(['mcp__notion__allowed_read'])
    expect(built.mcp__notion__turned_off_read).toBeUndefined()
    expect(built.mcp__notion__write_item).toBeUndefined()
    expect(built.mcp__disabled_conn__hidden_tool).toBeUndefined()
  })
})

describe('prepareChatRun + prepareStep + MockLanguageModelV3 — end-to-end lazy loading', () => {
  test('Step 0 hides deferred mcp__* tools; tool_search unlocks one for Step 1 in the SAME run', async () => {
    const manifestEntries: ConnectorToolManifestEntry[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        mcpEntry('notion', `page_op_${i}`, { description: `Notion page operation ${i}` })
      ),
      mcpEntry('chrome_devtools', 'take_screenshot', {
        description: 'Take a PNG screenshot of the active Chrome tab'
      }),
      mcpEntry('chrome_devtools', 'click_button', {
        description: 'Click an interactive UI button'
      })
    ]

    const connectorDomain = mockDomain((url) =>
      /\/invoke$/.test(url)
        ? okEnvelope({
            connector_id: 'chrome_devtools',
            tool_name: 'take_screenshot',
            content: 'Screenshot taken cleanly.',
            images: [{ media_type: 'image/png', data: PNG_1X1_B64 }],
            is_error: false,
            truncated: false,
            elapsed_ms: 5
          })
        : okEnvelope([])
    )

    const seenToolNamesPerStep: string[][] = []
    const seenPrompts: unknown[] = []
    let stepIdx = 0

    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        seenPrompts.push(opts.prompt)
        const names = (opts.tools ?? []).map((t) => t.name)
        seenToolNamesPerStep.push(names)
        const step = stepIdx++

        if (step === 0) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'tc-search-1',
                  toolName: 'tool_search',
                  input: JSON.stringify({
                    query: 'screenshot',
                    connector_id: 'chrome_devtools',
                    category: 'connector',
                    limit: 5
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
        if (step === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'tc-shot-1',
                  toolName: 'mcp__chrome_devtools__take_screenshot',
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
              { type: 'text-delta' as const, id: 't1', delta: 'Captured screenshot.' },
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

    const prepared = await prepareChatRun(
      {
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Take a Chrome screenshot' }] }
        ]
      },
      {
        port: 0,
        baseUrl: 'https://crs.example/api',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        toolSearchEnabled: true,
        createModel: () => model,
        buildTools: (collector, approvalMode, mode) => {
          const dynamicTools = createConnectorTools(
            connectorDomain,
            collector,
            new ApprovalGuard(),
            manifestEntries,
            { contextMode: mode }
          )
          return buildGatewayTools(
            {
              domain: connectorDomain,
              contextMode: mode,
              approvalMode,
              toolSearchEnabled: true,
              dynamicTools
            },
            collector
          )
        }
      },
      new AbortController().signal,
      'manual_chat'
    )

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected ok')

    await prepared.run.result.consumeStream()

    expect(seenToolNamesPerStep).toHaveLength(3)
    // Step 0: tool_search present; ZERO deferred mcp__* tools exposed
    expect(seenToolNamesPerStep[0]).toContain('tool_search')
    expect(seenToolNamesPerStep[0]?.some((n) => n.startsWith('mcp__'))).toBe(false)

    // Step 1: activated screenshot tool IS now in schema, unsearched tools stay hidden
    expect(seenToolNamesPerStep[1]).toContain('mcp__chrome_devtools__take_screenshot')
    expect(seenToolNamesPerStep[1]).not.toContain('mcp__notion__page_op_0')
    expect(seenToolNamesPerStep[1]).not.toContain('mcp__chrome_devtools__click_button')

    // Step 2 received WS-1A multimodal image file part returned by the lazily loaded tool
    expect(JSON.stringify(seenPrompts[2])).toContain(PNG_1X1_B64)
  })

  test('multi-turn replay keeps history tool pinned on Step 0 AND runs toModelOutput with full ToolSet', async () => {
    const manifestEntries: ConnectorToolManifestEntry[] = [
      ...Array.from({ length: 6 }, (_, i) => mcpEntry('notion', `page_op_${i}`)),
      mcpEntry('chrome_devtools', 'take_screenshot', { description: 'Screenshot' })
    ]
    const seenStep0Tools: string[][] = []
    let seenPrompt: unknown = null

    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        seenStep0Tools.push((opts.tools ?? []).map((t) => t.name))
        seenPrompt = opts.prompt
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: 'Followup reply.' },
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

    const history: MailAgentUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Screenshot' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-mcp__chrome_devtools__take_screenshot',
            toolCallId: 'tc-hist-1',
            state: 'output-available',
            input: {},
            output: {
              connector: 'chrome_devtools',
              tool: 'take_screenshot',
              content: 'Viewport image',
              images: [{ media_type: 'image/png', data: PNG_1X1_B64 }],
              is_error: false,
              truncated: false
            }
          } as never
        ]
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'What color is it?' }] }
    ]

    const prepared = await prepareChatRun(
      { messages: history },
      {
        port: 0,
        baseUrl: 'https://crs.example/api',
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        toolSearchEnabled: true,
        createModel: () => model,
        buildTools: (collector, approvalMode, mode) => {
          const dynamicTools = createConnectorTools(
            mockDomain(() => okEnvelope({})),
            collector,
            new ApprovalGuard(),
            manifestEntries,
            { contextMode: mode }
          )
          return buildGatewayTools(
            {
              domain: mockDomain(() => okEnvelope([])),
              contextMode: mode,
              approvalMode,
              toolSearchEnabled: true,
              dynamicTools
            },
            collector
          )
        }
      },
      new AbortController().signal,
      'manual_chat'
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected ok')

    await prepared.run.result.consumeStream()
    expect(seenStep0Tools[0]).toContain('mcp__chrome_devtools__take_screenshot')
    expect(seenStep0Tools[0]).toContain('tool_search')
    expect(seenStep0Tools[0]).not.toContain('mcp__notion__page_op_0')
    // Replay invariant: full tools passed to convertToModelMessages preserved image file part
    expect(JSON.stringify(seenPrompt)).toContain('"mediaType":"image/png"')
    expect(JSON.stringify(seenPrompt)).toContain(PNG_1X1_B64)
  })

  test('wrapCfgForAgentRun keeps tool_search when granted >5 connector tools in headless runs', async () => {
    const manifestEntries = Array.from({ length: 7 }, (_, i) => mcpEntry('notion', `op_${i}`))
    const spec: AgentRunSpec = {
      jobId: 1,
      agentId: 'notion_worker',
      agentTitle: 'Notion Worker',
      trigger: { kind: 'cron', firedAt: '2026-11-20T00:00:00Z' },
      prompt: { taskPrompt: 'List Notion pages' },
      sessionTitle: 'Notion Worker Run',
      model: null,
      toolPolicy: {
        allowedTools: [],
        skills: [],
        grantConnectors: { notion: 'read' }
      },
      budget: { maxRunSeconds: 60 }
    }

    const baseCfg = {
      port: 0,
      baseUrl: 'https://crs.example/api',
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      toolSearchEnabled: true,
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async (opts) => {
            seenStep0 = (opts.tools ?? []).map((t) => t.name)
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start' as const, warnings: [] },
                  { type: 'text-start' as const, id: 't1' },
                  { type: 'text-delta' as const, id: 't1', delta: 'OK' },
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
      buildTools: (collector: GatewayToolAuditCollector, approvalMode: 'always', mode: 'cron_headless', ctx?: unknown) => {
        const dynamicTools = createConnectorTools(
          mockDomain(() => okEnvelope({})),
          collector,
          new ApprovalGuard(),
          manifestEntries,
          {
            contextMode: mode,
            connectorGrants: (ctx as { modeGrants?: { connectors?: Record<string, string> } })
              ?.modeGrants?.connectors as never
          }
        )
        return buildGatewayTools(
          {
            domain: mockDomain(() => okEnvelope([])),
            contextMode: mode,
            approvalMode,
            toolSearchEnabled: true,
            agentRunContext: ctx as never,
            dynamicTools
          },
          collector
        )
      }
    }

    let seenStep0: string[] = []
    const wrapped = wrapCfgForAgentRun(baseCfg as never, agentRunContextFromSpec(spec))
    const prepared = await prepareChatRun(
      {
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: spec.prompt.taskPrompt }] }
        ]
      },
      wrapped,
      new AbortController().signal,
      'cron_headless'
    )
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected ok')
    await prepared.run.result.consumeStream()

    expect(seenStep0).toContain('tool_search')
    expect(seenStep0.some((n) => n.startsWith('mcp__notion__'))).toBe(false)
    expect(prepared.run.lazyPartition?.deferredToolNames).toHaveLength(7)
  })
})

describe('stable_prompt — L0 connector catalog prefix stays cache-stable', () => {
  test('catalog block carries fixed tool_search hint and preserves connector summary lines', () => {
    const prompt1 = buildGatewaySystemPrompt({
      promptConfig: {
        standingContext: 'Base context',
        connectorCatalog: [
          {
            connectorId: 'notion',
            displayName: 'Notion',
            readToolCount: 8,
            writeToolCount: 2,
            updateToolCount: 0
          }
        ]
      },
      contextSnapshot: null
    })
    const prompt2 = buildGatewaySystemPrompt({
      promptConfig: {
        standingContext: 'Base context',
        connectorCatalog: [
          {
            connectorId: 'notion',
            displayName: 'Notion',
            readToolCount: 8,
            writeToolCount: 2,
            updateToolCount: 0
          }
        ]
      },
      contextSnapshot: null
    })

    expect(prompt1).toBe(prompt2)
    expect(prompt1).toContain('# External connectors (MCP) — direct tools registered right now')
    expect(prompt1).toContain('call tool_search')
    expect(prompt1).toContain('- Notion — 10 tools as mcp__notion__* (8 read, 2 write)')
  })
})
