// chat-panel P4 Phase 01 + composer-parity — thread composer (assistant-ui ComposerPrimitive).
//
// MailAgent-token composer: a vertical strip — the text input on top, a toolbar row
// below (model picker + extended-thinking toggle on the left, send / cancel on the
// right). While the thread is running the Send swaps to a Cancel (stop generating)
// via ThreadPrimitive.If. ComposerPrimitive.Send is auto-disabled on empty input.
//
// composer-parity: the model picker + thinking toggle read panel-owned state via
// useChatComposerControls(). When no provider is mounted (controls === null — the
// read-only notion-agent thread, or a bare test render) the toolbar shows only
// send/cancel, byte-identical in behaviour to the Phase 01 text-only composer.
// @mention / attachment chrome lands in C2 (same controls context).

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Brain, Cpu, X } from 'lucide-react'
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'

import { useChatComposerControls, type ChatComposerControls } from './composerControls'

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
            'absolute bottom-full left-0 z-50 mb-1.5 min-w-[160px] rounded-md py-1',
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

export function ThreadComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const controls = useChatComposerControls()
  return (
    <ComposerPrimitive.Root className="flex flex-col gap-2 border-t border-[var(--hairline)] bg-ink-2 px-3 py-2.5">
      <ComposerPrimitive.Input
        placeholder={t('chat.composer.placeholder')}
        aria-label={t('chat.composer.placeholder')}
        className={cn(
          'scrollbar-thin max-h-32 w-full resize-none rounded-lg border bg-ink-3 px-3 py-2',
          'text-body leading-snug text-ink-fg outline-none placeholder:text-ink-fg-3',
          'border-[rgb(var(--ink-border))] focus-visible:border-[rgb(var(--c-accent))]'
        )}
        rows={1}
        autoFocus
      />
      <div className="flex items-center gap-1">
        {controls && (
          <>
            <ComposerModelPicker controls={controls} />
            <ComposerThinkingToggle controls={controls} />
          </>
        )}
        <div className="ml-auto flex items-center">
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send
              aria-label={t('chat.composer.send', { defaultValue: 'Send' })}
              title={`${t('chat.composer.send', { defaultValue: 'Send' })} (⌘↩)`}
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
    </ComposerPrimitive.Root>
  )
}
