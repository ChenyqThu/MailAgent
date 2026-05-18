// Sprint 4 §6 — chat message list. Renders user / assistant / tool / system
// rows per DESIGN.md §6.2-§6.5. Inlines the bubble + tool-row + draft-card
// components since none of them are reused outside the panel.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, ExternalLink, Loader2, RotateCcw, Sparkles, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
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
      <span className="text-info">→</span>
      <span>{payload.name ?? 'tool'}</span>
      {payload.durationMs !== undefined && (
        <span className="text-ink-fg-3">· {formatMs(payload.durationMs)}</span>
      )}
      <span className={cn('w-1.5 h-1.5 rounded-full', dotColor)} aria-label={statusLabel} />
    </div>
  )
}

function DraftPreviewCard({ content }: { content: string }): React.ReactElement {
  const { t } = useTranslation()
  // Strip the DRAFT REPLY header before piping into TranslatedBody so the
  // marker only shows in the card chrome, not twice.
  const body = content
    .replace(DRAFT_REPLY_MARKER, '')
    .replace(/^[#:\s]+/m, '')
    .trim()
  return (
    <div
      className={cn('rounded-md p-3 my-2', 'border border-coral/30 ring-2 ring-coral/5 bg-ink-3')}
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={12} strokeWidth={2} className="text-coral" />
        <span className="text-micro font-mono uppercase tracking-wider text-coral font-medium">
          {t('chat.draftReply.header')}
        </span>
      </div>
      <TranslatedBody text={body} />
      <div className="mt-3 flex items-center gap-2 text-meta font-mono">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-coral/100 text-accent-fg hover:bg-coral-hover transition-colors duration-fast"
        >
          <CheckCheck size={11} strokeWidth={2} />
          {t('chat.draftReply.send')}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-ink-fg-1 hover:bg-ink-4 transition-colors duration-fast"
        >
          <RotateCcw size={11} strokeWidth={2} />
          {t('chat.draftReply.regenerate')}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-ink-fg-1 hover:bg-ink-4 transition-colors duration-fast"
        >
          {t('chat.draftReply.edit')}
        </button>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg-1 transition-colors duration-fast"
          aria-label={t('chat.draftReply.openInWindow')}
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
          'bg-ink-4 text-ink-fg text-body whitespace-pre-wrap break-words'
        )}
      >
        {content}
      </div>
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
  if (DRAFT_REPLY_MARKER.test(message.content)) {
    return <DraftPreviewCard content={message.content} />
  }
  return (
    <div className="text-body text-ink-fg leading-relaxed">
      <TranslatedBody text={message.content || ' '} />
      {isStreaming && (
        <span className="inline-block ml-0.5 w-1.5 h-3.5 -mb-0.5 bg-coral/60 animate-pulse" />
      )}
    </div>
  )
}

// Long-thread truncation cap. The dispatcher feeds the full message
// history to the backend (so multi-turn context is preserved), but the
// renderer only paints the last N — anything older becomes a system
// divider "已截断早期 X 条" / "earlier X truncated" pill. Sprint 4
// state machine #1 (REVIEW-LOG C-04 carry-forward).
const MAX_RENDERED_MESSAGES = 40

export function MessageList({ messages, streamingMessageId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const bottomRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom when content arrives (new message, chunk delta).
  useEffect(() => {
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
        <span className="text-micro font-mono text-ink-fg-3 uppercase tracking-wider">
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
          <span className="text-micro font-mono text-ink-fg-3 uppercase tracking-wider">
            {m.content}
          </span>
        </div>
      )
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-3 py-3">
      {rendered}
      <div ref={bottomRef} />
    </div>
  )
}
