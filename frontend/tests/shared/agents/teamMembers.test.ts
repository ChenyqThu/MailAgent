// task 08-27 P4a（lane team-shell）— 团队清单成员派生（teamMembers.ts）。
// 覆盖：分组与顺序（照 AgentsTab 渲染序）· 视图档声明（主 Agent/搜索只有设置档，
// 主 session 拍板的搜索偏离）· clampMemberTab 纠正（design §8.1 第 2 条）。

import { describe, expect, test } from 'vitest'

import type { ReportAgentConfig } from '@shared/api/types'
import {
  clampMemberTab,
  deriveTeamMembers,
  findMemberByAgentId
} from '../../../src/shared/components/agents/team/teamMembers'

function cfg(id: string, type: string, over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id,
    type,
    enabled: true,
    title: id,
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '',
    prompt_is_default: true,
    model: 'claude-opus-4-8',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    mark_read_after_processing: true,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

const AGENTS: ReportAgentConfig[] = [
  // 有意乱序进：派生结果必须按 AgentsTab 渲染序稳定输出。
  cfg('zz_custom', 'custom'),
  cfg('contact_governance_agent', 'contact_governance'),
  cfg('weekly_email_digest', 'report', { schedule: { cadence: 'weekly', hours: [9] } }),
  cfg('email_search_agent', 'search'),
  cfg('daily_email_digest', 'report'),
  cfg('aa_custom', 'custom'),
  cfg('email_preprocess_agent', 'preprocess'),
  cfg('project_progress_sync', 'project_progress'),
  cfg('contact_profile_agent', 'contact_profile'),
  cfg('mystery_row', 'unknown_type') // 未知 type：静默丢弃（AgentsTab filter 同款纪律）
]

describe('deriveTeamMembers — 分组与顺序', () => {
  test('内置照 AgentsTab 渲染序（主→报告日→周→搜索→预处理→周报→画像→治理）+ 自定义按 id', () => {
    const members = deriveTeamMembers(AGENTS)
    expect(members.map((m) => (m.ref.kind === 'main' ? 'main' : m.ref.agentId))).toEqual([
      'main',
      'daily_email_digest',
      'weekly_email_digest',
      'email_search_agent',
      'email_preprocess_agent',
      'project_progress_sync',
      'contact_profile_agent',
      'contact_governance_agent',
      'aa_custom',
      'zz_custom'
    ])
    expect(members.filter((m) => m.group === 'custom').map((m) => m.key)).toEqual([
      'member:agent:aa_custom',
      'member:agent:zz_custom'
    ])
  })

  test('视图档声明：主 Agent / 搜索只有设置档；预处理/周报不接对话但有执行档', () => {
    const members = deriveTeamMembers(AGENTS)
    const byId = (id: string) => findMemberByAgentId(members, id)!
    expect(members[0].tabs).toEqual(['settings']) // main
    expect(byId('email_search_agent').tabs).toEqual(['settings']) // 🔴 主 session 拍板偏离 §8.0
    expect(byId('email_search_agent').noChatReasonKey).toBe('team.noChat.search')
    expect(byId('email_preprocess_agent').tabs).toEqual(['record', 'settings'])
    expect(byId('email_preprocess_agent').canChat).toBe(false)
    expect(byId('project_progress_sync').canChat).toBe(false)
    expect(byId('daily_email_digest').canChat).toBe(true)
    expect(byId('contact_profile_agent').recordSource).toBe('runs-no-transcript')
    expect(byId('contact_governance_agent').recordSource).toBe('runs')
    expect(byId('zz_custom').hasLiveRunState).toBe(true)
    expect(byId('contact_profile_agent').hasLiveRunState).toBe(false)
  })

  test('未知 type 不入清单', () => {
    expect(findMemberByAgentId(deriveTeamMembers(AGENTS), 'mystery_row')).toBeNull()
  })
})

describe('clampMemberTab — 当前档不在可选集时纠正（不能白屏）', () => {
  test('从别人的「执行」档切到主 Agent → 落设置档', () => {
    const members = deriveTeamMembers(AGENTS)
    expect(clampMemberTab(members[0], 'record')).toBe('settings')
    expect(clampMemberTab(findMemberByAgentId(members, 'zz_custom')!, 'record')).toBe('record')
  })
})
