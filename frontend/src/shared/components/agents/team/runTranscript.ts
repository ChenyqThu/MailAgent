// task 08-27 P4a（lane team-shell）— headless run transcript 的消息拆分（纯函数）。
//
// 🔴 r8 §A.2 实测：run 会话的第一条 user 消息是 4-7KB 的原始任务契约 prompt，
// **绝不直接渲染**（用户点开一次执行先看到 7KB 系统指令）。设计要的紫色
// 「⚡自动触发」气泡由前端用 run 行的 triggerKind + triggerFiredAtIso 合成
// （AgentRunTriggerBubble），原始 prompt 收进末尾折叠块（RunRawPromptBlock）。

import type { ChatMessage } from '@shared/api/types'

export interface RunTranscriptSplit {
  /** run 的第一条 user 消息全文（任务契约 prompt）；没有则 null。 */
  seedPrompt: string | null
  /** 交给 transcript 渲染器的其余消息（思考/工具在 ui_message_json parts 里）。 */
  rest: ChatMessage[]
}

/** 摘掉 run 会话的首条 user 消息（任务契约 prompt），其余原样保序。
 *  首条不是 user（异常形状）时不摘 —— 宁可多显示也不吞掉别的消息。 */
export function splitRunTranscript(messages: readonly ChatMessage[]): RunTranscriptSplit {
  const first = messages[0]
  if (first == null || first.role !== 'user') {
    return { seedPrompt: null, rest: [...messages] }
  }
  return { seedPrompt: first.content, rest: messages.slice(1) }
}

/** triggerKind → i18n key（词表与 ChatSessionTriggerKind 对齐；未知值回退 unknown）。 */
const TRIGGER_LABEL_KEYS: Record<string, string> = {
  manual: 'team.record.trigger.manual',
  schedule: 'team.record.trigger.schedule',
  cron: 'team.record.trigger.cron',
  email_filter: 'team.record.trigger.email',
  calendar_event_change: 'team.record.trigger.calendarChange',
  calendar_before_start: 'team.record.trigger.calendarBefore'
}

export function triggerLabelKey(kind: string | null | undefined): string {
  return (kind != null && TRIGGER_LABEL_KEYS[kind]) || 'team.record.trigger.unknown'
}
