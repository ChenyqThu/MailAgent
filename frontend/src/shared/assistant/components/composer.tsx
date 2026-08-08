// chat-panel P4 Phase 01 + composer-parity — thread composer (assistant-ui ComposerPrimitive).
//
// MailAgent-token composer: a vertical strip — the text input on top, a toolbar row
// below (entry menus on the left, model / effort / send on the right). While the thread is
// running the Send swaps to a Cancel (stop generating) via ThreadPrimitive.If.
// ComposerPrimitive.Send is auto-disabled on empty input.
//
// composer-parity: the model picker + @mention + attachment chips all read panel-owned state via
// useChatComposerControls(). When no provider is mounted (controls === null — the read-only
// notion-agent thread, or a bare test render) the toolbar shows only send/cancel, byte-identical in
// behaviour to the Phase 01 text-only composer.
//
// 08-05 WP-13+16b — 工具条重组（owner 参照 Notion composer，prd「composer 工具条布局」）：
//   左组 `[+（附件 / 引用邮件）] [滑块（connector / skill 快捷配置）] [授权模式]`
//   右组 `[context 环] [effort] [模型] [发送]`
// 两处删除：独立的 `@` 钮（并进「+」）、Brain 布尔开关（被 effort 档位菜单取代 —— 见
// EffortPicker 文件头；`body.thinking` 自此不再由任何 UI 发出，gateway 的 legacy 分支仍在，
// island resume 回放冻结的 originalBody 需要它）。

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, AtSign, Paperclip, X } from 'lucide-react'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type Attachment
} from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { formatAttachmentSize } from '@shared/lib/chat-attachments'

import { useChatComposerControls, type ChatComposerControls } from './composerControlsContext'
import { ApprovalModePicker } from './ApprovalModePicker'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { ComposerToolsMenu } from './ComposerToolsMenu'
import { ContextUsageRing } from './ContextUsageRing'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'

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
  const aui = useAui()
  const controls = useChatComposerControls()
  // codex r2 [D] — sendDisabled must gate the REAL submit path, not just the Send button: the
  // assistant-ui Input's Enter requestSubmit()s the Root form, whose composed handler calls send()
  // unless the user handler prevented default (radix composeEventHandlers checks defaultPrevented).
  // The Input itself is disabled too (typing fenced while the approval resume holds the lease).
  const sendDisabled = controls?.sendDisabled === true
  const composerText = useAuiState((state) => state.composer.text)
  return (
    <ComposerPrimitive.Root
      onSubmit={(e) => {
        if (sendDisabled) {
          e.preventDefault()
          return
        }
        if (composerText.trim() === '/compact' && controls?.compactEnabled === true) {
          e.preventDefault()
          aui.composer().setText('')
          controls.onCompact?.()
        }
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
        {/* 🔴 `relative` 是 WP-22 的 context 明细弹层的包含块（那颗环在右组第一位，按它自己的
            右缘锚会在 320px 窄面里被 overflow-hidden 裁掉 —— 算式见 ContextUsageRing 的注释）。
            其余弹层（+/滑块/授权/effort/模型）各自有 `div.relative` 包裹，不受这层影响。 */}
        <div className="relative flex items-center gap-1">
          {controls && (
            <>
              {/* 08-05 WP-13 — 「+」= 往这轮对话里加内容：附件 + 引用邮件（原独立 @ 钮）。 */}
              <ComposerPlusMenu variant="icon" mention />
              {/* 08-05 WP-13 — 滑块 = 配置这轮能用哪些外部能力（外部连接 / 技能 / 去 AI 设置）。 */}
              <ComposerToolsMenu variant="icon" />
              {/* 07-16 — owner-global 授权模式切换（Manual/Accept Edits/Bypass；backend 持久化，
                双 composer + 远程 web 同组件）。08-05 owner 拍板：保留为独立控件，不并进滑块。 */}
              <ApprovalModePicker variant="icon" />
            </>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {/* WP-15 — 上下文占用（环 / 中性药丸 / 不渲染，见 ContextUsageRing 文件头）。 */}
            <ContextUsageRing />
            {/* 08-05 WP-16b — effort 档位（取代 Brain 布尔）。controls.effort 缺席（旧测试 /
                只读线程）→ 整个不渲染，与引入前逐字一致。 */}
            {controls?.effort && <EffortPicker control={controls.effort} variant="icon" />}
            {/* 08-04 W8 — 两个 composer 共用的模型选择器（icon variant）。 */}
            {controls && <ModelPicker controls={controls} variant="icon" />}
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
