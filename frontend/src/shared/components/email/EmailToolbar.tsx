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
//   - Mark Read / Mark Flag — Sprint 15 D 块已切到 `mailApi.email.flag(...)`
//     (parent EmailDetail handles the call; this toolbar only emits
//     `onToggleRead` / `onToggleFlag` callbacks). SSoT inversion: writes
//     SQLite intent + outbox dual target, FanoutWorker async dispatch.
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
  RefreshCcw,
  Sparkles,
  Star,
  Zap
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { toggleAIChatPanel, useAIChatPanel } from '@shared/state/ai-chat-panel'
import type { ComposeMode } from '@shared/api/types'

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

  /** Compose — open the reply / reply-all / forward composer. When supplied,
   *  the primary CTA becomes a split button (label opens reply; the chevron
   *  opens a menu with all three modes). Falls back to `onCreateDraft` (the
   *  legacy AppleScript reply-all path) when this is not provided. */
  onOpenCompose?: (mode: ComposeMode) => void

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

  /** 归档收件箱邮件 (IMAP MOVE INBOX→Archive + Mailbox→存档). davmail-only —
   *  EmailDetail 在非 davmail 后端可不传, 按钮则保持禁用占位。 */
  onArchive?: () => void
  archiveState?: WriteActionState

  /** Sprint 13 — passive read-out from `email_metadata.is_important`
   *  (RFC header bit, see reader._parse_importance). No write path. */
  isImportant?: boolean

  notionUrl?: string | null

  onPrev?: () => void
  onNext?: () => void

  /** <lg 详情覆盖列表时的"返回列表"入口（清 activeId）。仅窄屏 EmailDetail
   *  传入；按钮自身 lg:hidden，≥lg 不渲染 → 桌面零回归。 */
  onBack?: () => void
}

// ─── Density observer ───────────────────────────────────────────────────

