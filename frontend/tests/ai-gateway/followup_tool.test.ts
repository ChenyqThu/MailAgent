// chat UI 优化 W6 — the in-turn suggest_followups tool: cleaning single source, tool execute,
// manual-only registration, the hasToolCall stop condition, and the prompt guidance wiring.
//
// Replaces the deleted auto_followups.test.ts (the out-of-turn POST /api/ai/followups second
// generation is gone — parseFollowups / buildFollowupsPrompt / generateFollowups removed).

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import {
  extractFollowupPrompts,
  followupPromptsFromPart,
  sanitizeFollowupPrompts,
  SUGGEST_FOLLOWUPS_TOOL_NAME
} from '../../src/shared/assistant/followups'
import { createFollowupTools } from '../../src/ai-gateway/tools/followups'
import { buildGatewayTools } from '../../src/ai-gateway/tools'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import {
  buildGatewaySystemPrompt,
  FOLLOWUP_SUGGESTIONS_GUIDANCE
} from '../../src/ai-gateway/systemPrompt'
import { prepareChatRun } from '../../src/ai-gateway/chatRun'
import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import { mockDomain, okEnvelope, runTool } from './tools/_helpers'

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
}

// ── sanitizeFollowupPrompts — the ONE cleaning discipline (gateway execute + renderer) ────────────

describe('sanitizeFollowupPrompts', () => {
  test('trims, strips wrapping quotes/bullets, drops empties + dups, caps at 3', () => {
    expect(
      sanitizeFollowupPrompts([
        ' "帮我回复第一封" ',
        '- 帮我回复第一封',
        '',
        '  ',
        'B?',
        'C?',
        'D?'
      ])
    ).toEqual(['帮我回复第一封', 'B?', 'C?'])
  })

  test('clips each prompt at 80 chars', () => {
    const out = sanitizeFollowupPrompts(['x'.repeat(120)])
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeLessThanOrEqual(80)
  })

  test('junk shapes → [] (never throws)', () => {
    for (const v of [undefined, null, 'a', 42, {}, [1, 2], [null]]) {
      expect(sanitizeFollowupPrompts(v)).toEqual([])
    }
  })
})

// ── extraction from message parts (both part shapes) ──────────────────────────────────────────────

describe('extractFollowupPrompts / followupPromptsFromPart', () => {
  const auiPart = (result: unknown, args?: unknown) => ({
    type: 'tool-call',
    toolCallId: 'tc1',
    toolName: SUGGEST_FOLLOWUPS_TOOL_NAME,
    args: args ?? { prompts: ['raw A', 'raw B'] },
    result
  })

  test('aui tool-call shape: prefers the execute result over args', () => {
    expect(followupPromptsFromPart(auiPart({ prompts: ['清洗后 A', '清洗后 B'] }))).toEqual([
      '清洗后 A',
      '清洗后 B'
    ])
  })

  test('aui tool-call shape without a result falls back to args (sanitized)', () => {
    expect(followupPromptsFromPart(auiPart(undefined, { prompts: [' " A " ', 'B'] }))).toEqual([
      'A',
      'B'
    ])
  })

  test('AI SDK wire shape (tool-suggest_followups + output/input) also extracts', () => {
    expect(
      followupPromptsFromPart({
        type: `tool-${SUGGEST_FOLLOWUPS_TOOL_NAME}`,
        state: 'output-available',
        input: { prompts: ['I1', 'I2'] },
        output: { prompts: ['O1', 'O2'] }
      })
    ).toEqual(['O1', 'O2'])
  })

  test('other tools / junk parts → []', () => {
    expect(followupPromptsFromPart({ type: 'tool-call', toolName: 'email_get' })).toEqual([])
    expect(followupPromptsFromPart({ type: 'text', text: 'hi' })).toEqual([])
    expect(followupPromptsFromPart(null)).toEqual([])
  })

  test('message-level: assistant + content array → prompts; user / no part / cleaned-empty → []', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }, auiPart({ prompts: ['A', 'B'] })]
    }
    expect(extractFollowupPrompts(msg)).toEqual(['A', 'B'])
    expect(extractFollowupPrompts({ ...msg, role: 'user' })).toEqual([])
    expect(extractFollowupPrompts({ role: 'assistant', content: [] })).toEqual([])
    expect(
      extractFollowupPrompts({
        role: 'assistant',
        content: [auiPart({ prompts: ['', '  '] }, { prompts: ['', ' '] })]
      })
    ).toEqual([])
    expect(extractFollowupPrompts(null)).toEqual([])
  })

  test('message-level: AI SDK `parts` key works too (persisted UIMessage shape)', () => {
    expect(
      extractFollowupPrompts({
        role: 'assistant',
        parts: [
          { type: 'text', text: 'done' },
          {
            type: `tool-${SUGGEST_FOLLOWUPS_TOOL_NAME}`,
            state: 'output-available',
            output: { prompts: ['P1', 'P2', 'P3'] }
          }
        ]
      })
    ).toEqual(['P1', 'P2', 'P3'])
  })
})

// ── the gateway tool itself (execute + audit) ─────────────────────────────────────────────────────

