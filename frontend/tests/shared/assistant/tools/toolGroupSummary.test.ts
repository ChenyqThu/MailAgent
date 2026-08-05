// harness-chat lane B — summarizeToolGroup (pure). Encodes the group header state + the second
// 灾难级 red line (forceExpand when an approval-requested OR errored tool is present) as a truth
// table so a regression can't quietly let a group fold an approval card out of sight.

import { describe, expect, test } from 'vitest'

import { summarizeToolGroup } from '@shared/assistant/tools/generic/toolGroupSummary'
import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'

const running = (name = 'a'): TurnStagePart => ({ type: 'tool-call', toolName: name })
const done = (name = 'b'): TurnStagePart => ({
  type: 'tool-call',
  toolName: name,
  result: { ok: true }
})
const errored = (name = 'c'): TurnStagePart => ({
  type: 'tool-call',
  toolName: name,
  isError: true,
  result: { error: 'x' }
})
const awaiting = (name = 'd'): TurnStagePart => ({
  type: 'tool-call',
  toolName: name,
  approval: { id: 'ap1' } as unknown as TurnStagePart['approval']
})

describe('summarizeToolGroup — aggregate + count + names', () => {
  test('all running → running, count/names captured', () => {
    const s = summarizeToolGroup([running('email_search'), running('kos_query')])
    expect(s.aggregate).toBe('running')
    expect(s.count).toBe(2)
    expect(s.toolNames).toEqual(['email_search', 'kos_query'])
    expect(s.forceExpand).toBe(false)
  })
  test('all done → done, not force-expanded (auto-collapse eligible)', () => {
    const s = summarizeToolGroup([done(), done()])
    expect(s.aggregate).toBe('done')
    expect(s.forceExpand).toBe(false)
  })
  test('mixed running + done → running', () => {
    expect(summarizeToolGroup([done(), running()]).aggregate).toBe('running')
  })
  test('ignores non-tool parts in the slice', () => {
    const s = summarizeToolGroup([{ type: 'text', text: 'x' }, running(), done()])
    expect(s.count).toBe(2)
  })

  // W6 — suggest_followups 零渲染（chip 行才是它的 UI），所以它不能进组头的计数与工具名列表，
  // 否则组头会念一件用户在展开区里找不到的事。
  test('suggest_followups 不计入 count / toolNames（零渲染的 part 不算「用了个工具」）', () => {
    const s = summarizeToolGroup([running('email_search'), done('suggest_followups')])
    expect(s.count).toBe(1)
    expect(s.toolNames).toEqual(['email_search'])
    expect(s.aggregate).toBe('running')
  })
  test('整组都是 suggest_followups → count 0（调用方据此退化成裸渲染，不出空组头）', () => {
    const s = summarizeToolGroup([done('suggest_followups'), done('suggest_followups')])
    expect(s.count).toBe(0)
    expect(s.toolNames).toEqual([])
    expect(s.forceExpand).toBe(false)
  })
})

describe('summarizeToolGroup — RED LINE ②: force-expand on approval / error', () => {
  test('a pending approval anywhere in the group → forceExpand + awaiting aggregate', () => {
    const s = summarizeToolGroup([done(), awaiting(), running()])
    expect(s.forceExpand).toBe(true)
    expect(s.aggregate).toBe('awaiting')
  })
  test('an errored tool anywhere → forceExpand + error aggregate', () => {
    const s = summarizeToolGroup([done(), errored()])
    expect(s.forceExpand).toBe(true)
    expect(s.aggregate).toBe('error')
  })
  test('incomplete part status also counts as error', () => {
    const s = summarizeToolGroup([
      { type: 'tool-call', toolName: 't', status: { type: 'incomplete' } }
    ])
    expect(s.forceExpand).toBe(true)
    expect(s.aggregate).toBe('error')
  })
  test('approval outranks error for the header word, but both force expand', () => {
    const s = summarizeToolGroup([errored(), awaiting()])
    expect(s.aggregate).toBe('awaiting')
    expect(s.forceExpand).toBe(true)
  })
})
