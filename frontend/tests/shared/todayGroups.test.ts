// 例外面分组模型的闸（L4 批次 2 设计 §4.2 / §6）。
//
// 钉的是四件「改了会静默错」的事：
//   ① 9 值读态 → 组的映射（含 `paused_expired` 单列、24h 之外的终态直接不进面）；
//   ② 组序与组内排序（等我处理浮顶 · severity 降序 · 等龄降序）；
//   ③ 🔴 时间戳单位归一：run 是**秒**、matter 是**毫秒**，混用差 1000 倍；
//   ④ 提案在场时同事项的 `needs_review` 信号不重复出现（同 AttnBand 的去重）。
//
// 期望值手写，不从被测函数反推。

import { describe, expect, test } from 'vitest'

import type { AgentRunHistoryItem, AgentRunState } from '../../src/shared/api/types'
import type {
  MatterAttentionSignal,
  MatterPendingUpdatesEntry
} from '../../src/shared/api/types/matter'
import {
  TODAY_GROUP_IDS,
  TODAY_RECENT_LIMIT,
  buildTodayItems,
  epochToMs,
  groupTodayItems,
  todayGroupOf,
  type TodayGroupId,
  type TodayItem
} from '../../src/shared/components/today/todayGroups'

const NOW_MS = Date.UTC(2026, 7, 25, 12, 0, 0)
const SECOND = 1000

/** 测试用 translate：把 key 与插值拼成可断言的串（不依赖真实文案）。 */
const t = (key: string, options?: Record<string, unknown>): string =>
  options === undefined ? key : `${key}(${JSON.stringify(options)})`

const ctx = {
  t,
  agentTitles: new Map([['weekly-digest', '周报 Agent']]),
  formatDateTime: (iso: string) => `@${iso}`
}

function run(over: Partial<AgentRunHistoryItem> & { state: AgentRunState }): AgentRunHistoryItem {
  return {
    jobId: 1,
    agentId: 'weekly-digest',
    createdAt: NOW_MS / SECOND - 600,
    ...over
  }
}

function proposalEntry(
  matterPublicId: string,
  over: Partial<MatterPendingUpdatesEntry['updates'][number]> = {}
): MatterPendingUpdatesEntry {
  return {
    matter_public_id: matterPublicId,
    updates: [
      {
        id: 77,
        review_status: 'pending',
        summary: '本周三家供应商已回复',
        created_at: NOW_MS - 3 * 60_000,
        change_count: 3,
        is_stale: false,
        agent_run_id: 9,
        confidence: 0.82,
        anchored_matter_version: 4,
        created_by_kind: 'agent',
        matter_id: 12,
        from_event_id: null,
        to_event_id: null,
        original_proposal: {},
        reviewed_result: null,
        changes: [],
        accepted_change_ids: null,
        citations: [],
        stale_at: null,
        stale_reason: null,
        ...over
      }
    ]
  }
}

function signal(over: Partial<MatterAttentionSignal> = {}): MatterAttentionSignal {
  return {
    id: 501,
    kind: 'wait_overdue',
    state: 'open',
    severity: 'warn',
    why: '等待「供应商报价」已 5 天',
    first_opened_at: NOW_MS - 5 * 60_000,
    matter: {
      public_id: 'm-abc',
      title: '供应商比价',
      status: 'active',
      health: 'on_track',
      priority: 'p1'
    },
    ...over
  }
}

function idsOf(groups: ReturnType<typeof groupTodayItems>, id: TodayGroupId): string[] {
  return groups.find((group) => group.id === id)?.items.map((item) => item.id) ?? []
}

describe('todayGroupOf — 9 值读态 → 组', () => {
  const cases: ReadonlyArray<[AgentRunState, TodayGroupId | null]> = [
    ['paused_pending', 'waiting'],
    ['queued', 'inProgress'],
    ['running', 'inProgress'],
    ['paused_expired', 'expired'],
    ['failed', 'attention'],
    ['completed', 'recent'],
    ['skipped', 'recent'],
    ['paused_approved', 'recent'],
    ['paused_rejected', 'recent']
  ]

  test.each(cases)('%s → %s（终态按 24h 内计）', (state, expected) => {
    const items = buildTodayItems({ runs: [run({ state })], proposals: [], signals: [] }, ctx)
    expect(todayGroupOf(items[0]!, NOW_MS)).toBe(expected)
  })

  test('🔴 paused_expired 单列一组，不混进「等我处理」', () => {
    const items = buildTodayItems(
      { runs: [run({ state: 'paused_expired' })], proposals: [], signals: [] },
      ctx
    )
    expect(todayGroupOf(items[0]!, NOW_MS)).not.toBe('waiting')
  })

  test('24h 之外的终态 run 不进例外面（回顾面不是历史全量）', () => {
    const stale = run({
      state: 'completed',
      finishedAt: NOW_MS / SECOND - 25 * 3600
    })
    const items = buildTodayItems({ runs: [stale], proposals: [], signals: [] }, ctx)
    expect(todayGroupOf(items[0]!, NOW_MS)).toBeNull()
  })

  test('提案与信号恒进「等我处理」', () => {
    const items = buildTodayItems(
      { runs: [], proposals: [proposalEntry('m-abc')], signals: [signal()] },
      ctx
    )
    expect(items.map((item) => todayGroupOf(item, NOW_MS))).toEqual(['waiting', 'waiting'])
  })
})

