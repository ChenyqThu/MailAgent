// L4 群聊 UX 批 — groupTimeline 纯函数（design §3 七条规则）。
//
//   TL1 同 speaker 3 分钟内折叠，超过拆组；TL2 跨日插日期分隔；TL3 turn 行 → meta 变体映射
//   （skipped 按 error 三分 + 泛化）；TL4 stopped turn 行与 group_stop 系统行同 runId 只一项；
//   TL5 spoke overlay 被同 messageId 落库行顶掉；TL6 overlay 与 turn 行同 turnKey 落库优先；
//   TL7 meta 行打断折叠；TL8 无事件无台账 → 零在场态；TL9 user / 成员交替不合并；
//   TL10 早于最早消息的 turn 不成项；TL11 hasMore 边界分隔，界外不推导；TL12 no_candidates
//   台账推导三分支；TL13 同链有 stopped 行 → 失败项 retryDisabled。

import { describe, expect, test } from 'vitest'

import type { ChatMessage } from '@shared/api/types'
import type { GroupTurnWire } from '@shared/api/groupSettings'
import {
  buildGroupTimeline,
  type GroupLiveSnapshot,
  type GroupLiveTurn,
  type GroupTimelineItem
} from '../../../src/shared/components/agents/groups/groupTimeline'

const MIN = 60_000
// 2026-09-01 12:00 本地（vitest 钉 TZ=America/Los_Angeles）。
const BASE = new Date(2026, 8, 1, 12, 0, 0).getTime()

function row(
  id: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  createdAt: number,
  over: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    session_id: 300,
    role,
    content,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    speaker_agent_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...over
  } as ChatMessage
}

function turn(over: Partial<GroupTurnWire> & { id: number; startedAt: number }): GroupTurnWire {
  return {
    runId: 'r1',
    chainId: 1,
    seq: over.id,
    agentId: 'a1',
    triggerKind: 'human',
    outcome: 'silent',
    messageId: null,
    model: null,
    tokensInput: null,
    tokensOutput: null,
    costUsd: null,
    error: null,
    finishedAt: null,
    ...over
  }
}

function live(
  over: Partial<GroupLiveSnapshot> & { overlayItems?: GroupLiveTurn[] } = {}
): GroupLiveSnapshot {
  const overlay = new Map<string, GroupLiveTurn>()
  for (const o of over.overlayItems ?? []) overlay.set(o.turnKey, o)
  return {
    inFlight: over.inFlight ?? null,
    preparing: over.preparing ?? null,
    queued: over.queued ?? [],
    overlay,
    stoppedByRun: over.stoppedByRun ?? new Set()
  }
}

function build(
  messages: ChatMessage[],
  turns: GroupTurnWire[] | null = [],
  extra: { hasMore?: boolean; live?: GroupLiveSnapshot | null } = {}
): GroupTimelineItem[] {
  return buildGroupTimeline({
    messages,
    turns,
    turnsHasMore: extra.hasMore ?? false,
    live: extra.live ?? null,
    local: []
  }).items
}

const groups = (items: GroupTimelineItem[]) =>
  items.filter((i): i is Extract<GroupTimelineItem, { kind: 'group' }> => i.kind === 'group')
const metas = (items: GroupTimelineItem[]) =>
  items.filter((i): i is Extract<GroupTimelineItem, { kind: 'meta' }> => i.kind === 'meta')
const kinds = (items: GroupTimelineItem[]) => items.map((i) => i.kind)

