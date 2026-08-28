// /agents route shell — 团队域（智能体清单与配置）。08-27 P3：报告与对话拆成各自的
// 一级域（`/reports` / `/sessions`），本路由的三 tab 壳（AgentsPage）随之退役，直接
// 渲染 AgentsTab。AgentsTab 自管内部滚动，故给它 column-flex main 槽（无外层滚动）。
import { useNavigate } from '@tanstack/react-router'

import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'

import { PageFrame } from './PageFrame'
import { AgentsTab } from '../agents/AgentsTab'

export function AgentsLayout(): React.ReactElement {
  const navigate = useNavigate()
  return (
    <PageFrame ariaLabel="agents" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* 卡片与配置抽屉里的「去看报告」——tab 切换换成跨域导航（落点单源仍是 registry）。 */}
      <AgentsTab onOpenReports={() => navigateToNavEntry(navigate, navEntry('reports'))} />
    </PageFrame>
  )
}
