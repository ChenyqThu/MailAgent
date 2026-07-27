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

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, AtSign, Brain, Cpu, Paperclip, X } from 'lucide-react'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState
} from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { MentionPopover } from '@shared/components/chat/MentionPopover'
import { formatAttachmentSize } from '@shared/lib/chat-attachments'

import { useChatComposerControls, type ChatComposerControls } from './composerControls'
import { ApprovalModePicker } from './ApprovalModePicker'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

/** C1-② model picker — Cpu button + a glass popover of the enabled models (anchored above).
 *  Hidden when there are no models to pick or no onChange wired. Mirrors the legacy Composer Cpu
 *  picker (idiom + popover recipe); selection routes through controls.onModelChange (re-scopes the
 *  panel backend). Closes on outside-click / Escape / select. */
function ComposerModelPicker({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (controls.availableModels.length === 0) return null
  const disabled = controls.modelPickerDisabled
  return (
    <div className="relative" ref={ref}>
      <HoverTip
        text={
          disabled
            ? t('chat.composer.modelHint')
            : `${t('chat.composer.model')} · ${controls.model ?? '—'}`
        }
        side="top"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((v) => !v)}
          aria-label={t('chat.composer.model')}
          aria-expanded={open}
          aria-haspopup="menu"
          tabIndex={disabled ? -1 : 0}
          className={cn(
            ICON_BTN,
            disabled
              ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
              : open
                ? 'bg-coral/10 text-coral active:scale-[0.96]'
                : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
          )}
        >
          <Cpu size={13} strokeWidth={2} />
        </button>
      </HoverTip>
      {open && (
        <div
          role="menu"
          aria-label={t('chat.composer.model')}
          className={cn(
            // 主题 v3 C8/批 4: 紧凑菜单档 rounded-md(6) → --r-ctl(8)
            'absolute bottom-full left-0 z-50 mb-1.5 min-w-[160px] rounded-[var(--r-ctl)] py-1',
            'glass-pop shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
          )}
        >
          {controls.availableModels.map((m) => {
            const active = m === controls.model
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  controls.onModelChange(m)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-meta font-mono',
                  'transition-colors duration-fast',
                  active
                    ? 'bg-coral/10 text-coral'
                    : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    active ? 'bg-coral/100' : 'bg-ink-fg-3'
                  )}
                />
                {m}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

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

/** C2-② attachment — Paperclip button + hidden file input. issue #61 Lane 3 (A2): each picked file
 *  now routes through composer.addAttachment → the MailAgent AttachmentAdapter (images → bounded
 *  file parts; text/binary → panel injectedContext path), the same pipeline paste + drop use. The
 *  adapter owns failure toasts — swallow the rethrow so one bad file doesn't stop the rest. */
function ComposerAttachmentButton(): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const inputRef = useRef<HTMLInputElement>(null)
  const onPick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      await aui
        .composer()
        .addAttachment(file)
        .catch(() => {
          /* adapter add() already toasted */
        })
    }
  }
  return (
    <>
      <HoverTip text={t('chat.attachment.add', { defaultValue: 'Attach a file' })} side="top">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label={t('chat.attachment.add', { defaultValue: 'Attach a file' })}
          className={cn(
            ICON_BTN,
            'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
          )}
        >
          <Paperclip size={13} strokeWidth={2} />
        </button>
      </HoverTip>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void onPick(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}

/** issue #61 Lane 3 (A2) — attachment chips now render from the assistant-ui COMPOSER state (the
 *  adapter's pending attachments), so paperclip / paste / drop all get the same visible feedback.
 *  Styling is the former controls-driven chip, verbatim; the hand-rolled X becomes
 *  AttachmentPrimitive.Remove → composer.removeAttachment → adapter.remove → panel-state sync. */
function ComposerAttachmentChips(): React.JSX.Element {
  return (
    <ComposerPrimitive.Attachments>
      {({ attachment }) => (
        <span className="inline-flex max-w-[200px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1">
          <Paperclip size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
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
      )}
    </ComposerPrimitive.Attachments>
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
          paperclip. The primitive owns the drag handlers + a data-dragging attribute for the
          highlight wash; the document-level fileDropGuard only blocks the file:// navigation
          default and doesn't consume the drop. Layout classes moved off Root so the wash paints. */}
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
              <ComposerAttachmentButton />
              <ComposerModelPicker controls={controls} />
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
