// 排程求值器单测 —— 契约 §3（`.trellis/tasks/07-24-…/research/schedule-contract.md`）。
//
// 这些断言是**手写**的（不是「实现产出什么就断言什么」），锁的是语义不是实现：
// interval 相位以 anchor 为原点、WKST=SU、月末 skip/clamp、DST 墙钟恒定、星期编号转换。
// 跨语言对齐另有 parity 测试（scheduleParity.test.ts）读 Python 侧生成的黄金 fixture。
//
// ⚠️ vitest 全局 TZ 钉死 America/Los_Angeles（vitest.config.ts）——本文件用 Asia/Shanghai
// 的用例正好验证「求值按规则时区、不是宿主机时区」。
import { describe, expect, test } from 'vitest'

import {
  occurrences,
  offsetAt,
  offsetLabel,
  preview,
  wallClockAt,
  wallClockToUtc
} from '@shared/components/agents/schedule/occurrences'
import { DEFAULT_RULE, type ScheduleRule } from '@shared/components/agents/schedule/types'

const LA = 'America/Los_Angeles'
const SH = 'Asia/Shanghai'

function rule(over: Partial<ScheduleRule>): ScheduleRule {
  return { ...DEFAULT_RULE, ...over }
}

/** 求值 → ISO 字符串（带真实 offset），断言可读。 */
function isos(
  r: Partial<ScheduleRule>,
  tz: string,
  anchor: string,
  after: string,
  count = 5
): string[] {
  return occurrences(rule(r), tz, anchor, new Date(after).getTime(), count).map((e) =>
    isoWithOffset(e.utcMs, tz)
  )
}