describe('groupTimeline', () => {
  test('TL1 同 speaker 3 分钟内折叠成组，超过拆组', () => {
    const near = build([
      row(1, 'assistant', '一', BASE, { speaker_agent_id: 'a1' }),
      row(2, 'assistant', '二', BASE + 2 * MIN, { speaker_agent_id: 'a1' })
    ])
    expect(groups(near)).toHaveLength(1)
    expect(groups(near)[0].messages.map((m) => m.text)).toEqual(['一', '二'])

    const far = build([
      row(1, 'assistant', '一', BASE, { speaker_agent_id: 'a1' }),
      row(2, 'assistant', '二', BASE + 4 * MIN, { speaker_agent_id: 'a1' })
    ])
    expect(groups(far)).toHaveLength(2)
  })

  test('TL2 跨自然日插日期分隔', () => {
    // turns=null：只看日期规则（台账加载后两条链根会各自走规则 6，TL12 单独钉）。
    const items = build(
      [row(1, 'user', '昨天', BASE - 24 * 60 * MIN), row(2, 'user', '今天', BASE)],
      null
    )
    const dates = items.filter((i) => i.kind === 'date')
    expect(dates).toHaveLength(2)
    // 分隔落在两条消息之间（第一条前也有一条，给首屏一个日期锚）。
    expect(kinds(items)).toEqual(['date', 'group', 'date', 'group'])
  })

  test('TL3 turn 行 → meta 变体：silent / held_dup / failed；spoke 不成项；skipped 按 error 三分 + 泛化', () => {
    const messages = [row(1, 'user', '开始', BASE)]
    const turns = [
      turn({ id: 1, startedAt: BASE + 1, outcome: 'silent' }),
      turn({ id: 2, startedAt: BASE + 2, outcome: 'held_dup' }),
      turn({ id: 3, startedAt: BASE + 3, outcome: 'failed', error: 'boom' }),
      turn({ id: 4, startedAt: BASE + 4, outcome: 'spoke', messageId: 9 }),
      turn({ id: 5, startedAt: BASE + 5, outcome: 'skipped', error: 'monologue' }),
      turn({ id: 6, startedAt: BASE + 6, outcome: 'skipped', error: 'no_new_messages' }),
      turn({ id: 7, startedAt: BASE + 7, outcome: 'skipped', error: 'removed' }),
      turn({ id: 8, startedAt: BASE + 8, outcome: 'skipped', error: null }),
      turn({ id: 9, startedAt: BASE + 9, outcome: 'skipped', error: 'something_new' })
    ]
    const variants = metas(build(messages, turns)).map((m) => m.variant)
    expect(variants).toEqual([
      'silent',
      'held_dup',
      'failed',
      'skipped_monologue',
      'skipped_no_new_messages',
      'skipped_removed',
      'skipped',
      'skipped'
    ])
    expect(metas(build(messages, turns))[2].error).toBe('boom')
  })

  test('TL4 stopped turn 行与 group_stop 系统行同 runId → 只一项（系统行优先）', () => {
    const messages = [
      row(1, 'user', '开始', BASE),
      row(2, 'system', '', BASE + 10, {
        metadata: JSON.stringify({ kind: 'group_stop', reason: 'chain_cap', runId: 'r1' })
      })
    ]
    const turns = [turn({ id: 1, startedAt: BASE + 5, outcome: 'stopped', error: 'chain_cap' })]
    const stopped = build(messages, turns).filter((i) => i.kind === 'stopped')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatchObject({ key: 's:2', reason: 'chain_cap' })
    // 没有系统行时 turn 行兜底。
    const only = build([messages[0]], turns).filter((i) => i.kind === 'stopped')
    expect(only).toHaveLength(1)
    expect(only[0].key).toBe('st:1')
  })

  test('TL5 live spoke 项在 messages 出现同 messageId 后被丢', () => {
    const messages = [
      row(1, 'user', '开始', BASE),
      row(2, 'assistant', '回复', BASE + 1, { speaker_agent_id: 'a1' })
    ]
    const overlay: GroupLiveTurn = {
      turnKey: 'r1:1',
      phase: 'spoke',
      agentId: 'a1',
      runId: 'r1',
      chainId: 1,
      seq: 1,
      ts: BASE + 1,
      text: '回复',
      messageId: 2
    }
    const withRow = groups(build(messages, [], { live: live({ overlayItems: [overlay] }) }))
    expect(withRow.flatMap((g) => g.messages).filter((m) => m.text === '回复')).toHaveLength(1)
    // 落库行还没到：overlay 项顶上。
    const before = groups(build([messages[0]], [], { live: live({ overlayItems: [overlay] }) }))
    expect(before.flatMap((g) => g.messages).filter((m) => m.text === '回复')).toHaveLength(1)
  })

  test('TL6 live meta 项与 turn 行同 runId:seq → 落库优先', () => {
    const messages = [row(1, 'user', '开始', BASE)]
    const overlay: GroupLiveTurn = {
      turnKey: 'r1:1',
      phase: 'silent',
      agentId: 'a1',
      runId: 'r1',
      chainId: 1,
      seq: 1,
      ts: BASE + 5
    }
    const turns = [turn({ id: 1, startedAt: BASE + 5, runId: 'r1', seq: 1, outcome: 'silent' })]
    const items = build(messages, turns, { live: live({ overlayItems: [overlay] }) })
    expect(metas(items)).toHaveLength(1)
    expect(metas(items)[0].key).toBe('t:1')
  })

  test('TL7 meta 行打断折叠组', () => {
    const messages = [
      row(1, 'assistant', '一', BASE, { speaker_agent_id: 'a1' }),
      row(2, 'assistant', '二', BASE + MIN, { speaker_agent_id: 'a1' })
    ]
    const turns = [turn({ id: 1, startedAt: BASE + 30_000, agentId: 'a2', outcome: 'silent' })]
    expect(kinds(build(messages, turns))).toEqual(['date', 'group', 'meta', 'group'])
  })

  test('TL8 无事件无 turn 行 → tail 空、无在场项', () => {
    const out = buildGroupTimeline({
      messages: [row(1, 'user', '开始', BASE), row(2, 'user', '再来', BASE + MIN)],
      turns: null,
      turnsHasMore: false,
      live: null,
      local: []
    })
    expect(out.tail).toEqual({ inFlight: null, preparing: null, queued: [] })
    expect(out.items.some((i) => i.kind !== 'date' && i.kind !== 'group')).toBe(false)
  })

  test('TL9 user 组与成员组交替不合并', () => {
    const items = build([
      row(1, 'user', '一', BASE),
      row(2, 'assistant', '二', BASE + 1, { speaker_agent_id: 'a1' }),
      row(3, 'user', '三', BASE + 2)
    ])
    expect(groups(items).map((g) => g.speaker.type)).toEqual(['user', 'member', 'user'])
  })

  test('TL10 早于最早消息的 turn 行不成项', () => {
    const messages = [row(1, 'user', '开始', BASE)]
    const turns = [
      turn({ id: 1, startedAt: BASE - 1, outcome: 'silent' }),
      turn({ id: 2, startedAt: BASE + 1, outcome: 'silent' })
    ]
    expect(metas(build(messages, turns)).map((m) => m.key)).toEqual(['t:2'])
  })

  test('TL11 hasMore → 最旧 turn 之前插 turnsBoundary；其前的消息不出 meta 行、不做推导', () => {
    const messages = [
      row(1, 'user', '一', BASE),
      row(2, 'assistant', '二', BASE + 1, { speaker_agent_id: 'a1' }),
      row(3, 'user', '三', BASE + 3 * MIN),
      row(4, 'assistant', '四', BASE + 4 * MIN, { speaker_agent_id: 'a1' })
    ]
    const turns = [
      turn({ id: 9, startedAt: BASE + 3 * MIN + 30_000, chainId: 3, outcome: 'silent' })
    ]
    const items = build(messages, turns, { hasMore: true })
    const boundaryAt = items.findIndex((i) => i.kind === 'turnsBoundary')
    expect(boundaryAt).toBeGreaterThan(0)
    expect(items[boundaryAt]).toMatchObject({ ts: BASE + 3 * MIN + 30_000 })
    // 链根 1 在边界之前：零 turn 行也不推导 no_candidates。
    expect(items.some((i) => i.kind === 'noCandidates')).toBe(false)
    // 边界之后 meta 行照常。
    expect(metas(items)).toHaveLength(1)
    expect(items.findIndex((i) => i.kind === 'meta')).toBeGreaterThan(boundaryAt)
  })

  test('TL12 no_candidates 推导：链根零 turn 行且非最后一条 → 出；最后一条不出；台账未加载不出', () => {
    const messages = [row(1, 'user', '一', BASE), row(2, 'user', '二', BASE + MIN)]
    const items = build(messages, [])
    const nc = items.filter((i) => i.kind === 'noCandidates')
    expect(nc).toHaveLength(1)
    expect(nc[0].key).toBe('nc:1')
    // 链根 1 有 turn 行 → 不推导。
    expect(
      build(messages, [turn({ id: 1, startedAt: BASE + 1, chainId: 1 })]).some(
        (i) => i.kind === 'noCandidates'
      )
    ).toBe(false)
    // 台账未加载（labs off / 请求中）→ 不推导。
    expect(build(messages, null).some((i) => i.kind === 'noCandidates')).toBe(false)
  })

  test('TL13 失败 meta 项在同链存在 stopped 行时 retryDisabled=true', () => {
    const messages = [row(1, 'user', '一', BASE)]
    const failed = turn({
      id: 1,
      startedAt: BASE + 1,
      outcome: 'failed',
      error: 'boom',
      chainId: 1
    })
    const stopped = turn({
      id: 2,
      startedAt: BASE + 2,
      outcome: 'stopped',
      error: 'chain_cap',
      chainId: 1
    })
    expect(metas(build(messages, [failed]))[0].retryDisabled).toBe(false)
    expect(metas(build(messages, [failed, stopped]))[0].retryDisabled).toBe(true)
    // 事件里被停掉的 run 同样禁用。
    expect(
      metas(build(messages, [failed], { live: live({ stoppedByRun: new Set(['r1']) }) }))[0]
        .retryDisabled
    ).toBe(true)
  })
})
