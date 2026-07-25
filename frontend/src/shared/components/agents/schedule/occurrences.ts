// Occurrence 求值 —— 契约 §3 的前端实现，必须与 Python `src/agents/schedule_rule.py` 逐条一致
// （裁判 = 仓库根 `tests/fixtures/schedule_occurrences.json`）。
//
// 统一做法（契约 §3）：**在 timezone 的墙钟上用 naive datetime 跑 RRULE，最后再贴时区**。
// JS 里没有 naive datetime，故用「as-UTC 编码」表示墙钟：把墙钟分量 (y,m,d,h,mi) 塞进
// `Date.UTC(...)`。rrule.js 在不设 tzid 时正是这么工作的（进出都读 getUTC*），所以
// RRULE 迭代全程在浮动墙钟空间里，出口才用 wallClockToUtc 贴真实时区。
//
// 这样「每天 9:00」跨 DST 恒为本地 9:00 —— 与上游组件、与两个现有 Python worker 语义一致。
//
// 🔴 renderer 走 rrule 的 **ESM 构建**（package.json `module: dist/esm/index.js`），它**只有
// named export、没有 default**（`export { RRule } / { RRuleSet } / { rrulestr } / …`）。
// 所以这里必须 named import。
//
// 别照搬 `src/electron/main/handlers/calendar-read.ts` 的 `import rrulePkg from 'rrule'` ——
// 那个文件在 **Electron main 进程的 CJS 上下文**，default-import 互操作在那儿才成立；跨运行时
// 抄过来，vitest（模块解析宽松）和 `tsc --noEmit`（读的是 CJS 入口的类型声明）都会放过，
// 只有 rollup 生产构建会炸 `"default" is not exported by …/dist/esm/index.js`。
import { RRule } from 'rrule'

import { type ScheduleRule, coerceRule } from './types'

/** 契约 §2 顺序：0=周日 … 6=周六。rrule.js 的 RRule.SU..RRule.SA 按同一顺序索引。 */
const RRULE_WEEKDAYS = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA]

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** 大于任何真实 UTC 偏移（现实最大 +14 / -12 小时）。 */
const MAX_OFFSET_MS = 26 * HOUR_MS
/** rrule 迭代硬上限，防止病态输入把 UI 线程挂住。 */
const ITER_CAP = 20_000

// ─── 时区原语（Intl 驱动，无第三方日期库）────────────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    dtfCache.set(tz, f)
  }
  return f
}

/** 某个真实 UTC 瞬间在 tz 的墙钟，编码成 as-UTC 毫秒。 */
export function wallClockAt(utcMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs))
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type)
    return p ? Number(p.value) : 0
  }
  // hourCycle:'h23' 下午夜是 00；个别引擎仍会给 24 —— 归一，避免整日偏移。
  const hour = get('hour') % 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
}

/** tz 在某瞬间的偏移（墙钟 − UTC，毫秒）。 */
export function offsetAt(utcMs: number, tz: string): number {
  return wallClockAt(utcMs, tz) - utcMs
}

/**
 * 墙钟（as-UTC 编码）→ 真实 UTC 瞬间。契约 §3.3 的两条 DST 规则：
 *  • **重复的墙钟**（秋季回拨）→ 取较早的那次（等价 Python `fold=0`）。
 *  • **不存在的墙钟**（春季前跳）→ 向后推到「首个存在的瞬间」，即 offset 跃变的那一刻本身
 *    （LA 2026-03-08 02:30 → 03:00 PDT），**不是** shift-by-gap 的 03:30。
 */
