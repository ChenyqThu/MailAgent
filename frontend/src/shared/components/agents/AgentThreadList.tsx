// redesign Phase 1 — MailAgent view LEFT session-history sidebar.
//
// A collapsible (260px ↔ 48px) thread-list for the general-agent surface, restyled from the
// assistant-ui base template with our coral/ink tokens. Visual DNA borrowed from the ChatsTab
// SessionRow/SessionListPane (the read-only /sessions browser this view replaces). Pure
// props-driven — the parent AgentViewLayout owns the session state — so the same component serves
// Phase 1 (static list) and Phase 9 (live CRUD). Phase 9: the list is UNIFIED (all agent sessions,
// email + general) from listAllSessions; rows carry their own title (email subject / first user
// message) + anchor icon. Sessions group by updated_at into Today / Yesterday / Earlier; each row has
// a hover arm-to-delete (rename deferred — no rename IPC).

import { useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Mail,
  MessagesSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'

import type { ChatSessionListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

export interface AgentThreadListProps {
  /** Unified history — all sessions (email + general), newest-first. */
  items: ChatSessionListItem[]
  activeSessionId: number | null
  onSelect: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
  /** Phase 10 — inline rename → updateSessionTitle (parent persists + refreshes the list). */
  onRename: (id: number, title: string) => void
  /** dogfood-2 — 归档 → updateSessionArchived(id, true)（parent persists + refreshes，从列表过滤）。 */
  onArchive: (id: number) => void
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

// Unified title: a stored title wins (manual rename / haiku auto-title); else an email session shows
// its subject, a general session the first user message; else "untitled".
function titleOf(item: ChatSessionListItem, t: TFunction): string {
  return (
    item.title?.trim() ||
    item.email_subject?.trim() ||
    item.first_user_message?.trim() ||
    t('sessions.untitled')
  )
}

export function AgentThreadList(props: AgentThreadListProps): React.ReactElement {
  const {
    items,
    activeSessionId,
    onSelect,
    onNew,
    onDelete,
    onRename,
    onArchive,
    collapsed,
    onToggleCollapse,
    fluid
  } = props
  const { t } = useTranslation()
  const [renamingId, setRenamingId] = useState<number | null>(null)

  // Desktop collapses to a 48px rail; fluid (narrow / mobile) stays full-width and never collapses.
  // Single <aside> with a width + opacity transition (demo parity): the rail keeps the PanelLeft
  // toggle + New icon visible while the title and session list fade out — no DOM swap, so the 200ms
  // collapse animates smoothly instead of hard-cutting between two layouts.
  const isRail = collapsed && !fluid

  // Sessions arrive newest-first from the hook; group them by their updated_at day.
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()
  const grouped: Record<GroupKey, ChatSessionListItem[]> = { today: [], yesterday: [], earlier: [] }
  for (const s of items) grouped[groupOf(s.updated_at, todayStartMs)].push(s)

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
        {items.length === 0 ? (
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
                      title={titleOf(s, t)}
                      isEmail={s.anchor_type === 'email'}
                      selected={s.id === activeSessionId}
                      onSelect={() => onSelect(s.id)}
                      renaming={renamingId === s.id}
                      onStartRename={() => setRenamingId(s.id)}
                      onSubmitRename={(next) => {
                        setRenamingId(null)
                        onRename(s.id, next)
                      }}
                      onCancelRename={() => setRenamingId(null)}
                      onArchive={() => onArchive(s.id)}
                      onDelete={() => onDelete(s.id)}
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
  isEmail,
  selected,
  renaming,
  onSelect,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onArchive,
  onDelete,
  t
}: {
  title: string
  isEmail: boolean
  selected: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onSubmitRename: (title: string) => void
  onCancelRename: () => void
  onArchive: () => void
  onDelete: () => void
  t: TFunction
}): React.ReactElement {
  // Anchor cue: an email-anchored session (opened from the inbox panel) vs a general agent chat.
  const Icon = isEmail ? Mail : MessagesSquare

  // Inline rename — local draft, re-seeded from the title each time the row enters rename mode
  // (adjust-on-prop-change setState; conditional so it doesn't loop). Enter / Escape both blur the
  // input so onBlur is the single commit/cancel path (no double-fire); an escape flag (mutated only in
  // the keydown handler, never during render) distinguishes cancel from commit.
  const [draft, setDraft] = useState(title)
  const [wasRenaming, setWasRenaming] = useState(renaming)
  const escapeRef = useRef(false)
  if (renaming !== wasRenaming) {
    setWasRenaming(renaming)
    if (renaming) setDraft(title)
  }
  const commit = (): void => {
    const next = draft.trim()
    if (next.length > 0 && next !== title) onSubmitRename(next)
    else onCancelRename()
  }

  if (renaming) {
    return (
      <div className="relative flex items-center rounded-lg bg-ink-3 pl-2.5">
        <Icon size={13} strokeWidth={1.75} className="mr-2 shrink-0 text-ink-fg-3" />
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              escapeRef.current = true
              e.currentTarget.blur()
            }
          }}
          onBlur={() => {
            if (escapeRef.current) {
              escapeRef.current = false
              onCancelRename()
            } else {
              commit()
            }
          }}
          aria-label={t('agentView.rename')}
          className="h-9 min-w-0 flex-1 bg-transparent pr-2.5 text-body text-ink-fg outline-none"
        />
      </div>
    )
  }

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
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 pr-10 text-left"
      >
        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
        <span className="min-w-0 flex-1 truncate text-body text-ink-fg-1" title={title}>
          {title}
        </span>
      </button>
      <SessionRowMenu onRename={onStartRename} onArchive={onArchive} onDelete={onDelete} t={t} />
    </div>
  )
}

/** dogfood-2 — session row hover「...」菜单（demo ThreadListItemMore 形态，取代旧的双 icon 铅笔+
 *  垃圾桶）：hover / 选中 / 菜单打开时显示单个 ... → radix Popover 菜单 改名 / 归档 / 删除。 */
function SessionRowMenu({
  onRename,
  onArchive,
  onDelete,
  t
}: {
  onRename: () => void
  onArchive: () => void
  onDelete: () => void
  t: TFunction
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ITEM =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux transition-colors duration-fast'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('agentView.more')}
          className={cn(
            'absolute right-1 grid size-6 place-items-center rounded text-ink-fg-3 transition-opacity duration-fast',
            'hover:bg-ink-4 hover:text-ink-fg',
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          )}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" sideOffset={6} className="w-36 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onRename()
          }}
          className={cn(ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
        >
          <Pencil size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
          {t('agentView.rename')}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onArchive()
          }}
          className={cn(ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
        >
          <Archive size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
          {t('agentView.archive')}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onDelete()
          }}
          className={cn(ITEM, 'text-fail hover:bg-fail/10')}
        >
          <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
          {t('agentView.delete')}
        </button>
      </PopoverContent>
    </Popover>
  )
}
