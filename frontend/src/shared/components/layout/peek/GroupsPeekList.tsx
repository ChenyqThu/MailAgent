// 群聊域 peek —— 投影变体（体例同 ChatsPeekList：浮层只做「看 + 选」，`GroupList` 的重命名 /
// 删除 / 建群那一整套写动作在浮层里没有落点）。行 = 群图标 + 群名 + 未读点 + 相对时间。
// 数据 = 与侧栏那颗未读点、`GroupsLayout` 的清单同一个 key（`qk.chat.groupOriginSessions`），
// 三处共享缓存；点行 = `navigateToGroupSession`（选群 + 进 /groups 的落地单源）。

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { UsersRound } from 'lucide-react'

import { navigateToGroupSession } from '@shared/components/agents/groups/navigation'
import { formatRelativeTime } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import { isGroupRowUnread } from '@shared/lib/groupUnread'
import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'

import { PeekEmpty, PeekHeader, PeekSkeleton, type PeekListProps } from './PeekChrome'

const MAX_ROWS = 40

export default function GroupsPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const q = useQuery({
    queryKey: qk.chat.groupOriginSessions(),
    queryFn: () => mailApi.chat.listAllSessions({ origin: 'group' }),
    staleTime: 30_000
  })
  const items = (q.data ?? []).slice(0, MAX_ROWS)

  return (
    <>
      <PeekHeader title={t('nav.domain.groups')} />
      <div
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-1.5 py-1.5 space-y-px"
        data-nav-peek-list="groups"
      >
        {q.isPending ? (
          <PeekSkeleton />
        ) : items.length === 0 ? (
          <PeekEmpty text={t('groupChat.emptyList')} />
        ) : (
          items.map((session) => {
            const unread = isGroupRowUnread(session)
            return (
              <button
                key={session.id}
                type="button"
                data-session-id={session.id}
                onClick={() => {
                  navigateToGroupSession(navigate, session.id)
                  onNavigate()
                }}
                className={cn(
                  'row flex h-[30px] w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 text-left text-body',
                  'text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg'
                )}
              >
                <UsersRound size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                <span className={cn('flex-1 truncate', unread && 'font-medium text-ink-fg')}>
                  {session.title ?? t('groupChat.defaultTitle')}
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