export function wallClockToUtc(wallMs: number, tz: string): number {
  const offBefore = offsetAt(wallMs - MAX_OFFSET_MS, tz)
  const offAfter = offsetAt(wallMs + MAX_OFFSET_MS, tz)
  const candA = wallMs - offBefore
  const candB = wallMs - offAfter
  const okA = wallClockAt(candA, tz) === wallMs
  const okB = wallClockAt(candB, tz) === wallMs
  if (okA && okB) return Math.min(candA, candB) // 重叠 → 较早（fold=0）
  if (okA) return candA
  if (okB) return candB
  // 都不成立 = 墙钟落在被跳过的空洞里。二分找 offset 跃变点（现实中的 DST 跃变一律
  // 对齐到分钟，故 1 分钟精度足够）；跃变瞬间就是该日「首个存在的瞬间」。
  let lo = Math.min(candA, candB)
  let hi = Math.max(candA, candB)
  const loOff = offsetAt(lo, tz)
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS
    if (mid <= lo || mid >= hi) break
    if (offsetAt(mid, tz) === loOff) lo = mid
    else hi = mid
  }
  return hi
}

// ─── 墙钟分量 ────────────────────────────────────────────────────────────────

export interface WallParts {
  year: number
  /** 0-11。 */
  month: number
  day: number
  hour: number
  minute: number
  /** 0=周日 … 6=周六（契约 §2 口径）。 */
  weekday: number
}

export function wallPartsOf(wallMs: number): WallParts {
  const d = new Date(wallMs)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay()
  }
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function anchorWallMs(anchor: string, rule: ScheduleRule): number {
  const [y, m, d] = anchor.split('-').map(Number)
  return Date.UTC(y, m - 1, d, rule.hour, rule.minute)
}

// ─── RRULE 构造（契约 §3.1）──────────────────────────────────────────────────

function buildRRule(rule: ScheduleRule, dtstartWallMs: number): InstanceType<typeof RRule> {
  const dtstart = new Date(dtstartWallMs)
  if (rule.freq === 'daily') {
    return new RRule({ freq: RRule.DAILY, interval: rule.interval, dtstart })
  }
  if (rule.freq === 'weekly') {
    return new RRule({
      freq: RRule.WEEKLY,
      interval: rule.interval,
      byweekday: rule.weekdays.map((w) => RRULE_WEEKDAYS[w]),
      // 🔴 必须显式：RFC 5545 默认 WKST=MO，会让 INTERVAL>1 的周规则相位差一周。
      wkst: RRule.SU,
      dtstart
    })
  }
  if (rule.monthMode === 'nth') {
    const nth = rule.ordinal === 'last' ? -1 : rule.ordinal
    return new RRule({
      freq: RRule.MONTHLY,
      interval: rule.interval,
      byweekday: [RRULE_WEEKDAYS[rule.weekday].nth(nth)],
      dtstart
    })
  }
  // monthMode='date' + clamp=false —— BYMONTHDAY=31 天然跳过没有 31 号的月份（RRULE 语义）。
  return new RRule({
    freq: RRule.MONTHLY,
    interval: rule.interval,
    bymonthday: rule.monthDay,
    dtstart
  })
}

// ─── 求值 ────────────────────────────────────────────────────────────────────

export interface RunEntry {
  kind: 'run'
  /** 真实 UTC 瞬间（毫秒）。 */
  utcMs: number
  /** 该次运行在规则时区里的墙钟分量。 */
  wall: WallParts
  /** clamp=true 且该月不足 monthDay 天，落到了当月最后一天。 */
  clamped?: boolean
}

export interface SkipEntry {
  kind: 'skip'
  key: string
  year: number
  /** 0-11。 */
  month: number
  /** 该月实际天数（用于「9 月只有 30 天」文案）。 */
  days: number
}

export type PreviewEntry = RunEntry | SkipEntry

/**
 * 严格晚于 `afterUtcMs` 的前 `count` 次运行（真实 UTC 瞬间 + 规则时区墙钟）。
 * 契约 §3 的 `occurrences(rule, timezone, anchor, after, count)`。
 */
export function occurrences(
  rawRule: ScheduleRule,
  timezone: string,
  anchor: string,
  afterUtcMs: number,
  count: number
): RunEntry[] {
  return preview(rawRule, timezone, anchor, afterUtcMs, count).filter(
    (e): e is RunEntry => e.kind === 'run'
  )
}

/**
 * 预览条目：运行 + （clamp=false 的 monthDay 规则下）被跳过的月份 ghost 行。
 * ghost 行只服务 UI 呈现，不参与 occurrence 语义。
 */
