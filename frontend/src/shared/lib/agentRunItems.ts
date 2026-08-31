// 08-31 执行台账 — `GET /api/agent-runs` 聚合行的判别（零依赖叶子）。
//
// 该端点返两种形状：async_jobs run 行（AgentRunHistoryItem，`kind` 缺省或 'job'）与
// agent_run_log 行（AgentRunLogItem，`kind: 'run_log'`）。判别写在这一处，读侧不各抄一遍
// `item.kind === 'run_log'` —— 抄第二遍就是第二处解读。

import type { AgentRunHistoryItem, AgentRunListItem, AgentRunLogItem } from '@shared/api/types'

export function isRunLogItem(item: AgentRunListItem): item is AgentRunLogItem {
  return item.kind === 'run_log'
}

/** 老台账行（async_jobs）。缺 `kind` 的老投影恒落这一档。 */
export function isJobRunItem(item: AgentRunListItem): item is AgentRunHistoryItem {
  return item.kind !== 'run_log'
}
