// 排程规则值模型 —— 与 Python 侧 `src/agents/schedule_rule.py` 共用一份契约
// （`.trellis/tasks/07-24-…/research/schedule-contract.md`）。**任何一侧想改语义，先改契约。**
//
// 🔴 星期编号（契约 §2，最容易错的地方）：本模块 / JS `getDay()` / cron 一律
// 0=周日 … 6=周六；Python `datetime.weekday()` 是 0=周一 … 6=周日。跨边界必须转换，
// 见 ./migrate.ts 的 pyWeekdayToRule / ruleWeekdayToPy。

export type ScheduleFreq = 'daily' | 'weekly' | 'monthly'
export type ScheduleMonthMode = 'date' | 'nth'
export type ScheduleOrdinal = 1 | 2 | 3 | 4 | 'last'

/** 契约 §1 的 `rule` 对象。freq 不用的字段仍必须在场且合法（用默认值）——
 *  避免两侧对「缺字段」的兜底不一致。 */
export interface ScheduleRule {
  freq: ScheduleFreq
  /** 每 N 天/周/月，>= 1。相位以 anchor 为原点（见 ScheduleValue.anchor）。 */
  interval: number
  /** freq=weekly：0=周日 … 6=周六，至少一项。 */
  weekdays: number[]
  monthMode: ScheduleMonthMode
  /** monthMode=date：1..31。 */
  monthDay: number
  /** monthMode=nth：第 1/2/3/4 个或最后一个。 */
  ordinal: ScheduleOrdinal
  /** monthMode=nth：0=周日 … 6=周六。 */
  weekday: number
  hour: number
  minute: number
  /** 月末策略，仅 monthMode=date 有意义：false=该月无此日则跳过（RRULE 语义）/
   *  true=夹到当月最后一天。 */
  clamp: boolean
}

/** 契约 §1 的持久化形状。存进 `report_agent.trigger_json`（custom agent）与
 *  `report_agent.schedule_json`（报告 agent，另叠加 cadence/hours 等 legacy 镜像键）。 */
export interface ScheduleValue {
  v: 1
  kind: 'schedule'
  rule: ScheduleRule
  /** 相位原点，**本地日历日期** `YYYY-MM-DD`（在下方 timezone 里解释，契约 §1 有意偏离
   *  PRD 的「UTC 日期」建议）。interval=1 时对结果无影响。 */
  anchor: string
  /** IANA 时区，**不允许为空**（报告 agent 老行的空时区在迁移时写实成宿主机时区）。 */
  timezone: string
}

export const DEFAULT_RULE: ScheduleRule = {
  freq: 'daily',
  interval: 1,
  weekdays: [1],
  monthMode: 'date',
  monthDay: 1,
  ordinal: 1,
  weekday: 1,
  hour: 9,
  minute: 0,
  clamp: false
}

export const ORDINALS: ScheduleOrdinal[] = [1, 2, 3, 4, 'last']

/** 宿主机当前 IANA 时区；拿不到时退 UTC（契约要求 timezone 恒非空）。 */
export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 今天（宿主机墙钟）的 `YYYY-MM-DD`，用作新建规则的 anchor 缺省值。 */
export function todayAnchor(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const ANCHOR_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidAnchor(anchor: unknown): anchor is string {
  if (typeof anchor !== 'string' || !ANCHOR_RE.test(anchor)) return false
  const [y, m, d] = anchor.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  // 用 UTC 构造回读，确认不是 2026-02-31 这类溢出日期。
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 宽松解析：任意输入 → 合法 ScheduleRule（缺字段/野值补默认）。
 *  用于读 DB 老行 / 后端投影；**不做拒绝**，拒绝由后端 parse_trigger 深校验负责。 */
export function coerceRule(raw: unknown): ScheduleRule {
  const r = (raw ?? {}) as Partial<Record<keyof ScheduleRule, unknown>>
  const freq: ScheduleFreq = r.freq === 'weekly' || r.freq === 'monthly' ? r.freq : 'daily'
  const interval = Math.max(1, Math.trunc(Number(r.interval)) || 1)
  const weekdays = Array.isArray(r.weekdays)
    ? [
        ...new Set(r.weekdays.map((w) => Math.trunc(Number(w))).filter((w) => w >= 0 && w <= 6))
      ].sort((a, b) => a - b)
    : []
  const monthMode: ScheduleMonthMode = r.monthMode === 'nth' ? 'nth' : 'date'
  const monthDay = clampInt(r.monthDay, 1, 31, DEFAULT_RULE.monthDay)
  const ordinal: ScheduleOrdinal =
    r.ordinal === 'last' ? 'last' : (clampInt(r.ordinal, 1, 4, 1) as ScheduleOrdinal)
  const weekday = clampInt(r.weekday, 0, 6, DEFAULT_RULE.weekday)
  return {
    freq,
    interval,
    // weekly 至少要有一天，否则 RRULE 退化成「按 dtstart 的星期」，语义漂移。
    weekdays: weekdays.length ? weekdays : [DEFAULT_RULE.weekdays[0]],
    monthMode,
    monthDay,
    ordinal,
    weekday,
    hour: clampInt(r.hour, 0, 23, DEFAULT_RULE.hour),
    minute: clampInt(r.minute, 0, 59, DEFAULT_RULE.minute),
    clamp: r.clamp === true
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** 判别式：拿到的值是不是新形状（`kind:'schedule'`）。 */
export function isScheduleValue(raw: unknown): raw is ScheduleValue {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === 'schedule' &&
    typeof (raw as { rule?: unknown }).rule === 'object' &&
    (raw as { rule?: unknown }).rule !== null
  )
}
