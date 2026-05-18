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

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  active?: boolean
  pending?: boolean
  disabled?: boolean
  onClick?: () => void
}

function Ghost({
  icon,
  children,
  title,
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

  return (
    <button
      type="button"
      onClick={onToggle}
      title={`⌥T · ${label}`}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
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
      <span className="flex items-center gap-1">
        {label}
        {langIsEn && !isError && !isLoading && (
          <span
            className="lang-pip ml-0.5"
            style={{
              background: 'rgb(var(--c-accent) / 0.10)',
              borderColor: 'rgb(var(--c-accent) / 0.30)',
              color: 'rgb(var(--c-accent))'
            }}
          >
            EN→中
          </span>
        )}
      </span>
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
  if (!open) return null
  // Plain `<dialog>` would clash with our coral focus ring conventions;
  // hand-rolled modal stays small + matches DESIGN.md §5 dialog inset.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resync-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
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
              'hover:bg-ink-4 transition-colors duration-fast'
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
              'hover:bg-ink-4 transition-colors duration-fast'
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
              'transition-colors duration-fast'
            )}
          >
            {t('toolbarConfirm.resyncReal')}
          </button>
        </div>
      </div>
    </div>
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
    <header className="h-[48px] border-b border-ink-border bg-ink-3 flex items-center px-3 gap-1 shrink-0">
      <IconOnly
        icon={<ArrowLeft size={14} strokeWidth={2} />}
        title={`${t('toolbar.back')} (Esc)`}
      />
      <Divider />

      {/* Primary CTA — coral fill (DESIGN.md §2.2 "one CTA per surface"). */}
      <button
        type="button"
        onClick={onCreateDraft}
        disabled={!onCreateDraft || draftState?.pending}
        title={`R · ${draftLabel}`}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
          'bg-coral/100 text-accent-fg text-aux font-medium',
          'hover:bg-coral-hover transition-colors duration-fast',
          'disabled:opacity-70 disabled:cursor-not-allowed'
        )}
      >
        {draftState?.pending ? (
          <Loader2 size={13} strokeWidth={2} className="animate-spin" />
        ) : (
          <Sparkles size={13} strokeWidth={2} className="fill-current" />
        )}
        <span>{draftLabel}</span>
      </button>

      {translate && <TranslateButton {...translate} />}

      <Divider />

      <Ghost
        icon={<CheckCheck size={13} strokeWidth={2} />}
        title={`U · ${readLabel}`}
        active={isRead}
        pending={readState?.pending}
        onClick={onToggleRead}
      >
        {readLabel}
      </Ghost>
      <Ghost
        icon={<Star size={13} strokeWidth={1.5} className={isFlagged ? 'fill-current' : ''} />}
        title={`S · ${t('toolbar.toggleFlag')}`}
        active={isFlagged}
        pending={flagState?.pending}
        onClick={onToggleFlag}
      >
        {t('toolbar.toggleFlag')}
      </Ghost>
      <Ghost icon={<Archive size={13} strokeWidth={2} />} title={`E · ${t('toolbar.archive')}`}>
        {t('toolbar.archive')}
      </Ghost>

      <Divider />

      <Ghost
        icon={<RefreshCcw size={13} strokeWidth={2} />}
        title={resyncLabel}
        pending={resyncState?.pending}
        onClick={handleResyncClick}
      >
        {resyncLabel}
      </Ghost>
      <Ghost
        icon={<Zap size={13} strokeWidth={2} />}
        title={llmLabel}
        pending={llmRunState?.pending}
        onClick={onLlmRun}
      >
        {llmLabel}
      </Ghost>

      <div className="ml-auto flex items-center gap-1">
        <Ghost
          icon={<ExternalLink size={13} strokeWidth={2} />}
          title={t('toolbar.openNotion')}
          onClick={openNotion}
        >
          Notion
        </Ghost>
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
