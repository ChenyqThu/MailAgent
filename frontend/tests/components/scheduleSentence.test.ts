// 排程句子 + 老形状迁移的纯逻辑单测。
//
// 句子部分锁的是「中文语序自然」（不是英文直译）+ 英文语法正确；迁移部分锁的是
// 契约 §4 的映射表，特别是 🔴 星期编号（Python 0=周一 ↔ 契约 0=周日）双向转换。
import { beforeAll, describe, expect, test } from 'vitest'

import i18n from '@shared/i18n'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import {
  LEGACY_ANCHOR,
  cronToRuleSeed,
  legacyScheduleToRule,
  pyWeekdayToRule,
  readReportSchedule,
  readTriggerSchedule,
  ruleWeekdayToPy,
  writeReportSchedule,
  writeTriggerSchedule
} from '@shared/components/agents/schedule/migrate'
import { DEFAULT_RULE, type ScheduleRule } from '@shared/components/agents/schedule/types'

function rule(over: Partial<ScheduleRule>): ScheduleRule {
  return { ...DEFAULT_RULE, ...over }
}

const t = (key: string, opts?: Record<string, unknown>): string =>
  i18n.t(key, opts as never) as string

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

// 🔴 dogfood 反馈：时刻**中英一律 12 小时制 + AM/PM**（原先按 locale 分叉成 zh→24h `09:00`，
// owner 用中文 UI 但明确要 AM/PM）。中文语序仍是中文语序，只有时刻记号统一。
describe('句子 · zh-CN（中文语序 + AM/PM 时刻）', () => {
  const zh = (r: Partial<ScheduleRule>): string => sentenceText(t, 'zh-CN', rule(r))

  test('每天 9:00 AM', () => {
    expect(zh({ freq: 'daily', hour: 9 })).toBe('每天 9:00 AM')
  })

  test('每 3 天 9:30 AM', () => {
    expect(zh({ freq: 'daily', interval: 3, hour: 9, minute: 30 })).toBe('每 3 天 9:30 AM')
  })

  test('每周 周二和周四 9:00 AM', () => {
    expect(zh({ freq: 'weekly', weekdays: [2, 4], hour: 9 })).toBe('每周 周二和周四 9:00 AM')
  })

  test('每 2 周 周一 7:15 AM', () => {
    expect(zh({ freq: 'weekly', interval: 2, weekdays: [1], hour: 7, minute: 15 })).toBe(
      '每 2 周 周一 7:15 AM'
    )
  })

  test('每月 15 号 9:00 AM', () => {
    expect(zh({ freq: 'monthly', monthMode: 'date', monthDay: 15, hour: 9 })).toBe(
      '每月 15 号 9:00 AM'
    )
  })

  test('每月 第 2 个周二 9:00 AM', () => {
    expect(zh({ freq: 'monthly', monthMode: 'nth', ordinal: 2, weekday: 2, hour: 9 })).toBe(
      '每月 第 2 个周二 9:00 AM'
    )
  })

  test('最后一个星期几不说成「第 最后一个」', () => {
    const s = zh({ freq: 'monthly', monthMode: 'nth', ordinal: 'last', weekday: 5, hour: 9 })
    expect(s).toBe('每月 最后一个周五 9:00 AM')
    expect(s).not.toContain('第 最后一个')
  })

  test('🔴 zh 不渲染成「上午/下午」（Intl hour12 会那样，故手工拼）', () => {
    const s = zh({ freq: 'daily', hour: 13, minute: 5 })
    expect(s).toBe('每天 1:05 PM')
    expect(s).not.toContain('下午')
    expect(s).not.toContain('上午')
  })

  test('中英时刻记号完全一致（只有句子结构随 locale 变）', () => {
    const r: Partial<ScheduleRule> = { freq: 'daily', hour: 0, minute: 0 }
    expect(sentenceText(t, 'zh-CN', rule(r))).toContain('12:00 AM')
    expect(sentenceText(t, 'en-US', rule(r))).toContain('12:00 AM')
  })
})

describe('句子 · en-US', () => {
  const en = (r: Partial<ScheduleRule>): string => sentenceText(t, 'en-US', rule(r))

  beforeAll(async () => {
    await i18n.changeLanguage('en-US')
  })

  test('Every day at 9:00 AM', () => {
    expect(en({ freq: 'daily', hour: 9 })).toBe('Every day at 9:00 AM')
  })

  test('Every week on Tuesday and Thursday at 9:00 AM', () => {
    expect(en({ freq: 'weekly', weekdays: [2, 4], hour: 9 })).toBe(
      'Every week on Tuesday and Thursday at 9:00 AM'
    )
  })

  test('Every 2 weeks …（interval > 1 用复数）', () => {
    expect(en({ freq: 'weekly', interval: 2, weekdays: [1], hour: 7, minute: 15 })).toBe(
      'Every 2 weeks on Monday at 7:15 AM'
    )
  })

  test('Every month on day 15 at 6:00 PM（12 小时制 + PM）', () => {
    expect(en({ freq: 'monthly', monthMode: 'date', monthDay: 15, hour: 18 })).toBe(
      'Every month on day 15 at 6:00 PM'
    )
  })

  test('Every month on the last Friday at 9:00 AM', () => {
    expect(en({ freq: 'monthly', monthMode: 'nth', ordinal: 'last', weekday: 5, hour: 9 })).toBe(
      'Every month on the last Friday at 9:00 AM'
    )
  })
})

