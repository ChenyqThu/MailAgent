// R3 (task 07-05 dogfood) — custom agent 工具区 UI 分组常量（纯前端呈现层）。
// 落库格式不变（flat tool_policy.allowed_tools）；/tool-options 响应契约冻结不动 ——
// 分组只把后端返回的工具按家族排布。工具名权威 = src/api/routers/agent_runs.py
// HEADLESS_TOOL_OPTIONS（当前 28 个，日历 epic 4.1/4.2 起含 calendar 五件）；未映射的
// 新工具落 FALLBACK「其他」组渲染，不许静默丢（tests/components/toolGroups.test.ts
// 断言全集归属 + fallback 行为）。
import type { AgentRunToolOption } from '@shared/api/types'

/** 未映射工具的兜底组 id（i18n key agents.custom.tools.group.other）。 */
export const FALLBACK_TOOL_GROUP_ID = 'other'

/** 家族定义（渲染顺序 = 声明顺序；组内工具顺序 = 声明的语义顺序）。 */
export const TOOL_GROUPS: ReadonlyArray<{ id: string; tools: readonly string[] }> = [
  {
    id: 'emailRead',
    tools: [
      'email_list_filter',
      'email_get',
      'email_body',
      'email_list_thread',
      'email_search_fulltext',
      'email_search_attachments',
      'email_attachment_text',
      'email_thread_attachments'
    ]
  },
  {
    id: 'emailWrite',
    tools: ['email_flag', 'email_archive', 'email_pin', 'email_resync', 'email_draft_reply']
  },
  {
    // 日历 epic 4.1/4.2：读在前（silent），三写在后（edit-tier 恒卡，writeBadge 由 class 驱动）。
    id: 'calendar',
    tools: [
      'calendar_events_list',
      'calendar_event_get',
      'calendar_event_reschedule',
      'calendar_event_rsvp',
      'calendar_event_delete'
    ]
  },
  { id: 'report', tools: ['report_get', 'report_list'] },
  {
    id: 'session',
    tools: [
      'chat_session_list',
      'chat_session_search',
      'chat_session_get',
      'agent_profile_read',
      'agent_profile_history'
    ]
  },
  { id: 'knowledge', tools: ['discover_skills', 'skill_read', 'kos_query'] }
]

export interface GroupedToolOptions {
  id: string
  tools: AgentRunToolOption[]
}

/** /tool-options 返回的 flat 工具清单 → 按家族分组。只输出非空组；任何未映射的
 *  工具进 FALLBACK「其他」组（保持后端返回顺序），绝不静默丢。 */
export function groupToolOptions(tools: readonly AgentRunToolOption[]): GroupedToolOptions[] {
  const out: GroupedToolOptions[] = []
  const mapped = new Set<string>()
  for (const group of TOOL_GROUPS) {
    const memberSet = new Set(group.tools)
    const members = tools
      .filter((t) => memberSet.has(t.name))
      .sort((a, b) => group.tools.indexOf(a.name) - group.tools.indexOf(b.name))
    for (const name of group.tools) mapped.add(name)
    if (members.length > 0) out.push({ id: group.id, tools: members })
  }
  const rest = tools.filter((t) => !mapped.has(t.name))
  if (rest.length > 0) out.push({ id: FALLBACK_TOOL_GROUP_ID, tools: [...rest] })
  return out
}
