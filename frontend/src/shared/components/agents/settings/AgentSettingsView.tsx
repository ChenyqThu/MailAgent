// P4a agent-config lane — 团队页「设置」档的对外契约（team-shell 挂它）。
//
// TeamMemberRef 的三支（agents/shared.ts 末尾的接缝契约）：
//   • {kind:'main'} → 主 Agent：走 chat.setAssistantIdentity + agent_config profile docs，
//     🔴 不进 PUT /api/report-agents 的 patch 通道（r8 §B.1 唯一例外）。
//   • {kind:'matterFollowup'} → 事项跟进：同样不是 report_agent 行，可写面全在事项域，
//     这一档只做深链（09-02 misc05）。
//   • {kind:'agent', agentId} → report_agent 行：useReportConfig 找行，按 type 分发到
//     对应的配置表单。内部表单以 cfg.id 作 key —— 换成员必重挂载，表单 state 不串。
import { useTranslation } from 'react-i18next'

import type { ReportAgentConfig } from '@shared/api/types'

import { useReportConfig } from '../hooks'
import type { TeamMemberRef } from '../shared'
import { SettingsChromeContext } from './chrome'
import { MainAssistantSettings } from './MainAssistantSettings'
import { ReportAgentSettings } from './ReportAgentSettings'
import { PreprocessSettings } from './PreprocessSettings'
import { ProjectProgressSettings } from './ProjectProgressSettings'
import { SearchAgentSettings } from './SearchAgentSettings'
import { ContactProfileSettings } from './ContactProfileSettings'
import { ContactGovernanceSettings } from './ContactGovernanceSettings'
import { CustomAgentSettings } from './CustomAgentSettings'
import { MatterFollowupSettings } from './MatterFollowupSettings'

export { CustomAgentCreateView } from './CustomAgentSettings'

function AgentRowSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  switch (cfg.type) {
    case 'report':
      return <ReportAgentSettings key={cfg.id} cfg={cfg} />
    case 'preprocess':
      return <PreprocessSettings key={cfg.id} cfg={cfg} />
    case 'project_progress':
      return <ProjectProgressSettings key={cfg.id} cfg={cfg} />
    case 'search':
      return <SearchAgentSettings key={cfg.id} cfg={cfg} />
    case 'contact_profile':
      return <ContactProfileSettings key={cfg.id} cfg={cfg} />
    case 'contact_governance':
      return <ContactGovernanceSettings key={cfg.id} cfg={cfg} />
    case 'custom':
      return <CustomAgentSettings key={cfg.id} cfg={cfg} />
    default:
      // 未知 type（未来新增专型行而本表单未跟上）：如实说，不套错表单去改别人的列。
      return (
        <div style={{ padding: 18, fontSize: 12.5, color: 'rgb(var(--ink-fg-3))' }}>
          {t('agentSettings.notFound')}
        </div>
      )
  }
}

/** 本组件是「团队页成员详情」这一个挂载点，外层 52px 页头已在显示成员名 —— 骨架页头
 *  据此退成动作栏（见 chrome.ts）。模块级常量：每次渲染新建对象会让所有消费者白重渲染。 */
const EMBEDDED_CHROME = { embedded: true } as const

export function AgentSettingsView({ member }: { member: TeamMemberRef }): React.ReactElement {
  const { t } = useTranslation()
  const { agents, isLoading } = useReportConfig()
  const cfg = member.kind === 'agent' ? (agents.find((a) => a.id === member.agentId) ?? null) : null
  let content: React.ReactElement
  if (member.kind === 'main') {
    content = <MainAssistantSettings />
  } else if (member.kind === 'matterFollowup') {
    content = <MatterFollowupSettings />
  } else if (cfg) {
    content = <AgentRowSettings cfg={cfg} />
  } else {
    content = (
      <div style={{ padding: 18, fontSize: 12.5, color: 'rgb(var(--ink-fg-3))' }}>
        {isLoading ? t('agentSettings.loading') : t('agentSettings.notFound')}
      </div>
    )
  }
  // Provider 不产生 DOM 节点：骨架根仍是 data-team-settings 的直接子元素，
  // 单层滚动所依赖的 flex 链不受影响。
  return (
    <SettingsChromeContext.Provider value={EMBEDDED_CHROME}>
      {content}
    </SettingsChromeContext.Provider>
  )
}
