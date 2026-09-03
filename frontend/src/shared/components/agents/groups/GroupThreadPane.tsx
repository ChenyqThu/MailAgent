// T3 群聊话题 — 右侧话题面（顶替群详情面，父设计 D9）。本组件只做「解析 + 壳」：
//   · 从话题清单（groupThreadsKey，与主时间线共享缓存）找到这条话题的摘要，从父群消息缓存
//     （qk.chat.messages(groupId)）找到根消息行 —— 两个 key 与群视图同一份，通知直达时才会真的拉；
//   · 合成话题会话行（id = threadId、members_json = 父群成员：@ 候选恒是父群成员，与话题行自己那份
//     快照无关）交给 GroupChatView 的 thread 模式 —— 消息流 / 在场态 / composer / 停止 / 重试与群视图
//     **同一条管线**，不抄第二份；`key={threadId}` 由工作区给，换话题整体重挂；
//   · Esc 关闭（composer 的 @ 弹层开着时 Esc 归它：它 preventDefault，这里看 defaultPrevented 让位）。
// 打开即已读、前台二元组、话题卡刷新都在 GroupChatView 的 thread 分支里。

import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import type { ChatSession } from '@shared/api/types'
import { listGroupThreads } from '@shared/api/groupSettings'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

import { GroupChatView } from './GroupChatView'
import { groupThreadsKey } from './groupThreads'
import type { GroupMemberMeta } from './members'
import type { GroupLiveTriple } from './useGroupTurnEvents'

export function GroupThreadPane({
  groupId,
  threadId,
  group,
  memberMeta,
  initialLive,
  onClose
}: {
  groupId: number
  threadId: number
  /** 父群行：成员名单（@ 候选）从这里来。 */
  group: ChatSession
  memberMeta: Map<string, GroupMemberMeta>
  initialLive?: GroupLiveTriple | null
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()

  const threadsQ = useQuery({
    queryKey: groupThreadsKey(groupId),
    queryFn: () => listGroupThreads(groupId),
    staleTime: 5_000
  })
  const groupMessagesQ = useQuery({
    queryKey: qk.chat.messages(groupId),
    queryFn: () => mailApi.chat.listMessages(groupId),
    staleTime: 5_000
  })
  const summary = threadsQ.data?.find((th) => th.sessionId === threadId) ?? null
  const rootMessage =
    summary != null
      ? (groupMessagesQ.data?.find((m) => m.id === summary.rootMessageId) ?? null)
      : null

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 话题会话行：只有 id / 成员 / 父群 / 标题四件被 GroupChatView 读到。
  const threadSession = useMemo<ChatSession>(
    () => ({ ...group, id: threadId, parent_session_id: groupId, title: summary?.title ?? null }),
    [group, threadId, groupId, summary?.title]
  )
  const thread = useMemo(
    () =>
      summary == null
        ? null
        : {
            groupId,
            summary,
            rootMessage,
            onClose,
            // 「在群里查看」= 收起话题面回到主时间线（那条根消息下面挂着这张话题卡）。
            onViewInGroup: onClose
          },
    [groupId, summary, rootMessage, onClose]
  )
  // 话题里落了一条（本人发送 / v1 循环的成员回复）→ 刷父群的话题卡与群列表的未读派生列。
  const onActivity = (): void => {
    void qc.invalidateQueries({ queryKey: groupThreadsKey(groupId) })
    void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-group-thread-pane={threadId}>
      {thread != null ? (
        <GroupChatView
          session={threadSession}
          memberMeta={memberMeta}
          onActivity={onActivity}
          initialLive={initialLive}
          thread={thread}
        />
      ) : (
        <>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-border px-3">
            <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink-fg">
              {t('groupChat.thread.paneTitle')}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('groupChat.thread.close')}
              className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
          {/* 清单到了却没有这条（已删 / 旧链接）或清单读失败：说读失败 + 重试，不猜它去哪了。 */}
          {(threadsQ.isError || threadsQ.data != null) && (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-meta text-ink-fg-3">
              <span>{t('groupChat.transcript.loadFailed')}</span>
              <button
                type="button"
                onClick={() => void threadsQ.refetch()}
                className="text-aux text-ink-fg-1 underline-offset-2 hover:underline"
              >
                {t('groupChat.transcript.retryLoad')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
