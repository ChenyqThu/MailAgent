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
  ArchiveRestore,
  ChevronRight,
  Mail,
  MessagesSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Star,
  Trash2
} from 'lucide-react'

import type { ChatSessionListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { isSessionUnread } from '@shared/lib/chatUnread'
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
  /** dogfood-2 — 归档 → updateSessionArchived(id, true)（parent persists + refreshes，移到底部归档组）。 */
  onArchive: (id: number) => void
  /** dogfood-3 — 恢复 → updateSessionArchived(id, false)（从归档组移回日期分组）。 */
  onRestore: (id: number) => void
  /** custom-agent epic W3 — pin/unpin and refresh the dedicated top group. */
  onPin: (id: number, pinned: boolean) => void
  /** custom-agent epic W3 — independent leading star icon state. */
  onStar: (id: number, starred: boolean) => void
  collapsed: boolean
  onToggleCollapse: () => void
  /** fluid = full-width single pane (narrow / mobile); ignores collapse. */
  fluid?: boolean
}

// dogfood-3 — 'archived' is a synthetic group pinned to the BOTTOM (collapsed by default); active
// sessions still group by updated_at into today / yesterday / earlier.
type GroupKey = 'pinned' | 'today' | 'yesterday' | 'earlier' | 'archived'
const GROUP_ORDER: readonly GroupKey[] = ['pinned', 'today', 'yesterday', 'earlier', 'archived']

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
    onRestore,
    onPin,
    onStar,
    collapsed,
    onToggleCollapse,
    fluid
  } = props
  const { t } = useTranslation()
  const [renamingId, setRenamingId] = useState<number | null>(null)
  // dogfood-3 — per-group collapse (date headers + the archived group are all collapsible). Archived
  // starts collapsed so it stays out of the way until expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(() => new Set(['archived']))
  const toggleGroup = (g: GroupKey): void =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })

  // Desktop collapses to a 48px rail; fluid (narrow / mobile) stays full-width and never collapses.
  // Single <aside> with a width + opacity transition (demo parity): the rail keeps the PanelLeft
  // toggle + New icon visible while the title and session list fade out — no DOM swap, so the 200ms
  // collapse animates smoothly instead of hard-cutting between two layouts.
  const isRail = collapsed && !fluid

  // Sessions arrive newest-first from the hook; group them by their updated_at day.
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()
  const grouped: Record<GroupKey, ChatSessionListItem[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    earlier: [],
    archived: []
  }
  // Archived takes precedence over pinned. Active pinned rows get their own top group; the rest use
  // conversation recency. A fresh pin sorts above an older pin without touching updated_at.
  for (const s of items) {
    if (s.archived) grouped.archived.push(s)
    else if (s.pinned_at != null) grouped.pinned.push(s)
    else grouped[groupOf(s.updated_at, todayStartMs)].push(s)
  }
  grouped.pinned.sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0))

  return (
    <aside
      className={cn(
        // 会话侧栏材质与右侧对话区（AgentThread glass-3）统一为玻璃，暗色下不再是孤立纯色块。
        'glass-panel flex h-full shrink-0 flex-col overflow-hidden',
        fluid
          ? 'w-full'
          : cn(
              'border-r border-ink-border transition-[width] duration-base ease-standard motion-reduce:transition-none',
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
          GROUP_ORDER.map((g) => {
            if (grouped[g].length === 0) return null
            const isGroupCollapsed = collapsedGroups.has(g)
            return (
              <div key={g} className="mb-1">
                {/* Collapsible group header — the chevron rotates on expand; a count sits to the right. */}
                <button
                  type="button"
                  onClick={() => toggleGroup(g)}
                  aria-expanded={!isGroupCollapsed}
                  className="flex w-full items-center gap-1 rounded px-2 pb-1 pt-2.5 text-micro font-medium uppercase tracking-wider text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-1"
                >
                  <ChevronRight
                    size={11}
                    strokeWidth={2.5}
                    className={cn(
                      'shrink-0 transition-transform duration-fast',
                      !isGroupCollapsed && 'rotate-90'
                    )}
                  />
                  <span className="flex-1 text-left">{t(`agentView.group.${g}`)}</span>
                  <span className="shrink-0 tabular-nums opacity-60">{grouped[g].length}</span>
                </button>
                {!isGroupCollapsed && (
                  <div className="flex flex-col gap-0.5">
                    {grouped[g].map((s) => (
                      <SessionRow
                        key={s.id}
                        title={titleOf(s, t)}
                        isEmail={s.anchor_type === 'email'}
                        fromIm={s.origin === 'im'}
                        isArchived={g === 'archived'}
                        pinned={s.pinned_at != null}
                        starred={Boolean(s.starred)}
                        unread={s.id !== activeSessionId && isSessionUnread(s)}
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
                        onRestore={() => onRestore(s.id)}
                        onPin={(pinned) => onPin(s.id, pinned)}
                        onStar={(starred) => onStar(s.id, starred)}
                        onDelete={() => onDelete(s.id)}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}

function SessionRow({
  title,
  isEmail,
  fromIm,
  isArchived,
  pinned,
  starred,
  unread,
  selected,
  renaming,
  onSelect,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onArchive,
  onRestore,
  onPin,
  onStar,
  onDelete,
  t
}: {
  title: string
  isEmail: boolean
  /** Stage 2 PR-1 (Q18=A 信任可见) — origin='im' session (飞书会话): rows carry a「来自飞书」badge
   *  so provenance is explicit in the desktop list, not only in the DB column. */
  fromIm: boolean
  isArchived: boolean
  pinned: boolean
  starred: boolean
  /** B4 (07-15) — unread badge: content persisted after the last read (never on the selected row). */
  unread: boolean
  selected: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  onSubmitRename: (title: string) => void
  onCancelRename: () => void
  onArchive: () => void
  onRestore: () => void
  onPin: (pinned: boolean) => void
  onStar: (starred: boolean) => void
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
    // 主题 v3 C8/批 4: 会话行圆角 rounded-lg(8) → token 化 --r-ctl
    return (
      <div className="relative flex items-center rounded-[var(--r-ctl)] bg-ink-3 pl-2.5">
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
        // 主题 v3 C8/批 4: 会话行圆角 rounded-lg(8) → token 化 --r-ctl
        'group relative flex items-center rounded-[var(--r-ctl)]',
        // 主题 v3 C5/批 4: 选中 wash 从中性灰 bg-ink-3 收编到 --sel-wash
        // (与 Sidebar/EmailRow 跨视图同一选中签名); 左条 span 本体保留 (owner 红线)。
        selected ? '[background-image:var(--sel-wash)]' : 'hover:bg-ink-fg/[0.04]'
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
        aria-label={starred ? t('agentView.unstar') : t('agentView.star')}
        aria-pressed={starred}
        onClick={() => onStar(!starred)}
        className={cn(
          'ml-1.5 grid size-6 shrink-0 place-items-center rounded transition-colors duration-fast',
          starred
            ? 'text-coral hover:bg-coral/10'
            : 'text-ink-fg-3 hover:bg-ink-4 hover:text-ink-fg-1'
        )}
      >
        <Star size={13} strokeWidth={1.9} fill={starred ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        onClick={onSelect}
        // 主题 v3 C8/批 4: 会话行点击面圆角 rounded-lg(8) → token 化 --r-ctl
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-ctl)] pl-1 pr-10 text-left"
      >
        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-body',
            unread ? 'font-semibold text-ink-fg' : 'text-ink-fg-1'
          )}
          title={title}
        >
          {title}
        </span>
        {fromIm && (
          // Stage 2 PR-1 (Q18=A) — provenance badge for 飞书-originated sessions. Styling follows
          // the list's existing micro/pill idioms (group-header text-micro + soft ink border);
          // the i18n key ships with a defaultValue（locale files归 PR-4 信任可见收尾）.
          <span className="shrink-0 rounded-full border border-ink-border-soft bg-ink-3 px-1.5 py-px text-micro text-ink-fg-3">
            {t('agentView.fromFeishu', { defaultValue: '来自飞书' })}
          </span>
        )}
        {unread && (
          <span
            data-session-unread-dot
            aria-label={t('chat.sidebar.unread')}
            className="size-1.5 shrink-0 rounded-full bg-coral/100"
          />
        )}
      </button>
      <SessionRowMenu
        onRename={onStartRename}
        isArchived={isArchived}
        pinned={pinned}
        onPin={() => onPin(!pinned)}
        onArchive={onArchive}
        onRestore={onRestore}
        onDelete={onDelete}
        t={t}
      />
    </div>
  )
}

/** dogfood-2 — session row hover「...」菜单（demo ThreadListItemMore 形态，取代旧的双 icon 铅笔+
 *  垃圾桶）：hover / 选中 / 菜单打开时显示单个 ... → radix Popover 菜单 改名 / 归档 / 删除。 */
function SessionRowMenu({
  onRename,
  isArchived,
  pinned,
  onPin,
  onArchive,
  onRestore,
  onDelete,
  t
}: {
  onRename: () => void
  isArchived: boolean
  pinned: boolean
  onPin: () => void
  onArchive: () => void
  onRestore: () => void
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
        {isArchived ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onRestore()
            }}
            className={cn(ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
          >
            <ArchiveRestore size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
            {t('agentView.restore')}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onPin()
              }}
              className={cn(ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
            >
              {pinned ? (
                <PinOff size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
              ) : (
                <Pin size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
              )}
              {t(pinned ? 'agentView.unpin' : 'agentView.pin')}
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
          </>
        )}
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
