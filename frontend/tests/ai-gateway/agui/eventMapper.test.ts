// chat-panel P4 Phase 05 — AG-UI eventMapper golden snapshots.
//
// Drives synthetic AI SDK UIMessageChunk sequences through the mapper and asserts the exact AG-UI
// event order (the mirror's primary acceptance — phase-05 §10). Covers the three required scenarios
// at the deterministic mapper layer: basic text, tool call (args + result), approval interrupt
// (resolver + fail-closed fallback), plus reasoning + error mapping + the post-interrupt RUN_FINISHED
// suppression.

import { describe, expect, test, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'

import {
  AgUiEventType,
  type AgUiEvent,
  type AgUiInterruptValue
} from '../../../src/ai-gateway/agui/events'
import {
  createAgUiEventMapper,
  type ApprovalChunkInfo
} from '../../../src/ai-gateway/agui/eventMapper'

const IDS = { threadId: 'th-1', runId: 'rn-1', assistantMessageId: 'asst-1' } as const

function run(
  chunks: UIMessageChunk[],
  ctx: Partial<Parameters<typeof createAgUiEventMapper>[0]> = {}
): AgUiEvent[] {
  const mapper = createAgUiEventMapper({ ...IDS, ...ctx })
  const out: AgUiEvent[] = [mapper.runStarted()]
  for (const c of chunks) out.push(...mapper.map(c))
  return out
}

const c = (chunk: unknown): UIMessageChunk => chunk as UIMessageChunk

describe('agui eventMapper — basic text', () => {
  test('run start → text block → finish maps to the AG-UI text golden', () => {
    const events = run([
      c({ type: 'start', messageId: 'm1' }),
      c({ type: 'start-step' }),
      c({ type: 'text-start', id: 't1' }),
      c({ type: 'text-delta', id: 't1', delta: 'Hello' }),
      c({ type: 'text-delta', id: 't1', delta: ', world' }),
      c({ type: 'text-end', id: 't1' }),
      c({ type: 'finish-step' }),
      c({ type: 'finish', finishReason: 'stop' })
    ])
    expect(events).toEqual([
      { type: AgUiEventType.RunStarted, threadId: 'th-1', runId: 'rn-1' },
      { type: AgUiEventType.StepStarted, stepName: 'step-1' },
      { type: AgUiEventType.TextMessageStart, messageId: 't1', role: 'assistant' },
      { type: AgUiEventType.TextMessageContent, messageId: 't1', delta: 'Hello' },
      { type: AgUiEventType.TextMessageContent, messageId: 't1', delta: ', world' },
      { type: AgUiEventType.TextMessageEnd, messageId: 't1' },
      { type: AgUiEventType.StepFinished, stepName: 'step-1' },
      {
        type: AgUiEventType.RunFinished,
        threadId: 'th-1',
        runId: 'rn-1',
        result: { status: 'success', finishReason: 'stop' }
      }
    ])
  })
})

describe('agui eventMapper — tool call (no approval)', () => {
  test('tool input + output map to TOOL_CALL_START/ARGS/END/RESULT', () => {
    const events = run([
      c({ type: 'tool-input-start', toolCallId: 'cc1', toolName: 'email_search' }),
      c({
        type: 'tool-input-available',
        toolCallId: 'cc1',
        toolName: 'email_search',
        input: { q: 'redis' }
      }),
      c({ type: 'tool-output-available', toolCallId: 'cc1', output: { ok: true, count: 2 } }),
      c({ type: 'finish', finishReason: 'stop' })
    ])
    expect(events).toEqual([
      { type: AgUiEventType.RunStarted, threadId: 'th-1', runId: 'rn-1' },
      {
        type: AgUiEventType.ToolCallStart,
        toolCallId: 'cc1',
        toolCallName: 'email_search',
        parentMessageId: 'asst-1'
      },
      { type: AgUiEventType.ToolCallArgs, toolCallId: 'cc1', delta: '{"q":"redis"}' },
      { type: AgUiEventType.ToolCallEnd, toolCallId: 'cc1' },
      {
        type: AgUiEventType.ToolCallResult,
        messageId: 'tr-cc1',
        toolCallId: 'cc1',
        content: '{"ok":true,"count":2}',
        role: 'tool'
      },
      {
        type: AgUiEventType.RunFinished,
        threadId: 'th-1',
        runId: 'rn-1',
        result: { status: 'success', finishReason: 'stop' }
      }
    ])
  })

  test('streamed arg deltas are mirrored as TOOL_CALL_ARGS (no double full-args)', () => {
    const events = run([
      c({ type: 'tool-input-start', toolCallId: 'cc2', toolName: 'email_get' }),
      c({ type: 'tool-input-delta', toolCallId: 'cc2', inputTextDelta: '{"internal_id":' }),
      c({ type: 'tool-input-delta', toolCallId: 'cc2', inputTextDelta: '51}' }),
      c({
        type: 'tool-input-available',
        toolCallId: 'cc2',
        toolName: 'email_get',
        input: { internal_id: 51 }
      })
    ])
    const args = events.filter((e) => e.type === AgUiEventType.ToolCallArgs)
    expect(args).toEqual([
      { type: AgUiEventType.ToolCallArgs, toolCallId: 'cc2', delta: '{"internal_id":' },
      { type: AgUiEventType.ToolCallArgs, toolCallId: 'cc2', delta: '51}' }
    ])
    // tool-input-available must NOT re-emit the full args when they were streamed.
    expect(events.at(-1)).toEqual({ type: AgUiEventType.ToolCallEnd, toolCallId: 'cc2' })
  })

  test('undefined input → TOOL_CALL_ARGS delta "{}" (not the literal "null")', () => {
    const events = run([
      c({
        type: 'tool-input-available',
        toolCallId: 'cc3',
        toolName: 'report_list',
        input: undefined
      })
    ])
    expect(events).toContainEqual({
      type: AgUiEventType.ToolCallArgs,
      toolCallId: 'cc3',
      delta: '{}'
    })
  })

  test('at most ONE TOOL_CALL_RESULT per tool call (a later output for the same id is dropped)', () => {
    const events = run([
      c({
        type: 'tool-input-error',
        toolCallId: 'cc4',
        toolName: 'email_get',
        input: {},
        errorText: 'bad input'
      }),
      // a provider that ALSO surfaces an output for the same failed call must not yield a 2nd result.
      c({ type: 'tool-output-available', toolCallId: 'cc4', output: { ok: false } })
    ])
    const results = events.filter((e) => e.type === AgUiEventType.ToolCallResult)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: 'cc4', content: '{"error":"bad input"}' })
  })
})

