// Sprint 4 §6 — chat message list. Renders user / assistant / tool / system
// rows per DESIGN.md §6.2-§6.5. Inlines the bubble + tool-row + draft-card
// components since none of them are reused outside the panel.
//
// V1 redesign (Sprint 10 polish): DraftPreviewCard adopts the mockup's
// three-section shape (mockup-inbox.html lines 1278-1304): mono header
// strip with recipient, body region, footer button row with bg tints —
// far more visual weight than a single bordered <div> can carry.
// Assistant messages additionally render a per-message footer row
// (regenerate / copy / 转 Notion) per DESIGN.md §6.2.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Copy, ExternalLink, Loader2, RotateCcw, Send, Sparkles, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { toastSuccess } from '@shared/state/toast'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'
import type { ChatMessage } from '@shared/api/types'

/** Sprint 13 — DraftPreviewCard action wiring. AIChatPanel injects real
 *  handlers; if a panel doesn't (e.g. read-only conversation viewer), the
 *  card renders the buttons as data-disabled with a HoverTip explaining
 *  why (matches DESIGN.md §9.4 disabled treatment). */
export interface DraftHandlers {
  /** Open a Mail.app reply draft populated with `body`. AIChatPanel wires
   *  this to `mailApi.email.createDraft({ internalId, body })`. */
  onSend?: (body: string) => void | Promise<void>
  /** Re-fire the last user prompt that produced this draft. AIChatPanel
   *  wires this to `chat.retryLast` when available; null disables the
   *  button + surfaces the `chat.draftReply.toast.regenPending` hint. */
  onRegenerate?: (() => void | Promise<void>) | null
  /** Inline editor — Sprint 14 placeholder. Toast TODO until wired. */
  onEdit?: () => void
  /** Popout window — Sprint 14 decision. Toast TODO until wired. */
  onOpenInWindow?: () => void
  /** Disable send + show spinner during the IPC round-trip. */
  isSending?: boolean
  /** "to: …" header recipient. AIChatPanel resolves from email.to_addr or
   *  the parsed `from` (reply-to). */
  recipient?: string | null
}

interface Props {
  messages: ReadonlyArray<ChatMessage>
  streamingMessageId: number | null
  /** Surface area for the "regenerate" button on the last assistant message. */
  onRegenerate?: () => void
  /** Sprint 13 — wired by AIChatPanel; flows down to DraftPreviewCard. */
  draftHandlers?: DraftHandlers
}

