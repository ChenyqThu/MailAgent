// task 08-27 P4a（lane team-shell）— headless run transcript 的消息拆分（纯函数）。
//
// 🔴 r8 §A.2 实测：run 会话的第一条 user 消息是 4-7KB 的原始任务契约 prompt，
// **绝不直接渲染**（用户点开一次执行先看到 7KB 系统指令）。设计要的紫色
// 「⚡自动触发」气泡由前端用 run 行的 triggerKind + triggerFiredAtIso 合成
// （AgentRunTriggerBubble），原始 prompt 收进末尾折叠块（RunRawPromptBlock）。

import type { AgentRunStep, ChatMessage } from '@shared/api/types'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'

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

// ─── run_log 步骤 → UIMessage（chatMessageToUIMessage 的平行合成器） ──────────
//
// 报告 / 联系人画像 / 项目周报三位不走 gateway headless，没有 ai_chat_messages 可读
// （r10 §0.3）；它们的过程落在 agent_run_step。渲染器吃的是 `UIMessage[]` 而不是消息行
// （r10 §4.3），所以这里合成同一种载荷，四位共用同一条渲染路径 —— 不再为「不走 LLM 的
// 成员」造第二套日志式详情。

/** `payload` 的内部形状不在接缝契约里（只约定「对象或 null」）：约定俗成的 `input` /
 *  `output`(`output_preview`) 两键在时按语义分开，否则整块当请求参数。 */
function toolInput(payload: Record<string, unknown> | null): unknown {
  if (payload && 'input' in payload) return payload.input ?? {}
  return payload ?? {}
}

function toolResult(step: AgentRunStep): unknown {
  const payload = step.payload ?? null
  const raw =
    payload && ('output' in payload || 'output_preview' in payload)
      ? (payload.output ?? payload.output_preview ?? null)
      : (step.detail ?? null)
  // 耗时并进结果块：ToolTraceCard 的行内秒表只跟 live part（replay 的部分恒读 null），
  // 结果 JSON 是现有渲染器里唯一看得见 per-tool ms 的位置。
  if (step.ms == null) return raw
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>), durationMs: step.ms }
  }
  return raw == null ? { durationMs: step.ms } : { result: raw, durationMs: step.ms }
}

/** 步骤序列 → 一条 assistant 消息（思考 / 工具 / 输出 parts 按 seq 排）。
 *
 *  🔴 `trig` **不进消息流** —— 紫色触发气泡由 run 行的 triggerKind/triggerDetail 合成
 *  （AgentRunTriggerBubble），与 headless run 同一处单源；在这里再合成一次就是两处。
 *  🔴 没有可渲染节点时返回 `[]`（不是一条空消息）—— 调用方据此走「这次运行没有产生任何
 *  输出」分支，绝不把 AgentThread 挂上去（它的空态是「新对话」欢迎屏，会撒谎）。 */
export function runStepsToUIMessages(steps: readonly AgentRunStep[]): MailAgentUIMessage[] {
  const parts: MailAgentUIMessage['parts'] = []
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    switch (step.kind) {
      case 'trig':
        break
      case 'think': {
        const text = step.detail?.trim()
        if (text) parts.push({ type: 'reasoning', text })
        break
      }
      case 'tool': {
        const name = step.name?.trim() || 'unknown'
        const base = {
          type: `tool-${name}`,
          toolCallId: `run-step-${step.seq}`,
          input: toolInput(step.payload ?? null)
        } as const
        parts.push(
          step.ok === false
            ? // 失败 → output-error：ToolTraceCard 落 error 相位（✗ + fail 色）。
              { ...base, state: 'output-error', errorText: step.detail?.trim() || name }
            : { ...base, state: 'output-available', output: toolResult(step) }
        )
        break
      }
      case 'out': {
        const text = step.detail?.trim()
        if (text) parts.push({ type: 'text', text })
        break
      }
    }
  }
  if (parts.length === 0) return []
  return [{ id: 'run-log-transcript', role: 'assistant', parts }]
}