describe('createFollowupTools — suggest_followups execute', () => {
  test('cleans the prompts, returns { prompts, count }, pushes an ok audit entry', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = createFollowupTools(collector)
    const out = await runTool(tools[SUGGEST_FOLLOWUPS_TOOL_NAME], {
      prompts: [' "A?" ', 'A?', 'B?']
    })
    expect(out).toEqual({ prompts: ['A?', 'B?'], count: 2 })
    expect(collector).toHaveLength(1)
    expect(collector[0]).toMatchObject({ toolName: SUGGEST_FOLLOWUPS_TOOL_NAME, status: 'ok' })
  })
})

// ── manual-only registration (the venue gate) ─────────────────────────────────────────────────────

describe('buildGatewayTools × suggest_followups registration', () => {
  const build = (contextMode?: Parameters<typeof buildGatewayTools>[0]['contextMode']) =>
    buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      ...(contextMode !== undefined ? { contextMode } : {})
    })

  test('manual_chat → registered (part of the default manual assembly)', () => {
    expect(build('manual_chat')[SUGGEST_FOLLOWUPS_TOOL_NAME]).toBeDefined()
  })

  test.each(['untrusted_trigger', 'cron_headless', 'im_chat'] as const)(
    '%s → NOT registered (interactive UI supply is manual-only)',
    (mode) => {
      expect(build(mode)[SUGGEST_FOLLOWUPS_TOOL_NAME]).toBeUndefined()
    }
  )

  test('absent contextMode fail-closes (→ untrusted) → NOT registered', () => {
    expect(build(undefined)[SUGGEST_FOLLOWUPS_TOOL_NAME]).toBeUndefined()
  })
})

// ── system prompt guidance (keyed off the BUILT tool set) ─────────────────────────────────────────

describe('buildGatewaySystemPrompt × followupToolAvailable', () => {
  test('true → guidance injected BEFORE the date block; absent/false → byte-identical', () => {
    const base = { promptConfig: null, contextSnapshot: null }
    const withGuidance = buildGatewaySystemPrompt({ ...base, followupToolAvailable: true })
    expect(withGuidance).toContain(FOLLOWUP_SUGGESTIONS_GUIDANCE)
    expect(withGuidance.indexOf(FOLLOWUP_SUGGESTIONS_GUIDANCE)).toBeLessThan(
      withGuidance.indexOf('当前日期')
    )
    const absent = buildGatewaySystemPrompt(base)
    const explicitFalse = buildGatewaySystemPrompt({ ...base, followupToolAvailable: false })
    expect(absent).not.toContain('# Follow-up suggestions')
    expect(explicitFalse).toBe(absent)
  })
})

// ── stopWhen: the tool call ends the manual turn; other tools do not ──────────────────────────────

const handles: AiGatewayHandle[] = []
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** doStream #1 emits `firstChunks`; any later step emits closing text. Counts the steps. */
function stepCountingModel(
  firstChunks: unknown[],
  counter: { steps: number }
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => {
      counter.steps += 1
      const chunks =
        counter.steps === 1
          ? firstChunks
          : [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 't' },
              { type: 'text-delta' as const, id: 't', delta: 'done' },
              { type: 'text-end' as const, id: 't' },
              { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE }
            ]
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) }
    }
  })
}

const toolCallChunks = (toolName: string, input: unknown): unknown[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'tc1', toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: 'tool-calls', usage: USAGE }
]

function chatCfg(model: MockLanguageModelV3): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://crs.example/api',
    apiKey: 'sk-test',
    model: 'test-model',
    createModel: () => model,
    buildTools: (collector, _approvalMode, contextMode) =>
      buildGatewayTools({ domain: mockDomain(() => okEnvelope([])), contextMode }, collector)
  }
}

async function postChat(cfg: AiGatewayConfig): Promise<number> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    })
  })
  await res.text() // drain the SSE to completion
  return res.status
}

describe('stopWhen — hasToolCall(suggest_followups) ends the manual turn', () => {
  test('a suggest_followups call stops the loop (no further model step)', async () => {
    const counter = { steps: 0 }
    const model = stepCountingModel(
      toolCallChunks(SUGGEST_FOLLOWUPS_TOOL_NAME, { prompts: ['A?', 'B?'] }),
      counter
    )
    expect(await postChat(chatCfg(model))).toBe(200)
    expect(counter.steps).toBe(1)
  })

  test('another tool call does NOT stop the loop (a second step still runs)', async () => {
    const counter = { steps: 0 }
    const model = stepCountingModel(toolCallChunks('email_list_filter', {}), counter)
    expect(await postChat(chatCfg(model))).toBe(200)
    expect(counter.steps).toBe(2)
  })
})

// ── prepareChatRun: headless never carries the tool (mode-driven ToolSet) ─────────────────────────

describe('prepareChatRun × contextMode — toolNames surface', () => {
  const run = async (mode: 'manual_chat' | 'cron_headless') => {
    const cfg = chatCfg(stepCountingModel([], { steps: 0 }))
    const outcome = await prepareChatRun(
      { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      cfg,
      new AbortController().signal,
      mode
    )
    if (!outcome.ok) throw new Error(`prepareChatRun failed: ${outcome.body.error}`)
    return outcome.run
  }

  test('manual_chat run holds suggest_followups', async () => {
    expect((await run('manual_chat')).toolNames).toContain(SUGGEST_FOLLOWUPS_TOOL_NAME)
  })

  test('cron_headless run does NOT hold suggest_followups', async () => {
    expect((await run('cron_headless')).toolNames).not.toContain(SUGGEST_FOLLOWUPS_TOOL_NAME)
  })
})
