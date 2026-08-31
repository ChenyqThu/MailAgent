// 今日页五节的纯模块单测（L4 P4c）。渲染面在 `TodaySurface.test.tsx`；这里只测算法。
//
// 三条最容易做假的：
//   ① **临期的三种 kind 才归 due 节**，其余四种留在 decide —— 判据来自后端
//      `attention.py::_collect_facts` 的产生条件，不是前端另定的标签。
//   ② `splitDueSignals` 把信号从读态组里**摘走**（不是复制）：同一件事出现两遍比不显示更糟。
//   ③ 二级栏 meta 只在算得出一句有信息量时才有；算不出返空串，**不用「N 件待处理」凑数**。

import { describe, expect, test } from 'vitest'

import { MATTER_ATTENTION_KINDS } from '@shared/api/types/matter'
import type { AgendaEntry, ReportListItem } from '@shared/api/types'
import type { TodayReplyItem } from '@shared/api/types/today'
import {
  buildMeetItems,
  buildReplyItems,
  buildReportItems,
  buildTodaySections,
  isDueSignalKind,
  remainingLabel,
  splitDueSignals,
  type TodaySectionBuildContext
} from '@shared/components/today/todaySections'
import type {
  TodayGroup,
  TodayRunItem,
  TodaySignalItem
} from '@shared/components/today/todayGroups'

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0)

/** 纯模块只要 key + 插值：把 key 与参数拼成可断言的串，不引 i18next。 */
const ctx: TodaySectionBuildContext = {
  t: (key, options) =>
    options === undefined ? key : `${key}(${JSON.stringify(options, Object.keys(options).sort())})`,
  formatTime: (ms) => `T${new Date(ms).toISOString().slice(11, 16)}`,
  formatAge: (ms) => `AGE${Math.round(ms / 3600_000)}h`
}

function signal(over: Partial<TodaySignalItem> = {}): TodaySignalItem {
  return {
    id: 'signal:1',
    source: 'signal',
    state: 'open',
    kind: 'wait_overdue',
    title: '供应商比价',
    triageLogic: '等待「供应商报价」已 5 天',
    at: NOW - 3600_000,
    severity: 'warn',
    link: { matterPublicId: 'm-abc', signalId: 1 },
    ...over
  }
}

function runItem(id: string, state: TodayRunItem['state'] = 'paused_pending'): TodayRunItem {
  return {
    id,
    source: 'run',
    state,
    title: '周报 Agent',
    triageLogic: '由「定时」触发',
    at: NOW - 60_000,
    severity: 'warn',
    link: { jobId: 1, agentId: 'weekly', sessionId: 9 }
  }
}

describe('isDueSignalKind', () => {
  test('只有三种「临期」kind 归 due 节', () => {
    expect(MATTER_ATTENTION_KINDS.filter(isDueSignalKind)).toEqual([
      'wait_overdue',
      'action_overdue',
      'deadline_near'
    ])
  })

  test('要拿主意的四种留在 decide', () => {
    for (const kind of ['needs_review', 'run_failed', 'context_gap', 'health_down'] as const) {
      expect(isDueSignalKind(kind), kind).toBe(false)
    }
  })
})

describe('splitDueSignals', () => {
  test('临期信号被**摘走**（不是复制），其余原样留在组里', () => {
    const groups: TodayGroup[] = [
      {
        id: 'waiting',
        items: [
          runItem('run:1'),
          signal({ id: 'signal:due', kind: 'deadline_near' }),
          signal({ id: 'signal:review', kind: 'needs_review' })
        ]
      }
    ]
    const out = splitDueSignals(groups)
    expect(out.due.map((s) => s.id)).toEqual(['signal:due'])
    expect(out.groups[0].items.map((i) => i.id)).toEqual(['run:1', 'signal:review'])
  })

  test('组被摘空后整组消失（渲染面因此不必判空）', () => {
    const out = splitDueSignals([{ id: 'waiting', items: [signal()] }])
    expect(out.groups).toEqual([])
    expect(out.due).toHaveLength(1)
  })
})

