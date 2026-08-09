import { createElement, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Unstable_TriggerItem } from '@assistant-ui/react'

import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'

import { AgentAvatar } from './AgentAvatar'
import { AGENT_MENTION_CATEGORY_ID, buildAgentMentionItems } from './agentMention'
import {
  useCustomAgentCallEnabled,
  useCustomAgentsEnabled,
  useReportConfig
} from './hooks'

type TriggerAdapter = {
  categories: () => readonly { readonly id: string; readonly label: string }[]
  categoryItems: (categoryId: string) => readonly Unstable_TriggerItem[]
  search: (query: string) => readonly Unstable_TriggerItem[]
}

function matchesTriggerItem(item: Unstable_TriggerItem, query: string): boolean {
  const lower = query.toLowerCase()
  return (
    item.id.toLowerCase().includes(lower) ||
    item.label.toLowerCase().includes(lower) ||
    item.description?.toLowerCase().includes(lower) === true
  )
}

export function useAgentMentionAdapter(controls: ChatComposerControls | null): {
  adapter: TriggerAdapter
  isLoading: boolean
  onInserted: (item: Unstable_TriggerItem) => void
  renderItemIcon: (item: Unstable_TriggerItem) => ReactNode
} {
  const { t } = useTranslation()
  const { agents, isLoading } = useReportConfig()
  const customAgentsEnabled = useCustomAgentsEnabled()
  const customAgentCallEnabled = useCustomAgentCallEnabled()
  const visible = controls != null && customAgentsEnabled && customAgentCallEnabled
  const eligibleAgents = useMemo(
    () => agents.filter((agent) => agent.type === 'custom' && agent.enabled),
    [agents]
  )
  const items = useMemo(() => buildAgentMentionItems(eligibleAgents), [eligibleAgents])
  const configsByItemId = useMemo(
    () => new Map(eligibleAgents.map((agent) => [`agent-${agent.id}`, agent])),
    [eligibleAgents]
  )
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () =>
        visible ? [{ id: AGENT_MENTION_CATEGORY_ID, label: t('agentView.mention.agents') }] : [],
      categoryItems: (categoryId: string) =>
        visible && categoryId === AGENT_MENTION_CATEGORY_ID ? items : [],
      search: (query: string) =>
        visible ? items.filter((item) => matchesTriggerItem(item, query)) : []
    }),
    [items, t, visible]
  )
  const onInserted = useCallback(
    (item: Unstable_TriggerItem) => {
      const agent = configsByItemId.get(item.id)
      if (agent) controls?.onAddAgentMention?.(agent)
    },
    [configsByItemId, controls]
  )
  const renderItemIcon = useCallback(
    (item: Unstable_TriggerItem): ReactNode => {
      const agent = configsByItemId.get(item.id)
      return agent
        ? createElement(AgentAvatar, { agentId: agent.id, config: agent.avatar, size: 18 })
        : null
    },
    [configsByItemId]
  )
  return { adapter, isLoading, onInserted, renderItemIcon }
}