describe('🔴 星期编号转换（契约 §2）', () => {
  test('Python 0=周一 → 契约 1=周一；Python 6=周日 → 契约 0=周日', () => {
    expect(pyWeekdayToRule(0)).toBe(1)
    expect(pyWeekdayToRule(6)).toBe(0)
    expect(ruleWeekdayToPy(1)).toBe(0)
    expect(ruleWeekdayToPy(0)).toBe(6)
  })

  test('双向往返在 0..6 全域是恒等', () => {
    for (let w = 0; w <= 6; w += 1) {
      expect(ruleWeekdayToPy(pyWeekdayToRule(w))).toBe(w)
      expect(pyWeekdayToRule(ruleWeekdayToPy(w))).toBe(w)
    }
  })
})

describe('老形状迁移（契约 §4 映射表）', () => {
  test('daily hours=[9] → freq=daily hour=9', () => {
    expect(legacyScheduleToRule({ cadence: 'daily', hours: [9] })).toMatchObject({
      freq: 'daily',
      interval: 1,
      hour: 9,
      minute: 0
    })
  })

  test('🔴 weekly weekday=0（Python 周一）→ weekdays=[1]（契约周一），不是 [0]', () => {
    const r = legacyScheduleToRule({ cadence: 'weekly', hours: [9], weekday: 0 })
    expect(r).toMatchObject({ freq: 'weekly', interval: 1, hour: 9, minute: 0 })
    expect(r.weekdays).toEqual([1])
  })

  test('weekly weekday=6（Python 周日）→ weekdays=[0]', () => {
    expect(legacyScheduleToRule({ cadence: 'weekly', hours: [9], weekday: 6 }).weekdays).toEqual([
      0
    ])
  })

  test('monthly day_of_month=D → monthMode=date monthDay=D clamp=false', () => {
    expect(
      legacyScheduleToRule({ cadence: 'monthly', hours: [9], day_of_month: 15 })
    ).toMatchObject({ freq: 'monthly', monthMode: 'date', monthDay: 15, clamp: false, hour: 9 })
  })

  test('生产实测两行读进来不丢配置（daily 9 点 / weekly 周一 9 点）', () => {
    const daily = readReportSchedule({ cadence: 'daily', hours: [9] }, 'America/Los_Angeles')
    expect(daily.rule).toMatchObject({ freq: 'daily', hour: 9, minute: 0, interval: 1 })
    const weekly = readReportSchedule(
      { cadence: 'weekly', hours: [9], weekday: 0 },
      'America/Los_Angeles'
    )
    expect(weekly.rule).toMatchObject({ freq: 'weekly', hour: 9, minute: 0, interval: 1 })
    expect(weekly.rule.weekdays).toEqual([1])
  })

  test('🔴 空时区写实成宿主机 IANA，不留空（留空会退化成 UTC 让 9:00 报告漂）', () => {
    const v = readReportSchedule({ cadence: 'daily', hours: [9] }, '')
    expect(v.timezone).toBeTruthy()
    expect(v.timezone).not.toBe('')
    // vitest 全局 TZ 钉死 LA
    expect(v.timezone).toBe('America/Los_Angeles')
  })

  test('迁移行 anchor 是安全的过去日期（DTSTART 落未来会吃掉近期 occurrence）', () => {
    const v = readReportSchedule({ cadence: 'daily', hours: [9] }, 'UTC')
    expect(v.anchor).toBe(LEGACY_ANCHOR)
    expect(new Date(`${v.anchor}T00:00:00Z`).getTime()).toBeLessThan(Date.now())
  })

  test('新形状读回来原样（不被当成老形状二次迁移）', () => {
    const stored = {
      cadence: 'weekly' as const,
      hours: [7],
      weekday: 0,
      v: 1 as const,
      kind: 'schedule' as const,
      rule: {
        freq: 'weekly' as const,
        interval: 2,
        weekdays: [1, 3],
        monthMode: 'date' as const,
        monthDay: 1,
        ordinal: 1,
        weekday: 1,
        hour: 7,
        minute: 45,
        clamp: false
      },
      anchor: '2026-07-01',
      timezone: 'Asia/Shanghai'
    }
    const v = readReportSchedule(stored, 'America/Los_Angeles')
    expect(v.timezone).toBe('Asia/Shanghai')
    expect(v.anchor).toBe('2026-07-01')
    expect(v.rule.weekdays).toEqual([1, 3])
    expect(v.rule.minute).toBe(45)
  })
})

