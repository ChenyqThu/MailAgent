// R3 (task 07-05) — custom agent 工具分组常量完整性闸：
//  • 后端 HEADLESS_TOOL_OPTIONS（src/api/routers/agent_runs.py）当前全部工具名必须在
//    TOOL_GROUPS 有归属 —— 新 headless 工具漏映射 → 首个用例红，逼同步补组。
//  • fallback：未映射工具落「其他」组渲染，绝不静默丢。
import { describe, expect, test } from 'vitest'

import type { AgentRunToolOption } from '../../src/shared/api/types'
import {
  FALLBACK_TOOL_GROUP_ID,
  TOOL_GROUPS,
  groupToolOptions
} from '../../src/shared/components/agents/toolGroups'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'

// 镜像 src/api/routers/agent_runs.py::HEADLESS_TOOL_OPTIONS（35 个，/tool-options 契约冻结）。
// 后端加工具 → 此 fixture 必须跟着补（连同 TOOL_GROUPS 归属），否则首个用例红。
const HEADLESS_TOOL_OPTIONS: AgentRunToolOption[] = [
  { name: 'agent_profile_history', class: 'read' },
  { name: 'agent_profile_read', class: 'read' },
  { name: 'calendar_event_get', class: 'read' },
  { name: 'calendar_events_list', class: 'read' },
  { name: 'chat_session_get', class: 'read' },
  { name: 'chat_session_list', class: 'read' },
  { name: 'chat_session_search', class: 'read' },
  { name: 'discover_skills', class: 'read' },
  { name: 'email_attachment_text', class: 'read' },
  { name: 'email_body', class: 'read' },
  { name: 'email_get', class: 'read' },
  { name: 'email_list_filter', class: 'read' },
  { name: 'email_list_thread', class: 'read' },
  { name: 'email_search_attachments', class: 'read' },
  { name: 'email_search_fulltext', class: 'read' },
  { name: 'email_thread_attachments', class: 'read' },
  { name: 'kos_find_experts', class: 'read' },
  { name: 'kos_get_backlinks', class: 'read' },
  { name: 'kos_get_page', class: 'read' },
  { name: 'kos_list_pages', class: 'read' },
  { name: 'kos_query', class: 'read' },
  { name: 'kos_search', class: 'read' },
  { name: 'report_get', class: 'read' },
  { name: 'report_list', class: 'read' },
  { name: 'skill_read', class: 'read' },
  { name: 'calendar_event_delete', class: 'domain_write' },
  { name: 'calendar_event_reschedule', class: 'domain_write' },
  { name: 'calendar_event_rsvp', class: 'domain_write' },
  { name: 'email_archive', class: 'domain_write' },
  // prd 07-27 — 草稿写族补全（新建/转发 + 改已有草稿）。
  { name: 'email_draft_compose', class: 'domain_write' },
  { name: 'email_draft_reply', class: 'domain_write' },
  { name: 'email_draft_update', class: 'domain_write' },
  { name: 'email_flag', class: 'domain_write' },
  { name: 'email_pin', class: 'domain_write' },
  { name: 'email_resync', class: 'domain_write' }
]

describe('toolGroups — R3 工具分组常量', () => {
  test('当前 35 个 headless 工具全部有家族归属（无一落 fallback）且无一丢失', () => {
    const groups = groupToolOptions(HEADLESS_TOOL_OPTIONS)
    expect(groups.find((g) => g.id === FALLBACK_TOOL_GROUP_ID)).toBeUndefined()
    const grouped = groups.flatMap((g) => g.tools.map((t) => t.name)).sort()
    expect(grouped).toEqual(HEADLESS_TOOL_OPTIONS.map((t) => t.name).sort())
  })

  test('分组常量无重复工具名（一个工具恰属一组）', () => {
    const all = TOOL_GROUPS.flatMap((g) => [...g.tools])
    expect(new Set(all).size).toBe(all.length)
  })

  test('未映射工具落「其他」fallback 组（不静默丢）', () => {
    const groups = groupToolOptions([
      { name: 'email_get', class: 'read' },
      { name: 'future_tool_x', class: 'read' }
    ])
    const other = groups.find((g) => g.id === FALLBACK_TOOL_GROUP_ID)
    expect(other?.tools.map((t) => t.name)).toEqual(['future_tool_x'])
  })

  test('空组不输出；组内顺序 = 常量声明的语义顺序（非输入顺序）', () => {
    const groups = groupToolOptions([
      { name: 'email_body', class: 'read' },
      { name: 'email_list_filter', class: 'read' }
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('emailRead')
    expect(groups[0].tools.map((t) => t.name)).toEqual(['email_list_filter', 'email_body'])
  })

  test('i18n：zh/en 组标签 key 齐全（含 fallback other）', () => {
    const zhG = zhCommon.agents.custom.tools.group as Record<string, string>
    const enG = enCommon.agents.custom.tools.group as Record<string, string>
    for (const id of [...TOOL_GROUPS.map((g) => g.id), FALLBACK_TOOL_GROUP_ID]) {
      expect(zhG[id], `zh missing agents.custom.tools.group.${id}`).toBeTruthy()
      expect(enG[id], `en missing agents.custom.tools.group.${id}`).toBeTruthy()
    }
  })
})
