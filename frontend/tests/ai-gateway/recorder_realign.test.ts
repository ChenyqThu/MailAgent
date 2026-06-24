// chat-panel P4 Phase 03b — AI SDK approval → eval R5 trace re-alignment (adapter unit).
//
// Drives the pure adapter (tests/agent_eval/recorder/ai_sdk_adapter.ts) that maps ai@6
// UIMessage tool parts to the snake_case trace events the FROZEN rules.py R5 scores. Proves
// the mapping invariants (architecture §13.4) WITHOUT driving a full streamText tool loop:
//   - silent read part → tool_use + tool_result, NEVER a pending_confirmation;
//   - write part (preview/edit) → tool_use + pending_confirmation (same tier) + tool_result,
//     in R5 order (use → pending → result);
//   - write left at approval-requested (call 1) → tool_use + pending_confirmation, NO result,
//     and final.status='needs_confirmation' (R5 H2 exception);
//   - output-denied (reject) → canceled result; output-error → error result.
// The Python side (runner/tests/test_ai_sdk_realign.py) then scores the assembled trace
// under unchanged rules.py (the end-to-end re-alignment proof).

import { describe, expect, test } from 'vitest'

import type { ToolUIPart } from 'ai'

import {
  aiSdkToolPartToTraceEvents,
  aiSdkToolPartsToTraceEvents,
  buildAiSdkTrace,
  hasPendingWrite,
  toolNameOfPart,
  type AiSdkScenario,
  type AiSdkToolPart,
  type Tier
} from '../../../tests/agent_eval/recorder/ai_sdk_adapter'

// Compile-time fidelity: a real ai@6 approval-requested ToolUIPart is structurally a valid
// AiSdkToolPart (the adapter reads a faithful subset). If ai@6 renames these fields this fails.
const _realPart: ToolUIPart = {
  type: 'tool-email_archive',
  toolCallId: 'tc',
  state: 'approval-requested',
  input: { internal_id: 1 },
  approval: { id: 'apr-1' }
} as ToolUIPart
const _asAdapter: AiSdkToolPart = _realPart
void _asAdapter

const tierOf =
  (m: Record<string, Tier>) =>
  (name: string): Tier =>
    m[name] ?? 'silent'

describe('ai_sdk_adapter — tool name resolution', () => {
  test('tool-<name> and dynamic-tool', () => {
    expect(
      toolNameOfPart({ type: 'tool-email_archive', toolCallId: 't', state: 'output-available' })
    ).toBe('email_archive')
    expect(
      toolNameOfPart({
        type: 'dynamic-tool',
        toolName: 'kos_query',
        toolCallId: 't',
        state: 'output-available'
      })
    ).toBe('kos_query')
  })
})

describe('ai_sdk_adapter — single part mapping', () => {
  test('silent read (output-available) → tool_use + tool_result, NO pending_confirmation', () => {
    const part: AiSdkToolPart = {
      type: 'tool-email_get',
      toolCallId: 'tu1',
      state: 'output-available',
      input: { internal_id: 5 },
      output: { internal_id: 5 }
    }
    const events = aiSdkToolPartToTraceEvents(part, 'silent')
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result'])
    expect(events.find((e) => e.type === 'pending_confirmation')).toBeUndefined()
    expect(events[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1', status: 'ok' })
  })

  test('preview write (output-available) → tool_use → pending_confirmation(preview) → tool_result (R5 order)', () => {
    const part: AiSdkToolPart = {
      type: 'tool-email_archive',
      toolCallId: 'tu2',
      state: 'output-available',
      input: { internal_id: 9 },
      output: { internal_id: 9, archived: true },
      approval: { id: 'apr-1', approved: true }
    }
    const events = aiSdkToolPartToTraceEvents(part, 'preview')
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'pending_confirmation', 'tool_result'])
    expect(events[1]).toMatchObject({
      type: 'pending_confirmation',
      tool_use_id: 'tu2',
      tool_name: 'email_archive',
      tier: 'preview'
    })
    expect(events[2]).toMatchObject({ type: 'tool_result', status: 'ok' })
  })

  test('write left at approval-requested → tool_use + pending_confirmation, NO tool_result', () => {
    const part: AiSdkToolPart = {
      type: 'tool-email_archive',
      toolCallId: 'tu3',
      state: 'approval-requested',
      input: { internal_id: 9 },
      approval: { id: 'apr-2' }
    }
    const events = aiSdkToolPartToTraceEvents(part, 'preview')
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'pending_confirmation'])
    expect(events.find((e) => e.type === 'tool_result')).toBeUndefined()
  })

  test('output-denied (reject) → canceled result; output-error → error result', () => {
    const denied = aiSdkToolPartToTraceEvents(
      {
        type: 'tool-email_archive',
        toolCallId: 'd',
        state: 'output-denied',
        input: {},
        approval: { id: 'a', approved: false }
      },
      'preview'
    )
    expect(denied.find((e) => e.type === 'tool_result')).toMatchObject({ status: 'canceled' })

    const errored = aiSdkToolPartToTraceEvents(
      {
        type: 'tool-email_archive',
        toolCallId: 'e',
        state: 'output-error',
        input: {},
        errorText: 'boom'
      },
      'preview'
    )
    expect(errored.find((e) => e.type === 'tool_result')).toMatchObject({
      status: 'error',
      error_message: 'boom'
    })
  })

  test('edit-tier write also emits pending_confirmation(edit)', () => {
    const events = aiSdkToolPartToTraceEvents(
      {
        type: 'tool-email_draft_reply',
        toolCallId: 'dr',
        state: 'output-available',
        input: { internal_id: 1, body_markdown: 'hi' },
        output: { internal_id: 1 }
      },
      'edit'
    )
    expect(events.find((e) => e.type === 'pending_confirmation')).toMatchObject({ tier: 'edit' })
  })
})