describe('groupTodayItems — 组序与组内排序', () => {
  test('组序恒 = TODAY_GROUP_IDS，空组不返回', () => {
    const groups = groupTodayItems(
      buildTodayItems(
        {
          runs: [
            run({ jobId: 1, state: 'failed', finishedAt: NOW_MS / SECOND - 60 }),
            run({ jobId: 2, state: 'paused_pending', finishedAt: NOW_MS / SECOND - 120 }),
            run({ jobId: 3, state: 'running' })
          ],
          proposals: [],
          signals: []
        },
        ctx
      ),
      NOW_MS
    )
    expect(groups.map((group) => group.id)).toEqual(['waiting', 'inProgress', 'attention'])
    // 手写 canary：组序表本身没被改过。
    expect([...TODAY_GROUP_IDS]).toEqual([
      'waiting',
      'inProgress',
      'expired',
      'attention',
      'recent'
    ])
  })

  test('等我处理：severity 降序，同级按等龄降序（等最久的在最上）', () => {
    const groups = groupTodayItems(
      buildTodayItems(
        {
          runs: [run({ jobId: 4, state: 'paused_pending', finishedAt: NOW_MS / SECOND - 30 })],
          proposals: [],
          signals: [
            signal({ id: 1, severity: 'warn', first_opened_at: NOW_MS - 60_000 }),
            signal({ id: 2, severity: 'critical', first_opened_at: NOW_MS - 10_000 }),
            signal({ id: 3, severity: 'info', first_opened_at: NOW_MS - 999_000 })
          ]
        },
        ctx
      ),
      NOW_MS
    )
    // critical → 两条 warn（等更久的 signal:1 在 run:4 之前）→ info。
    expect(idsOf(groups, 'waiting')).toEqual(['signal:2', 'signal:1', 'run:4', 'signal:3'])
  })

  test('其余组按发生时刻降序（最新的在最上）', () => {
    const groups = groupTodayItems(
      buildTodayItems(
        {
          runs: [
            run({ jobId: 10, state: 'failed', finishedAt: NOW_MS / SECOND - 900 }),
            run({ jobId: 11, state: 'failed', finishedAt: NOW_MS / SECOND - 60 })
          ],
          proposals: [],
          signals: []
        },
        ctx
      ),
      NOW_MS
    )
    expect(idsOf(groups, 'attention')).toEqual(['run:11', 'run:10'])
  })

  test('最近结果封顶 20 条（回顾面不该把等人的挤出屏幕）', () => {
    const runs = Array.from({ length: 26 }, (_unused, index) =>
      run({ jobId: 100 + index, state: 'completed', finishedAt: NOW_MS / SECOND - index * 60 })
    )
    const groups = groupTodayItems(
      buildTodayItems({ runs, proposals: [], signals: [] }, ctx),
      NOW_MS
    )
    expect(idsOf(groups, 'recent')).toHaveLength(TODAY_RECENT_LIMIT)
    // 留下的是最新的那 20 条。
    expect(idsOf(groups, 'recent')[0]).toBe('run:100')
    expect(idsOf(groups, 'recent').at(-1)).toBe('run:119')
  })
})

describe('🔴 时间戳单位归一（async_jobs 秒 / matter 毫秒）', () => {
  test('epochToMs 按量级判别，两种输入落到同一轴', () => {
    expect(epochToMs(NOW_MS / SECOND)).toBe(NOW_MS)
    expect(epochToMs(NOW_MS)).toBe(NOW_MS)
    expect(epochToMs(null)).toBe(0)
  })

  test('run（秒）与信号（毫秒）在同一组里按真实时刻排序', () => {
    // signal 比 run 早 50 秒进入等待 —— 等龄更长，必须排在前面。
    // 🔴 顺序**故意与「秒当毫秒读」的结果相反**：不折算时 run 的 `at` 是 1.7e9 量级、
    // 恒小于任何毫秒时刻，等龄升序会把它排到最前 —— 断言写成 run 在前就抓不到这个 bug。
    const groups = groupTodayItems(
      buildTodayItems(
        {
          runs: [run({ jobId: 7, state: 'paused_pending', finishedAt: NOW_MS / SECOND - 50 })],
          proposals: [],
          signals: [signal({ id: 8, severity: 'warn', first_opened_at: NOW_MS - 100_000 })]
        },
        ctx
      ),
      NOW_MS
    )
    expect(idsOf(groups, 'waiting')).toEqual(['signal:8', 'run:7'])
  })
})

