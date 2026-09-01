/**
 * 今日页右侧「今天的时间线」列的行模型（task 08-27 P5）—— **纯模块**：不 import react /
 * react-query / i18next，只吃 `buildTodaySections` 的产物，吐一列按时刻排好的行 + 「现在」
 * 那条线该插在第几行之前。
 *
 * 🔴 **不新开数据源**。五节已经把今天该看的东西取全了（`useTodaySections` 的四条源 +
 * 日历当天窗口 + `GET /api/today` + 当天报告），时间线只是把同一份 `sections` **换一根轴**
 * 排一遍：按时刻，而不是按域。另起一条查询等于给同一批数据开第二个口径，两边迟早漂开。
 *
 * 🔴 **当天窗口是硬过滤**。五节里的行不是每一条都发生在今天 —— 待回邮件的 `atMs` 是它
 * **到达**的时刻（「等了 26 小时」的那封是昨天的），关注信号是它**出现**的时刻。把一条
 * 昨天的东西放进「今天的时间线」，等于给它编一个今天的时刻。窗口外的一律不进。
 *
 * 🔴 文件名是 `todayTimelineRows` 而不是 `todayTimeline`：macOS 的文件系统**不区分大小写**，
 * 而 vite 的扩展名顺序是 `.ts` 在 `.tsx` 前 —— 叫 `todayTimeline.ts` 会把同目录
 * `TodayTimeline.tsx` 的 import 静默劫持过来（组件解析成 `undefined`，报的是「Element type
 * is invalid」，跟真正的原因隔了十万八千里）。同目录不要出现只差大小写的两个模块名。
 *
 * 为什么是 `nowIndex` 而不是给某一行打个 `now` 标记：今天余下已经没有条目时，线要落在
 * **末尾**。标记法表达不了「落在所有行之后」这一档（原型那份假数据里恰好有一条未来的行，
 * 所以看不出这个分支）。
 */

import type { TodaySectionView } from './todaySections'

export interface TodayTimelineRow {
  /** 直接沿用源条目的跨源唯一 id（`{source}:{源实体主键}`）—— 同一件事在两根轴上是同一个身份。 */
  id: string
  /** 🔴 恒毫秒。 */
  atMs: number
  title: string
  /** 副行。空串 = 组装不出 → 按缺席渲染，不编一句话填上（同五节的纪律）。 */
  sub: string
}

export interface TodayTimelineView {
  rows: TodayTimelineRow[]
  /** 「现在」那条线插在第几行**之前**。等于 `rows.length` = 今天余下没有条目了，线落在末尾。 */
  nowIndex: number
}

/**
 * 五节 → 一条时间线。
 *
 * 两套行模型都要（`TodaySectionItem` 的简化行与 `TodayItem` 的例外面行）：原型那一列里
 * 「周报已生成」是 agent 的 run、「AW Catch Up」是会、「预算终审截止」是临期信号 —— 它们
 * 分属三节，在这根轴上是同一列。
 */
export function buildTodayTimeline(
  sections: readonly TodaySectionView[],
  window: { startMs: number; endMs: number },
  nowMs: number
): TodayTimelineView {
  const rows: TodayTimelineRow[] = []
  const push = (row: TodayTimelineRow): void => {
    if (!Number.isFinite(row.atMs)) return
    if (row.atMs < window.startMs || row.atMs >= window.endMs) return
    rows.push(row)
  }
  for (const section of sections) {
    for (const item of section.rows) {
      push({ id: item.id, atMs: item.atMs, title: item.title, sub: item.why })
    }
    for (const group of section.groups) {
      for (const item of group.items) {
        push({ id: item.id, atMs: item.at, title: item.title, sub: item.triageLogic })
      }
    }
  }
  // 同刻的两条要有稳定次序，否则每次 refetch 都可能换位置（id 是跨源唯一的，拿它兜底）。
  rows.sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const first = rows.findIndex((row) => row.atMs >= nowMs)
  return { rows, nowIndex: first === -1 ? rows.length : first }
}
