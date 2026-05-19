// 48px detail toolbar — Sprint 13 adaptive density:
//
//   wide   (container >= 980px) — primary + secondary labels rendered inline
//   medium (container >= 740px) — only the primary CTA label, others icon-only
//   narrow (container <  740px) — all icon-only (mockup baseline)
//
// HoverTip (DESIGN.md §9.5) wraps every icon-only button so hover always
// reveals the verb, regardless of locale or density. When a label is
// already visible inline, the HoverTip is skipped to avoid double cues.
//
// Backend wiring status:
//   - Draft Reply / Translate / Resync / AI Re-run — real CLI/IPC paths
//   - Mark Read / Mark Flag — go through `mailApi.notion.updateFlag`,
//     marked DEPRECATED (NOTES.md 2026-05-19 strategic). Sprint 14 swaps
//     to `email.flag` once the SQLite SSoT fanout worker lands.
//   - Mark Important — no write path. Backend writes the bit from RFC
//     headers (Importance / X-Priority / X-MSMail-Priority). We render a
//     passive ❗ indicator when isImportant=true; clicking is not a thing.
//   - Archive — no `mailagent email archive` CLI yet. Button stays in
//     the layout (mockup placement) but is data-disabled + HoverTip
//     explains the gap (i18n key toolbar.archiveBlocked).

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
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
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { toggleAIChatPanel, useAIChatPanel } from '@shared/state/ai-chat-panel'

export type TranslateStatus = 'idle' | 'loading' | 'translated' | 'error'

type Density = 'wide' | 'medium' | 'narrow'

interface TranslateProps {
  /** 'en' → show EN→中 pip; 'zh' → hide pip. The pip doubles as a direction
   *  signal so it stays even when the text label is showing. */
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

  // Sprint 5 §2.2 — write action callbacks.
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

  /** Sprint 13 — passive read-out from `email_metadata.is_important`
   *  (RFC header bit, see reader._parse_importance). No write path. */
  isImportant?: boolean

  notionUrl?: string | null

  onPrev?: () => void
  onNext?: () => void
}

// ─── Density observer ───────────────────────────────────────────────────

function useContainerDensity<T extends HTMLElement>(
  ref: React.RefObject<T | null>
): Density {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 1280
    return ref.current?.getBoundingClientRect().width ?? 1280
  })
  useEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setWidth(e.contentRect.width)
      }
    })
    ro.observe(node)
    return (): void => ro.disconnect()
  }, [ref])
  if (width >= 980) return 'wide'
  if (width >= 740) return 'medium'
  return 'narrow'
}

// ─── Adaptive button primitives ─────────────────────────────────────────

function Divider(): React.ReactElement {
  return <div className="w-px h-5 bg-ink-border mx-1 shrink-0" aria-hidden />
}

interface GhostBtnProps {
  icon: React.ReactNode
  label: string
  /** When true, label renders inline next to the icon; HoverTip is skipped.
   *  When false, button is icon-only and HoverTip surfaces the label on hover. */
  showLabel: boolean
  /** Override the HoverTip text; defaults to `label`. Use to attach a shortcut
   *  hint (e.g. "U") or — when `disabled` — an explanation of the gap. */
  hoverHint?: string
  active?: boolean
  pending?: boolean
  disabled?: boolean
  /** Set for toggle semantics (Read / Flag). aria-pressed mirrors `active`. */
  pressed?: boolean
  onClick?: () => void
}

function GhostBtn({
  icon,
  label,
  showLabel,
  hoverHint,
  active,
  pending,
  disabled,
  pressed,
  onClick
}: GhostBtnProps): React.ReactElement {
  const isDisabled = disabled === true || pending === true || !onClick
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      aria-pressed={pressed === true ? true : pressed === false ? false : undefined}
      data-disabled={isDisabled ? '' : undefined}
      tabIndex={isDisabled ? -1 : 0}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-aux',
        'transition-colors duration-fast',
        active ? 'text-urg' : 'text-ink-fg-1',
        'hover:text-ink-fg hover:bg-ink-4',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[13px] h-[13px]">
        {pending ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : icon}
      </span>
      {showLabel && <span className="whitespace-nowrap">{label}</span>}
    </button>
  )
  // When label is hidden OR action is disabled (so user can see why), wrap
  // with HoverTip. When label is visible AND action is live, the label
  // itself is the cue — no tooltip needed.
  if (showLabel && !isDisabled) return btn
  return (
    <HoverTip text={hoverHint ?? label} side="bottom">
      {btn}
    </HoverTip>
  )
}

