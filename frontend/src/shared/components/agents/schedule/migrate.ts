// 老形状 ↔ 新形状（契约 §4）+ 两处抽屉的读/写投影。
//
// 🔴 星期编号（契约 §2）：Python `datetime.weekday()` 0=周一…6=周日；本契约 / JS
// `getDay()` / cron 0=周日…6=周六。报告 agent 老 `schedule_json.weekday` 是 **Python 口径**，
// 读进来必须 +1 %7、写回去必须 +6 %7。透传 = 静默错一天。
import type { CustomAgentTrigger, ReportSchedule } from '@shared/api/types'

import { wallClockAt } from './occurrences'
import {
  DEFAULT_RULE,
  type ScheduleRule,
  type ScheduleValue,
  coerceRule,
  hostTimezone,
  isScheduleValue,
  isValidAnchor,
  isValidTimezone
} from './types'

/** 迁移行的 anchor 占位。契约 §4：迁移行 interval 恒为 1，anchor 不影响结果；
 *  但 anchor 同时是 RRULE 的 DTSTART，**绝不能落在未来**（否则近期 occurrence 全被吃掉），
 *  故取一个安全的过去日期常量（而不是 today，保证同一行在任何机器上读出同一结果）。 */
export const LEGACY_ANCHOR = '2020-01-01'

/** Python weekday（0=周一）→ 契约口径（0=周日）。 */
export function pyWeekdayToRule(w: number): number {
  return (Math.trunc(w) + 1 + 7) % 7
}

// `ruleWeekdayToPy` / `writeReportSchedule` 已下沉到 `@shared/lib/scheduleWire`（零运行时依赖的
// 叶子），供 gateway 与 renderer 共用 —— 本模块顶层拉着 rrule，main 进程 import 不动它。
// 这里原样 re-export，既有调用点（配置页 / index.ts / 测试）一行不改。
export { ruleWeekdayToPy, writeReportSchedule } from '@shared/lib/scheduleWire'

/** 新建规则的默认值（抽屉初始化用）：今天为 anchor、宿主机时区。 */
export function newScheduleValue(rule: ScheduleRule, tz = hostTimezone()): ScheduleValue {
  return { v: 1, kind: 'schedule', rule, anchor: todayInTimezone(tz), timezone: tz }
}

