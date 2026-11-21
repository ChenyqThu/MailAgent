import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Globe,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Share,
  Trash2
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { useSessionInspector } from '@shared/assistant/inspector/inspectorContext'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

import { AgentAvatar } from './AgentAvatar'

export interface AgentChatHeaderBarProps {
  readonly sessionId: number | null
  readonly sessionTitle: string | null
  readonly isPinned: boolean
  readonly isArchived: boolean
  readonly browserOpen: boolean
  readonly browserActive: boolean
  readonly narrow?: boolean
  readonly onBack?: () => void
  readonly onNew: () => void
  readonly onShare: () => void
  readonly onToggleBrowser: () => void
  readonly onTogglePin: () => void
  readonly onRename: (nextTitle: string) => void
  readonly onArchive: () => void
  readonly onRestore: () => void
  readonly onDelete: () => void
}

const ICON_BTN =
  'grid size-7 shrink-0 place-items-center rounded-md border border-transparent text-ink-fg-2 transition-colors duration-fast hover:bg-ink-2 hover:text-ink-fg disabled:cursor-not-allowed disabled:opacity-40'

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-aux transition-colors duration-fast'

/**
 * Minimal Notion-style top bar for active chat views: Agent identity + breadcrumb title on the
 * left, icon actions (New, Share, Browser, Inspector, Pin, More) on the right.
 */
