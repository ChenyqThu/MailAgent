// 48px detail toolbar · mockup-inbox.html line 854.
//   Back | ✦ 起草回复 (coral CTA) · 翻译 EN→中 | 已读 · 已标旗 · 归档 | 重传 · AI 重跑 | (ml-auto) Notion · ⌃/⌄/⋯
//
// Sprint 3 wired Translate; Sprint 5 wires the remaining ghost actions via
// the new write IPCs (email:createDraft / email:resync / llm:run /
// notion:updateFlag). Each action goes through `onXxx` props so the
// presentation stays pure — `EmailDetail` owns the loading state machine.
//
// Loading: each button accepts a `pending` flag. While true, the icon
// flips to a spinner + label switches to the pending i18n key + click is
// ignored. The pending toggle is set by EmailDetail around the IPC call.
//
// Destructive confirm: `重传 Notion` opens a 3-button confirm dialog
// (cancel / dry-run / push) because resync overwrites the Notion page.
// `AI 重跑` + `已读 / 已标旗` go through without confirm — they're
// trivially reversible.

import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import {
  Archive,
  ArrowLeft,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Languages,
  Loader2,
  MoreHorizontal,
  RefreshCcw,
  Sparkles,
  Star,
  Zap
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { toggleAIChatPanel, useAIChatPanel } from '@shared/state/ai-chat-panel'

export type TranslateStatus = 'idle' | 'loading' | 'translated' | 'error'

interface TranslateProps {
  /** 'en' → show EN→中 pip; 'zh' → hide pip (translate to English still works
   *  via ⌥T but the toolbar headline focuses on the most common direction). */
  langIsEn: boolean
  status: TranslateStatus
  onToggle: () => void
}

export interface WriteActionState {
  /** Disable + show spinner while the IPC round-trip is in flight. */
  pending: boolean
}

interface ToolbarProps {
  translate?: TranslateProps

  // Sprint 5 §2.2 — write action callbacks. Each is optional so a screen
  // that doesn't expose the corresponding write (search-results modal,
  // batch-only views) just hides the button.
  onCreateDraft?: () => void
  draftState?: WriteActionState

  onResync?: (opts: { dryRun: boolean }) => void
  resyncState?: WriteActionState

  onLlmRun?: () => void
  llmRunState?: WriteActionState

  onToggleRead?: () => void
  isRead?: boolean
  readState?: WriteActionState

  onToggleFlag?: () => void
  isFlagged?: boolean
  flagState?: WriteActionState

  /** Optional URL for the "Notion" link on the right edge. */
  notionUrl?: string | null

  /** Wire-driven prev/next. EmailDetail keeps the list-state — toolbar
   *  just relays. */
  onPrev?: () => void
  onNext?: () => void
}

function Divider(): React.ReactElement {
  return <div className="w-px h-5 bg-ink-border mx-1 shrink-0" aria-hidden />
}

interface GhostProps {
  icon: React.ReactNode
  children?: React.ReactNode
  title?: string
  /** Accessible name for the icon-only button. Required for a11y when
   *  `children` is omitted; falls back to `children` (rendered text) when
   *  not provided. */
  ariaLabel?: string
  active?: boolean
  pending?: boolean
  disabled?: boolean
  onClick?: () => void
}

function Ghost({
  icon,
  children,
  title,
  ariaLabel,
  active,
  pending,
  disabled,
  onClick
}: GhostProps): React.ReactElement {
  const isDisabled = disabled || pending || !onClick
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
        'transition-colors duration-fast',
        active ? 'text-urg' : 'text-ink-fg-1',
        'hover:text-ink-fg hover:bg-ink-4',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">
        {pending ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : icon}
      </span>
      {children && <span>{children}</span>}
    </button>
  )
}

interface IconOnlyProps {
  icon: React.ReactNode
  title?: string
  onClick?: () => void
}

function IconOnly({ icon, title, onClick }: IconOnlyProps): React.ReactElement {
  const isDisabled = !onClick
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      className={cn(
        'text-ink-fg-2 hover:text-ink-fg p-1.5 rounded transition-colors duration-fast hover:bg-ink-4',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent'
      )}
    >
      {icon}
    </button>
  )
}

