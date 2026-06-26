// MailAgent agent-view composer — demo-fidelity (chat-panel demo parity), Phase 7 non-lexical.
//
// Demo composer: a rounded shell on bg-ink-2 with the text input on top and an inline action row
// (left: attach "+" → @mention → model picker WITH vendor icon; right: send / cancel as round
// buttons). No extended-thinking toggle — the agent view follows the model automatically
// (AgentConversation sets thinkingActive = thinkingSupported). @ opens the existing MentionPopover
// in Phase 7; Phase 8 swaps the textarea for LexicalComposerInput with in-field @ / chips + / commands.
// Reads model / @mention / attachment state from useChatComposerControls() (provided by AgentConversation);
// when no provider is mounted (a read-only thread / bare test render) only send / cancel show.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, AtSign, Cpu, Paperclip, Plus, Square, X } from 'lucide-react'
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { MentionPopover } from '@shared/components/chat/MentionPopover'
import { formatAttachmentSize, readAttachment } from '@shared/lib/chat-attachments'
import { toastError } from '@shared/state/toast'
import {
  useChatComposerControls,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'

// ── vendor icon ────────────────────────────────────────────────────────────────
type Vendor = 'anthropic' | 'openai' | 'google' | 'other'
function vendorOf(modelId: string | null): Vendor {
  const m = (modelId ?? '').toLowerCase()
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gpt') || /^o[134]/.test(m)) return 'openai'
  if (m.startsWith('gemini')) return 'google'
  return 'other'
}

/** Compact, brand-coloured vendor marks (simplified — recognisable, not pixel-perfect logos):
 *  Anthropic sunburst (coral), OpenAI hexagon (teal), Gemini spark (blue), else a neutral Cpu. */
function ModelVendorIcon({ vendor }: { vendor: Vendor }): React.JSX.Element {
  switch (vendor) {
    case 'anthropic':
      return (
        <svg
          viewBox="0 0 24 24"
          className="size-3.5 shrink-0"
          stroke="var(--vendor-anthropic)"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <line x1="12" y1="3.5" x2="12" y2="20.5" />
          <line x1="3.5" y1="12" x2="20.5" y2="12" />
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      )
    case 'openai':
      return (
        <svg
          viewBox="0 0 24 24"
          className="size-3.5 shrink-0"
          fill="none"
          stroke="var(--vendor-openai)"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
        </svg>
      )
    case 'google':
      return (
        <svg
          viewBox="0 0 24 24"
          className="size-3.5 shrink-0"
          fill="var(--vendor-google)"
          aria-hidden
        >
          <path d="M12 2c0 5-5 10-10 10 5 0 10 5 10 10 0-5 5-10 10-10-5 0-10-5-10-10z" />
        </svg>
      )
    default:
      return <Cpu size={13} strokeWidth={2} className="shrink-0 text-ink-fg-2" />
  }
}

// ── attachment ("+") ─────────────────────────────────────────────────────────────
function AgentAttachmentButton({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const onPick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      try {
        controls.onAddAttachment(await readAttachment(file))
      } catch {
        toastError(t('chat.attachment.readFailed', { defaultValue: 'Could not read attachment' }))
      }
    }
  }
  return (
    <>
      <HoverTip text={t('chat.composer.attach')} side="top">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label={t('chat.composer.attach')}
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
        >
          <Plus size={17} strokeWidth={2} />
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

// ── @mention ───────────────────────────────────────────────────────────────────
function AgentMentionButton({ controls }: { controls: ChatComposerControls }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <HoverTip text={t('chat.composer.mention')} side="top">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('chat.composer.mention')}
          aria-expanded={open}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-fast',
            open ? 'bg-coral/10 text-coral' : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
          )}
        >
          <AtSign size={15} strokeWidth={2} />
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

// ── model picker (vendor icon) ───────────────────────────────────────────────────
function AgentModelPicker({
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
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-label={t('chat.composer.model')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full px-2 text-meta font-medium transition-colors duration-fast',
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : open
              ? 'bg-coral/10 text-coral'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
        )}
      >
        <ModelVendorIcon vendor={vendorOf(controls.model)} />
        <span className="max-w-[110px] truncate font-mono">
          {controls.model ?? t('chat.composer.model')}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('chat.composer.model')}
          className="glass-pop absolute bottom-full left-0 z-50 mb-1.5 min-w-[190px] rounded-lg py-1 shadow-[0_4px_12px_rgba(0,0,0,0.35)]"
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
                  'flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-meta font-mono transition-colors duration-fast',
                  active
                    ? 'bg-coral/10 text-coral'
                    : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                )}
              >
                <ModelVendorIcon vendor={vendorOf(m)} />
                <span className="truncate">{m}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── chip stack (mention + attachment) ────────────────────────────────────────────
function AgentComposerChips({
  controls
}: {
  controls: ChatComposerControls
}): React.JSX.Element | null {
  if (controls.mentions.length === 0 && controls.attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1">
      {controls.mentions.map((m) => (
        <span
          key={`m-${m.internal_id}`}
          className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1"
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
      {controls.attachments.map((a) => (
        <span
          key={`a-${a.id}`}
          className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1"
        >
          <Paperclip size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
          <span className="truncate">{a.filename}</span>
          <span className="shrink-0 font-mono text-micro text-ink-fg-3">
            {formatAttachmentSize(a.sizeBytes)}
          </span>
          <button
            type="button"
            onClick={() => controls.onRemoveAttachment(a.id)}
            aria-label="remove"
            className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </span>
      ))}
    </div>
  )
}

export function AgentComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const controls = useChatComposerControls()
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <div className="flex w-full flex-col gap-1.5 rounded-2xl border border-[var(--hairline)] bg-ink-2 p-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.18),0_1px_2px_rgba(0,0,0,0.06)] transition-[border-color,box-shadow] duration-fast focus-within:border-[rgb(var(--c-accent))]">
        {controls && <AgentComposerChips controls={controls} />}
        <ComposerPrimitive.Input
          placeholder={t('agentView.composer.placeholder')}
          aria-label={t('agentView.composer.placeholder')}
          className="scrollbar-thin max-h-32 min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1.5 text-body leading-snug text-ink-fg outline-none placeholder:text-ink-fg-3"
          rows={1}
          autoFocus
        />
        <div className="flex items-center justify-between gap-1 px-0.5">
          <div className="flex items-center gap-0.5">
            {controls && <AgentAttachmentButton controls={controls} />}
            {controls && <AgentMentionButton controls={controls} />}
            {controls && <AgentModelPicker controls={controls} />}
          </div>
          <div className="flex items-center">
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                aria-label={t('chat.composer.send')}
                title={t('chat.composer.send')}
                className="grid size-8 shrink-0 place-items-center rounded-full bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))] transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                aria-label={t('chat.composer.cancel')}
                title={t('chat.composer.cancel')}
                className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-4 text-ink-fg-1 transition-colors duration-fast hover:bg-[rgb(var(--c-accent))] hover:text-[rgb(var(--c-accent-fg))]"
              >
                <Square size={14} strokeWidth={2.5} className="fill-current" />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  )
}