/** 规则时区里的「今天」`YYYY-MM-DD` —— 新建规则的 anchor（契约 §1：anchor 是**本地**日期）。 */
export function todayInTimezone(tz: string, now: Date = new Date()): string {
  const wall = new Date(wallClockAt(now.getTime(), isValidTimezone(tz) ? tz : hostTimezone()))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`
}

/** 老 `schedule_json`（报告 agent）→ rule。契约 §4 映射表。
 *
 *  ⚠️ 已知有损点（有意取舍，如实记录）：老形状允许一天多时点（`hours:[9,18]`），新值模型
 *  只有单个 `hour` —— 这里取 `hours[0]`。**未保存前**后端惰性路径（Python
 *  `rules_from_legacy_schedule`）仍按每个 hour 各一条规则触发、不丢；一旦用户在新 UI 保存，
 *  即收敛为单时点（构建器 UI 本就表达不了多时点，收敛发生在用户看得见排程句子与预览的
 *  编辑态，不是静默后台改写）。生产存量两行均为单 hour，实际迁移面零损失。 */
export function legacyScheduleToRule(
  schedule: Partial<ReportSchedule> | null | undefined
): ScheduleRule {
  const hour = clampHour(schedule?.hours?.[0])
  const cadence = schedule?.cadence
  if (cadence === 'weekly') {
    return coerceRule({
      ...DEFAULT_RULE,
      freq: 'weekly',
      // 🔴 老值是 Python 口径（0=周一），必须转换。
      weekdays: [pyWeekdayToRule(Number(schedule?.weekday ?? 0))],
      hour,
      minute: 0
    })
  }
  if (cadence === 'monthly') {
    return coerceRule({
      ...DEFAULT_RULE,
      freq: 'monthly',
      monthMode: 'date',
      monthDay: Number(schedule?.day_of_month ?? 1),
      clamp: false,
      hour,
      minute: 0
    })
  }
  return coerceRule({ ...DEFAULT_RULE, freq: 'daily', hour, minute: 0 })
}

function clampHour(v: unknown): number {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 9
}

/**
 * 报告 agent 的 `cfg.schedule` → ScheduleValue（新老形状统一入口，**读时惰性迁移，不回写 DB**）。
 *
 * `fallbackTz` 是老行空时区的写实值（契约 §4：报告 agent 空时区的历史语义 = 宿主机本地，
 * 迁移时必须解析成实际 IANA 值，**不留空**；留空会让统一后的逻辑退化成 UTC，
 * 现有 9:00 报告直接漂到别的时刻）。
 */
export function readReportSchedule(
  schedule: Partial<ReportSchedule> | null | undefined,
  fallbackTz: string
): ScheduleValue {
  const tz = isValidTimezone(fallbackTz) ? fallbackTz : hostTimezone()
  if (isScheduleValue(schedule)) {
    return {
      v: 1,
      kind: 'schedule',
      rule: coerceRule(schedule.rule),
      anchor: isValidAnchor(schedule.anchor) ? schedule.anchor : LEGACY_ANCHOR,
      timezone: isValidTimezone(schedule.timezone) ? schedule.timezone : tz
    }
  }
  return {
    v: 1,
    kind: 'schedule',
    rule: legacyScheduleToRule(schedule),
    anchor: LEGACY_ANCHOR,
    timezone: tz
  }
}

/**
 * custom agent 的 `cfg.trigger` → ScheduleValue。
 * `kind:'cron'` 的老行**不映射**（契约 §4：原样走 croniter），返回 null 让调用方保留 cron 形态。
 */
export function readTriggerSchedule(
  trigger: CustomAgentTrigger | null | undefined
): ScheduleValue | null {
  if (!isScheduleValue(trigger)) return null
  return {
    v: 1,
    kind: 'schedule',
    rule: coerceRule(trigger.rule),
    anchor: isValidAnchor(trigger.anchor) ? trigger.anchor : LEGACY_ANCHOR,
    timezone: isValidTimezone(trigger.timezone) ? trigger.timezone : hostTimezone()
  }
}

/** ScheduleValue → custom agent 的 `trigger`（契约 §1 原形状，无 cadence 问题）。 */
export function writeTriggerSchedule(value: ScheduleValue): CustomAgentTrigger {
  return {
    v: 1,
    kind: 'schedule',
    rule: value.rule,
    anchor: value.anchor,
    timezone: value.timezone
  }
}

/** 老 cron 行升级到构建器时的种子规则（尽力而为，仅用于 UI 初值）。
 *  只认最常见的「`m h * * *` / `m h * * dow` / `m h D * *`」三型；认不出就退默认。 */
export function cronToRuleSeed(cron: string): ScheduleRule | null {
  const seg = cron.trim().split(/\s+/)
  if (seg.length !== 5) return null
  const [mi, h, dom, mon, dow] = seg
  const minute = Number(mi)
  const hour = Number(h)
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null
  if (mon !== '*') return null
  if (dom === '*' && dow === '*') {
    return coerceRule({ ...DEFAULT_RULE, freq: 'daily', hour, minute })
  }
  if (dom === '*' && dow !== '*') {
    const days = expandDow(dow)
    if (!days) return null
    return coerceRule({ ...DEFAULT_RULE, freq: 'weekly', weekdays: days, hour, minute })
  }
  if (dom !== '*' && dow === '*') {
    const d = Number(dom)
    if (!Number.isInteger(d) || d < 1 || d > 31) return null
    return coerceRule({
      ...DEFAULT_RULE,
      freq: 'monthly',
      monthMode: 'date',
      monthDay: d,
      hour,
      minute
    })
  }
  return null
}

/** cron dow 字段 → 契约口径星期集合（支持 `1`、`1,3`、`1-5`；cron 的 7 也是周日）。 */
function expandDow(dow: string): number[] | null {
  const out = new Set<number>()
  for (const part of dow.split(',')) {
    const range = part.split('-')
    if (range.length === 1) {
      const n = Number(range[0])
      if (!Number.isInteger(n) || n < 0 || n > 7) return null
      out.add(n % 7)
    } else if (range.length === 2) {
      const a = Number(range[0])
      const b = Number(range[1])
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 7 || a > b) return null
      for (let n = a; n <= b; n += 1) out.add(n % 7)
    } else {
      return null
    }
  }
  return out.size ? [...out].sort((x, y) => x - y) : null
}