function TranslateButton({ langIsEn, status, onToggle }: TranslateProps): React.ReactElement {
  const { t } = useTranslation()
  const isError = status === 'error'
  const isLoading = status === 'loading'
  const isTranslated = status === 'translated'

  const label = isLoading
    ? t('translate.loading')
    : isError
      ? t('translate.failed')
      : isTranslated
        ? t('translate.showOriginal')
        : t('translate.label')

  // Sprint 10 user-acceptance — toolbar dropped all text labels (the row
  // overflowed at 1280px). Keep the EN→中 pip when targeting English
  // because the pip itself doubles as a status badge (direction signal).
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`⌥T · ${label}`}
      className={cn(
        'flex items-center gap-1 px-2 py-1.5 rounded-md text-aux',
        'transition-colors duration-fast',
        isError
          ? 'text-fail hover:bg-fail/10'
          : isTranslated
            ? 'text-coral bg-coral/10 hover:bg-coral/15'
            : 'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
        'disabled:opacity-60 disabled:cursor-not-allowed'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">
        <Languages size={13} strokeWidth={2} className={isLoading ? 'animate-spin' : undefined} />
      </span>
      {langIsEn && !isError && !isLoading && (
        <span
          className="lang-pip"
          style={{
            background: 'rgb(var(--c-accent) / 0.10)',
            borderColor: 'rgb(var(--c-accent) / 0.30)',
            color: 'rgb(var(--c-accent))'
          }}
        >
          EN→中
        </span>
      )}
    </button>
  )
}

interface ResyncConfirmProps {
  open: boolean
  onCancel: () => void
  onDry: () => void
  onPush: () => void
}