describe('agui eventMapper — approval interrupt', () => {
  const approvalChunks: UIMessageChunk[] = [
    c({ type: 'tool-input-start', toolCallId: 'cs1', toolName: 'email_prepare_send' }),
    c({
      type: 'tool-input-available',
      toolCallId: 'cs1',
      toolName: 'email_prepare_send',
      input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' }
    }),
    c({
      type: 'tool-approval-request',
      approvalId: 'apr-1',
      toolCallId: 'cs1',
      signature: 'sig-xyz'
    }),
    c({ type: 'finish', finishReason: 'stop' })
  ]

  test('resolver enriches the interrupt; CUSTOM + RUN_FINISHED(requires_action); finish suppressed', () => {
    const interrupt: AgUiInterruptValue = {
      id: 'apr-1',
      name: 'email_prepare_send',
      payload: {
        toolCallId: 'cs1',
        input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' },
        risk: 'blocking',
        reason: 'needs approval',
        expiresAt: '2026-06-25T00:05:00.000Z'
      }
    }
    const resolve = vi.fn<(info: ApprovalChunkInfo) => AgUiInterruptValue | null>(() => interrupt)
    const events = run(approvalChunks, { resolveApprovalInterrupt: resolve })

    // resolver saw the joined tool name + input + the ai@6 approval id/signature.
    expect(resolve).toHaveBeenCalledWith({
      approvalId: 'apr-1',
      toolCallId: 'cs1',
      toolName: 'email_prepare_send',
      input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' },
      signature: 'sig-xyz'
    })
    // the interrupt is a CUSTOM 'Interrupt' + a requires_action RUN_FINISHED.
    expect(events).toContainEqual({
      type: AgUiEventType.Custom,
      name: 'Interrupt',
      value: interrupt
    })
    expect(events).toContainEqual({
      type: AgUiEventType.RunFinished,
      threadId: 'th-1',
      runId: 'rn-1',
      result: { status: 'requires_action', interrupt }
    })
    // exactly ONE RUN_FINISHED — the trailing `finish` chunk must not emit a second.
    expect(events.filter((e) => e.type === AgUiEventType.RunFinished)).toHaveLength(1)
  })

  test('no resolver → fail-closed minimal interrupt (risk blocking, empty expiry)', () => {
    const events = run(approvalChunks)
    const custom = events.find((e) => e.type === AgUiEventType.Custom)
    expect(custom).toEqual({
      type: AgUiEventType.Custom,
      name: 'Interrupt',
      value: {
        id: 'apr-1',
        name: 'email_prepare_send',
        payload: {
          toolCallId: 'cs1',
          input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' },
          risk: 'blocking',
          reason: 'approval required',
          expiresAt: ''
        }
      }
    })
  })
})

describe('agui eventMapper — reasoning + errors', () => {
  test('reasoning block → THINKING_* events', () => {
    const events = run([
      c({ type: 'reasoning-start', id: 'r1' }),
      c({ type: 'reasoning-delta', id: 'r1', delta: 'thinking…' }),
      c({ type: 'reasoning-end', id: 'r1' })
    ])
    expect(events.slice(1)).toEqual([
      { type: AgUiEventType.ThinkingStart },
      { type: AgUiEventType.ThinkingTextMessageStart, messageId: 'r1' },
      { type: AgUiEventType.ThinkingTextMessageContent, messageId: 'r1', delta: 'thinking…' },
      { type: AgUiEventType.ThinkingTextMessageEnd, messageId: 'r1' },
      { type: AgUiEventType.ThinkingEnd }
    ])
  })

  test('error chunk → RUN_ERROR and a trailing finish does not add RUN_FINISHED', () => {
    const events = run([
      c({ type: 'text-start', id: 't1' }),
      c({ type: 'error', errorText: 'boom' }),
      c({ type: 'finish', finishReason: 'error' })
    ])
    expect(events).toContainEqual({
      type: AgUiEventType.RunError,
      message: 'boom',
      code: 'E_RUN_ERROR'
    })
    expect(events.filter((e) => e.type === AgUiEventType.RunFinished)).toHaveLength(0)
  })
})
