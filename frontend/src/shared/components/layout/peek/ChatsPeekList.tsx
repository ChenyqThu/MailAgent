// 对话域 peek —— 投影变体（design.md §3：`AgentThreadList` 依赖 10 个写回调与会话引擎，
// 浮层里那些动作要么空操作要么改真数据）。只做「看 + 选」：锚点 icon + 标题 + 未读点 + 相对时间。
// 数据 = 与 `AgentViewLayout` 同 key（`[...qk.chat.allSessions(), 'interactive']`，字面量
// 必须一致，共享缓存）；点行 = `requestOpenAgentSession`（⌘O / 通知深链打开会话的同一条桥）。

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Mail, MessagesSquare } from 'lucide-react'

import { titleOf } from '@shared/components/agents/sessionTitle'
import { formatRelativeTime } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import { isSessionUnread } from '@shared/lib/chatUnread'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { navigateToDomain } from '@shared/navigation/domain-location'
import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'

import { PeekEmpty, PeekHeader, PeekSkeleton, type PeekListProps } from './PeekChrome'

const MAX_ROWS = 40

export default function ChatsPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const q = useQuery({
    // 🔴 与 AgentViewLayout 的 ALL_SESSIONS_KEY 逐字一致（那边未导出）。
    queryKey: [...qk.chat.allSessions(), 'interactive'] as const,
    queryFn: () => mailApi.chat.listAllSessions({ includeArchived: true, origin: 'interactive' }),
    staleTime: 10_000
  })
  const items = (q.data ?? []).filter((s) => !s.archived).slice(0, MAX_ROWS)

  return (
    <>
      <PeekHeader title={t('nav.domain.chats')} />
      <div
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-1.5 py-1.5 space-y-px"
        data-nav-peek-list="chats"
      >
        {q.isPending ? (
          <PeekSkeleton />
        ) : items.length === 0 ? (
          <PeekEmpty text={t('agentView.emptyHistory')} />
        ) : (
          items.map((session) => {
            const unread = isSessionUnread(session)
            const isEmail = session.email_subject != null
            const Icon = isEmail ? Mail : MessagesSquare
            return (
              <button
                key={session.id}
                type="button"
                data-session-id={session.id}
                onClick={() => {
                  requestOpenAgentSession(session.id)
                  navigateToDomain(navigate, 'chats')
                  onNavigate()
                }}
                className={cn(
                  'row flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 text-left text-body',
                  'text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg'
                )}
              >
                <Icon size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                <span className={cn('flex-1 truncate', unread && 'font-medium text-ink-fg')}>
                  {titleOf(session, t)}
                </span>
                {unread && (
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-coral/100" />
                )}
                <span className="shrink-0 font-mono text-micro text-ink-fg-3">
                  {formatRelativeTime(new Date(session.updated_at).toISOString(), i18n.language)}
                </span>
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