describe('buildTodayItems — 行装配', () => {
  test('run 标题读 agent 名；triage 说明 = 触发方式 + 触发时刻', () => {
    const [item] = buildTodayItems(
      {
        runs: [
          run({
            state: 'paused_pending',
            triggerKind: 'cron',
            triggerFiredAtIso: '2026-08-25T09:00:00+00:00'
          })
        ],
        proposals: [],
        signals: []
      },
      ctx
    )
    expect(item?.title).toBe('周报 Agent')
    expect(item?.triageLogic).toContain('today.triage.runTriggerAt')
    expect(item?.triageLogic).toContain('@2026-08-25T09:00:00+00:00')
  })

  test('触发方式缺席（老行）→ 不编一句话填上', () => {
    const [item] = buildTodayItems(
      { runs: [run({ state: 'failed' })], proposals: [], signals: [] },
      ctx
    )
    expect(item?.triageLogic).toBe('')
  })

  test('认不出的 trigger kind 原样显示，不吞成「未知」', () => {
    const [item] = buildTodayItems(
      {
        runs: [run({ state: 'queued', triggerKind: 'brand_new_kind' })],
        proposals: [],
        signals: []
      },
      ctx
    )
    expect(item?.triageLogic).toContain('brand_new_kind')
  })

  test('提案：is_stale / 非 pending 都不进队列', () => {
    const items = buildTodayItems(
      {
        runs: [],
        proposals: [
          proposalEntry('m-1', { id: 1, is_stale: true }),
          proposalEntry('m-2', { id: 2, review_status: 'accepted' }),
          proposalEntry('m-3', { id: 3 })
        ],
        signals: []
      },
      ctx
    )
    expect(items.map((item) => item.id)).toEqual(['proposal:3'])
  })

  test('提案 triage = summary + 变更数 + 置信度（置信度缺席则省略那一段）', () => {
    const [withConfidence] = buildTodayItems(
      { runs: [], proposals: [proposalEntry('m-1')], signals: [] },
      ctx
    )
    expect(withConfidence?.triageLogic).toContain('本周三家供应商已回复')
    expect(withConfidence?.triageLogic).toContain('today.triage.proposalChanges')
    expect(withConfidence?.triageLogic).toContain('"percent":82')

    const [noConfidence] = buildTodayItems(
      { runs: [], proposals: [proposalEntry('m-1', { confidence: null })], signals: [] },
      ctx
    )
    expect(noConfidence?.triageLogic).not.toContain('proposalConfidence')
  })

  test('信号：why 直通当 triage 说明；severity 透传', () => {
    const [item] = buildTodayItems({ runs: [], proposals: [], signals: [signal()] }, ctx)
    expect(item?.title).toBe('供应商比价')
    expect(item?.triageLogic).toBe('等待「供应商报价」已 5 天')
    expect(item?.severity).toBe('warn')
  })

  test('信号缺 signal.id / matter.public_id → 不渲染（点不动的行比不渲染更糟）', () => {
    const items = buildTodayItems(
      {
        runs: [],
        proposals: [],
        signals: [
          signal({ id: undefined }),
          signal({ id: 9, matter: undefined }),
          signal({ id: 10, state: 'snoozed' })
        ]
      },
      ctx
    )
    expect(items).toEqual([])
  })

  test('🔴 同事项有待评审提案时，needs_review 信号不重复出现（同 AttnBand 去重）', () => {
    const items = buildTodayItems(
      {
        runs: [],
        proposals: [proposalEntry('m-abc')],
        signals: [
          signal({ id: 20, kind: 'needs_review' }),
          signal({
            id: 21,
            kind: 'needs_review',
            matter: { ...signal().matter!, public_id: 'm-other' }
          }),
          signal({ id: 22, kind: 'wait_overdue' })
        ]
      },
      ctx
    )
    const ids = items.map((item: TodayItem) => item.id)
    expect(ids).not.toContain('signal:20')
    // 别的事项的 needs_review、以及同事项的其它 kind 都照常在场。
    expect(ids).toContain('signal:21')
    expect(ids).toContain('signal:22')
    expect(ids).toContain('proposal:77')
  })
})
