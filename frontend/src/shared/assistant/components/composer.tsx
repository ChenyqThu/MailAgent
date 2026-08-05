// chat-panel P4 Phase 01 + composer-parity — thread composer (assistant-ui ComposerPrimitive).
//
// MailAgent-token composer: a vertical strip — the text input on top, a toolbar row
// below (model picker + extended-thinking toggle on the left, send / cancel on the
// right). While the thread is running the Send swaps to a Cancel (stop generating)
// via ThreadPrimitive.If. ComposerPrimitive.Send is auto-disabled on empty input.
//
// composer-parity: the model picker + thinking toggle + @mention + attachment chips all read
// panel-owned state via useChatComposerControls(). When no provider is mounted (controls === null —
// the read-only notion-agent thread, or a bare test render) the toolbar shows only send/cancel,
// byte-identical in behaviour to the Phase 01 text-only composer.
//
// 08-04 WP6: the toolbar's own Paperclip button + the standalone connector button are gone — both
// live inside the shared ComposerPlusMenu ("+", 2nd control) now, so the left group is 5 controls:
// @ / + / model / thinking / approval-mode.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, AtSign, Brain, Paperclip, X } from 'lucide-react'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  ThreadPrimitive,
  useAuiState,
  type Attachment
} from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { MentionPopover } from '@shared/components/chat/MentionPopover'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { formatAttachmentSize } from '@shared/lib/chat-attachments'

import { useChatComposerControls, type ChatComposerControls } from './composerControlsContext'
import { ApprovalModePicker } from './ApprovalModePicker'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { ModelPicker } from './ModelPicker'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

/** C1-① extended-thinking toggle — Brain button (coral fill when on). Disabled (greyed, like legacy)
 *  when the active model can't do extended thinking (gpt / notion-agent) so a stale-ON never sends
 *  thinking to a backend that ignores it. The next send streams reasoning into a collapsible block. */
function ComposerThinkingToggle({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const disabled = !controls.thinkingSupported
  return (
    <HoverTip
      text={
        disabled
          ? t('chat.thinking.unsupported')
          : controls.thinkingEnabled
            ? t('chat.thinking.toggleOff')
            : t('chat.thinking.toggleOn')
      }
      side="top"
    >
      <button
        type="button"
        disabled={disabled}
        aria-label={t('chat.thinking.label')}
        aria-pressed={controls.thinkingEnabled}
        onClick={() => !disabled && controls.onToggleThinking()}
        tabIndex={disabled ? -1 : 0}
        className={cn(
          ICON_BTN,
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : controls.thinkingEnabled
              ? 'bg-coral/10 text-coral active:scale-[0.96]'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
        )}
      >
        <Brain size={13} strokeWidth={2} />
      </button>
    </HoverTip>
  )
}

/** C2-① @mention — AtSign button + MentionPopover (FTS email search). A selected hit becomes a chip
 *  (controls.onAddMention); the panel resolves its body excerpt + prepends an untrusted block at send. */
function ComposerMentionButton({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <HoverTip text={t('chat.mention.title', { defaultValue: 'Reference an email' })} side="top">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('chat.mention.title', { defaultValue: 'Reference an email' })}
          aria-expanded={open}
          className={cn(
            ICON_BTN,
            open
              ? 'bg-coral/10 text-coral active:scale-[0.96]'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
          )}
        >
          <AtSign size={13} strokeWidth={2} />
        </button>
      </HoverTip>
      <MentionPopover
        open={open}
        onClose={() => setOpen(false)}
        onSelect={(hit) => {
          controls.onAddMention(hit)
          setOpen(false)
        }}
      />
    </div>
  )
}

/** One pending-attachment chip. An image chip swaps the paperclip for a thumbnail of the file
 *  itself (objectURL over attachment.file — the adapter's prepared data URL isn't exposed here),
 *  clickable to open the shared lightbox; every other chip is the paperclip pill unchanged.
 *  The objectURL is owned per chip: created when the File lands, revoked on unmount / removal. */