export function AgentChatHeaderBar({
  sessionId,
  sessionTitle,
  isPinned,
  isArchived,
  browserOpen,
  browserActive,
  narrow = false,
  onBack,
  onNew,
  onShare,
  onToggleBrowser,
  onTogglePin,
  onRename,
  onArchive,
  onRestore,
  onDelete
}: AgentChatHeaderBarProps): React.JSX.Element {
  const { t } = useTranslation()
  const identity = useAssistantIdentity()
  const inspector = useSessionInspector()

  const agentName = identity.name?.trim() || t('chat.title')
  const displayTitle = sessionTitle?.trim() || t('chat.tabs.newChat')
  const hasPersistedSession = sessionId != null && sessionId > 0

  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(displayTitle)
  const [moreOpen, setMoreOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [prevSessionKey, setPrevSessionKey] = useState<string>(
    `${sessionId ?? 'new'}:${displayTitle}`
  )
  const curKey = `${sessionId ?? 'new'}:${displayTitle}`
  if (prevSessionKey !== curKey) {
    setPrevSessionKey(curKey)
    setEditing(false)
    setDraftTitle(displayTitle)
    setMoreOpen(false)
  }

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const commitRename = (): void => {
    const trimmed = draftTitle.trim()
    setEditing(false)
    if (!trimmed || trimmed === displayTitle || !hasPersistedSession) {
      setDraftTitle(displayTitle)
      return
    }
    onRename(trimmed)
  }

  const showInspectorButton =
    inspector !== null && (inspector.snapshot.totalItems > 0 || inspector.open)
  const artifactCount = inspector?.snapshot.artifacts.length ?? 0

  return (
    <header
      data-testid="agent-chat-header"
      className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-ink-border-soft/70 px-3.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {narrow && onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('agents.reports.backToList')}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-2 hover:text-ink-fg"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
        )}
        <AgentAvatar
          agentId="main"
          config={identity.avatar}
          size={22}
          className="shrink-0"
        />
        <span className="shrink-0 text-aux font-medium text-ink-fg">{agentName}</span>
        <span aria-hidden className="shrink-0 text-aux text-ink-fg-3">
          /
        </span>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            aria-label={t('agentView.rename')}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setDraftTitle(displayTitle)
                setEditing(false)
              }
            }}
            className="min-w-0 max-w-[360px] flex-1 rounded border border-coral/50 bg-ink-2 px-2 py-0.5 text-aux text-ink-fg outline-none"
          />
        ) : hasPersistedSession ? (
          <button
            type="button"
            onClick={() => {
              setDraftTitle(displayTitle)
              setEditing(true)
            }}
            title={t('agentView.rename')}
            className="min-w-0 max-w-[360px] truncate rounded px-1.5 py-0.5 text-left text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-2 hover:text-ink-fg"
          >
            {displayTitle}
          </button>
        ) : (
          <span className="min-w-0 max-w-[360px] truncate px-1 text-aux text-ink-fg-2">
            {displayTitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <HoverTip text={t('agentView.newSession')} side="bottom">
          <button
            type="button"
            onClick={onNew}
            aria-label={t('agentView.newSession')}
            className={ICON_BTN}
          >
            <MessageSquarePlus size={16} strokeWidth={1.75} />
          </button>
        </HoverTip>

        <HoverTip text={t('agentView.share')} side="bottom">
          <button
            type="button"
            disabled={!hasPersistedSession}
            onClick={onShare}
            aria-label={t('agentView.share')}
            className={ICON_BTN}
          >
            <Share size={15} strokeWidth={1.75} />
          </button>
        </HoverTip>

        {showInspectorButton && (
          <HoverTip text={`${t('chat.inspector.toggle')} (⌘.)`} side="bottom">
            <button
              type="button"
              data-testid="inspector-toggle-pill"
              aria-label={`${t('chat.inspector.toggle')} (${inspector.snapshot.totalItems})`}
              aria-expanded={inspector.open}
              onClick={inspector.toggle}
              className={cn(
                ICON_BTN,
                'relative',
                inspector.open && 'border-coral/40 bg-coral/10 text-coral hover:bg-coral/15 hover:text-coral'
              )}
            >
              <PanelRight size={16} strokeWidth={1.75} />
              {artifactCount > 0 && !inspector.open && (
                <span
                  aria-hidden
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-coral/100"
                />
              )}
            </button>
          </HoverTip>
        )}

        <HoverTip text={t('browserPane.toggleButton')} side="bottom">
          <button
            type="button"
            onClick={onToggleBrowser}
            aria-label={t('browserPane.toggleButton')}
            aria-expanded={browserOpen}
            className={cn(
              ICON_BTN,
              'relative',
              browserOpen && 'border-coral/40 bg-coral/10 text-coral hover:bg-coral/15 hover:text-coral'
            )}
          >
            <Globe size={15} strokeWidth={1.75} />
            {browserActive && (
              <span
                aria-hidden
                className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-coral/100"
              />
            )}
          </button>
        </HoverTip>

        <HoverTip text={t(isPinned ? 'agentView.unpin' : 'agentView.pin')} side="bottom">
          <button
            type="button"
            disabled={!hasPersistedSession}
            onClick={onTogglePin}
            aria-label={t(isPinned ? 'agentView.unpin' : 'agentView.pin')}
            aria-pressed={isPinned}
            className={cn(
              ICON_BTN,
              isPinned && 'bg-ink-2 text-coral hover:text-coral'
            )}
          >
            {isPinned ? (
              <PinOff size={15} strokeWidth={1.75} />
            ) : (
              <Pin size={15} strokeWidth={1.75} />
            )}
          </button>
        </HoverTip>

        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!hasPersistedSession}
              aria-label={t('agentView.more')}
              className={ICON_BTN}
            >
              <MoreHorizontal size={16} strokeWidth={1.85} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" sideOffset={6} className="w-36 p-1">
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false)
                setDraftTitle(displayTitle)
                setEditing(true)
              }}
              className={cn(MENU_ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
            >
              <Pencil size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
              {t('agentView.rename')}
            </button>
            {isArchived ? (
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false)
                  onRestore()
                }}
                className={cn(MENU_ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
              >
                <ArchiveRestore size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                {t('agentView.restore')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false)
                  onArchive()
                }}
                className={cn(MENU_ITEM, 'text-ink-fg-1 hover:bg-ink-3')}
              >
                <Archive size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                {t('agentView.archive')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false)
                onDelete()
              }}
              className={cn(MENU_ITEM, 'text-fail hover:bg-fail/10')}
            >
              <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
              {t('agentView.delete')}
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  )
}
