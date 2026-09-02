// 报告域 peek —— 同一组件 `ReportList`（从 ReportsPage 导出；`fluid` 档）。
// 数据 = `useReportList` + `useReportConfig`（与报告页同 key）；cadence 筛选在浮层里本地生效。
// 删除在浮层里不做（`onDelete` 空实现 —— 浮层是「看一眼再切」）；点行 = `navigateToReport`。

import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { MANUAL_CHAT_REPORT_AGENT_ID } from '@shared/api/reportBlocks'
import type { ReportCadence } from '@shared/api/types'
import { useReportConfig, useReportList } from '@shared/components/agents/hooks'
import { ReportList } from '@shared/components/agents/ReportsPage'
import { navigateToReport } from '@shared/navigation/registry'

import type { PeekListProps } from './PeekChrome'

const noop = (): void => {}

export default function ReportsPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<string>('all')
  const cadence = filter === 'all' ? undefined : (filter as ReportCadence)
  const { items, total, isLoading, hasMore, isFetchingMore, fetchMore } = useReportList(cadence)
  const { agents } = useReportConfig()
  // 与 ReportsPage 同一份映射（manual chat 哨兵作者 + 真 agent 配置）。
  const agentNames = useMemo(
    () => ({
      [MANUAL_CHAT_REPORT_AGENT_ID]: t('agents.reports.assistantAuthor'),
      ...Object.fromEntries(agents.map((agent) => [agent.id, agent.title || agent.id]))
    }),
    [agents, t]
  )
  const agentAvatars = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent.avatar])),
    [agents]
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-nav-peek-list="reports">
      <ReportList
        items={items}
        total={total}
        selectedId={null}
        onSelect={(id) => {
          navigateToReport(navigate, id)
          onNavigate()
        }}
        onDelete={noop}
        filter={filter}
        onFilter={setFilter}
        loading={isLoading}
        hasMore={hasMore}
        isFetchingMore={isFetchingMore}
        onFetchMore={fetchMore}
        agentNames={agentNames}
        agentAvatars={agentAvatars}
        fluid
      />
    </div>
  )
}