function ComposerAttachmentChip({
  attachment,
  maxWidthClass,
  onPreview
}: {
  attachment: Attachment
  maxWidthClass: string
  onPreview: (src: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const file = attachment.type === 'image' ? attachment.file : undefined
  const thumbUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  // 拿到 URL 的那次 memo 之外没有别的持有者 —— chip 卸载/附件被移除/换了 File 时必须 revoke，
  // 否则每粘一张图都在 renderer 里留一份不会被 GC 的 blob。
  useEffect(() => {
    if (thumbUrl === null) return undefined
    return (): void => URL.revokeObjectURL(thumbUrl)
  }, [thumbUrl])
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1',
        maxWidthClass
      )}
    >
      {thumbUrl !== null ? (
        // 点击图本身放大（role/tabIndex，而不是外面套一层 <button>：chip 里已有 Remove 按钮，
        // 图再包一层会多一个嵌套的可聚焦盒子）。
        <img
          src={thumbUrl}
          alt=""
          role="button"
          tabIndex={0}
          aria-label={t('chat.attachment.preview', { defaultValue: 'Preview image' })}
          onClick={() => onPreview(thumbUrl)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onPreview(thumbUrl)
            }
          }}
          className="h-9 w-9 shrink-0 cursor-zoom-in rounded-md border border-ink-border bg-ink-1 object-cover"
        />
      ) : (
        <Paperclip size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
      )}
      <span className="truncate">{attachment.name}</span>
      {attachment.file && (
        <span className="shrink-0 font-mono text-micro text-ink-fg-3">
          {formatAttachmentSize(attachment.file.size)}
        </span>
      )}
      <AttachmentPrimitive.Remove
        aria-label="remove"
        className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
      >
        <X size={11} strokeWidth={2.5} />
      </AttachmentPrimitive.Remove>
    </span>
  )
}

/** issue #61 Lane 3 (A2) — attachment chips now render from the assistant-ui COMPOSER state (the
 *  adapter's pending attachments), so paperclip / paste / drop all get the same visible feedback.
 *  Styling is the former controls-driven chip, verbatim; the hand-rolled X becomes
 *  AttachmentPrimitive.Remove → composer.removeAttachment → adapter.remove → panel-state sync.
 *
 *  🔴 Exported because there are TWO composers: this one (email panel) and AgentComposer (general
 *  chat / Cmd+O), which shipped a byte-for-byte copy of this chip apart from its max-width. One
 *  component, both surfaces — mirroring UserMessageAttachments — so a chip change can't land on
 *  only one of them. The lightbox lives here so a chip thumbnail zooms on either surface. */
