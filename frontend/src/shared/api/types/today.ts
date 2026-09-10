// task 08-27 P4c —— 今日页读面（`GET /api/today`）。
//
// 🔴 端点**只出两块**：待回邮件 + 下一个硬时间点。今日页另外四节（等你拍板 / 今天的会 /
// 临期事项 / 智能体产出）走各自的现成端点 —— 理由写在 `src/today/aggregate.py` 的模块
// docstring（那是对 design §十「五节一次算出来」的显式偏离），改这里之前先读那段。

import type { AgendaEntry } from './calendar'

/** 「待回邮件」的一条。`why` 是后端组装的一句话，空串 = 组装不出（按缺席渲染，不兜底）。 */
export interface TodayReplyItem {
  /** 跨源唯一：`thread:{thread_id}`；无线程 ID 时为 `mail:{internal_id}`。 */
  id: string
  threadId?: string | null
  oldestAtIso?: string
  pendingCount?: number
  internalIds?: number[]
  messages?: TodayReplyItem[]
  source: 'mail'
  title: string
  /** 「为什么是今天」——「需要回复 · 等了 26 小时」。**空串 = 缺席**。 */
  why: string
  /** 次要展示串（发件人显示名，没有名字时是地址）。 */
  meta: string
  /** 恒 ISO（UTC）。跨源比较用。 */
  atIso: string
  /** 等龄毫秒（now − date_received，恒 ≥ 0）。 */
  waitedMs: number
  actionable: boolean
  link: { kind: 'mail'; internalId: number }
}

export interface TodayData {
  reply: TodayReplyItem[]
  /** 今天剩下的最早一条日程。🔴 「硬」没有字段 —— 这是近似，不是判据（见后端注释）。
   *  形状直接是 `AgendaEntry`：它自带 `startIso` / `title` / `source` + 各源定位键，
   *  前端能原样喂给 `useAgendaEntryClick` 分流，不必再开一份镜像类型。 */
  nextHardPoint: AgendaEntry | null
}

export interface TodayApi {
  /** Errors reject on both transports; the page keeps stale data and shows a warning. */
  get(opts?: { tz?: string; replyLimit?: number }): Promise<TodayData>
  dismiss(internalIds: number[]): Promise<{ operationId: string }>
  undo(operationId: string): Promise<{ operationId: string }>
}
