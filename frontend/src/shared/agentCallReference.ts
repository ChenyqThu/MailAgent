/**
 * `custom_agent_call` 的跨 agent 引用类型 —— 零依赖叶子。
 *
 * 曾在两处各手抄一份且没有任何一致性闸：
 *   1. `ai-gateway/tools/agent_call.ts`（工具执行侧）—— `type` 是严格字面量 union。
 *   2. `shared/assistant/tools/generic/CustomAgentCallCard.tsx`（卡片渲染侧）—— `type` 偷懒写成
 *      `string`，比 1 更松。
 * 漂移形态：给 1 加一个新 `type` 分支，2 认不出来——编译过、测试过，直到那类引用在卡片上静默不
 * 渲染（2 的类型本来就比 1 宽，类型检查挡不住）。闸在 `tests/config/test_agent_call_reference_parity.py`。
 *
 * 🔴 本文件不许 import 任何东西——两处消费方一处在 ai-gateway（Node 运行时直接加载），一处在
 * renderer 组件树，拉进 electron / store 或任何运行时依赖就没法被 gateway 侧 import。
 */

/** 引用来源域。加成员必须同时改两处消费方的映射分支，闸会红。 */
export const AGENT_CALL_REFERENCE_TYPES = [
  'session',
  'report',
  'notion',
  'email',
  'calendar',
  'library'
] as const

export type AgentCallReferenceType = (typeof AGENT_CALL_REFERENCE_TYPES)[number]

/** `custom_agent_call` 工具输入 / 输出里携带的一条跨 agent 上下文引用。 */
export interface AgentCallReference {
  type: AgentCallReferenceType
  id: string | number
  title?: string
}