function isoWithOffset(utcMs: number, tz: string): string {
  const w = new Date(wallClockAt(utcMs, tz))
  const pad = (n: number, l = 2): string => String(n).padStart(l, '0')
  const offMin = Math.round(offsetAt(utcMs, tz) / 60000)
  const sign = offMin >= 0 ? '+' : '-'
  const a = Math.abs(offMin)
  return (
    `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}` +
    `T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  )
}

describe('时区原语', () => {
  test('wallClockToUtc / wallClockAt 往返一致（普通时刻）', () => {
    const wall = Date.UTC(2026, 6, 24, 9, 0)
    const utc = wallClockToUtc(wall, LA)
    expect(wallClockAt(utc, LA)).toBe(wall)
    // 2026-07-24 是 PDT（-7）
    expect(new Date(utc).toISOString()).toBe('2026-07-24T16:00:00.000Z')
  })

  test('无 DST 时区（Asia/Shanghai）恒 +8', () => {
    const wall = Date.UTC(2026, 0, 15, 9, 0)
    expect(new Date(wallClockToUtc(wall, SH)).toISOString()).toBe('2026-01-15T01:00:00.000Z')
    expect(offsetLabel(wallClockToUtc(wall, SH), SH)).toBe('GMT+8')
  })

  test('秋季回拨的重复墙钟 → 取较早那次（fold=0）', () => {
    // LA 2026-11-01 01:30 出现两次：08:30Z (PDT) 与 09:30Z (PST)。
    const wall = Date.UTC(2026, 10, 1, 1, 30)
    expect(new Date(wallClockToUtc(wall, LA)).toISOString()).toBe('2026-11-01T08:30:00.000Z')
  })

  test('春季前跳的空洞墙钟 → 推到首个存在的瞬间（契约 §3.3）', () => {
    // LA 2026-03-08 02:30 不存在（01:59:59 PST → 03:00:00 PDT）。
    // 契约要求「首个存在的瞬间」= 跃变瞬间本身 = 10:00Z = 本地 03:00 PDT，
    // 而**不是** shift-by-gap 的 03:30。
    const wall = Date.UTC(2026, 2, 8, 2, 30)
    const utc = wallClockToUtc(wall, LA)
    expect(new Date(utc).toISOString()).toBe('2026-03-08T10:00:00.000Z')
    expect(offsetLabel(utc, LA)).toBe('GMT-7')
  })
})

describe('daily', () => {
  test('interval=1 基线', () => {
    expect(
      isos({ freq: 'daily', hour: 9 }, LA, '2026-07-01', '2026-07-23T12:00:00-07:00', 3)
    ).toEqual([
      '2026-07-24T09:00:00-07:00',
      '2026-07-25T09:00:00-07:00',
      '2026-07-26T09:00:00-07:00'
    ])
  })

  test('interval=3 相位以 anchor 为原点', () => {
    // anchor 7/01 → 7/01, 7/04, 7/07 … 落在 7/22, 7/25, 7/28
    expect(
      isos(
        { freq: 'daily', interval: 3, hour: 9 },
        LA,
        '2026-07-01',
        '2026-07-21T00:00:00-07:00',
        3
      )
    ).toEqual([
      '2026-07-22T09:00:00-07:00',
      '2026-07-25T09:00:00-07:00',
      '2026-07-28T09:00:00-07:00'
    ])
  })

  test('interval=3 anchor 差一天 → 结果整体位移一天（anchor 真的在参与相位）', () => {
    expect(
      isos(
        { freq: 'daily', interval: 3, hour: 9 },
        LA,
        '2026-07-02',
        '2026-07-21T00:00:00-07:00',
        3
      )
    ).toEqual([
      '2026-07-23T09:00:00-07:00',
      '2026-07-26T09:00:00-07:00',
      '2026-07-29T09:00:00-07:00'
    ])
  })

  test('严格晚于 after（等于 after 的那次不算）', () => {
    const first = isos({ freq: 'daily', hour: 9 }, LA, '2026-07-01', '2026-07-24T09:00:00-07:00', 1)
    expect(first).toEqual(['2026-07-25T09:00:00-07:00'])
  })
})

describe('weekly', () => {
  test('interval=1 多 weekday（周二 + 周四）', () => {
    expect(
      isos(
        { freq: 'weekly', weekdays: [2, 4], hour: 9 },
        LA,
        '2026-07-01',
        '2026-07-20T00:00:00-07:00',
        4
      )
    ).toEqual([
      '2026-07-21T09:00:00-07:00', // 周二
      '2026-07-23T09:00:00-07:00', // 周四
      '2026-07-28T09:00:00-07:00',
      '2026-07-30T09:00:00-07:00'
    ])
  })

  test('interval=2 —— WKST=SU 相位（anchor 所在周为第 0 周）', () => {
    // anchor 2026-01-04 是周日 → 该周（1/04–1/10）为第 0 周，隔周即 1/18 那周。
    expect(
      isos(
        { freq: 'weekly', interval: 2, weekdays: [2], hour: 9 },
        LA,
        '2026-01-04',
        '2026-01-05T00:00:00-08:00',
        3
      )
    ).toEqual([
      '2026-01-06T09:00:00-08:00',
      '2026-01-20T09:00:00-08:00',
      '2026-02-03T09:00:00-08:00'
    ])
  })

  test('interval=2 anchor 挪一周 → 相位翻转（隔周落在另一组周）', () => {
    expect(
      isos(
        { freq: 'weekly', interval: 2, weekdays: [2], hour: 9 },
        LA,
        '2026-01-11',
        '2026-01-05T00:00:00-08:00',
        3
      )
    ).toEqual([
      '2026-01-13T09:00:00-08:00',
      '2026-01-27T09:00:00-08:00',
      '2026-02-10T09:00:00-08:00'
    ])
  })

  test('🔴 星期编号：weekdays=[1] 必须全部落在周一（锁 Python weekday ↔ 契约口径转换）', () => {
    const runs = occurrences(
      rule({ freq: 'weekly', weekdays: [1], hour: 9 }),
      LA,
      '2026-07-01',
      new Date('2026-07-01T00:00:00-07:00').getTime(),
      5
    )
    expect(runs).toHaveLength(5)
    for (const r of runs) {
      expect(r.wall.weekday).toBe(1) // 契约口径 1 = 周一
      expect(r.wall.hour).toBe(9)
    }
  })
})

describe('monthly · 按日期', () => {
  test('monthDay=31 clamp=false → 没有 31 号的月份被跳过', () => {
    expect(
      isos(
        { freq: 'monthly', monthMode: 'date', monthDay: 31, hour: 9 },
        LA,
        '2026-01-01',
        '2026-01-01T00:00:00-08:00',
        5
      )
    ).toEqual([
      '2026-01-31T09:00:00-08:00',
      '2026-03-31T09:00:00-07:00', // 2 月被跳过
      '2026-05-31T09:00:00-07:00', // 4 月被跳过
      '2026-07-31T09:00:00-07:00', // 6 月被跳过
      '2026-08-31T09:00:00-07:00'
    ])
  })

  test('monthDay=31 clamp=false → 预览含被跳过月份的 ghost 行', () => {
    const entries = preview(
      rule({ freq: 'monthly', monthMode: 'date', monthDay: 31, hour: 9 }),
      LA,
      '2026-01-01',
      new Date('2026-01-01T00:00:00-08:00').getTime(),
      3
    )
    const skips = entries.filter((e) => e.kind === 'skip')
    expect(skips.map((s) => (s as { month: number }).month)).toEqual([1, 3]) // 2 月、4 月
    expect((skips[0] as { days: number }).days).toBe(28) // 2026 非闰年
  })

  test('monthDay=31 clamp=true → 夹到当月最后一天并标 clamped', () => {
    const runs = occurrences(
      rule({ freq: 'monthly', monthMode: 'date', monthDay: 31, clamp: true, hour: 9 }),
      LA,
      '2026-01-01',
      new Date('2026-01-01T00:00:00-08:00').getTime(),
      4
    )
    expect(runs.map((r) => `${r.wall.month + 1}/${r.wall.day}`)).toEqual([
      '1/31',
      '2/28',
      '3/31',
      '4/30'
    ])
    expect(runs.map((r) => r.clamped === true)).toEqual([false, true, false, true])
  })

  test('闰年 clamp=true → 2 月落 29 日', () => {
    const runs = occurrences(
      rule({ freq: 'monthly', monthMode: 'date', monthDay: 31, clamp: true, hour: 9 }),
      LA,
      '2028-01-01',
      new Date('2028-02-01T00:00:00-08:00').getTime(),
      1
    )
    expect(runs[0].wall.day).toBe(29)
  })

  test('interval=2 —— 上游组件的 monthly 分支忽略 interval，这里必须生效（契约 §5 case 9）', () => {
    expect(
      isos(
        { freq: 'monthly', monthMode: 'date', monthDay: 15, interval: 2, hour: 9 },
        LA,
        '2026-01-01',
        '2026-01-01T00:00:00-08:00',
        3
      )
    ).toEqual([
      '2026-01-15T09:00:00-08:00',
      '2026-03-15T09:00:00-07:00',
      '2026-05-15T09:00:00-07:00'
    ])
  })
})

describe('monthly · 第 N 个星期几', () => {
  test('每月第 2 个周二', () => {
    const runs = occurrences(
      rule({ freq: 'monthly', monthMode: 'nth', ordinal: 2, weekday: 2, hour: 9 }),
      LA,
      '2026-01-01',
      new Date('2026-01-01T00:00:00-08:00').getTime(),
      3
    )
    expect(runs.map((r) => `${r.wall.month + 1}/${r.wall.day}`)).toEqual(['1/13', '2/10', '3/10'])
    for (const r of runs) expect(r.wall.weekday).toBe(2)
  })

  test('每月最后一个周五', () => {
    const runs = occurrences(
      rule({ freq: 'monthly', monthMode: 'nth', ordinal: 'last', weekday: 5, hour: 9 }),
      LA,
      '2026-01-01',
      new Date('2026-01-01T00:00:00-08:00').getTime(),
      3
    )
    expect(runs.map((r) => `${r.wall.month + 1}/${r.wall.day}`)).toEqual(['1/30', '2/27', '3/27'])
    for (const r of runs) expect(r.wall.weekday).toBe(5)
  })

  test('clamp 对 nth 无意义（1st–4th 与 last 必然存在）', () => {
    const a = occurrences(
      rule({ freq: 'monthly', monthMode: 'nth', ordinal: 4, weekday: 3, hour: 9 }),
      LA,
      '2026-01-01',
      new Date('2026-01-01T00:00:00-08:00').getTime(),
      4
    )
    const b = occurrences(
      rule({ freq: 'monthly', monthMode: 'nth', ordinal: 4, weekday: 3, clamp: true, hour: 9 }),
      LA,
      '2026-01-01',
      new Date('2026-01-01T00:00:00-08:00').getTime(),
      4
    )
    expect(a.map((x) => x.utcMs)).toEqual(b.map((x) => x.utcMs))
  })
})

describe('DST（契约 §3.3）', () => {
  test('春季跨 2026-03-08：本地墙钟恒 9:00，UTC 偏移变化', () => {
    const runs = occurrences(
      rule({ freq: 'daily', hour: 9 }),
      LA,
      '2026-03-01',
      new Date('2026-03-06T00:00:00-08:00').getTime(),
      4
    )
    expect(runs.map((r) => r.wall.hour)).toEqual([9, 9, 9, 9])
    expect(runs.map((r) => offsetLabel(r.utcMs, LA))).toEqual([
      'GMT-8', // 3/6
      'GMT-8', // 3/7
      'GMT-7', // 3/8 起 PDT
      'GMT-7'
    ])
  })

  test('秋季跨 2026-11-01：同上（回拨）', () => {
    const runs = occurrences(
      rule({ freq: 'daily', hour: 9 }),
      LA,
      '2026-10-01',
      new Date('2026-10-30T00:00:00-07:00').getTime(),
      4
    )
    expect(runs.map((r) => r.wall.hour)).toEqual([9, 9, 9, 9])
    expect(runs.map((r) => `${r.wall.month + 1}/${r.wall.day}`)).toEqual([
      '10/30',
      '10/31',
      '11/1',
      '11/2'
    ])
    expect(runs.map((r) => offsetLabel(r.utcMs, LA))).toEqual([
      'GMT-7', // 10/30
      'GMT-7', // 10/31
      'GMT-8', // 11/1 起 PST
      'GMT-8'
    ])
  })

  test('空洞时刻 hour=2 minute=30 跨 2026-03-08：该日推到 03:00', () => {
    const runs = occurrences(
      rule({ freq: 'daily', hour: 2, minute: 30 }),
      LA,
      '2026-03-01',
      new Date('2026-03-07T00:00:00-08:00').getTime(),
      3
    )
    // 3/7 02:30 正常；3/8 02:30 不存在 → 03:00 PDT；3/9 02:30 正常。
    expect(runs.map((r) => new Date(r.utcMs).toISOString())).toEqual([
      '2026-03-07T10:30:00.000Z',
      '2026-03-08T10:00:00.000Z',
      '2026-03-09T09:30:00.000Z'
    ])
  })

  test('Asia/Shanghai 无 DST：偏移恒定、不被特殊逻辑污染', () => {
    const runs = occurrences(
      rule({ freq: 'daily', hour: 9 }),
      SH,
      '2026-03-01',
      new Date('2026-03-06T00:00:00+08:00').getTime(),
      4
    )
    expect(new Set(runs.map((r) => offsetLabel(r.utcMs, SH)))).toEqual(new Set(['GMT+8']))
    expect(runs.map((r) => r.wall.hour)).toEqual([9, 9, 9, 9])
  })

  test('🔴 求值按规则时区、不是宿主机时区（vitest TZ 钉死 LA）', () => {
    // 同一规则同一 after，Shanghai 与 LA 各自算自己本地的 9:00：
    // after = 2026-07-23T00:00Z 在上海是当天 08:00（下一次 9:00 就是当天），
    // 在 LA 是前一天 17:00（下一次 9:00 是 7/23 当天）。绝对瞬间必然不同。
    const after = new Date('2026-07-23T00:00:00Z').getTime()
    const sh = occurrences(rule({ freq: 'daily', hour: 9 }), SH, '2026-07-01', after, 1)
    const la = occurrences(rule({ freq: 'daily', hour: 9 }), LA, '2026-07-01', after, 1)
    expect(new Date(sh[0].utcMs).toISOString()).toBe('2026-07-23T01:00:00.000Z')
    expect(new Date(la[0].utcMs).toISOString()).toBe('2026-07-23T16:00:00.000Z')
  })
})