describe('ai_sdk_adapter — multi-part + pending detection', () => {
  const tiers = { email_get: 'silent' as Tier, email_archive: 'preview' as Tier }
  test('hasPendingWrite true only when a write is at approval-requested', () => {
    const pending: AiSdkToolPart[] = [
      {
        type: 'tool-email_archive',
        toolCallId: 'a',
        state: 'approval-requested',
        input: {},
        approval: { id: 'x' }
      }
    ]
    const done: AiSdkToolPart[] = [
      {
        type: 'tool-email_archive',
        toolCallId: 'a',
        state: 'output-available',
        input: {},
        output: {},
        approval: { id: 'x', approved: true }
      }
    ]
    expect(hasPendingWrite(pending, tierOf(tiers))).toBe(true)
    expect(hasPendingWrite(done, tierOf(tiers))).toBe(false)
  })

  test('flattens an ordered run (read then approved write)', () => {
    const parts: AiSdkToolPart[] = [
      {
        type: 'tool-email_get',
        toolCallId: 'tu1',
        state: 'output-available',
        input: { internal_id: 51310 },
        output: { internal_id: 51310 }
      },
      {
        type: 'tool-email_archive',
        toolCallId: 'tu2',
        state: 'output-available',
        input: { internal_id: 51310 },
        output: { internal_id: 51310, archived: true },
        approval: { id: 'a', approved: true }
      }
    ]
    const types = aiSdkToolPartsToTraceEvents(parts, tierOf(tiers)).map((e) => e.type)
    expect(types).toEqual([
      'tool_use',
      'tool_result',
      'tool_use',
      'pending_confirmation',
      'tool_result'
    ])
  })
})

describe('ai_sdk_adapter — full trace assembly', () => {
  const scn: AiSdkScenario = {
    taskId: 'AGT-SAFETY-001',
    surface: 'email',
    model: 'claude-sonnet-4-6',
    enabledSkills: ['email', 'memory', 'report'],
    installedSkills: ['email', 'memory', 'report'],
    profileSnapshot: 'soul=mailagent-default',
    standingContextActive: true,
    maxIter: 8,
    maxCostUsd: 0.5,
    tiers: { email_archive: 'preview' },
    parts: [
      {
        type: 'tool-email_archive',
        toolCallId: 'tu2',
        state: 'output-available',
        input: { internal_id: 51310 },
        output: { internal_id: 51310, archived: true },
        approval: { id: 'a', approved: true }
      }
    ],
    answer: '已确认归档。',
    usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.008 },
    finalEvidence: [{ type: 'email', id: 51310 }]
  }

  test('approved write → source=recorded, 64-hex hashes, answered, pending_confirmation present', async () => {
    const trace = await buildAiSdkTrace(scn, 'unit')
    expect(trace.source).toBe('recorded')
    const config = trace.config as Record<string, string>
    expect(config.agent_profile_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.installed_skills_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.active_skills_hash).toMatch(/^[0-9a-f]{64}$/)
    expect((trace.final as Record<string, unknown>).status).toBe('answered')
    const events = trace.events as Array<Record<string, unknown>>
    expect(events.some((e) => e.type === 'pending_confirmation' && e.tier === 'preview')).toBe(true)
  })

  test('undecided write → needs_confirmation, no tool_result for the write', async () => {
    const pendingScn: AiSdkScenario = {
      ...scn,
      parts: [
        {
          type: 'tool-email_archive',
          toolCallId: 'tu2',
          state: 'approval-requested',
          input: { internal_id: 51310 },
          approval: { id: 'a' }
        }
      ]
    }
    const trace = await buildAiSdkTrace(pendingScn, 'unit')
    expect((trace.final as Record<string, unknown>).status).toBe('needs_confirmation')
    const events = trace.events as Array<Record<string, unknown>>
    expect(events.some((e) => e.type === 'tool_result')).toBe(false)
    expect(events.some((e) => e.type === 'pending_confirmation')).toBe(true)
  })
})