describe('写回形状', () => {
  test('🔴 报告 agent 必带 cadence（它同时是报告内容种类，丢了周报会退化成日报）', () => {
    const out = writeReportSchedule({
      v: 1,
      kind: 'schedule',
      rule: rule({ freq: 'weekly', weekdays: [1], hour: 9 }),
      anchor: '2026-07-24',
      timezone: 'Asia/Shanghai'
    })
    expect(out.cadence).toBe('weekly')
    expect(out.kind).toBe('schedule')
    expect(out.rule?.freq).toBe('weekly')
    // legacy 镜像回写成 Python 口径
    expect(out.weekday).toBe(0)
    expect(out.hours).toEqual([9])
  })

  test('cadence 恒同步 rule.freq（改频率不会留下旧 cadence）', () => {
    for (const freq of ['daily', 'weekly', 'monthly'] as const) {
      const out = writeReportSchedule({
        v: 1,
        kind: 'schedule',
        rule: rule({ freq }),
        anchor: '2026-07-24',
        timezone: 'UTC'
      })
      expect(out.cadence).toBe(freq)
    }
  })

  test('monthly+date 写 day_of_month 镜像；nth 不写（无对应老字段）', () => {
    const base = { v: 1 as const, kind: 'schedule' as const, anchor: '2026-07-24', timezone: 'UTC' }
    expect(
      writeReportSchedule({
        ...base,
        rule: rule({ freq: 'monthly', monthMode: 'date', monthDay: 15 })
      }).day_of_month
    ).toBe(15)
    expect(
      writeReportSchedule({
        ...base,
        rule: rule({ freq: 'monthly', monthMode: 'nth', ordinal: 2, weekday: 2 })
      }).day_of_month
    ).toBeUndefined()
  })

  test('custom agent trigger 是契约 §1 原形状（无 cadence）', () => {
    const out = writeTriggerSchedule({
      v: 1,
      kind: 'schedule',
      rule: rule({ freq: 'daily', hour: 9 }),
      anchor: '2026-07-24',
      timezone: 'UTC'
    })
    expect(out).toEqual({
      v: 1,
      kind: 'schedule',
      rule: rule({ freq: 'daily', hour: 9 }),
      anchor: '2026-07-24',
      timezone: 'UTC'
    })
  })

  test('读写往返（round-trip）不丢字段', () => {
    const original = {
      v: 1 as const,
      kind: 'schedule' as const,
      rule: rule({
        freq: 'monthly',
        interval: 3,
        monthMode: 'nth',
        ordinal: 'last',
        weekday: 5,
        hour: 21,
        minute: 30
      }),
      anchor: '2026-02-11',
      timezone: 'Europe/Berlin'
    }
    expect(readReportSchedule(writeReportSchedule(original), 'UTC')).toEqual(original)
    expect(readTriggerSchedule(writeTriggerSchedule(original))).toEqual(original)
  })
})

describe('老 kind:cron 行（契约 §4：不映射、原样走 croniter）', () => {
  test('readTriggerSchedule 对 cron 行返回 null（保留 cron 形态）', () => {
    expect(readTriggerSchedule({ v: 1, kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' })).toBe(
      null
    )
    expect(readTriggerSchedule(null)).toBe(null)
    expect(readTriggerSchedule({ v: 1, kind: 'email_filter' })).toBe(null)
  })

  test('cronToRuleSeed 只认得出的三型（UI 初值用，认不出退 null）', () => {
    expect(cronToRuleSeed('0 9 * * *')).toMatchObject({ freq: 'daily', hour: 9, minute: 0 })
    expect(cronToRuleSeed('30 7 * * 1-5')).toMatchObject({
      freq: 'weekly',
      hour: 7,
      minute: 30
    })
    expect(cronToRuleSeed('30 7 * * 1-5')?.weekdays).toEqual([1, 2, 3, 4, 5])
    // cron 的 0 与 7 都是周日
    expect(cronToRuleSeed('0 9 * * 7')?.weekdays).toEqual([0])
    expect(cronToRuleSeed('0 9 15 * *')).toMatchObject({
      freq: 'monthly',
      monthMode: 'date',
      monthDay: 15
    })
    // 认不出的高级 cron → null（调用方保留原 cron）
    expect(cronToRuleSeed('*/5 * * * *')).toBe(null)
    expect(cronToRuleSeed('0 9 1 1 *')).toBe(null)
    expect(cronToRuleSeed('0 9 * *')).toBe(null)
  })
})
