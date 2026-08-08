// chat-panel P4 Phase 01 — assistant-ui message renderers (MailAgent token skin).
//
// Adopts the Phase 00 spike paradigm (headless MessagePrimitive + MailAgent
// tokens): user bubble on --c-accent, assistant bubble on bg-ink-3 + hairline.
// The assistant bubble renders parts through `assistantPartComponents`
// (text → Streamdown, reasoning → collapsible, tool-call → ToolTraceCard).
// User messages flip into the EditComposer on edit; assistant messages carry a
// hover Copy/Reload action bar. Theme three-state + 6 accents reskin for free —
// only CSS variables drive color.

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip } from 'lucide-react'
import {
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  type CompleteAttachment
} from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'

import { getAssistantPartComponents } from '../tools/registerToolUIs'
import { TurnStatusLine } from './TurnStatusLine'
import { AssistantActionBar, UserActionBar } from './action-bar'
import { FollowupSuggestions } from './FollowupSuggestions'
import { CompactCard } from './CompactCard'

/** Displayable image bytes of a sent attachment, or null for a non-image one. The AI SDK converter
 *  turns a user `file` part with an image/* mediaType into `{type:'image', image:<data URL>}` inside
 *  attachment.content (react-ai-sdk convertMessage.ts) — the only producer of these, so "no image
 *  part" means a genuinely non-image attachment and the caller falls back to the name pill. */
function attachmentImageSrc(attachment: CompleteAttachment): string | null {
  for (const part of attachment.content ?? []) {
    if (part.type === 'image' && typeof part.image === 'string') return part.image
  }
  return null
}

/** issue #61 Lane 3 (A2) — sent attachments under the user bubble. File parts on a user UIMessage
 *  surface as thread-message `attachments` (AISDKMessageConverter), both live and on session reload
 *  — without this row a sent image "disappears" again the moment the chip clears.
 *
 *  dogfood 07-27 (Lane D) — images render as a bounded thumbnail, not a paperclip pill: the pill
 *  showed only the filename, so a pasted screenshot still looked absent from the history (owner:
 *  「发出后，消息历史里没有显示图片」). assistant-ui has no image primitive for this —
 *  AttachmentPrimitive.unstable_Thumb renders the file EXTENSION as text — so the <img> is ours.
 *  Sizes are capped (the src is a data URL up to CHAT_IMAGE_MAX_PAYLOAD_CHARS, and a 1568px-edge
 *  image at natural size would dwarf the bubble); multiple images wrap in the flex row.
 *
 *  🔴 Exported because there are TWO user-bubble renderers: this one (email panel) and
 *  AgentMessage.tsx's AgentUserMessage (general chat / Cmd+O, demo-fidelity layout). The general
 *  surface shipped with NO attachments row at all, so a sent image vanished there completely — the
 *  converter routes user `file` parts to `attachments` and DELETES them from `content`, so a
 *  Parts-only renderer drops them on the floor. One row, both surfaces: a third copy would just
 *  diverge again. Mount it as a sibling of the bubble under a `flex-col items-end` root. */
export function UserMessageAttachments(): React.JSX.Element {
  const { t } = useTranslation()
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  return (
    <div className="mt-1 flex max-w-[80%] flex-wrap justify-end gap-1">
      <MessagePrimitive.Attachments>
        {({ attachment }) => {
          const imageSrc = attachmentImageSrc(attachment)
          if (imageSrc !== null) {
            return (
              // 点击放大（role/tabIndex 加在图本身，而不是外面套一层 <button>：图是这条 flex-wrap
              // 行的直接子元素，包一层会改掉换行布局）。缩略图受限于气泡宽度，原图要看细节只能放大。
              <img
                src={imageSrc}
                alt={attachment.name}
                title={attachment.name}
                role="button"
                tabIndex={0}
                aria-label={t('chat.attachment.preview', { defaultValue: 'Preview image' })}
                onClick={() => setPreviewSrc(imageSrc)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setPreviewSrc(imageSrc)
                  }
                }}
                className="max-h-40 max-w-[min(240px,100%)] cursor-zoom-in rounded-lg border border-ink-border bg-ink-3"
              />
            )
          }
          return (
            <span className="inline-flex max-w-[200px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-0.5 text-micro text-ink-fg-2">
              <Paperclip size={10} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
              <span className="truncate">{attachment.name}</span>
            </span>
          )
        }}
      </MessagePrimitive.Attachments>
      {previewSrc !== null && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </div>
  )
}

