// task 08-27 P4a（lane team-shell）— 团队清单成员派生（teamMembers.ts）。
// 覆盖：分组与顺序（内置固定序）· 视图档声明（主 Agent/搜索只有设置档，
// 主 session 拍板的搜索偏离）· clampMemberTab 纠正（design §8.1 第 2 条）。

import { describe, expect, test } from 'vitest'

import type { ReportAgentConfig } from '@shared/api/types'
import {
  clampMemberTab,
  deriveTeamMembers,
  findMemberByAgentId,
  memberAvatarSeed,
  memberTitle,
  type TeamMember
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
  // 有意乱序进：派生结果必须按 teamMembers.ts 里的内置固定序稳定输出（TeamMemberList 直接
  // 照这个顺序渲染，不再自己排一遍）。
  cfg('zz_custom', 'custom'),
  cfg('contact_governance_agent', 'contact_governance'),
  cfg('weekly_email_digest', 'report', { schedule: { cadence: 'weekly', hours: [9] } }),
  cfg('email_search_agent', 'search'),
  cfg('daily_email_digest', 'report'),
  cfg('aa_custom', 'custom'),
  cfg('email_preprocess_agent', 'preprocess'),
  cfg('project_progress_sync', 'project_progress'),
  cfg('contact_profile_agent', 'contact_profile'),
  // 未知 type：deriveTeamMembers 静默丢弃 —— 前端认不出的行不进清单，免得 TeamMemberList
  // 渲染出一个点开是空白的成员。
  cfg('mystery_row', 'unknown_type')
]

/** ref → 可读标识（'main' / 'matter_followup' 两个合成成员没有 agentId）。 */
function refId(member: TeamMember): string {
  if (member.ref.kind === 'main') return 'main'
  if (member.ref.kind === 'matterFollowup') return 'matter_followup'
  return member.ref.agentId
}

describe('deriveTeamMembers — 分组与顺序', () => {
  test('内置按固定序（主→事项跟进→报告日→周→搜索→预处理→周报→画像→治理）+ 自定义按 id', () => {
    const members = deriveTeamMembers(AGENTS)
    expect(members.map(refId)).toEqual([
      'main',
      'matter_followup',
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

// 09-02 misc05 —「事项跟进」是第二个合成成员（不是 report_agent 行 → cfg 恒 null）。
// 变异验证：把 memberTitle / memberAvatarSeed 里的 matterFollowup 分支删掉，
// 下面两条分别红在「拿到 未知 Agent」与「拿到 unknown」。
describe('matterFollowup —— cfg:null 的三处特判', () => {
  const member = (): TeamMember =>
    deriveTeamMembers(AGENTS).find((m) => m.ref.kind === 'matterFollowup')!

  test('标题走固定文案，不落 untitled 兜底', () => {
    expect(memberTitle(member(), '主助理', '未知 Agent', '事项跟进')).toBe('事项跟进')
    // 兜底仍归 report_agent 行用（合成成员绝不落到它）。
    expect(memberTitle(member(), '主助理', '未知 Agent', '')).toBe('')
  })

  test('头像种子是合成 id，不与别的无配置成员撞成同一张脸', () => {
    expect(memberAvatarSeed(member())).toBe('matter_followup')
    expect(memberAvatarSeed(deriveTeamMembers(AGENTS)[0])).toBe('unknown') // 主 Agent 不走这里
  })

  test('记录源 = matter 会话；不接对话但有记录档', () => {
    expect(member().recordSource).toBe('matter')
    expect(member().tabs).toEqual(['record', 'settings'])
    expect(member().canChat).toBe(false)
    expect(member().noChatReasonKey).toBe('team.noChat.matterFollowup')
    // 🔴 它没有 run 读态（跟进 run 不进 /api/agent-runs 口径）——标「工作中」就是装饰。
    expect(member().hasLiveRunState).toBe(false)
    expect(member().key).toBe('member:matter_followup')
  })
})

describe('clampMemberTab — 当前档不在可选集时纠正（不能白屏）', () => {
  test('从别人的「执行」档切到主 Agent → 落设置档', () => {
    const members = deriveTeamMembers(AGENTS)
    expect(clampMemberTab(members[0], 'record')).toBe('settings')
    expect(clampMemberTab(findMemberByAgentId(members, 'zz_custom')!, 'record')).toBe('record')
  })
})