export function ComposerAttachmentChips({
  chipMaxWidthClass = 'max-w-[200px]'
}: {
  chipMaxWidthClass?: string
} = {}): React.JSX.Element {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  return (
    <>
      <ComposerPrimitive.Attachments>
        {({ attachment }) => (
          <ComposerAttachmentChip
            attachment={attachment}
            maxWidthClass={chipMaxWidthClass}
            onPreview={setPreviewSrc}
          />
        )}
      </ComposerPrimitive.Attachments>
      {previewSrc !== null && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </>
  )
}

/** C2 chip stack — referenced-email chips (panel state) + attachment chips (composer state) above
 *  the input. Nothing renders when both are empty (byte-identical to no chips). Mention chips stay
 *  controls-driven (their send-time excerpt resolution lives in the panel); attachment chips render
 *  even without controls so a pasted image is never an invisible send (issue #61's观感 root). */
function ComposerChips({
  controls
}: {
  controls: ChatComposerControls | null
}): React.JSX.Element | null {
  const attachmentCount = useAuiState((s) => s.composer.attachments.length)
  const mentions = controls?.mentions ?? []
  if (mentions.length === 0 && attachmentCount === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {controls &&
        controls.mentions.map((m) => (
          <span
            key={`m-${m.internal_id}`}
            className="inline-flex max-w-[200px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1"
          >
            <AtSign size={11} strokeWidth={2} className="shrink-0 text-coral" />
            <span className="truncate">{m.subject || `#${m.internal_id}`}</span>
            <button
              type="button"
              onClick={() => controls.onRemoveMention(m.internal_id)}
              aria-label="remove"
              className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
      <ComposerAttachmentChips />
    </div>
  )
}

export function ThreadComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const controls = useChatComposerControls()
  // codex r2 [D] — sendDisabled must gate the REAL submit path, not just the Send button: the
  // assistant-ui Input's Enter requestSubmit()s the Root form, whose composed handler calls send()
  // unless the user handler prevented default (radix composeEventHandlers checks defaultPrevented).
  // The Input itself is disabled too (typing fenced while the approval resume holds the lease).
  const sendDisabled = controls?.sendDisabled === true
  return (
    <ComposerPrimitive.Root
      onSubmit={(e) => {
        if (sendDisabled) e.preventDefault()
      }}
      className="border-t border-[var(--hairline)] bg-ink-2"
    >
      {/* issue #61 Lane 3 (A2) — drag&drop lands files on the same adapter pipeline as paste /
          the "+" menu's attachment item. The primitive owns the drag handlers + a data-dragging
          attribute for the highlight wash; the document-level fileDropGuard only blocks the
          file:// navigation default and doesn't consume the drop. Layout classes moved off Root
          so the wash paints. */}
      <ComposerPrimitive.AttachmentDropzone
        disabled={sendDisabled}
        className="flex flex-col gap-2 px-3 py-2.5 transition-colors duration-fast data-[dragging=true]:bg-coral/5"
      >
        <ComposerChips controls={controls} />
        <ComposerPrimitive.Input
          placeholder={t('chat.composer.placeholder')}
          aria-label={t('chat.composer.placeholder')}
          disabled={sendDisabled}
          className={cn(
            'scrollbar-thin max-h-32 w-full resize-none rounded-lg border bg-ink-3 px-3 py-2',
            'text-body leading-snug text-ink-fg outline-none placeholder:text-ink-fg-3',
            'border-[rgb(var(--ink-border))] focus-visible:border-[rgb(var(--c-accent))]',
            sendDisabled && 'opacity-60'
          )}
          rows={1}
          autoFocus
        />
        <div className="flex items-center gap-1">
          {controls && (
            <>
              <ComposerMentionButton controls={controls} />
              {/* 08-04 WP6 — 「+」菜单收编附件 + 外部连接（两面同一颗，见 ComposerPlusMenu
                  文件头；工具条因此从 6 个平铺控件收敛到 5 个）。 */}
              <ComposerPlusMenu variant="icon" />
              {/* 08-04 W8 — 两个 composer 共用的模型选择器（icon variant）。 */}
              <ModelPicker controls={controls} variant="icon" />
              <ComposerThinkingToggle controls={controls} />
              {/* 07-16 — owner-global 授权模式切换（Manual/Accept Edits/Bypass；backend 持久化，
                双 composer + 远程 web 同组件）。 */}
              <ApprovalModePicker variant="icon" />
            </>
          )}
          <div className="ml-auto flex items-center">
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                aria-label={t('chat.composer.send', { defaultValue: 'Send' })}
                title={`${t('chat.composer.send', { defaultValue: 'Send' })} (⌘↩)`}
                // P1-2 — an approval decide holds the session's run lease; sending would 409.
                disabled={sendDisabled}
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                  'bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))]',
                  'transition-opacity duration-fast hover:opacity-90 disabled:opacity-40'
                )}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                aria-label={t('chat.composer.cancel', { defaultValue: 'Stop' })}
                title={t('chat.composer.cancel', { defaultValue: 'Stop' })}
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                  'bg-ink-4 text-ink-fg-1',
                  'transition-colors duration-fast hover:bg-[rgb(var(--c-accent))] hover:text-[rgb(var(--c-accent-fg))]'
                )}
              >
                <X size={15} strokeWidth={2.5} />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  )
}
