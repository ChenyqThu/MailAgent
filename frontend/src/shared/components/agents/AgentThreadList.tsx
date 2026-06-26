// redesign Phase 1 — MailAgent view LEFT session-history sidebar.
//
// A collapsible (260px ↔ 48px) thread-list for the general-agent surface, restyled from the
// assistant-ui base template with our coral/ink tokens. Visual DNA borrowed from the ChatsTab
// SessionRow/SessionListPane (the read-only /sessions browser this view replaces). Pure
// props-driven — the parent AgentViewLayout owns the session state (useGeneralChat) — so the same
// component serves Phase 1 (static list) and Phase 2 (live CRUD). Sessions group by updated_at into
// Today / Yesterday / Earlier; each row has a hover arm-to-delete (rename deferred — no rename IPC).
// General sessions carry no subject, so row titles come from the parent's lazy first-message preview.

import { useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Check, PanelLeft, Plus, Trash2, X } from 'lucide-react'

import type { ChatSession } from '@shared/api/types'
import { cn } from '@shared/lib/cn'

export interface AgentThreadListProps {
  sessions: ChatSession[]
  /** session id → lazily-loaded first-user-message preview (row title source). */
  previews: Record<number, string | null>
  activeSessionId: number | null
  onSelect: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
  collapsed: boolean
  onToggleCollapse: () => void
  /** fluid = full-width single pane (narrow / mobile); ignores collapse. */
  fluid?: boolean
}

type GroupKey = 'today' | 'yesterday' | 'earlier'
const GROUP_ORDER: readonly GroupKey[] = ['today', 'yesterday', 'earlier']

function groupOf(updatedAtMs: number, todayStartMs: number): GroupKey {
  if (updatedAtMs >= todayStartMs) return 'today'
  if (updatedAtMs >= todayStartMs - 86_400_000) return 'yesterday'
  return 'earlier'
}

function titleOf(
  session: ChatSession,
  previews: Record<number, string | null>,
  t: TFunction
): string {
  const preview = previews[session.id]
  if (typeof preview === 'string' && preview.trim().length > 0) return preview.trim()
  return t('sessions.untitled')
}

export function AgentThreadList(props: AgentThreadListProps): React.ReactElement {
  const {
    sessions,
    previews,
    activeSessionId,
    onSelect,
    onNew,
    onDelete,
    collapsed,
    onToggleCollapse,
    fluid
  } = props
  const { t } = useTranslation()
  const [armedDelete, setArmedDelete] = useState<number | null>(null)

  // Desktop collapses to a 48px rail; fluid (narrow / mobile) stays full-width and never collapses.
  // Single <aside> with a width + opacity transition (demo parity): the rail keeps the PanelLeft
  // toggle + New icon visible while the title and session list fade out — no DOM swap, so the 200ms
  // collapse animates smoothly instead of hard-cutting between two layouts.
  const isRail = collapsed && !fluid

  // Sessions arrive newest-first from the hook; group them by their updated_at day.
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()
  const grouped: Record<GroupKey, ChatSession[]> = { today: [], yesterday: [], earlier: [] }
  for (const s of sessions) grouped[groupOf(s.updated_at, todayStartMs)].push(s)

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden',
        fluid
          ? 'w-full'
          : cn(
              'border-r border-ink-border transition-[width] duration-200',
              isRail ? 'w-12' : 'w-[260px]'
            )
      )}
    >
      {/* Header — PanelLeft collapse toggle (demo icon) + fading title. */}
      <div
        className={cn(
          'flex h-12 shrink-0 items-center gap-1',
          isRail ? 'justify-center px-2' : 'px-3'
        )}
      >
        {!fluid && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={t('agentView.collapseSidebar')}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </button>
        )}
        {!isRail && (
          <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-ink-fg">
            {t('agentView.historyTitle')}
          </h2>
        )}
      </div>

      {/* New-session button — collapses to a centered icon on the rail. */}
      <div className={cn('pb-2', isRail ? 'px-2' : 'px-3')}>
        <button
          type="button"
          onClick={onNew}
          aria-label={t('agentView.newSession')}
          title={isRail ? t('agentView.newSession') : undefined}
          className={cn(
            'flex h-8 items-center rounded-lg border border-ink-border-soft bg-ink-2',
            'text-body font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3',
            isRail ? 'w-8 justify-center px-0' : 'w-full gap-2 px-2.5'
          )}
        >
          <Plus size={15} strokeWidth={2} className="shrink-0 text-coral" />
          {!isRail && <span className="truncate">{t('agentView.newSession')}</span>}
        </button>
      </div>

      {/* Session list — fades out on the rail (kept mounted, no DOM swap). */}
      <div
        aria-hidden={isRail}
        className={cn(
          'scrollbar-thin flex-1 overflow-y-auto px-2 pb-2 transition-opacity duration-200',
          isRail && 'pointer-events-none opacity-0'
        )}
      >
        {sessions.length === 0 ? (
          <div className="px-2 py-6 text-center text-meta text-ink-fg-3">
            {t('agentView.emptyHistory')}
          </div>
        ) : (
          GROUP_ORDER.map((g) =>
            grouped[g].length === 0 ? null : (
              <div key={g} className="mb-1">
                <div className="px-2 pb-1 pt-2.5 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
                  {t(`agentView.group.${g}`)}
                </div>
                <div className="flex flex-col gap-0.5">
                  {grouped[g].map((s) => (
                    <SessionRow
                      key={s.id}
                      title={titleOf(s, previews, t)}
                      selected={s.id === activeSessionId}
                      armed={armedDelete === s.id}
                      onSelect={() => {
                        setArmedDelete(null)
                        onSelect(s.id)
                      }}
                      onArmDelete={() => setArmedDelete(s.id)}
                      onCancelDelete={() => setArmedDelete(null)}
                      onConfirmDelete={() => {
                        setArmedDelete(null)
                        onDelete(s.id)
                      }}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            )
          )
        )}
      </div>
    </aside>
  )
}

function SessionRow({
  title,
  selected,
  armed,
  onSelect,
  onArmDelete,
  onCancelDelete,
  onConfirmDelete,
  t
}: {
  title: string
  selected: boolean
  armed: boolean
  onSelect: () => void
  onArmDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  t: TFunction
}): React.ReactElement {
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-lg',
        selected ? 'bg-ink-3' : 'hover:bg-ink-fg/[0.04]'
      )}
    >
      {selected && (
        <span
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-sm"
          style={{ background: 'rgb(var(--c-accent))' }}
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex h-9 min-w-0 flex-1 items-center rounded-lg pl-2.5 pr-8 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-body text-ink-fg-1" title={title}>
          {title}
        </span>
      </button>
      {armed ? (
        <div className="absolute right-1 flex items-center gap-0.5">
          <button
            type="button"
            onClick={onConfirmDelete}
            aria-label={t('agentView.delete')}
            className="grid size-6 place-items-center rounded text-fail transition-colors duration-fast hover:bg-fail/15"
          >
            <Check size={13} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            aria-label={t('generalAgent.dismiss')}
            className="grid size-6 place-items-center rounded text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4"
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onArmDelete}
          aria-label={t('agentView.delete')}
          className={cn(
            'absolute right-1 grid size-6 place-items-center rounded text-ink-fg-3 opacity-0',
            'transition-[opacity,color,background-color] duration-fast hover:bg-ink-4 hover:text-fail',
            'group-hover:opacity-100 focus-visible:opacity-100'
          )}
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}
