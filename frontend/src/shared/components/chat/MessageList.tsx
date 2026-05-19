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
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'
import type { ChatMessage } from '@shared/api/types'

interface Props {
  messages: ReadonlyArray<ChatMessage>
  streamingMessageId: number | null
  /** Surface area for the "regenerate" button on the last assistant message. */
  onRegenerate?: () => void
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
  const dotColor =
    status === 'running' ? 'bg-urg animate-pulse' : status === 'error' ? 'bg-fail' : 'bg-ok'
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 px-2 py-0.5 rounded',
        'text-micro font-mono text-ink-fg-2 bg-ink-4/50'
      )}
      title={payload.detail ?? undefined}
    >
      <span
        className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColor)}
        aria-label={statusLabel}
      />
      <span className="text-info">→</span>
      <span>{payload.name ?? 'tool'}</span>
      {payload.durationMs !== undefined && (
        <span className="text-ink-fg-3">· {formatMs(payload.durationMs)}</span>
      )}
    </div>
  )
}

function DraftPreviewCard({
  content,
  recipient
}: {
  content: string
  recipient?: string | null
}): React.ReactElement {
  const { t } = useTranslation()
  // Strip the DRAFT REPLY header before piping into TranslatedBody so the
  // marker only shows in the card chrome, not twice.
  const body = content
    .replace(DRAFT_REPLY_MARKER, '')
    .replace(/^[#:\s]+/m, '')
    .trim()
  return (
    <div
      className={cn(
        'rounded-md overflow-hidden my-2',
        'border border-coral/30 ring-2 ring-coral/5'
      )}
    >
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

      {/* Footer — coral primary action + secondary text buttons */}
      <div
        className={cn(
          'px-3 py-2 border-t border-ink-border-soft bg-ink-2/40',
          'flex items-center gap-2'
        )}
      >
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded',
            'text-aux text-accent-fg bg-coral/100 hover:bg-coral-hover',
            'transition-colors duration-fast'
          )}
        >
          <Send size={11} strokeWidth={2.5} />
          {t('chat.draftReply.send')}
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1.5 rounded text-aux',
            'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
            'transition-colors duration-fast'
          )}
        >
          <RotateCcw size={11} strokeWidth={2} />
          {t('chat.draftReply.regenerate')}
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center px-2 py-1.5 rounded text-aux',
            'text-ink-fg-1 hover:text-ink-fg hover:bg-ink-4',
            'transition-colors duration-fast'
          )}
        >
          {t('chat.draftReply.edit')}
        </button>
        <button
          type="button"
          aria-label={t('chat.draftReply.openInWindow')}
          title={t('chat.draftReply.openInWindow')}
          className={cn(
            'ml-auto inline-flex items-center px-2 py-1.5 rounded text-aux',
            'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4',
            'transition-colors duration-fast'
          )}
        >
          <ExternalLink size={11} strokeWidth={2} />
        </button>
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
  isStreaming
}: {
  message: ChatMessage
  isStreaming: boolean
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

  // Optional metadata header (mockup lines 1171-1175). Only renders when a
  // backend supplies model/cost — V1 dispatcher doesn't populate this yet,
  // so the guard is `((m as any).metadata?.model)` and we silently skip
  // when missing.
  const meta = (
    message as unknown as { metadata?: { model?: string; cost?: string; duration?: string } }
  ).metadata
  const showHeader = Boolean(meta?.model)

  if (DRAFT_REPLY_MARKER.test(message.content)) {
    return (
      <div className="space-y-2">
        {showHeader && meta?.model && (
          <div className="flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
            <Sparkles size={11} strokeWidth={0} className="fill-coral text-coral" />
            <span>{meta.model}</span>
            {meta.duration && <span className="text-ink-fg-3">· {meta.duration}</span>}
            {meta.cost && <span className="text-ink-fg-3">· {meta.cost}</span>}
          </div>
        )}
        <DraftPreviewCard content={message.content} />
        {!isStreaming && <AssistantMessageFooter />}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {showHeader && meta?.model && (
        <div className="flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
          <Sparkles size={11} strokeWidth={0} className="fill-coral text-coral" />
          <span>{meta.model}</span>
          {meta.duration && <span className="text-ink-fg-3">· {meta.duration}</span>}
          {meta.cost && <span className="text-ink-fg-3">· {meta.cost}</span>}
        </div>
      )}
      <div className="text-body text-ink-fg leading-relaxed">
        <TranslatedBody text={message.content || ' '} />
        {isStreaming && (
          <span className="inline-block ml-0.5 w-1.5 h-3.5 -mb-0.5 bg-coral/60 animate-pulse" />
        )}
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

export function MessageList({ messages, streamingMessageId }: Props): React.ReactElement {
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
          <AssistantBubble message={m} isStreaming={m.id === streamingMessageId} />
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
      rendered.push(
        <div key={m.id} className="px-3 py-2 text-center">
          <span className={cn(dividerKlass, 'text-ink-fg-3')}>{m.content}</span>
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
