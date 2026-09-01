// task 08-27 P4a（lane team-shell）— 团队页成员派生：report_agent 行集 → 清单成员。
//
// 纯函数叶子（零 react / 零 api import）：分组、顺序、视图档、记录源全部在这里声明，
// 组件只穷举渲染。设计权威 = design.md §8.0/8.1 + 主 session 拍板的两条偏离：
//   🔴 搜索 Agent 只有设置档（design §8.0 写的是 [执行｜设置]）—— 它零执行台账，
//      调用面在 ⌘K，造一个空执行面不如一句说明诚实。
//   🔴 状态点两档起步（启停色 + 「工作中」仅对有真实 run 读态的成员）；「待触发 +
//      下一次几点」等 agenda 侧的 per-agent next-occurrence 投影，前端不手算排程
//      （语义单源 schedule-rule-contract.md，重算就是第二处解读）。

import type { ReportAgentConfig } from '@shared/api/types'

import { memberRefKey, type TeamMemberRef } from '../shared'

/** 视图档：第一档（对话/执行，名字随 canChat 变）+ 第二档设置。 */
export type TeamViewTab = 'record' | 'settings'

/** 记录面的数据源（r8 §A 的结论表落成词表）。 */
export type TeamRecordSource =
  /** GET /api/agent-runs 完整 run 历史 + transcript（自定义 / 通讯录治理）。 */
  | 'runs'
  /** 同一端点（联系人画像）。名字是 r8 时代的事实：那时它的行 sessionId 恒 null、详情
   *  只有统计摘要。08-31 起它的记录改落 `agent_run_log`，详情**有** transcript，于是本档
   *  与 `'runs'` 在行为上已经没有差别 —— 保留是为了不在收口批里动词表与它的测试；
   *  下次碰团队页时合并掉。 */
  | 'runs-no-transcript'
  /** `report` 行投影（报告本身即记录，无过程 transcript）。 */
  | 'report'
  /** GET /api/project-progress/runs（自有 status 词表，不走 9 值域）。 */
  | 'progress'
  /** llm_processing per-邮件（经 listEnriched 投影，无 per-run 概念）。 */
  | 'preprocess'
  /** 无记录面（主 Agent / 搜索 —— 两者都只有设置档）。 */
  | 'none'

export interface TeamMember {
  ref: TeamMemberRef
  /** memberRefKey(ref) —— 选中态 / react key。 */
  key: string
  group: 'builtin' | 'custom'
  /** 配置行；主 Agent 不是 report_agent 行 → null（名字/头像走 assistant identity）。 */
  cfg: ReportAgentConfig | null
  /** 跟它说话有没有意义（design §8.0 判据）。决定第一档叫「对话」还是「执行」。 */
  canChat: boolean
  /** 可用视图档；主 Agent / 搜索只有 ['settings']。 */
  tabs: readonly TeamViewTab[]
  recordSource: TeamRecordSource
  /** 不接对话的成员：为什么不接（i18n key，显示在记录面顶部——否则像功能缺失）。 */
  noChatReasonKey?: string
  /** 「工作中」状态点判据：只有经 AgentRunWorker 的成员有真实 run 读态
   *  （r8 §D：AGENT_JOB_TYPES 覆盖 custom + contact_governance；其余成员运行中
   *  不广播事件，硬标「工作中」就是装饰）。 */
  hasLiveRunState: boolean
}

const RECORD_SETTINGS: readonly TeamViewTab[] = ['record', 'settings']
const SETTINGS_ONLY: readonly TeamViewTab[] = ['settings']

/** 报告 cadence 稳定排序：日→周→月。 */
const CADENCE_ORDER: Record<string, number> = { daily: 0, weekly: 1, monthly: 2 }