function useContainerDensity<T extends HTMLElement>(ref: React.RefObject<T | null>): Density {
  // Default 1280 covers the desktop ship target. The very first render
  // resolves to `wide` (most labels visible) — the effect below kicks in
  // immediately after mount and re-renders with the real width, so worst
  // case the user sees one paint with optimistic label visibility before
  // the layout settles. Better than reading ref.current during render
  // (React 19 lint rule + happy-dom Render Phase guard).
  const [width, setWidth] = useState<number>(1280)
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
        // active 态填充色走主题 accent (text-coral → --c-accent), 不再用固定
        // 语义色 text-urg (--c-urg 不随 accent 主题切换, 用户验收: 与 UI 规范不符)。
        active ? 'text-coral' : 'text-ink-fg-1',
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
  // Sprint 13 round 7 — switched from `bg-coral text-accent-fg` to the
  // dedicated CTA tokens (`--c-cta-bg` + `--c-cta-fg`, both in index.css).
  // User feedback: 起草回复 on a coral fill needed visible white text
  // + white icon (mockup-faithful). text-accent-fg (near-black) read as
  // muted. The CTA token uses the deeper accent stop so white fg still
  // clears AA on every accent swatch.
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      className={cn(
        'flex items-center justify-center rounded-md',
        padClass,
        'text-aux font-medium transition-colors duration-fast',
        'disabled:opacity-70 disabled:cursor-not-allowed',
        'btn-cta'
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

// ─── Compose split button — primary CTA + reply/reply-all/forward menu ──────

interface ComposeSplitProps {
  onOpenCompose: (mode: ComposeMode) => void
  showLabel: boolean
  pending?: boolean
}

function ComposeSplitButton({
  onOpenCompose,
  showLabel,
  pending
}: ComposeSplitProps): React.ReactElement {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape (mirrors the appearance popover pattern).
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const pick = (mode: ComposeMode): void => {
    setMenuOpen(false)
    onOpenCompose(mode)
  }

  const label = t('toolbar.reply')
  const items: { mode: ComposeMode; label: string; hint: string }[] = [
    { mode: 'reply', label: t('toolbar.reply'), hint: 'R' },
    { mode: 'reply-all', label: t('toolbar.replyAll'), hint: '⇧R' },
    { mode: 'forward', label: t('toolbar.forward'), hint: 'F' }
  ]

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <div className="flex items-stretch btn-cta rounded-md overflow-hidden">
        {/* Primary action — reply. */}
        <button
          type="button"
          onClick={() => pick('reply')}
          disabled={pending}
          aria-label={label}
          className={cn(
            'flex items-center justify-center text-aux font-medium',
            'transition-colors duration-fast disabled:opacity-70 disabled:cursor-not-allowed',
            showLabel ? 'gap-1.5 pl-3 pr-2 py-1.5' : 'w-8 h-8'
          )}
        >
          <span className="shrink-0 grid place-items-center w-[14px] h-[14px]">
            {pending ? (
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
            ) : (
              <Sparkles size={14} strokeWidth={2} className="fill-current" />
            )}
          </span>
          {showLabel && <span className="whitespace-nowrap">{label}</span>}
        </button>
        {/* Split chevron — opens the mode menu. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={pending}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('toolbar.composeMenu')}
          className={cn(
            'flex items-center justify-center px-1.5',
            'border-l border-white/20 transition-colors duration-fast',
            'disabled:opacity-70 disabled:cursor-not-allowed'
          )}
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
      </div>

      {menuOpen && (
        <div
          role="menu"
          className={cn(
            'absolute left-0 top-full mt-1 z-50 min-w-[160px]',
            // 实心 bg-ink-2 (对齐 ResyncConfirmDialog 弹层底色): glass-pop 的
            // ink-2/0.82 半透明会透出底下标题/正文, 下拉菜单观感发脏 — 菜单是
            // 功能性弹层不是装饰玻璃, 用实心底保证可读.
            'rounded-md bg-ink-2 border border-ink-border-soft py-1',
            'shadow-[0_8px_24px_rgba(0,0,0,0.35)]'
          )}
        >
          {items.map((it) => (
            <button
              key={it.mode}
              type="button"
              role="menuitem"
              onClick={() => pick(it.mode)}
              className={cn(
                'w-full flex items-center justify-between gap-3 px-3 py-1.5 text-aux',
                'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast'
              )}
            >
              <span className="whitespace-nowrap">{it.label}</span>
              <kbd className="text-[10px]">{it.hint}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface IconOnlyBtnProps {
  icon: React.ReactNode
  label: string
  active?: boolean
  pressed?: boolean
  onClick?: () => void
}

function IconOnlyBtn({
  icon,
  label,
  active,
  pressed,
  onClick
}: IconOnlyBtnProps): React.ReactElement {
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
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]'
  })

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

  if (!shouldRender) return null
  return createPortal(
    <div
      ref={scopeRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="resync-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        data-anim-card
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
  onOpenCompose,
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
  onArchive,
  archiveState,
  isImportant,
  notionUrl,
  onPrev,
  onNext,
  onBack
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
      // mockup col3: detail header 不带自己的背景, 直接坐在 <main> 的 .glass-3
      // (ink-3/0.55 + blur) 玻璃面上, 只用 border-b 分隔 → toolbar 与正文是同一块
      // 连续玻璃. 之前套 .glass-2 (ink-2/0.45) 自带一层更深的玻璃, 比正文 (ink-3)
      // 低一个 ink 档, toolbar 就成了一条灰色块, 跟上方 TitleBar / 下方正文衔接不上.
      // 现在透明化, 由 <main> 的 glass-3 透上来.
      //
      // relative z-[15]: position:relative + 正 z-index 自成 stacking context
      // (无需 backdrop-filter), 让 reply 下拉 (top-full z-50) 和 HoverTip 向下溢出
      // 时画在 sticky 标题 (z-10) 之上、compose overlay (z-20) 之下.
      // pl-8 (= 正文 px-8 的 32px) 让首个按钮 (回复 CTA) 左边缘与下方标题/正文左起点
      // 对齐; 右侧 pr-3 不变 (右端 nav/AI 按钮维持原边距)。
      className={cn(
        'relative z-[15] h-11 border-b border-ink-border-soft flex items-center pr-3 gap-1 shrink-0',
        // <lg 返回按钮占左侧 → pl 收窄；≥lg 无返回按钮 → pl-8 对齐正文起点。
        onBack ? 'pl-2 lg:pl-8' : 'pl-8'
      )}
    >
      {/* <lg 返回列表 — 详情覆盖态的返回入口（EmailDetail 主分支传 onBack）。
          lg:hidden 在桌面三栏并排时收起 → 零回归。 */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={t('toolbar.backToList', { defaultValue: '返回列表' })}
          className="lg:hidden shrink-0 p-1.5 -ml-0.5 mr-0.5 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
      )}
      {/* Primary CTA — DESIGN.md §2.2 "one CTA per surface". Sprint 13:
          the label flips on at medium density so the headline action stays
          self-explanatory even when secondary buttons collapse to icons.
          Compose: when onOpenCompose is wired the CTA becomes a split button
          (reply / reply-all / forward); otherwise it stays the legacy
          AppleScript reply-all draft button (onCreateDraft). */}
      {onOpenCompose ? (
        <ComposeSplitButton
          onOpenCompose={onOpenCompose}
          showLabel={wantsPrimaryLabel}
          pending={draftState?.pending}
        />
      ) : (
        <PrimaryBtn
          icon={<Sparkles size={14} strokeWidth={2} className="fill-current" />}
          label={draftLabel}
          showLabel={wantsPrimaryLabel}
          hoverHint={`${draftLabel} · R`}
          pending={draftState?.pending}
          onClick={onCreateDraft}
        />
      )}

      {translate && <TranslateButton {...translate} showLabel={wantsLabels} />}

      <Divider />

      {/* Mark Read / Mark Flag — Sprint 15 D 块: parent EmailDetail's
          handleToggleRead / handleToggleFlag now call `mailApi.email.flag()`
          (SSoT inversion: SQLite intent + outbox dual fanout). */}
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

      {/* Archive — IMAP MOVE INBOX→Archive via `mailagent email archive`
          (davmail-only). onArchive 未接 (非 davmail 后端) 时 GhostBtn 因 !onClick
          自动禁用, hoverHint 解释 davmail 限制, 用户不会以为按钮坏了。 */}
      <GhostBtn
        icon={<Archive size={13} strokeWidth={2} />}
        label={t('toolbar.archive')}
        showLabel={wantsLabels}
        hoverHint={onArchive ? t('toolbar.archive') : t('toolbar.archiveBlocked')}
        pending={archiveState?.pending}
        onClick={onArchive}
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

      {/* Right cluster: Open Notion · Divider · Prev · Next · Divider · AIPanelToggle.
          AIPanelToggle sits at the **very right** because it's the "open
          right panel" affordance — visually anchored to the panel it
          controls. Sprint 13 user feedback: previous order (Toggle first)
          read like a primary action rather than the panel handle.
          (旧 mockup 的 ← 返回 / ⋯ 更多 占位按钮已移除: 3 栏常驻布局里"返回"无语义,
          "更多"无菜单内容 — 等有真实次要操作时再以溢出菜单引入。) */}
      <div className="ml-auto flex items-center gap-1">
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
        <Divider />
        <AIPanelToggleButton />
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
