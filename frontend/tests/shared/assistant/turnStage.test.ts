// harness-chat lane B — deriveTurnStage truth table + partAwaitsApproval (pure, no runtime).
//
// The stage machine is where "shimmer must stop on terminal/self-narrating stages" lives; this
// table pins every (parts tail × message status × stall level) → stage so a regression can't
// silently reintroduce the 永动 behavior.

import { describe, expect, test } from 'vitest'

import {
  deriveTurnStage,
  partAwaitsApproval,
  type TurnStagePart,
  type StallLevel
} from '@shared/assistant/runtime/useTurnStage'

const text = (t = 'hi'): TurnStagePart => ({ type: 'text', text: t })
const reasoning = (t = 'думаю'): TurnStagePart => ({ type: 'reasoning', text: t })
const emptyText = (): TurnStagePart => ({ type: 'text', text: '   ' })
const dataPart = (): TurnStagePart => ({ type: 'data-followups' })
const toolRunning = (name = 'email_search'): TurnStagePart => ({ type: 'tool-call', toolName: name })
const toolDone = (name = 'email_search'): TurnStagePart => ({
  type: 'tool-call',
  toolName: name,
  result: { ok: true },
  status: { type: 'complete' }
})
const toolError = (name = 'email_search'): TurnStagePart => ({
  type: 'tool-call',
  toolName: name,
  isError: true,
  result: { error: 'boom' }
})
const toolAwaiting = (name = 'email_draft_reply'): TurnStagePart => ({
  type: 'tool-call',
  toolName: name,
  approval: { id: 'ap1' } as unknown as TurnStagePart['approval']
})

const running = { type: 'running' as const }
const complete = { type: 'complete' as const, reason: 'stop' }
const requiresAction = { type: 'requires-action' as const, reason: 'tool-calls' }
const errorStatus = { type: 'incomplete' as const, reason: 'error' }
const cancelledStatus = { type: 'incomplete' as const, reason: 'cancelled' }

function stage(
  parts: TurnStagePart[],
  status: { type?: string; reason?: string } | undefined,
  stallLevel: StallLevel = 0
): string {
  return deriveTurnStage({ parts, status, stallLevel }).stage
}

describe('partAwaitsApproval', () => {
  test('approval object with no decision + no resolution → true', () => {
    expect(partAwaitsApproval(toolAwaiting())).toBe(true)
  })
  test('approved decision recorded → false', () => {
    expect(
      partAwaitsApproval({ type: 'tool-call', approval: { approved: true } })
    ).toBe(false)
  })
  test('rejected decision recorded → false', () => {
    expect(
      partAwaitsApproval({ type: 'tool-call', approval: { approved: false } })
    ).toBe(false)
  })
  test('terminal resolution (cancelled/expired) → false', () => {
    expect(
      partAwaitsApproval({ type: 'tool-call', approval: { resolution: 'expired' } })
    ).toBe(false)
  })
  test('no approval object → false', () => {
    expect(partAwaitsApproval(toolRunning())).toBe(false)
  })
})

describe('deriveTurnStage — terminal statuses', () => {
  test('incomplete(error) → error, regardless of parts', () => {
    expect(stage([], errorStatus)).toBe('error')
    expect(stage([text()], errorStatus)).toBe('error')
    expect(stage([toolRunning()], errorStatus)).toBe('error')
  })
  test('incomplete(cancelled/length/etc.) → idle (quiet, no error line)', () => {
    expect(stage([], cancelledStatus)).toBe('idle')
    expect(stage([toolRunning()], cancelledStatus)).toBe('idle')
  })
  test('complete → idle (the settled tool-tail 永动 fix)', () => {
    expect(stage([toolDone()], complete)).toBe('idle')
    expect(stage([text()], complete)).toBe('idle')
    expect(stage([], complete)).toBe('idle')
  })
  test('undefined status → idle', () => {
    expect(stage([toolDone()], undefined)).toBe('idle')
  })
})

describe('deriveTurnStage — approval gate has top priority', () => {
  test('last tool awaiting approval (even while status running) → awaiting-approval', () => {
    expect(stage([text(), toolAwaiting()], running)).toBe('awaiting-approval')
  })
  test('requires-action status → awaiting-approval (interrupt / pending)', () => {
    expect(stage([toolRunning()], requiresAction)).toBe('awaiting-approval')
  })
  test('trailing data placeholder after an approval tool still resolves to awaiting-approval', () => {
    expect(stage([toolAwaiting(), dataPart()], running)).toBe('awaiting-approval')
  })
})

describe('deriveTurnStage — running sub-states', () => {
  test('0 meaningful parts → connecting', () => {
    expect(stage([], running)).toBe('connecting')
    expect(stage([emptyText()], running)).toBe('connecting') // empty text is a placeholder
    expect(stage([dataPart()], running)).toBe('connecting') // data-* is a placeholder
  })
  test('last reasoning → thinking', () => {
    expect(stage([reasoning()], running)).toBe('thinking')
  })
  test('last streaming text → writing', () => {
    expect(stage([text('partial answer')], running)).toBe('writing')
  })
  test('last tool still executing → calling-tool (+ toolName)', () => {
    expect(stage([toolRunning('kos_query')], running)).toBe('calling-tool')
    expect(deriveTurnStage({ parts: [toolRunning('kos_query')], status: running, stallLevel: 0 }).toolName).toBe(
      'kos_query'
    )
  })
  test('last tool settled while running → thinking (model generating next step)', () => {
    expect(stage([toolDone()], running)).toBe('thinking')
    expect(stage([toolError()], running)).toBe('thinking')
  })
  test('stall level > 0 overrides every running sub-state → stalled', () => {
    expect(stage([], running, 1)).toBe('stalled')
    expect(stage([toolRunning()], running, 1)).toBe('stalled')
    expect(stage([reasoning()], running, 2)).toBe('stalled')
  })
  test('stall does NOT override the approval gate', () => {
    expect(stage([toolAwaiting()], running, 2)).toBe('awaiting-approval')
  })
  test('stall does NOT override a terminal error', () => {
    expect(stage([], errorStatus, 2)).toBe('error')
  })
})

describe('deriveTurnStage — last-meaningful-part skips trailing placeholders', () => {
  test('a settled tool followed by a data placeholder → thinking (tool is the anchor)', () => {
    expect(stage([toolDone(), dataPart()], running)).toBe('thinking')
  })
  test('a running tool followed by an empty text placeholder → calling-tool', () => {
    expect(stage([toolRunning(), emptyText()], running)).toBe('calling-tool')
  })
})