function ResyncConfirmDialog({
  open,
  onCancel,
  onDry,
  onPush
}: ResyncConfirmProps): React.ReactElement | null {
  const { t } = useTranslation()
  // Sprint 9 D4.1 (Sprint 7 review LOW #2 carry-forward) — shared focus-trap
  // hook replaces the inline querySelectorAll boundary handling. Behaviour
  // unchanged: cancel is the first focusable (initial focus target), Tab
  // wraps to the last; Shift-Tab cycles in reverse.
  const { dialogRef, handleTab } = useFocusTrap({ open })

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      handleTab(e)
    },
    [onCancel, handleTab]
  )

  if (!open) return null
  // Portal to document.body so the dialog's lifecycle is independent of
  // the toolbar mount tree. Plain `<dialog>` would clash with our coral
  // focus ring conventions; hand-rolled modal stays small + matches
  // DESIGN.md §5 dialog inset.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resync-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-[440px] rounded-lg bg-ink-2 border border-ink-border p-5',
          'shadow-[0_8px_24px_rgba(0,0,0,0.35)]'
        )}
      >
        <h2 id="resync-confirm-title" className="text-lead text-ink-fg font-semibold mb-2">
          {t('toolbarConfirm.resyncTitle')}
        </h2>
        <p className="text-aux text-ink-fg-1 mb-5 leading-relaxed">
          {t('toolbarConfirm.resyncBody')}
        </p>
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'px-3 py-1.5 rounded-md text-aux text-ink-fg-1',
              'hover:bg-ink-4 transition-colors duration-fast',
              'focus:outline-none focus:ring-2 focus:ring-coral/60'
            )}
          >
            {t('toolbarConfirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onDry}
            className={cn(
              'px-3 py-1.5 rounded-md text-aux',
              'text-ink-fg border border-ink-border',
              'hover:bg-ink-4 transition-colors duration-fast',
              'focus:outline-none focus:ring-2 focus:ring-coral/60'
            )}
          >
            {t('toolbarConfirm.resyncDry')}
          </button>
          <button
            type="button"
            onClick={onPush}
            className={cn(
              'px-3 py-1.5 rounded-md text-aux font-medium',
              'bg-coral/100 text-accent-fg hover:bg-coral-hover',
              'transition-colors duration-fast',
              'focus:outline-none focus:ring-2 focus:ring-accent-fg/40'
            )}
          >
            {t('toolbarConfirm.resyncReal')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Sprint 9 D4.1 — `FOCUSABLE_SELECTOR` lifted to `@shared/hooks/useFocusTrap`
// alongside the centralised trap logic. The selector constant lives there
// (exported) so any future modal can stay in lockstep.

// Sprint 10 user-acceptance — toolbar gained a toggle for the AI Chat
// panel since the panel itself is no longer always-mounted. Active state
// (coral fill) mirrors the zustand visible flag so users can see at a
// glance whether the panel is showing.
//
// Icon: Sparkles (same as draft CTA / AI tab) — one symbol for "AI-touched"
// actions across the toolbar so users learn the glyph once.
function AIPanelToggleButton(): React.ReactElement {
  const { t } = useTranslation()
  const visible = useAIChatPanel((s) => s.visible)
  return (
    <button
      type="button"
      onClick={toggleAIChatPanel}
      title={`⌘L · ${t('chat.title')}`}
      aria-pressed={visible}
      className={cn(
        'p-1.5 rounded transition-colors duration-fast',
        visible
          ? 'text-coral bg-coral/10 hover:bg-coral/15'
          : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
      )}
    >
      <Sparkles size={14} strokeWidth={2} className={visible ? 'fill-current' : ''} />
    </button>
  )
}

export function EmailToolbar({
  translate,
  onCreateDraft,
  draftState,
  onResync,
  resyncState,
  onLlmRun,
  llmRunState,
  onToggleRead,
  isRead,
  readState,
  onToggleFlag,
  isFlagged,
  flagState,
  notionUrl,
  onPrev,
  onNext
}: ToolbarProps = {}): React.ReactElement {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const openNotion = notionUrl
    ? (): void => {
        window.open(notionUrl, '_blank', 'noopener,noreferrer')
      }
    : undefined

  const handleResyncClick = (): void => {
    if (!onResync) return
    setConfirmOpen(true)
  }
  const dispatchResync = (dryRun: boolean): void => {
    setConfirmOpen(false)
    onResync?.({ dryRun })
  }

  const draftLabel = draftState?.pending ? t('toolbar.draftPending') : t('toolbar.draft')
  const resyncLabel = resyncState?.pending ? t('toolbar.resyncPending') : t('toolbar.resync')
  const llmLabel = llmRunState?.pending ? t('toolbar.llmRunPending') : t('toolbar.llmRun')
  const readLabel = isRead ? t('toolbar.markUnread') : t('toolbar.markRead')

  return (
    <header className="h-11 border-b border-ink-border bg-ink-3 flex items-center px-3 gap-1 shrink-0">
      <IconOnly
        icon={<ArrowLeft size={14} strokeWidth={2} />}
        title={`${t('toolbar.back')} (Esc)`}
      />
      <Divider />

      {/* Primary CTA — coral fill (DESIGN.md §2.2 "one CTA per surface").
          Sprint 10 user-acceptance — text label dropped to icon-only so
          the 11-button toolbar fits at 1280px column width. Tooltip carries
          "R · 起草回复" for discoverability. */}
      <button
        type="button"
        onClick={onCreateDraft}
        disabled={!onCreateDraft || draftState?.pending}
        title={`R · ${draftLabel}`}
        className={cn(
          'flex items-center justify-center w-8 h-8 rounded-md',
          'bg-coral/100 text-accent-fg',
          'hover:bg-coral-hover transition-colors duration-fast',
          'disabled:opacity-70 disabled:cursor-not-allowed'
        )}
      >
        {draftState?.pending ? (
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
        ) : (
          <Sparkles size={14} strokeWidth={2} className="fill-current" />
        )}
      </button>

      {translate && <TranslateButton {...translate} />}

      <Divider />

      <Ghost
        icon={<CheckCheck size={13} strokeWidth={2} />}
        title={`U · ${readLabel}`}
        ariaLabel={readLabel}
        active={isRead}
        pending={readState?.pending}
        onClick={onToggleRead}
      />
      <Ghost
        icon={<Star size={13} strokeWidth={1.5} className={isFlagged ? 'fill-current' : ''} />}
        title={`S · ${t('toolbar.toggleFlag')}`}
        ariaLabel={t('toolbar.toggleFlag')}
        active={isFlagged}
        pending={flagState?.pending}
        onClick={onToggleFlag}
      />
      <Ghost
        icon={<Archive size={13} strokeWidth={2} />}
        title={`E · ${t('toolbar.archive')}`}
        ariaLabel={t('toolbar.archive')}
      />

      <Divider />

      {/* Sprint 10 visual review L-1 — Resync + AI re-run dropped their
          labels to keep the toolbar from overflowing at 1280px width.
          Title tooltip preserves the verbal cue for discoverability. */}
      <Ghost
        icon={<RefreshCcw size={13} strokeWidth={2} />}
        title={resyncLabel}
        ariaLabel={resyncLabel}
        pending={resyncState?.pending}
        onClick={handleResyncClick}
      />
      <Ghost
        icon={<Zap size={13} strokeWidth={2} />}
        title={llmLabel}
        ariaLabel={llmLabel}
        pending={llmRunState?.pending}
        onClick={onLlmRun}
      />

      <div className="ml-auto flex items-center gap-1">
        <AIPanelToggleButton />
        <Ghost
          icon={<ExternalLink size={13} strokeWidth={2} />}
          title={t('toolbar.openNotion')}
          ariaLabel="Notion"
          onClick={openNotion}
        />
        <Divider />
        <IconOnly
          icon={<ChevronUp size={14} strokeWidth={2} />}
          title={`K · ${t('toolbar.prev')}`}
          onClick={onPrev}
        />
        <IconOnly
          icon={<ChevronDown size={14} strokeWidth={2} />}
          title={`J · ${t('toolbar.next')}`}
          onClick={onNext}
        />
        <IconOnly icon={<MoreHorizontal size={14} strokeWidth={2} />} title={t('toolbar.more')} />
      </div>

      <ResyncConfirmDialog
        open={confirmOpen}
        onCancel={(): void => setConfirmOpen(false)}
        onDry={(): void => dispatchResync(true)}
        onPush={(): void => dispatchResync(false)}
      />
    </header>
  )
}
