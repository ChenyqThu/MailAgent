// Phase 4·#3 — RRULE builder 纯逻辑 (FREQ/INTERVAL/BYDAY/COUNT/UNTIL).
//
// build/parse 对称: parseRRule(buildRRule(s)) 语义等价 s (UNTIL 走 UTC date-only
// 避免时区 off-by-one). RRuleEditor 组件用它, 抽离纯函数便于 node 单测.
//
// 仅覆盖 builder UI 能表达的子集 (DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL +
// WEEKLY 的 BYDAY + COUNT/UNTIL). 更复杂的 RRULE (BYMONTHDAY / BYSETPOS / ...)
// parseRRule 回退 freq=NONE — 调用方 (EventFormModal) 用 rruleDirty flag 保证
// "没动 repeat 段就不覆盖原 RRULE", 防有损解析破坏复杂规则.

export type RRuleFreq = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export type RRuleEnd = 'never' | 'count' | 'until'

export interface RRuleState {
  freq: RRuleFreq
  /** 每 N (天/周/月/年); ≥ 1. */
  interval: number
  /** WEEKLY 专用, e.g. ['MO','WE','FR']; 按 WEEKDAYS 顺序输出. */
  byday: string[]
  end: RRuleEnd
  /** end='count' 时有效, ≥ 1. */
  count: number
  /** end='until' 时有效, 'YYYY-MM-DD'. */
  until: string
}

/** RFC 5545 周一首序 (BYDAY 输出稳定). */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

const SUPPORTED_FREQ = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

export function defaultRRuleState(): RRuleState {
  return { freq: 'NONE', interval: 1, byday: [], end: 'never', count: 10, until: '' }
}

/** 'YYYY-MM-DD' → RFC 5545 UNTIL 'YYYYMMDDT235959Z' (当天末 UTC, date-only 语义). */
function untilToIcal(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  if (!y || !m || !d) return ''
  return `${y}${m}${d}T235959Z`
}

/** RFC 5545 UNTIL (YYYYMMDD[THHMMSS[Z]]) → 'YYYY-MM-DD' (date-only, 不做时区转换). */
function icalToYmd(until: string): string {
  const m = until.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** RRuleState → RFC 5545 RRULE 字符串 (不含 'RRULE:' 前缀). freq=NONE → ''. */
export function buildRRule(s: RRuleState): string {
  if (s.freq === 'NONE') return ''
  const parts = [`FREQ=${s.freq}`]
  if (s.interval > 1) parts.push(`INTERVAL=${s.interval}`)
  if (s.freq === 'WEEKLY' && s.byday.length > 0) {
    const ordered = WEEKDAYS.filter((d) => s.byday.includes(d))
    if (ordered.length > 0) parts.push(`BYDAY=${ordered.join(',')}`)
  }
  if (s.end === 'count' && s.count >= 1) {
    parts.push(`COUNT=${s.count}`)
  } else if (s.end === 'until' && s.until) {
    const ical = untilToIcal(s.until)
    if (ical) parts.push(`UNTIL=${ical}`)
  }
  return parts.join(';')
}

/** RFC 5545 RRULE 字符串 → RRuleState (edit 预填). 无法识别 FREQ / 空 →
 *  defaultRRuleState (freq=NONE). 调用方靠 rruleDirty 防覆盖原复杂规则. */
export function parseRRule(rrule: string | null | undefined): RRuleState {
  const s = defaultRRuleState()
  if (!rrule || !rrule.trim()) return s
  const clean = rrule.trim().replace(/^RRULE:/i, '')
  const map = new Map<string, string>()
  for (const tok of clean.split(';')) {
    const [k, v] = tok.split('=')
    if (k && v) map.set(k.toUpperCase().trim(), v.trim())
  }
  const freq = (map.get('FREQ') || '').toUpperCase()
  if (!SUPPORTED_FREQ.includes(freq)) return s
  s.freq = freq as RRuleFreq

  const iv = parseInt(map.get('INTERVAL') || '1', 10)
  s.interval = Number.isFinite(iv) && iv >= 1 ? iv : 1

  const byday = map.get('BYDAY')
  if (byday) {
    s.byday = byday
      .split(',')
      .map((d) => d.trim().toUpperCase())
      .filter((d) => (WEEKDAYS as readonly string[]).includes(d))
  }

  if (map.has('COUNT')) {
    const c = parseInt(map.get('COUNT') || '0', 10)
    s.end = 'count'
    s.count = Number.isFinite(c) && c >= 1 ? c : 1
  } else if (map.has('UNTIL')) {
    const ymd = icalToYmd(map.get('UNTIL') || '')
    if (ymd) {
      s.end = 'until'
      s.until = ymd
    }
  }
  return s
}
