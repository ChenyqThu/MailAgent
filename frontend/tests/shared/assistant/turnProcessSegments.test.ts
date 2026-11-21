import { describe, expect, test } from 'vitest'

import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'
import { segmentAssistantParts } from '@shared/assistant/tools/generic/turnProcessSegments'

const reasoning = (text = 'checking', running = false): TurnStagePart => ({
  type: 'reasoning',
  text,
  status: { type: running ? 'running' : 'complete' }
})
const readTool = (toolName = 'email_search_fulltext', over?: Partial<TurnStagePart>): TurnStagePart => ({
  type: 'tool-call',
  toolName,
  result: { items: [] },
  status: { type: 'complete' },
  ...over
})
const textPart = (text = 'Final answer'): TurnStagePart => ({ type: 'text', text })

describe('segmentAssistantParts', () => {
  test('groups interleaved reasoning + read tools (including step-start bridges) ahead of final answer', () => {
    const parts: TurnStagePart[] = [
      reasoning('step 1'),
      { type: 'step-start' },
      readTool('email_search_fulltext'),
      readTool('email_body'),
      textPart('Here is what I found.')
    ]
    expect(segmentAssistantParts(parts)).toEqual([
      { kind: 'process', key: 'process-0', foldableIndices: [0, 2, 3], hasFollowingContent: true },
      { kind: 'single', index: 4 }
    ])
  })

  test('folds even a single silent read tool when followed by final answer prose', () => {
    const parts: TurnStagePart[] = [readTool('email_get'), textPart('Done.')]
    expect(segmentAssistantParts(parts)).toEqual([
      { kind: 'process', key: 'process-0', foldableIndices: [0], hasFollowingContent: true },
      { kind: 'single', index: 1 }
    ])
  })

  test('never folds approvals, errors, plan_update, or rich A2UI write cards', () => {
    const parts: TurnStagePart[] = [
      readTool('email_search_fulltext'),
      readTool('email_draft_reply'),
      readTool('email_get', { isError: true, result: { error: 'boom' } }),
      readTool('email_flag', { approval: { approved: undefined } }),
      readTool('plan_update')
    ]
    expect(segmentAssistantParts(parts)).toEqual([
      { kind: 'process', key: 'process-0', foldableIndices: [0], hasFollowingContent: true },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
      { kind: 'single', index: 4 }
    ])
  })

  test('never folds suggest_followups inside a process group', () => {
    const parts: TurnStagePart[] = [
      readTool('email_search_fulltext'),
      readTool('email_body'),
      textPart('Answer'),
      readTool('suggest_followups')
    ]
    expect(segmentAssistantParts(parts)).toEqual([
      { kind: 'process', key: 'process-0', foldableIndices: [0, 1], hasFollowingContent: true },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 }
    ])
  })

  test('folds consecutive completed or running computer_use_run calls into one process timeline', () => {
    const parts: TurnStagePart[] = [
      readTool('computer_use_run', {
        approval: { approved: true },
        result: { status: 'completed', current_url_or_app: 'https://oa.internal.test/1' }
      }),
      readTool('computer_use_run', {
        approval: { approved: true },
        result: { status: 'completed', current_url_or_app: 'https://oa.internal.test/2' }
      }),
      {
        type: 'tool-call',
        toolName: 'computer_use_run',
        approval: { approved: true },
        result: undefined,
        status: { type: 'running' }
      },
      textPart('All steps completed.')
    ]
    expect(segmentAssistantParts(parts)).toEqual([
      { kind: 'process', key: 'process-0', foldableIndices: [0, 1, 2], hasFollowingContent: true },
      { kind: 'single', index: 3 }
    ])
  })

  test('never folds computer_use_run when attention is required (pending, awaiting_confirmation, scope_violation, error, denied)', () => {
    const parts: TurnStagePart[] = [
      readTool('computer_use_run', {
        approval: { approved: true },
        result: { status: 'completed' }
      }),
      {
        type: 'tool-call',
        toolName: 'computer_use_run',
        approval: { approved: undefined },
        result: undefined,
        status: { type: 'requires-action' }
      },
      readTool('computer_use_run', {
        approval: { approved: true },
        result: { status: 'awaiting_confirmation', pending_action: 'Click Submit' }
      }),
      readTool('computer_use_run', {
        approval: { approved: true },
        result: { status: 'scope_violation' }
      }),
      readTool('computer_use_run', {
        isError: true,
        approval: { approved: true },
        result: { error: 'boom' }
      }),
      readTool('computer_use_run', {
        isError: true,
        approval: { approved: false },
        result: { rejected: true }
      })
    ]
    expect(segmentAssistantParts(parts)).toEqual([
      { kind: 'process', key: 'process-0', foldableIndices: [0], hasFollowingContent: true },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
      { kind: 'single', index: 4 },
      { kind: 'single', index: 5 }
    ])
  })
})
