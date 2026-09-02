// /groups route shell — 群聊域（09-02 对话域拆分：原对话域二级栏「AI｜群聊」分段的群聊
// 那一半升成一级域）。二级栏 = GroupChatWorkspace 自管的群清单列（registry 里 groups 域
// 是 second:'page'），故本壳只负责列表数据、折叠态与主标签面包屑，三栏布局都在工作区里。

import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { useDomainCollapsed } from '@shared/state/nav-shell'
import { useGroupsView } from '@shared/state/groups-view'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'

import { PageFrame } from './PageFrame'
import { useNarrow } from '../agents/hooks'

// Lazy：群聊工作区拖着群聊视图 / 详情面 / 建群对话框整条链，让它走自己的 chunk
// （同 SessionsLayout 对 AgentViewLayout 的做法）。
const GroupChatWorkspace = lazy(() =>
  import('../agents/groups/GroupChatWorkspace').then((m) => ({ default: m.GroupChatWorkspace }))
)

export function GroupsLayout(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const narrow = useNarrow()
  const navHidden = useDomainCollapsed('groups')
  const activeGroupId = useGroupsView((s) => s.activeGroupSessionId)

  // 群清单。query key 与侧栏那颗未读点共读一份（qk.chat.groupOriginSessions）——
  // 拆域前挂在 AgentViewLayout 上并按分段 `enabled`，现在「本页挂着就拉」。
  const groupsQ = useQuery({
    queryKey: qk.chat.groupOriginSessions(),
    queryFn: () => mailApi.chat.listAllSessions({ origin: 'group' }),
    staleTime: 10_000
  })
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
  }

  // 主标签第二段 = 当前群名。列表里查不到（刚建好还没 refetch 到 / 群已删）就传 null 走
  // 单段，不猜一个可能是错的名字。
  const activeRow =
    activeGroupId != null ? (groupsQ.data?.find((s) => s.id === activeGroupId) ?? null) : null
  useMainBreadcrumb(
    'groups',
    activeRow != null ? (activeRow.title ?? t('groupChat.defaultTitle')) : null
  )

  return (
    <PageFrame ariaLabel="group-chat" mainClassName="flex-1 flex flex-col overflow-hidden min-w-0">
      <Suspense fallback={<div className="flex-1" />}>
        <GroupChatWorkspace
          items={groupsQ.data ?? []}
          invalidate={invalidate}
          narrow={narrow}
          navHidden={navHidden}
        />
      </Suspense>
    </PageFrame>
  )
}
