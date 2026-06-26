// assistant-modal P4 — the modal header title's dropdown: an embedded unified-history session list.
//
// Mirrors AgentThreadList's grouping (today / yesterday / earlier) but WITHOUT the archived group — the
// modal's quick-switcher only surfaces active chats (截图). A transparent fixed overlay catches the
// outside click to close. Picking a row calls onSelect (chat.selectSession) — general AND email-anchored
// sessions switch the same way (AgentConversation routes the runtime per the picked item's backend_kind).
// titleOf is exported so the header reuses the exact same title precedence for the collapsed title text.

import { useTranslation } from 'react-i18next'
import { Mail, MessagesSquare } from 'lucide-react'

import type { ChatSessionListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

import { titleOf } from './sessionTitle'

type ActiveGroupKey = 'today' | 'yesterday' | 'earlier'
const ACTIVE_GROUP_ORDER: readonly ActiveGroupKey[] = ['today', 'yesterday', 'earlier']

function groupOf(updatedAtMs: number, todayStartMs: number): ActiveGroupKey {
  if (updatedAtMs >= todayStartMs) return 'today'
  if (updatedAtMs >= todayStartMs - 86_400_000) return 'yesterday'
  return 'earlier'
}

export function ChatModalHistoryDropdown({
  items,
  activeSessionId,
  onSelect,
  onClose
}: {
  items: ChatSessionListItem[]
  activeSessionId: number | null
  onSelect: (id: number) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()
  // 去 archived — the quick-switcher only lists active chats (the agent view's bottom 归档 group is the
  // place to restore archived sessions).
  const active = items.filter((s) => !s.archived)
  const grouped: Record<ActiveGroupKey, ChatSessionListItem[]> = {
    today: [],
    yesterday: [],
    earlier: []
  }
  for (const s of active) grouped[groupOf(s.updated_at, todayStartMs)].push(s)

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="menu"
        className={cn(
          'scrollbar-thin absolute left-0 top-8 z-50 max-h-[60vh] w-72 overflow-y-auto',
          'rounded-lg border border-[var(--hairline)] bg-ink-2 p-1',
          'shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)]'
        )}
      >
        {active.length === 0 ? (
          <div className="px-2 py-6 text-center text-meta text-ink-fg-3">
            {t('agentView.emptyHistory')}
          </div>
        ) : (
          ACTIVE_GROUP_ORDER.map((g) =>
            grouped[g].length === 0 ? null : (
              <div key={g} className="mb-1">
                <div className="px-2 pb-1 pt-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
                  {t(`agentView.group.${g}`)}
                </div>
                <div className="flex flex-col gap-0.5">
                  {grouped[g].map((s) => {
                    const Icon = s.anchor_type === 'email' ? Mail : MessagesSquare
                    const selected = s.id === activeSessionId
                    const title = titleOf(s, t)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => onSelect(s.id)}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-left',
                          'transition-colors duration-fast',
                          selected ? 'bg-ink-3' : 'hover:bg-ink-3/60'
                        )}
                      >
                        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                        <span
                          className="min-w-0 flex-1 truncate text-meta text-ink-fg-1"
                          title={title}
                        >
                          {title}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          )
        )}
      </div>
    </>
  )
}