describe('buildMeetItems', () => {
  test('只取邮箱日历源，按开始时刻升序；已开始的 why 换一句', () => {
    const entries: AgendaEntry[] = [
      {
        id: 'a',
        source: 'mail',
        hot: false,
        title: '晚会',
        startIso: new Date(NOW + 3600_000).toISOString(),
        endIso: null,
        allDay: false,
        multiDay: false
      },
      {
        id: 'b',
        source: 'mail',
        hot: false,
        title: '早会',
        startIso: new Date(NOW - 3600_000).toISOString(),
        endIso: null,
        allDay: false,
        multiDay: false
      },
      {
        id: 'c',
        source: 'matter',
        hot: false,
        title: '事项截止（归 due 节，不进这里）',
        startIso: new Date(NOW).toISOString(),
        endIso: null,
        allDay: false,
        multiDay: false
      }
    ]
    const items = buildMeetItems(entries, NOW, ctx)
    expect(items.map((i) => i.title)).toEqual(['早会', '晚会'])
    expect(items[0].why).toContain('today.why.meetPast')
    expect(items[1].why).toContain('today.why.meetUpcoming')
    // 会是知会档 —— 没有「在这一行做完」的动作。
    expect(items.every((i) => i.actionable === false)).toBe(true)
  })

  test('startIso 解析不了的条目直接丢（说不出几点 = 说不出为什么是今天）', () => {
    const items = buildMeetItems(
      [
        {
          id: 'x',
          source: 'mail',
          hot: false,
          title: '坏时刻',
          startIso: 'not-a-date',
          endIso: null,
          allDay: false,
          multiDay: false
        }
      ],
      NOW,
      ctx
    )
    expect(items).toEqual([])
  })
})

describe('buildReplyItems', () => {
  const row: TodayReplyItem = {
    id: 'mail:1',
    source: 'mail',
    title: '主题',
    why: '需要回复 · 等了 26 小时',
    meta: '张三',
    atIso: new Date(NOW - 26 * 3600_000).toISOString(),
    waitedMs: 26 * 3600_000,
    actionable: true,
    link: { kind: 'mail', internalId: 1 }
  }

  test('后端的 why 原样透传（前端不重拼第二个口径）', () => {
    const [item] = buildReplyItems([row])
    expect(item.why).toBe('需要回复 · 等了 26 小时')
    expect(item.atMs).toBe(NOW - 26 * 3600_000)
    expect(item.actionable).toBe(true)
  })

  test('why 为空串时原样保留空串（渲染面据此按缺席处理，不在这里编一句）', () => {
    const [item] = buildReplyItems([{ ...row, why: '' }])
    expect(item.why).toBe('')
  })
})

describe('buildReportItems', () => {
  function report(over: Partial<ReportListItem>): ReportListItem {
    return {
      id: 'rp',
      agent_id: 'daily',
      cadence: 'daily',
      report_date: '2026-08-31',
      window_start: '',
      window_end: '',
      status: 'ready',
      counts: { total: 0, attention: 0, handled: 0, fyi: 0 },
      headline: '日报',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      error: null,
      created_at: null,
      generated_at: null,
      ...over
    } as ReportListItem
  }

  const window = { startMs: NOW - 12 * 3600_000, endMs: NOW + 12 * 3600_000 }

  test('只留窗口内的那几份，秒 epoch 自动折算成毫秒', () => {
    const items = buildReportItems(
      [
        report({ id: 'in', generated_at: (NOW - 3600_000) / 1000 }),
        report({ id: 'out', generated_at: (NOW - 48 * 3600_000) / 1000 })
      ],
      window,
      ctx
    )
    expect(items.map((i) => i.id)).toEqual(['report:in'])
    expect(items[0].atMs).toBe(NOW - 3600_000)
  })

  test('generated_at 缺席时回落 created_at（还没生成完的那份也该看得见）', () => {
    const items = buildReportItems(
      [report({ id: 'pending', generated_at: null, created_at: NOW / 1000 })],
      window,
      ctx
    )
    expect(items.map((i) => i.id)).toEqual(['report:pending'])
  })
})

