/**
 * 事项「截止时间」日期选择的**纯逻辑**层（0813 dogfood 轮 2 · 追加条目 #21）。
 *
 * 分出来是因为两件事必须能单独测：
 *   ① 快捷按钮（今天 / 本周 / 下周 / 本月）→ 具体哪一天，跨月跨年都要对；
 *   ② 月视图的 6×7 网格从哪天起、到哪天止。
 *
 * 🔴 **全部是本地时区语义**。写侧的约定是「本地零点的 epoch **毫秒**」——
 * 服务端 `_require_epoch_ms`（`src/matters/service.py`，0813 批 A 加的硬闸）会拒掉
 * 秒级时间戳，而 UI 这侧原本就用 `new Date(y, m, d).getTime()`（旧的
 * `type="date"` 输入解析路径）产出该值。这里的每个出口都必须与它逐位一致，
 * 所以一律走 `new Date(year, monthIndex, day)` 构造，**不做 `+ 86400000` 之类的
 * 毫秒加减** —— 后者在夏令时切换日会偏 1 小时，落到零点以外。
 */

/** 快捷按钮的值域。UI 顺序即此数组顺序。 */
export type MatterDatePreset = 'today' | 'thisWeek' | 'nextWeek' | 'thisMonth'

export const MATTER_DATE_PRESETS: readonly MatterDatePreset[] = [
  'today',
  'thisWeek',
  'nextWeek',
  'thisMonth'
]

/** 一格网格 = 6 行 × 7 列，固定 42 天（月份切换时高度不跳）。 */
export const MATTER_DATE_GRID_CELLS = 42

/** 把任意时刻收敛到**当地**当天零点的毫秒。 */
export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 同一个本地日？（比较零点毫秒，不比较原始时刻） */
export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

/**
 * 按天数平移（DST 安全）：走 Date 构造器的溢出归一，跨月跨年自动进位。
 * 传 0 等价于 `startOfLocalDay`。
 */
export function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

/**
 * 快捷按钮 → 日期。**周一为一周之始**（于是「本周」= 本周的**周日** = 这一周的
 * 最后一天，作为截止日才有意义；若按周日起算，「本周日」恒等于今天或已过去）。
 *
 * - `today`     今天
 * - `thisWeek`  本周的周日（今天就是周日 → 今天）
 * - `nextWeek`  下周的周日（= 本周日 + 7 天）
 * - `thisMonth` 当月最后一天
 *
 * 🔴 这四条映射是 owner 后续最可能改判的地方（例如改成「本周五」或按周日起算），
 * 改这里一处即可，UI 与测试都从这个函数取值。
 */
export function resolveMatterDatePreset(preset: MatterDatePreset, now: number): number {
  const today = new Date(startOfLocalDay(now))
  const year = today.getFullYear()
  const month = today.getMonth()
  const day = today.getDate()
  switch (preset) {
    case 'today':
      return today.getTime()
    case 'thisWeek':
      return new Date(year, month, day + daysUntilSunday(today.getDay())).getTime()
    case 'nextWeek':
      return new Date(year, month, day + daysUntilSunday(today.getDay()) + 7).getTime()
    case 'thisMonth':
      // 下个月的「第 0 天」= 当月最后一天（12 月时 monthIndex=12 由构造器进位到次年 1 月）。
      return new Date(year, month + 1, 0).getTime()
    default:
      return today.getTime()
  }
}

/** 距离本周周日还有几天（`dayOfWeek`：0=周日 … 6=周六）。周日当天 = 0。 */
function daysUntilSunday(dayOfWeek: number): number {
  return dayOfWeek === 0 ? 0 : 7 - dayOfWeek
}

/**
 * 月视图网格：从**包含当月 1 号那一周的周一**起连续 42 天的本地零点毫秒。
 * 前后溢出的邻月日期照常给出（UI 弱化显示），不留空洞 —— 空洞会让方向键导航断掉。
 */
export function monthGridDays(year: number, monthIndex: number): number[] {
  const first = new Date(year, monthIndex, 1)
  // getDay(): 0=周日。周一起算 ⇒ 周日要回退 6 天，其余回退 (day - 1) 天。
  const back = first.getDay() === 0 ? 6 : first.getDay() - 1
  const days: number[] = []
  for (let i = 0; i < MATTER_DATE_GRID_CELLS; i += 1) {
    days.push(new Date(year, monthIndex, 1 - back + i).getTime())
  }
  return days
}

/** 月份平移（`delta` 可正可负），返回该月 1 号的本地零点毫秒。 */
export function shiftMonth(year: number, monthIndex: number, delta: number): number {
  return new Date(year, monthIndex + delta, 1).getTime()
}

/**
 * 把某一天整体平移 `delta` 个月，**日号夹到目标月的天数上限**（PageUp/PageDown 用）。
 *
 * 🔴 夹取不能省：`new Date(y, m + 1, 31)` 会溢出到再下个月（1/31 翻页会直接落到 3/3，
 * 用户看到的是光标「跳过了整个二月」）。夹到 28/29/30 才是日期选择器的通行行为。
 */
export function shiftDayByMonths(timestamp: number, delta: number): number {
  const cursor = new Date(timestamp)
  const year = cursor.getFullYear()
  const target = cursor.getMonth() + delta
  const lastDay = new Date(year, target + 1, 0).getDate()
  return new Date(year, target, Math.min(cursor.getDate(), lastDay)).getTime()
}