export function preview(
  rawRule: ScheduleRule,
  timezone: string,
  anchor: string,
  afterUtcMs: number,
  count: number
): PreviewEntry[] {
  const rule = coerceRule(rawRule)
  // 比较 `after` 时先转成规则时区的墙钟（契约 §3）——同一坐标系才能比。
  const afterWallMs = wallClockAt(afterUtcMs, timezone)
  const dtstartWall = anchorWallMs(anchor, rule)
  const out: PreviewEntry[] = []
  let runs = 0

  const pushRun = (wallMs: number, clamped?: boolean): void => {
    const entry: RunEntry = {
      kind: 'run',
      utcMs: wallClockToUtc(wallMs, timezone),
      wall: wallPartsOf(wallMs)
    }
    if (clamped) entry.clamped = true
    out.push(entry)
    runs += 1
  }

  // 契约 §3.2 —— clamp=true 是唯一非 RRULE 分支：按 interval 步进枚举候选月，
  // 逐月自取 min(monthDay, 当月天数)。刻意不用 BYSETPOS 技巧（两侧引擎边界行为易分叉）。
  if (rule.freq === 'monthly' && rule.monthMode === 'date' && rule.clamp) {
    const start = wallPartsOf(dtstartWall)
    for (let i = 0; runs < count && i < ITER_CAP; i += 1) {
      const abs = start.year * 12 + start.month + i * rule.interval
      const year = Math.floor(abs / 12)
      const month = abs % 12
      const dim = daysInMonth(year, month)
      const day = Math.min(rule.monthDay, dim)
      const wallMs = Date.UTC(year, month, day, rule.hour, rule.minute)
      // DTSTART 语义：早于 anchor 的候选不算（与 RRULE 分支一致）。
      if (wallMs < dtstartWall) continue
      if (wallMs <= afterWallMs) continue
      pushRun(wallMs, rule.monthDay > dim)
    }
    return out
  }

  const rr = buildRRule(rule, dtstartWall)
  // ghost 行：clamp=false 且按日期的月规则，才存在「该月没有这天」的跳过。
  const wantSkips = rule.freq === 'monthly' && rule.monthMode === 'date' && rule.monthDay > 28
  const seenSkipMonths = new Set<string>()
  // 已产出的最后一次运行墙钟 —— 用来界定「产出之间被跳过了哪些月」。
  let cursorWall = Math.max(afterWallMs, dtstartWall - 1)

  let iter = 0
  rr.all((d) => {
    iter += 1
    if (iter > ITER_CAP) return false
    const wallMs = d.getTime()
    if (wallMs <= afterWallMs) return true
    if (wantSkips) {
      collectSkips(out, seenSkipMonths, cursorWall, wallMs, rule)
    }
    cursorWall = wallMs
    pushRun(wallMs)
    return runs < count
  })
  return out
}

/** 在 `(fromWall, toWall)` 之间补上「该月没有第 monthDay 天」的 ghost 行。 */
function collectSkips(
  out: PreviewEntry[],
  seen: Set<string>,
  fromWall: number,
  toWall: number,
  rule: ScheduleRule
): void {
  const from = wallPartsOf(fromWall)
  const to = wallPartsOf(toWall)
  const startAbs = from.year * 12 + from.month
  const endAbs = to.year * 12 + to.month
  for (let abs = startAbs; abs < endAbs; abs += 1) {
    const year = Math.floor(abs / 12)
    const month = abs % 12
    const dim = daysInMonth(year, month)
    if (dim >= rule.monthDay) continue
    const key = `${year}-${month}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: 'skip', key, year, month, days: dim })
  }
}

/** GMT 偏移标签（`GMT-7` / `GMT+5:30`），预览行右侧用来暴露 DST 跃变。 */
export function offsetLabel(utcMs: number, tz: string): string {
  const mins = Math.round(offsetAt(utcMs, tz) / MINUTE_MS)
  const sign = mins >= 0 ? '+' : '-'
  const abs = Math.abs(mins)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}
