// T3 群聊话题 — 话题清单的 query key（主时间线的话题卡、话题面、turn-persisted 的刷新三处共读）。
//
// 🔴 有意**不挂** `qk.chat.allSessions` 前缀：那个前缀下的 invalidate 会把群列表 / 团队页清单一并
// 重拉，而话题一有回复就刷一次 —— 流式期间等于每条回复都重拉整份会话清单。

export const groupThreadsKey = (groupId: number) => ['chat', 'threads', groupId] as const