interface PrimaryBtnProps {
  icon: React.ReactNode
  label: string
  showLabel: boolean
  hoverHint?: string
  pending?: boolean
  disabled?: boolean
  onClick?: () => void
}

function PrimaryBtn({
  icon,
  label,
  showLabel,
  hoverHint,
  pending,
  disabled,
  onClick
}: PrimaryBtnProps): React.ReactElement {
  const isDisabled = disabled === true || pending === true || !onClick
  // Squared 8x8 chip when icon-only (matches mockup L2046) — width opens to
  // pill shape when label is visible.
  const padClass = showLabel ? 'gap-1.5 px-3 py-1.5' : 'w-8 h-8'
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      className={cn(
        'flex items-center justify-center rounded-md',
        padClass,
        'bg-coral/100 text-accent-fg text-aux font-medium',
        'hover:bg-coral-hover transition-colors duration-fast',
        'disabled:opacity-70 disabled:cursor-not-allowed'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[14px] h-[14px]">
        {pending ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : icon}
      </span>
      {showLabel && <span className="whitespace-nowrap">{label}</span>}
    </button>
  )
  if (showLabel) return btn
  return (
    <HoverTip text={hoverHint ?? label} side="bottom">
      {btn}
    </HoverTip>
  )
}

interface IconOnlyBtnProps {
  icon: React.ReactNode
  label: string
  active?: boolean
  pressed?: boolean
  onClick?: () => void
}

function IconOnlyBtn({ icon, label, active, pressed, onClick }: IconOnlyBtnProps): React.ReactElement {
  const isDisabled = !onClick
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      aria-pressed={pressed === true ? true : pressed === false ? false : undefined}
      data-disabled={isDisabled ? '' : undefined}
      tabIndex={isDisabled ? -1 : 0}
      className={cn(
        'p-1.5 rounded transition-colors duration-fast',
        active
          ? 'text-coral bg-coral/10 hover:bg-coral/15'
          : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent'
      )}
    >
      {icon}
    </button>
  )
  return (
    <HoverTip text={label} side="bottom">
      {btn}
    </HoverTip>
  )
}

// ─── Translate — keeps EN→中 pip + density-aware label ──────────────────