const DRAFT_REPLY_MARKER = /^\s*(?:#+\s*)?DRAFT REPLY\b/i

interface ToolPayload {
  name?: string
  args?: unknown
  status?: 'running' | 'ok' | 'error'
  durationMs?: number
  detail?: string
}

function parseToolContent(content: string): ToolPayload | null {
  try {
    return JSON.parse(content) as ToolPayload
  } catch {
    return null
  }
}

function formatMs(ms: number | undefined): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ToolCallRow({ payload }: { payload: ToolPayload }): React.ReactElement {
  const { t } = useTranslation()
  const status = payload.status ?? 'ok'
  const statusLabel = t(`chat.toolCall.${status}`)
  const dotKlass = status === 'running' ? 'dot-run' : status === 'error' ? 'dot-err' : 'dot-ok'
  // Sprint 12 — use the authored .ai-tool-row recipe in index.css so the
  // monospace pill matches mockup-inbox.html lines 2360-2380 verbatim.
  return (
    <div className="ai-tool-row" title={payload.detail ?? undefined}>
      <span className={dotKlass} aria-label={statusLabel} />
      <span className="arrow">→</span>
      <span>{payload.name ?? 'tool'}</span>
      {payload.durationMs !== undefined && (
        <span className="text-ink-fg-3">· {formatMs(payload.durationMs)}</span>
      )}
    </div>
  )
}

function DraftPreviewCard({
  content,
  recipient,
  handlers,
  isStreaming
}: {
  content: string
  recipient?: string | null
  handlers?: DraftHandlers
  /** True while the assistant message is still streaming chunks; send is
   *  blocked until the draft body settles to avoid creating a partial draft. */
  isStreaming: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  // Strip the DRAFT REPLY header before piping into TranslatedBody so the
  // marker only shows in the card chrome, not twice.
  const body = content
    .replace(DRAFT_REPLY_MARKER, '')
    .replace(/^[#:\s]+/m, '')
    .trim()

  const onSend = handlers?.onSend
  const onRegenerate = handlers?.onRegenerate
  const onEdit = handlers?.onEdit
  const onOpenInWindow = handlers?.onOpenInWindow
  const isSending = handlers?.isSending === true

  // Send is only enabled once the stream finishes (otherwise the draft body
  // would be truncated mid-sentence). Backend has no partial-send semantics.
  const sendDisabled = !onSend || isStreaming || isSending || body.length === 0
  // Regenerate piggybacks on chat.retryLast — if that's null (no failed
  // input on file, or no chat instance), surface a HoverTip explanation.
  const regenDisabled = !onRegenerate || isStreaming || isSending
  // Edit + popout currently surface "coming in Sprint 14" toasts. The
  // buttons still render so the layout matches the mockup; HoverTip
  // explains why they're informational only.
  const editTipKey = onEdit ? 'chat.draftReply.edit' : 'chat.draftReply.toast.editPending'
  const popoutTipKey = onOpenInWindow
    ? 'chat.draftReply.openInWindow'
    : 'chat.draftReply.toast.popoutPending'
  const regenTipKey = regenDisabled
    ? 'chat.draftReply.toast.regenPending'
    : 'chat.draftReply.regenerate'
  const sendTipKey = isStreaming
    ? 'chat.status.streaming'
    : isSending
      ? 'chat.draftReply.sending'
      : !onSend
        ? 'chat.draftReply.toast.sendFailNoBin'
        : 'chat.draftReply.send'

  // Sprint 12 — .draft-card recipe (coral ring + faint glow + glass bg)
  // lives in index.css so the chrome reads as the AI's headline output.
  return (
    <div className="draft-card my-2">
      {/* Header — mono "DRAFT REPLY" caption + recipient */}
      <div
        className={cn(
          'px-3 py-2 border-b border-ink-border-soft bg-ink-2/40',
          'flex items-center justify-between'
        )}
      >
        <div className="flex items-center gap-1.5">
          <Sparkles size={11} strokeWidth={0} className="fill-coral text-coral" />
          <span className="text-meta font-mono uppercase tracking-wider text-ink-fg-1">
            {/* mockup hard-codes EN "Draft Reply" — keep the chrome caption
                English-mono regardless of locale so the 12px floor is on-spec */}
            DRAFT REPLY
          </span>
        </div>
        <span className="text-meta font-mono text-ink-fg-2 truncate max-w-[180px]">
          {recipient ? `to: ${recipient}` : 'to: —'}
        </span>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 text-aux text-ink-fg space-y-2 bg-ink-3">
        <TranslatedBody text={body} />
      </div>

      {/* Footer — coral primary action + secondary text buttons. Each button
          is HoverTip-wrapped so the disabled-reason or shortcut is always
          one cursor-rest away. */}
      <div
        className={cn(
          'px-3 py-2 border-t border-ink-border-soft bg-ink-2/40',
          'flex items-center gap-2'
        )}
      >
        <HoverTip text={t(sendTipKey)} side="top">
          <button
            type="button"
            onClick={onSend ? () => void onSend(body) : undefined}
            disabled={sendDisabled}
            aria-label={t('chat.draftReply.send')}
            data-disabled={sendDisabled ? '' : undefined}
            tabIndex={sendDisabled ? -1 : 0}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded',
              'text-aux text-accent-fg bg-coral/100 hover:bg-coral-hover',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {isSending ? (
              <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />
            ) : (
              <Send size={11} strokeWidth={2.5} />
            )}
            {isSending ? t('chat.draftReply.sending') : t('chat.draftReply.send')}
          </button>
        </HoverTip>

        <HoverTip text={t(regenTipKey)} side="top">
          <button
            type="button"
            onClick={onRegenerate ? () => void onRegenerate() : undefined}
            disabled={regenDisabled}
            aria-label={t('chat.draftReply.regenerate')}
            data-disabled={regenDisabled ? '' : undefined}
            tabIndex={regenDisabled ? -1 : 0}
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-aux',
              'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
            )}
          >
            <RotateCcw size={11} strokeWidth={2} />
            {t('chat.draftReply.regenerate')}
          </button>
        </HoverTip>

        <HoverTip text={t(editTipKey)} side="top">
          <button
            type="button"
            onClick={onEdit ?? undefined}
            disabled={!onEdit}
            aria-label={t('chat.draftReply.edit')}
            data-disabled={!onEdit ? '' : undefined}
            tabIndex={!onEdit ? -1 : 0}
            className={cn(
              'inline-flex items-center px-2 py-1.5 rounded text-aux',
              'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-1'
            )}
          >
            {t('chat.draftReply.edit')}
          </button>
        </HoverTip>

        <HoverTip text={t(popoutTipKey)} side="top" className="ml-auto">
          <button
            type="button"
            onClick={onOpenInWindow ?? undefined}
            disabled={!onOpenInWindow}
            aria-label={t('chat.draftReply.openInWindow')}
            data-disabled={!onOpenInWindow ? '' : undefined}
            tabIndex={!onOpenInWindow ? -1 : 0}
            className={cn(
              'inline-flex items-center px-2 py-1.5 rounded text-aux',
              'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4',
              'transition-colors duration-fast',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-fg-2'
            )}
          >
            <ExternalLink size={11} strokeWidth={2} />
          </button>
        </HoverTip>
      </div>
    </div>
  )
}

function UserBubble({ content }: { content: string }): React.ReactElement {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          'max-w-[85%] rounded-lg rounded-br-sm px-3 py-2',
          'bg-ink-4 text-ink-fg text-body whitespace-pre-wrap break-words leading-snug'
        )}
      >
        {content}
      </div>
    </div>
  )
}

