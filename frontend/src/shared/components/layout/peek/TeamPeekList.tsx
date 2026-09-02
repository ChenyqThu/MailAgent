// 团队域 peek —— 同一组件 `TeamMemberList`（`fluid` 档：占满浮层宽、无右分割线；不出新建行）。
// 数据 = `useReportConfig` + `deriveTeamMembers`（与 TeamWorkspace 同 key）。
// 点行：自定义成员走 `useAgentsNavigation.openConfig`（通讯录「去配置」的同一条桥，落设置档）；
// 主 Agent 没有可点名的 id，只切域。

import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useReportConfig } from '@shared/components/agents/hooks'
import { useAgentsNavigation } from '@shared/components/agents/navigation'
import { TeamMemberList } from '@shared/components/agents/team/TeamMemberList'
import { deriveTeamMembers, type TeamMember } from '@shared/components/agents/team/teamMembers'
import { navigateToDomain } from '@shared/navigation/domain-location'

import type { PeekListProps } from './PeekChrome'

export default function TeamPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const navigate = useNavigate()
  const { agents, isLoading } = useReportConfig()
  const members = useMemo(() => deriveTeamMembers(agents), [agents])

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-nav-peek-list="agents">
      <TeamMemberList
        members={members}
        selectedKey={null}
        onSelect={(member: TeamMember) => {
          if (member.ref.kind === 'agent')
            useAgentsNavigation.getState().openConfig(member.ref.agentId)
          navigateToDomain(navigate, 'agents')
          onNavigate()
        }}
        isLoading={isLoading}
        fluid
      />
    </div>
  )
}
