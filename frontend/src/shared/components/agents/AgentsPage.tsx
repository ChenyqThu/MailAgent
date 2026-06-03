// Sprint 20 — /agents 页：Custom AI Agents 区，三 tab（Agents / 报告 / Chats）。
// Agents = agent 管理；报告 = 历史报告浏览；Chats 复用既有 SessionsPage（AI 会话历史）。
// tab 状态走 URL ?tab=（侧栏「Custom AI」「AI 会话历史」直接深链到对应 tab）。
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { AgentsTab } from './AgentsTab'
import { ChatsTab } from './ChatsTab'
import { ReportsTab } from './ReportsTab'
import { useReportList } from './hooks'

type AgentsTabKey = 'agents' | 'reports' | 'chats'
const TABS: AgentsTabKey[] = ['agents', 'reports', 'chats']

function TabButton({
  tabKey,
  label,
  active,
  count,
  onClick
}: {
  tabKey: AgentsTabKey
  label: string
  active: boolean
  count?: number
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        position: 'relative',
        padding: '0 14px',
        height: '100%',
        background: 'transparent',
        border: 0,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 14,
        fontWeight: active ? 600 : 500,
        color: active ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
        transition: 'color 120ms',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = 'rgb(var(--ink-fg))'
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = 'rgb(var(--ink-fg-2))'
      }}
    >
      {label}
      {tabKey === 'reports' && count !== undefined && count > 0 && (
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 5,
            color: active ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-3))',
            background: active ? 'rgb(var(--c-accent) / 0.12)' : 'rgb(var(--ink-fg) / 0.05)'
          }}
        >
          {count}
        </span>
      )}
      {active && (
        <span
          style={{
            position: 'absolute',
            bottom: -1,
            left: 10,
            right: 10,
            height: 2,
            borderRadius: 1,
            background: 'rgb(var(--c-accent))'
          }}
        />
      )}
    </button>
  )
}

export function AgentsPage(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { tab?: string }
  const tab: AgentsTabKey =
    search.tab && (TABS as string[]).includes(search.tab) ? (search.tab as AgentsTabKey) : 'agents'
  const { items } = useReportList()

  const go = (k: AgentsTabKey): void => {
    void navigate({ to: '/agents', search: { tab: k } })
  }

  const labels: Record<AgentsTabKey, string> = {
    agents: t('agents.tabAgents'),
    reports: t('agents.tabReports'),
    chats: t('agents.tabChats')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        className="flex items-center"
        style={{
          gap: 2,
          padding: '0 18px',
          borderBottom: '1px solid rgb(var(--ink-border))',
          background: 'rgb(var(--ink-1))',
          flexShrink: 0,
          height: 46
        }}
        role="tablist"
      >
        {TABS.map((k) => (
          <TabButton
            key={k}
            tabKey={k}
            label={labels[k]}
            active={tab === k}
            count={k === 'reports' ? items.length : undefined}
            onClick={() => go(k)}
          />
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'agents' && <AgentsTab onOpenReports={() => go('reports')} />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'chats' && <ChatsTab backend="custom-api" />}
      </div>
    </div>
  )
}
