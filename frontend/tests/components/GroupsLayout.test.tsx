// @vitest-environment happy-dom
//
// 09-02 对话域拆分 — `/groups` 路由壳的三件事（工作区本身归 GroupChatWorkspace.test.tsx）：
//   G1 挂载即拉 origin='group' 清单（拆域前挂在 AgentViewLayout 上按分段 `enabled`，
//      现在判据是「本页挂着就拉」）并把行发给工作区；
//   G2 主标签第二段 = 当前群名（useMainBreadcrumb 的守卫要求 mainPage 已落到 groups）；
//   G3 选中的群不在清单里（刚建好还没 refetch 到 / 已删）→ 单段，不猜名字。
//
// 工作区整体打桩：本文件只钉壳往下发的 props 与面包屑，三栏内部行为不在这里重复钉。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const mockListAllSessions = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { listAllSessions: mockListAllSessions } })
}))

const mockWorkspaceProps = vi.fn()
vi.mock('../../src/shared/components/agents/groups/GroupChatWorkspace', () => ({
  GroupChatWorkspace: (props: Record<string, unknown>) => {
    mockWorkspaceProps(props)
    return <div data-workspace />
  }
}))

import i18n from '@shared/i18n'
import type { ChatSessionListItem } from '@shared/api/types'
import { useGroupsView } from '@shared/state/groups-view'
import { useTabWorkspace } from '@shared/state/tab-workspace'
import { GroupsLayout } from '../../src/shared/components/layout/GroupsLayout'

await i18n.changeLanguage('zh-CN')

function groupRow(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 300,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: '项目对齐群',
    archived: false,
    created_at: 1,
    updated_at: 1,
    origin: 'group',
    members_json: '["a1","a2"]',
    ...over
  } as ChatSessionListItem
}

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(createElement(QueryClientProvider, { client: qc }, <GroupsLayout />))
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockListAllSessions.mockResolvedValue([groupRow()])
  useGroupsView.setState({ activeGroupSessionId: null })
  useTabWorkspace.setState({ mainPage: 'groups', mainBreadcrumb: null })
})

describe('GroupsLayout', () => {
  test('G1 挂载即拉 origin=group 清单并发给工作区', async () => {
    renderLayout()
    await waitFor(() => expect(mockListAllSessions).toHaveBeenCalledWith({ origin: 'group' }))
    await waitFor(() =>
      expect(mockWorkspaceProps.mock.calls.at(-1)?.[0].items).toEqual([groupRow()])
    )
  })

  test('G2 主标签第二段 = 当前群名；无标题的群回落默认名', async () => {
    useGroupsView.setState({ activeGroupSessionId: 300 })
    renderLayout()
    await waitFor(() => expect(useTabWorkspace.getState().mainBreadcrumb).toBe('项目对齐群'))

    cleanup()
    mockListAllSessions.mockResolvedValue([groupRow({ title: null })])
    renderLayout()
    await waitFor(() => expect(useTabWorkspace.getState().mainBreadcrumb).toBe('新群聊'))
  })

  test('G3 选中的群不在清单里 → 面包屑维持单段', async () => {
    useGroupsView.setState({ activeGroupSessionId: 999 })
    renderLayout()
    await waitFor(() => expect(mockListAllSessions).toHaveBeenCalledTimes(1))
    expect(useTabWorkspace.getState().mainBreadcrumb).toBeNull()
  })
})
