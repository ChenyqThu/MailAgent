/**
 * 「按天分组」—— 进展 lane 与操作日志弹窗共用的一份分组/标签逻辑（设计 `progress.jsx`
 * 的 `dayKey` / `dayLabel`：今天 / 昨天 + 周几）。
 *
 * 单独成模块是因为它有**两个**消费者：curated 进展（按 `happened_at` 分组）与操作日志
 * （按事件 `happened_at` 分组）。抄第二份的代价不是重复代码，而是两个面对「今天」的判定
 * 会各自漂（时区、跨天边界），读起来像数据出了错。
 */

/** 纯函数，只要 key + 插值；不引 i18next 的 TFunction 类型（同 `matterTimelineModel`）。 */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** 本地日历日的标识。🔴 用「年-月-日」而不是 `Math.floor(at / 86400000)` —— 后者是 UTC 日，
 *  在 PT 下会把当地下午 5 点之后的事情算进"明天"。 */
export function dayKeyOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function dayLabelOf(at: number, now: number, locale: string, t: Translate): string {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(at))
  if (dayKeyOf(at) === dayKeyOf(now)) return `${t('matters.timeline.dayToday')} · ${weekday}`
  if (dayKeyOf(at) === dayKeyOf(now - 86_400_000)) {
    return `${t('matters.timeline.dayYesterday')} · ${weekday}`
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(at))
}

export interface MatterDayGroup<T> {
  key: string
  /** 该天第一条（= 最新一条）的时刻，标签由它渲染。 */
  at: number
  rows: T[]
}

/**
 * 把**已按时间倒序排好**的一列行切成按天分组。
 *
 * 🔴 相邻切分（不是 `Map` 归并）：调用方给的顺序就是渲染顺序，这里只在「换天」的地方
 * 断开。乱序输入会切出重复的天头 —— 那是输入没排序的**症状**，比默默把它们并到一起
 * 好：并起来会让一条时间错位的行悄悄插进别的日子里。
 */
export function groupByDay<T>(rows: readonly T[], at: (row: T) => number): MatterDayGroup<T>[] {
  const days: MatterDayGroup<T>[] = []
  for (const row of rows) {
    const stamp = at(row)
    const key = dayKeyOf(stamp)
    const last = days[days.length - 1]
    if (last && last.key === key) last.rows.push(row)
    else days.push({ key, at: stamp, rows: [row] })
  }
  return days
}