describe('buildTodaySections', () => {
  const empty = { groups: [], meet: [], reply: [], reports: [] }

  test('节序 = 二级栏词表序', () => {
    expect(buildTodaySections(empty, NOW, ctx).map((s) => s.id)).toEqual([
      'decide',
      'meet',
      'reply',
      'due',
      'out'
    ])
  })

  test('读态组按表分流到 decide / out；临期信号单独进 due', () => {
    const sections = buildTodaySections(
      {
        ...empty,
        groups: [
          { id: 'waiting', items: [runItem('run:1'), signal()] },
          { id: 'expired', items: [runItem('run:2', 'paused_expired')] },
          { id: 'attention', items: [runItem('run:3', 'failed')] },
          { id: 'recent', items: [runItem('run:4', 'completed')] }
        ]
      },
      NOW,
      ctx
    )
    const byId = Object.fromEntries(sections.map((s) => [s.id, s]))
    expect(byId.decide.groups.map((g) => g.id)).toEqual(['waiting', 'expired'])
    expect(byId.decide.count).toBe(2)
    expect(byId.due.count).toBe(1)
    expect(byId.out.groups.map((g) => g.id)).toEqual(['attention', 'recent'])
    expect(byId.out.count).toBe(2)
  })

  test('count = 那一节屏幕上的行数（组行 + 简化行都算）', () => {
    const meet = buildMeetItems(
      [
        {
          id: 'a',
          source: 'mail',
          hot: false,
          title: '会',
          startIso: new Date(NOW + 600_000).toISOString(),
          endIso: null,
          allDay: false,
          multiDay: false
        }
      ],
      NOW,
      ctx
    )
    const sections = buildTodaySections({ ...empty, meet }, NOW, ctx)
    const meetSection = sections.find((s) => s.id === 'meet')
    expect(meetSection?.count).toBe(meetSection?.rows.length)
    expect(meetSection?.count).toBe(1)
  })

  test('meta：会有「下一场」、待回有「最久一封」；其余三节是空串（不用计数凑数）', () => {
    const meet = buildMeetItems(
      [
        {
          id: 'a',
          source: 'mail',
          hot: false,
          title: '会',
          startIso: new Date(NOW + 600_000).toISOString(),
          endIso: null,
          allDay: false,
          multiDay: false
        }
      ],
      NOW,
      ctx
    )
    const reply = buildReplyItems([
      {
        id: 'mail:1',
        source: 'mail',
        title: '新的',
        why: 'w',
        meta: '',
        atIso: new Date(NOW - 3600_000).toISOString(),
        waitedMs: 3600_000,
        actionable: true,
        link: { kind: 'mail', internalId: 1 }
      },
      {
        id: 'mail:2',
        source: 'mail',
        title: '最久的',
        why: 'w',
        meta: '',
        atIso: new Date(NOW - 26 * 3600_000).toISOString(),
        waitedMs: 26 * 3600_000,
        actionable: true,
        link: { kind: 'mail', internalId: 2 }
      }
    ])
    const byId = Object.fromEntries(
      buildTodaySections(
        { groups: [{ id: 'waiting', items: [runItem('run:1')] }], meet, reply, reports: [] },
        NOW,
        ctx
      ).map((s) => [s.id, s])
    )
    expect(byId.meet.meta).toContain('today.meta.nextMeet')
    // 「最久一封」取的是等最久那条（26h），不是列表第一条。
    expect(byId.reply.meta).toContain('AGE26h')
    expect(byId.decide.meta).toBe('')
    expect(byId.due.meta).toBe('')
    expect(byId.out.meta).toBe('')
  })

  test('全部开完之后不再有「下一场」（不指着一个过去的时刻说下一场）', () => {
    const meet = buildMeetItems(
      [
        {
          id: 'a',
          source: 'mail',
          hot: false,
          title: '开完了',
          startIso: new Date(NOW - 600_000).toISOString(),
          endIso: null,
          allDay: false,
          multiDay: false
        }
      ],
      NOW,
      ctx
    )
    const byId = Object.fromEntries(
      buildTodaySections({ ...empty, meet }, NOW, ctx).map((s) => [s.id, s])
    )
    expect(byId.meet.meta).toBe('')
  })
})

describe('remainingLabel', () => {
  const t = (key: string, options?: Record<string, unknown>): string =>
    `${key}:${JSON.stringify(options ?? {})}`

  test('不足一小时报分钟；不足一分钟也报「1 分钟」（不显示 0）', () => {
    expect(remainingLabel(t, 40 * 60_000)).toBe('today.next.inMinutes:{"n":40}')
    expect(remainingLabel(t, 20_000)).toBe('today.next.inMinutes:{"n":1}')
  })

  test('整点不写「2 小时 0 分」', () => {
    expect(remainingLabel(t, 2 * 3600_000)).toBe('today.next.inHoursOnly:{"h":2}')
    expect(remainingLabel(t, 2 * 3600_000 + 40 * 60_000)).toBe('today.next.inHours:{"h":2,"m":40}')
  })

  test('已经开始 → 空串（调用方换一句「已经开始」，不显示负数）', () => {
    expect(remainingLabel(t, 0)).toBe('')
    expect(remainingLabel(t, -60_000)).toBe('')
  })
})