export function UserMessage(): React.JSX.Element {
  const { t } = useTranslation()
  const hasAttachments = useAuiState((s) => (s.message.attachments?.length ?? 0) > 0)
  const queuedEnvelope = useAuiState((s) => {
    const text = s.message.content
      .filter((part) => part.type === 'text')
      .map((part) => ('text' in part ? part.text : ''))
      .join('')
    if (!text.startsWith('<queued_followups>')) return null
    const messages = [...text.matchAll(/<message>([\s\S]*?)<\/message>/g)].map((match) =>
      match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    )
    return messages.length > 0 ? messages : null
  })
  // An image-only send has no text part — skip the accent bubble instead of painting an empty pill.
  const hasBubbleContent = useAuiState((s) => s.message.content.length > 0)
  return (
    <MessagePrimitive.Root className="group mb-4 flex w-full flex-col items-end">
      {hasBubbleContent && (
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[rgb(var(--c-accent))] px-3.5 py-2 text-body leading-relaxed text-[rgb(var(--c-accent-fg))] shadow-sm">
          {queuedEnvelope ? (
            <div className="space-y-1.5">
              <div className="text-micro font-medium opacity-75">
                {t('chat.queuedInput.dispatchedLabel')}
              </div>
              {queuedEnvelope.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
            </div>
          ) : (
            <MessagePrimitive.Parts />
          )}
        </div>
      )}
      {hasAttachments && <UserMessageAttachments />}
      <UserActionBar />
    </MessagePrimitive.Root>
  )
}

/** issue #61 Lane 3 (A2/C) — stream-error footer. A failed turn (message status incomplete/error)
 *  previously rendered NOTHING here (no ErrorPrimitive anywhere), so an upstream reject — e.g. a
 *  non-vision model 400ing on an image file part — looked like the answer silently vanished. The
 *  gateway already forwards the real error text (server.ts onError); surface it, plus a plain-words
 *  hint when the conversation carries image attachments (no provider capability table yet — batch 2). */
function AssistantMessageError(): React.JSX.Element | null {
  const { t } = useTranslation()
  const error = useAuiState((s) =>
    s.message.status?.type === 'incomplete' && s.message.status.reason === 'error'
      ? s.message.status.error
      : undefined
  )
  const threadHasImage = useAuiState((s) =>
    s.thread.messages.some(
      (m) => m.role === 'user' && (m.attachments ?? []).some((a) => a.type === 'image')
    )
  )
  if (error === undefined) return null
  const detail = typeof error === 'string' ? error : JSON.stringify(error)
  return (
    <div className="rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-aux text-fail">
      <div className="font-medium">{t('chat.aiSdk.turnError')}</div>
      {detail.length > 0 && (
        <div className="mt-0.5 break-words font-mono text-micro opacity-80">
          {detail.slice(0, 400)}
        </div>
      )}
      {threadHasImage && (
        <div className="mt-1 text-micro text-ink-fg-2">{t('chat.aiSdk.visionHint')}</div>
      )}
    </div>
  )
}

export function AssistantMessage(): React.JSX.Element {
  // Phase 04a — flag-aware part components (generic ToolTraceCard fallback always; A2UI
  // per-tool cards added as tools.by_name — rich cards always on since S3; consecutive tool
  // calls folded by ToolGroupCard). harness-chat lane B — TurnStatusLine on the Empty slot so
  // the email panel gets the same truth-driven status line the agent panel has. Memoized once
  // per mount so the object reference stays stable across re-renders.
  const partComponents = useMemo(
    () => ({ ...getAssistantPartComponents(), Empty: TurnStatusLine }),
    []
  )
  return (
    <MessagePrimitive.Root className="group mb-4 flex w-full flex-col items-start">
      <div className="min-w-0 max-w-[85%] space-y-1.5 rounded-2xl rounded-bl-md border border-[var(--hairline)] bg-ink-3 px-3.5 py-2 text-body leading-relaxed text-ink-fg">
        <MessagePrimitive.Parts components={partComponents} />
        <MessagePrimitive.Error>
          <AssistantMessageError />
        </MessagePrimitive.Error>
        <AssistantActionBar />
      </div>
      {/* 0804 dogfood 1d — follow-up chips moved out of the thread-level row (above the composer)
          into THIS message, right after the action bar and outside the bubble (left-aligned with
          it via the Root's items-start). Only the LAST assistant message ever renders anything
          here (FollowupSuggestions' own isLast/isRunning/readOnly gates). */}
      <FollowupSuggestions className="mt-2" />
    </MessagePrimitive.Root>
  )
}

export function SystemMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-3 flex w-full items-center justify-center px-3">
      <div className="w-full max-w-[92%] text-micro font-mono uppercase tracking-wider text-ink-fg-3">
        <MessagePrimitive.Parts components={{ data: { by_name: { compact: CompactCard } } }} />
      </div>
    </MessagePrimitive.Root>
  )
}

/** Rendered by assistant-ui when a user message is being edited (ActionBar Edit).
 *  Re-stream is wired through the adapter `onEdit` (legacy editMessage). */
export function EditComposer(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ComposerPrimitive.Root className="mb-4 flex w-full flex-col gap-2 self-end rounded-2xl border border-[var(--hairline)] bg-ink-2 px-3 py-2.5">
      <ComposerPrimitive.Input
        className="scrollbar-thin max-h-40 w-full resize-none bg-transparent text-body leading-snug text-ink-fg outline-none"
        rows={3}
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <ComposerPrimitive.Cancel
          className={cn(
            'h-7 rounded px-3 text-aux',
            'border border-ink-border-soft bg-ink-2 text-ink-fg',
            'transition-colors duration-fast hover:bg-ink-3'
          )}
        >
          {t('chat.message.cancel')}
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send
          className={cn(
            'h-7 rounded px-3 text-aux font-medium',
            'bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))]',
            'transition-opacity duration-fast hover:opacity-90 disabled:opacity-40'
          )}
        >
          {t('chat.message.save')}
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}