function AssistantMessageFooter(): React.ReactElement {
  const { t } = useTranslation()
  // V1 placeholders — IPC wiring lands in V1.5. Each button toasts "即将上线".
  const soon = (): void => {
    toastSuccess(t('shortcutHelp.soon'))
  }
  return (
    <div className="flex items-center gap-2 pt-1 text-meta font-mono text-ink-fg-2">
      <button
        type="button"
        onClick={soon}
        className="inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast"
      >
        <RotateCcw size={11} strokeWidth={2} />
        {t('chat.draftReply.regenerate')}
      </button>
      <span className="text-ink-fg-3">·</span>
      <button
        type="button"
        onClick={soon}
        className="inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast"
      >
        <Copy size={11} strokeWidth={2} />
        {t('chat.messageActions.copy')}
      </button>
      <span className="text-ink-fg-3">·</span>
      <button
        type="button"
        onClick={soon}
        className="inline-flex items-center gap-1 hover:text-ink-fg transition-colors duration-fast"
      >
        <Bookmark size={11} strokeWidth={2} />
        {t('chat.messageActions.toNotion')}
      </button>
    </div>
  )
}

function AssistantBubble({
  message,
  isStreaming,
  draftHandlers
}: {
  message: ChatMessage
  isStreaming: boolean
  draftHandlers?: DraftHandlers
}): React.ReactElement {
  const { t } = useTranslation()
  // Empty + streaming: render the thinking pulse instead of an empty bubble.
  if (message.content.length === 0 && isStreaming) {
    return (
      <div className="flex items-center gap-2 py-1 text-aux text-ink-fg-2">
        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
        <span>{t('chat.status.thinking')}</span>
      </div>
    )
  }
  if (message.status === 'error') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md p-3',
          'border border-fail/30 bg-fail/10 text-aux text-fail'
        )}
      >
        <X size={13} strokeWidth={2} className="shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium">{t('chat.status.error')}</div>
          {message.error_message && (
            <div className="text-meta font-mono text-ink-fg-3 mt-1">{message.error_message}</div>
          )}
        </div>
      </div>
    )
  }

  // Sprint 13 fix — header reads real ChatMessage fields (model / cost_usd /
  // token counts) instead of a stale `metadata.model` object that was never
  // populated. mockup L2351-2357 + L2447-2452: "Notion Agent · Jarvis · 2.4s
  // · $0.0034" / "Notion Agent · drafting…  ·  1.1s · streaming".
  const model = message.model
  const costUsd = message.cost_usd
  const totalTokens =
    (message.tokens_input ?? 0) + (message.tokens_output ?? 0) > 0
      ? (message.tokens_input ?? 0) + (message.tokens_output ?? 0)
      : null
  const showHeader = Boolean(model || isStreaming)
  const headerMeta = (
    <>
      <Sparkles
        size={11}
        strokeWidth={isStreaming ? 2.5 : 0}
        className={cn('text-coral shrink-0', isStreaming ? 'animate-spin' : 'fill-coral')}
      />
      <span>{isStreaming ? t('chat.status.streaming') : (model ?? 'AI')}</span>
      {totalTokens !== null && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="tabular-nums">{totalTokens.toLocaleString()}t</span>
        </>
      )}
      {costUsd !== null && costUsd > 0 && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="tabular-nums">${costUsd.toFixed(4)}</span>
        </>
      )}
    </>
  )

  if (DRAFT_REPLY_MARKER.test(message.content)) {
    return (
      <div className="space-y-2">
        {showHeader && (
          <div className="flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
            {headerMeta}
          </div>
        )}
        <DraftPreviewCard
          content={message.content}
          recipient={draftHandlers?.recipient ?? null}
          handlers={draftHandlers}
          isStreaming={isStreaming}
        />
        {!isStreaming && <AssistantMessageFooter />}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {showHeader && (
        <div className="flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
          {headerMeta}
        </div>
      )}
      <div className="text-body text-ink-fg leading-relaxed">
        <TranslatedBody text={message.content || ' '} />
        {isStreaming && <span className="cursor-blink" aria-hidden />}
      </div>
      {!isStreaming && <AssistantMessageFooter />}
    </div>
  )
}

