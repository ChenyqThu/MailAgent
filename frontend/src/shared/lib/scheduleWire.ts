// 报告 agent 排程的 wire 投影 —— 从 `components/agents/schedule/migrate.ts` 下沉出来的纯函数。
//
// 🔴 为什么下沉而不是在 gateway 里再写一份：task 08-14 起 gateway（Electron main 进程）也要
// 产出 report agent 的 schedule patch，而 `migrate.ts` 顶层 import 了 `./occurrences` → `rrule`，
// 且 gateway 至今没有任何 `@shared/components/*` 的 import。抄第二份的代价不是重复几行，而是
// 「cadence 同步」与「星期口径转换」这两条最容易错的规则从此有两个真源 —— 哪天语义变了只会改一边。
// 故把纯函数下沉成零运行时依赖的叶子（类型全部 `import type`，编译期擦除），renderer 与 gateway
// 共用同一份；`migrate.ts` 继续 re-export 这两个名字，renderer 侧调用点一行不改。

import type { ReportSchedule } from '@shared/api/types'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'

/** 契约口径（0=周日）→ Python weekday（0=周一）。 */
export function ruleWeekdayToPy(w: number): number {
  return (Math.trunc(w) + 6 + 7) % 7
}

/**
 * ScheduleValue → 报告 agent 的 `schedule` patch。
 *
 * 🔴 `cadence` 必须保留：它在报告侧**不只是节奏，还是报告内容种类** —— `reports/worker.py`
 * 用它决定聚合窗（`_period_bounds`）、去重主键（`_report_id`）与周/月的层级聚合路径。
 * 丢了它 = 周报/月报静默退化成日报。故 `cadence` 恒同步为 `rule.freq`。
 *
 * `hours` / `weekday` / `day_of_month` 是 **legacy 镜像，只为降级安全**（用户回滚到旧版 app
 * 时老 worker 还读得懂）。`kind:'schedule'` 在场时 **`rule` 是唯一权威**，新 worker 不回头
 * 读这些镜像。多 weekday 时镜像只写排序后的第一个（有损，仅影响降级路径）。
 */
export function writeReportSchedule(value: ScheduleValue): ReportSchedule {
  const { rule } = value
  const out: ReportSchedule = {
    cadence: rule.freq,
    hours: [rule.hour],
    v: 1,
    kind: 'schedule',
    rule,
    anchor: value.anchor,
    timezone: value.timezone
  }
  if (rule.freq === 'weekly') {
    out.weekday = ruleWeekdayToPy([...rule.weekdays].sort((a, b) => a - b)[0] ?? 1)
  }
  if (rule.freq === 'monthly' && rule.monthMode === 'date') {
    out.day_of_month = rule.monthDay
  }
  return out
}