function TranslateButton({
  langIsEn,
  status,
  onToggle,
  showLabel
}: TranslateProps & { showLabel: boolean }): React.ReactElement {
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

  const btn = (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className={cn(
        'flex items-center gap-1 px-2 py-1.5 rounded-md text-aux',
        'transition-colors duration-fast',
        isError
          ? 'text-fail hover:bg-fail/10'
          : isTranslated
            ? 'text-coral bg-coral/10 hover:bg-coral/15'
            : 'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4'
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
      {showLabel && <span className="whitespace-nowrap">{label}</span>}
    </button>
  )
  if (showLabel) return btn
  return (
    <HoverTip text={`${label} · ⌥T`} side="bottom">
      {btn}
    </HoverTip>
  )
}

// ─── Resync Confirm Dialog (unchanged from Sprint 5) ─────────────────────

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

// ─── AI Panel Toggle ─────────────────────────────────────────────────────

function AIPanelToggleButton(): React.ReactElement {
  const { t } = useTranslation()
  const visible = useAIChatPanel((s) => s.visible)
  const label = `${t('chat.title')} · ⌘L`
  const btn = (
    <button
      type="button"
      onClick={toggleAIChatPanel}
      aria-pressed={visible}
      aria-label={label}
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
  return (
    <HoverTip text={label} side="bottom">
      {btn}
    </HoverTip>
  )
}

// ─── Root component ──────────────────────────────────────────────────────

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
  isImportant,
  notionUrl,
  onPrev,
  onNext
}: ToolbarProps = {}): React.ReactElement {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const containerRef = useRef<HTMLElement>(null)
  const density = useContainerDensity(containerRef)
  const wantsLabels = density === 'wide'
  const wantsPrimaryLabel = density !== 'narrow'

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
    <header
      ref={containerRef}
      className="h-11 border-b border-ink-border bg-ink-3 flex items-center px-3 gap-1 shrink-0"
    >
      <IconOnlyBtn icon={<ArrowLeft size={14} strokeWidth={2} />} label={`${t('toolbar.back')} · Esc`} />
      <Divider />

      {/* Primary CTA — DESIGN.md §2.2 "one CTA per surface". Sprint 13:
          the label flips on at medium density so the headline action stays
          self-explanatory even when secondary buttons collapse to icons. */}
      <PrimaryBtn
        icon={<Sparkles size={14} strokeWidth={2} className="fill-current" />}
        label={draftLabel}
        showLabel={wantsPrimaryLabel}
        hoverHint={`${draftLabel} · R`}
        pending={draftState?.pending}
        onClick={onCreateDraft}
      />

      {translate && <TranslateButton {...translate} showLabel={wantsLabels} />}

      <Divider />

      {/* Mark Read / Mark Flag — DEPRECATED path (NOTES.md 2026-05-19).
          notion.updateFlag → notion automation → Mail.app reverse sync.
          SQLite SSoT inversion Sprint will swap to email.flag(). */}
      <GhostBtn
        icon={<CheckCheck size={13} strokeWidth={2} />}
        label={readLabel}
        showLabel={wantsLabels}
        hoverHint={`${readLabel} · U`}
        active={isRead}
        pressed={isRead}
        pending={readState?.pending}
        onClick={onToggleRead}
      />
      <GhostBtn
        icon={<Star size={13} strokeWidth={1.5} className={isFlagged ? 'fill-current' : ''} />}
        label={t('toolbar.toggleFlag')}
        showLabel={wantsLabels}
        hoverHint={`${t('toolbar.toggleFlag')} · S`}
        active={isFlagged}
        pressed={isFlagged}
        pending={flagState?.pending}
        onClick={onToggleFlag}
      />

      {/* Mark Important — passive indicator. Source: RFC headers
          (Importance / X-Priority), already parsed into is_important by
          the reader. No write path; hover explains. Renders ONLY when true
          so the toolbar isn't padded for non-important mail. */}
      {isImportant === true && (
        <HoverTip text={t('toolbar.importantHint')} side="bottom">
          <span
            role="img"
            aria-label={t('toolbar.important')}
            data-disabled=""
            className="grid place-items-center w-7 h-7 rounded-md text-impt cursor-default"
          >
            <AlertCircle size={13} strokeWidth={2} />
          </span>
        </HoverTip>
      )}

      {/* Archive — no CLI yet. Stays in mockup layout but data-disabled
          + opacity-50; HoverTip surfaces the gap so users don't think the
          button is broken. */}
      <GhostBtn
        icon={<Archive size={13} strokeWidth={2} />}
        label={t('toolbar.archive')}
        showLabel={wantsLabels}
        hoverHint={t('toolbar.archiveBlocked')}
        disabled
      />

      <Divider />

      <GhostBtn
        icon={<RefreshCcw size={13} strokeWidth={2} />}
        label={resyncLabel}
        showLabel={wantsLabels}
        pending={resyncState?.pending}
        onClick={onResync ? handleResyncClick : undefined}
      />
      <GhostBtn
        icon={<Zap size={13} strokeWidth={2} />}
        label={llmLabel}
        showLabel={wantsLabels}
        pending={llmRunState?.pending}
        onClick={onLlmRun}
      />

      <div className="ml-auto flex items-center gap-1">
        <AIPanelToggleButton />
        <IconOnlyBtn
          icon={<ExternalLink size={13} strokeWidth={2} />}
          label={t('toolbar.openNotion')}
          onClick={openNotion}
        />
        <Divider />
        <IconOnlyBtn
          icon={<ChevronUp size={14} strokeWidth={2} />}
          label={`${t('toolbar.prev')} · K`}
          onClick={onPrev}
        />
        <IconOnlyBtn
          icon={<ChevronDown size={14} strokeWidth={2} />}
          label={`${t('toolbar.next')} · J`}
          onClick={onNext}
        />
        <IconOnlyBtn icon={<MoreHorizontal size={14} strokeWidth={2} />} label={t('toolbar.more')} />
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