// Long-thread truncation cap. The dispatcher feeds the full message
// history to the backend (so multi-turn context is preserved), but the
// renderer only paints the last N — anything older becomes a system
// divider "已截断早期 X 条" / "earlier X truncated" pill. Sprint 4
// state machine #1 (REVIEW-LOG C-04 carry-forward).
const MAX_RENDERED_MESSAGES = 40

/** Distance from the bottom edge (px) at which we still consider the user
 *  "reading the latest" — within this band a new chunk will auto-scroll;
 *  past it (user scrolled up to re-read) we leave them alone. Sprint 4
 *  review (opus L carry-forward). */
const AUTO_SCROLL_BAND_PX = 80

export function MessageList({
  messages,
  streamingMessageId,
  draftHandlers
}: Props): React.ReactElement {
  const { t } = useTranslation()
  // (opus M) CJK-safe class for the truncated / system divider strings —
  // both resolve to Chinese under zh-CN locale and would otherwise render
  // at the 11px mono floor that DESIGN.md §14 #2 forbids.
  const dividerKlass = useCjkMonoSwap('text-micro font-mono uppercase tracking-wider')
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom on new content — but only if the user is already
  // near the bottom. Otherwise an auto-scroll during streaming would
  // hijack manual reading of earlier turns.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distance > AUTO_SCROLL_BAND_PX) return
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages])

  const total = messages.length
  const truncated = Math.max(0, total - MAX_RENDERED_MESSAGES)
  // Sprint 4 review (codex low): the truncation divider itself counts
  // toward the visible cap — keep total rendered elements ≤ MAX_RENDERED_MESSAGES.
  const sliceSize = truncated > 0 ? MAX_RENDERED_MESSAGES - 1 : MAX_RENDERED_MESSAGES
  const visible = total > sliceSize ? messages.slice(-sliceSize) : messages

  const rendered: React.ReactElement[] = []
  if (truncated > 0) {
    rendered.push(
      <div key="__truncated__" className="px-3 py-2 text-center">
        <span className={cn(dividerKlass, 'text-ink-fg-3')}>
          {t('chat.truncated', { n: truncated })}
        </span>
      </div>
    )
  }
  for (const m of visible) {
    if (m.role === 'user') {
      rendered.push(
        <div key={m.id} className="px-3">
          <UserBubble content={m.content} />
        </div>
      )
    } else if (m.role === 'assistant') {
      rendered.push(
        <div key={m.id} className="px-3">
          <AssistantBubble
            message={m}
            isStreaming={m.id === streamingMessageId}
            draftHandlers={draftHandlers}
          />
        </div>
      )
    } else if (m.role === 'tool') {
      const payload = parseToolContent(m.content)
      if (payload) {
        rendered.push(
          <div key={m.id} className="px-3">
            <ToolCallRow payload={payload} />
          </div>
        )
      }
    } else if (m.role === 'system') {
      // Sprint 12 — flanked-hairline divider per mockup-inbox.html line 2337.
      rendered.push(
        <div key={m.id} className="px-3 py-1 flex items-center gap-2">
          <div className="flex-1 h-px bg-ink-border-soft" />
          <span className={cn(dividerKlass, 'text-ink-fg-3 shrink-0')}>{m.content}</span>
          <div className="flex-1 h-px bg-ink-border-soft" />
        </div>
      )
    }
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-3 py-3"
    >
      {rendered}
      <div ref={bottomRef} />
    </div>
  )
}