function builtinMember(cfg: ReportAgentConfig): TeamMember | null {
  const base = {
    ref: { kind: 'agent', agentId: cfg.id } as TeamMemberRef,
    key: memberRefKey({ kind: 'agent', agentId: cfg.id }),
    group: 'builtin' as const,
    cfg
  }
  switch (cfg.type) {
    case 'report':
      return {
        ...base,
        canChat: true,
        tabs: RECORD_SETTINGS,
        recordSource: 'report',
        hasLiveRunState: false
      }
    case 'search':
      // 🔴 主 session 拍板偏离 design §8.0：零执行台账 → 只有设置档 + ⌘K 说明。
      return {
        ...base,
        canChat: false,
        tabs: SETTINGS_ONLY,
        recordSource: 'none',
        noChatReasonKey: 'team.noChat.search',
        hasLiveRunState: false
      }
    case 'preprocess':
      return {
        ...base,
        canChat: false,
        tabs: RECORD_SETTINGS,
        recordSource: 'preprocess',
        noChatReasonKey: 'team.noChat.preprocess',
        hasLiveRunState: false
      }
    case 'project_progress':
      return {
        ...base,
        canChat: false,
        tabs: RECORD_SETTINGS,
        recordSource: 'progress',
        noChatReasonKey: 'team.noChat.projectProgress',
        hasLiveRunState: false
      }
    case 'contact_profile':
      return {
        ...base,
        canChat: true,
        tabs: RECORD_SETTINGS,
        recordSource: 'runs-no-transcript',
        hasLiveRunState: false
      }
    case 'contact_governance':
      return {
        ...base,
        canChat: true,
        tabs: RECORD_SETTINGS,
        recordSource: 'runs',
        hasLiveRunState: true
      }
    default:
      // 未知 type：不入清单（静默丢弃，不渲染一行没人认识的成员）。
      return null
  }
}

/** 主 Agent 成员（非 report_agent 行；只有设置档 + 「去对话」按钮，无记录）。 */
export function mainMember(): TeamMember {
  return {
    ref: { kind: 'main' },
    key: memberRefKey({ kind: 'main' }),
    group: 'builtin',
    cfg: null,
    canChat: false,
    tabs: SETTINGS_ONLY,
    recordSource: 'none',
    hasLiveRunState: false
  }
}

/** report_agent 行集 → 团队清单（内置在前，固定顺序：
 *  主 Agent → 报告(日→周→月) → 搜索 → 预处理 → 项目周报 → 画像 → 治理；
 *  自定义按 id 稳定排序归第二组）。 */
export function deriveTeamMembers(agents: readonly ReportAgentConfig[]): TeamMember[] {
  const byType = (type: string): ReportAgentConfig[] => agents.filter((a) => a.type === type)

  const builtinOrder: ReportAgentConfig[] = [
    ...byType('report').sort(
      (a, b) =>
        (CADENCE_ORDER[a.schedule?.cadence] ?? 9) - (CADENCE_ORDER[b.schedule?.cadence] ?? 9)
    ),
    ...byType('search').sort((a, b) => a.id.localeCompare(b.id)),
    ...byType('preprocess'),
    ...byType('project_progress'),
    ...byType('contact_profile'),
    ...byType('contact_governance')
  ]

  const members: TeamMember[] = [mainMember()]
  for (const cfg of builtinOrder) {
    const m = builtinMember(cfg)
    if (m) members.push(m)
  }
  for (const cfg of byType('custom').sort((a, b) => a.id.localeCompare(b.id))) {
    members.push({
      ref: { kind: 'agent', agentId: cfg.id },
      key: memberRefKey({ kind: 'agent', agentId: cfg.id }),
      group: 'custom',
      cfg,
      canChat: true,
      tabs: RECORD_SETTINGS,
      recordSource: 'runs',
      hasLiveRunState: true
    })
  }
  return members
}

/** 当前档不在成员可选集里时纠正到它的第一档（design §8.1「两条容易漏的」第 2 条：
 *  从别人的「执行」档切到主 Agent 不能白屏）。 */
export function clampMemberTab(member: TeamMember, tab: TeamViewTab): TeamViewTab {
  return member.tabs.includes(tab) ? tab : member.tabs[0]
}

/** 清单/页头共用的成员显示名：主 Agent 用 assistant identity 名，其余用配置行 title。 */
export function memberTitle(member: TeamMember, mainName: string, untitled: string): string {
  if (member.ref.kind === 'main') return mainName
  return member.cfg?.title?.trim() || member.cfg?.id || untitled
}

// 便于组件按 id 找成员（画像/治理的跨页深链用）。
export function findMemberByAgentId(
  members: readonly TeamMember[],
  agentId: string
): TeamMember | null {
  return members.find((m) => m.ref.kind === 'agent' && m.ref.agentId === agentId) ?? null
}
