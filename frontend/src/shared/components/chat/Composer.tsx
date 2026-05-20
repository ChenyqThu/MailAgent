// Sprint 4 §6.6 — composer textarea + send button.
// ⌘↩ shortcut wired here via useShortcut (Sprint 4 Day 1 keydown bus).
// allowInEditable: true so the binding fires when focus is in our own
// textarea.
//
// V1 redesign (Sprint 10 polish): mirrors mockup-inbox.html lines 1334-1358.
// Footer is a dedicated row beneath the textarea (no `absolute` overlap),
// the send button is a squared-off `rounded-md` 28×28 chip that turns
// coral on hover, and the affordance strip is English mono so the
// 12px text-meta floor is on-spec.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign, ArrowUp, Cpu, Paperclip, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useShortcut } from '@shared/hooks/useShortcut'

interface Props {
  /** Renderer-controlled draft text. Lifted so QuickActions can prefill it. */
  value: string
  onChange(next: string): void
  /** Called when user hits ⌘↩ or clicks the send button. */
  onSend(text: string): void
  /** Called when user clicks the cancel button during a streaming reply. */
  onCancel(): void
  /** True while a streaming reply is in flight — swap send button for cancel. */
  isStreaming: boolean
  /** Disable send when there's no active email or backend is missing. */
  canSend: boolean
  /** Short, ASCII-safe label for the active backend (e.g. "Jarvis", "sonnet-4-6").
   *  Rendered in the footer next to ⌘↩ so the user always sees what they'll
   *  be sending to. */
  backendName: string
  /** Sprint 13 — model dropdown lives in the Composer footer's Cpu button.
   *  Only meaningful for Custom API backend (Notion Agent has no model
   *  picker — the agent decides). Pass null + empty options to disable. */
  currentModel?: string | null
  availableModels?: ReadonlyArray<string>
  onModelChange?(model: string): void
  /** Hides the model picker entirely (used by Notion Agent backend kind). */
  modelPickerDisabled?: boolean
}

export function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  isStreaming,
  canSend,
  backendName,
  currentModel,
  availableModels,
  onModelChange,
  modelPickerDisabled
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  // Sprint 13 — model picker popover state. Open via the Cpu button in
  // the footer; closed by Escape, outside click, or model select.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!modelPickerOpen) return
    const handler = (e: MouseEvent): void => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false)
      }
    }
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setModelPickerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return (): void => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [modelPickerOpen])

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!canSend || isStreaming || trimmed.length === 0) return
    onSend(trimmed)
  }, [canSend, isStreaming, onSend, value])

  // ⌘↩ to send. Sprint 4 review (opus M carry-forward): `enabled: focused`
  // killed the shortcut whenever the user clicked a tool row or the
  // BackendSelector. Scope to "anywhere inside the AI panel" via aria-label
  // instead — composer textarea, quick-action chips, and BackendSelector
  // all sit under `aria-label="ai-chat-panel"` (see AIChatPanel root).
  useShortcut(
    'cmd+enter',
    () => {
      if (typeof document === 'undefined') return
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return
      if (!active.closest('[aria-label="ai-chat-panel"]')) return
      submit()
      return true
    },
    { allowInEditable: true }
  )

  const sendDisabled = !canSend || value.trim().length === 0
  const sendTitle = `${t('chat.composer.send')} (⌘↩)`

  return (
    // mockup L2514 — `border-t border-ink-border bg-ink-2 p-2.5`. p-2.5 (10px)
    // not p-3 (12px); border above is `border-ink-border` not `-soft`.
    <div className="p-2.5 border-t border-ink-border bg-ink-2">
      <div
        className={cn(
          'rounded-md bg-ink-3 border transition-colors duration-fast',
          focused ? 'border-coral/50' : 'border-ink-border'
        )}
      >
        <div className="px-3 pt-2.5 pb-1">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            rows={2}
            placeholder={t('chat.composer.placeholder')}
            aria-label={t('chat.composer.placeholder')}
            className={cn(
              'w-full resize-none bg-transparent text-body text-ink-fg leading-snug',
              'placeholder:text-ink-fg-3',
              'focus:outline-none',
              'max-h-40 overflow-y-auto scrollbar-thin'
            )}
            // grow up to ~8 lines then scroll. Implementation idiom from
            // mockup-inbox.html — height auto + max-h.
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 160) + 'px'
            }}
          />
        </div>

        {/* Footer affordance strip — mockup L2523-2540. Three 7×7 icon
            buttons (attach / @mention / model switch), backend name +
            ⌘↩ kbd hint pinned right, then the send button (rounded-md
            7×7, hover → coral). attach + @mention disabled with
            HoverTip TODO; model click points at the BackendSelector
            Alt row above (the canonical model picker). */}
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-t border-ink-border-soft">
          <HoverTip text={t('chat.composer.attachBlocked')} side="top">
            <button
              type="button"
              disabled
              aria-label={t('chat.composer.attach')}
              data-disabled=""
              tabIndex={-1}
              className={cn(
                'w-7 h-7 rounded-md grid place-items-center',
                'text-ink-fg-3 opacity-50 cursor-not-allowed'
              )}
            >
              <Paperclip size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          <HoverTip text={t('chat.composer.mentionBlocked')} side="top">
            <button
              type="button"
              disabled
              aria-label={t('chat.composer.mention')}
              data-disabled=""
              tabIndex={-1}
              className={cn(
                'w-7 h-7 rounded-md grid place-items-center',
                'text-ink-fg-3 opacity-50 cursor-not-allowed'
              )}
            >
              <AtSign size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          {/* Sprint 13 — mockup L2530 真模型切换 button. Notion Agent 时
              modelPickerDisabled=true 因为 agent 自己决定模型 (没有
              picker 概念)。Custom API 时点击弹 popover 列出可选 models.
              Popover anchored to button via relative wrapper. */}
          <div className="relative" ref={modelPickerRef}>
            <HoverTip
              text={
                modelPickerDisabled
                  ? t('chat.composer.modelHint')
                  : `${t('chat.composer.model')} · ${currentModel ?? '—'}`
              }
              side="top"
            >
              <button
                type="button"
                disabled={modelPickerDisabled}
                onClick={() => {
                  if (!modelPickerDisabled) setModelPickerOpen((v) => !v)
                }}
                aria-label={t('chat.composer.model')}
                aria-expanded={modelPickerOpen}
                aria-haspopup="menu"
                data-disabled={modelPickerDisabled ? '' : undefined}
                tabIndex={modelPickerDisabled ? -1 : 0}
                className={cn(
                  'w-7 h-7 rounded-md grid place-items-center',
                  'transition-colors duration-fast',
                  modelPickerDisabled
                    ? 'text-ink-fg-3 opacity-50 cursor-not-allowed'
                    : modelPickerOpen
                      ? 'text-coral bg-coral/10'
                      : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
                )}
              >
                <Cpu size={13} strokeWidth={2} />
              </button>
            </HoverTip>

            {modelPickerOpen &&
              !modelPickerDisabled &&
              availableModels &&
              availableModels.length > 0 && (
                // mockup-faithful glass popover anchored above the Cpu button.
                // Width auto-fits the widest model id (claude-opus-4-7 ≈ 110px);
                // padding matches Sprint 11 .glass-pop recipe.
                <div
                  role="menu"
                  aria-label={t('chat.composer.model')}
                  className={cn(
                    'absolute z-50 bottom-full mb-1.5 left-0',
                    'min-w-[160px] rounded-md py-1',
                    'glass-pop shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
                  )}
                >
                  {availableModels.map((m) => {
                    const active = m === currentModel
                    return (
                      <button
                        key={m}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          onModelChange?.(m)
                          setModelPickerOpen(false)
                        }}
                        className={cn(
                          'w-full text-left px-3 py-1.5 text-meta font-mono',
                          'flex items-center gap-2 whitespace-nowrap',
                          active
                            ? 'text-coral bg-coral/10'
                            : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg',
                          'transition-colors duration-fast'
                        )}
                      >
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
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

          {/* Backend label + ⌘↩ kbd — `ml-auto` shoves the affordance
              icons left and the send button stays at the right edge. */}
          <span className="ml-auto inline-flex items-center gap-1.5 text-meta font-mono text-ink-fg-2">
            <span className="truncate max-w-[120px]">{backendName}</span>
            <kbd>⌘↩</kbd>
          </span>

          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label={t('chat.composer.cancel')}
              title={t('chat.composer.cancel')}
              className={cn(
                'ml-1 w-7 h-7 rounded-md grid place-items-center',
                'bg-ink-4 hover:bg-coral/100 text-ink-fg-1 hover:text-accent-fg',
                'transition-colors duration-fast'
              )}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={sendDisabled}
              aria-label={t('chat.composer.send')}
              title={sendTitle}
              className={cn(
                'ml-1 w-7 h-7 rounded-md grid place-items-center',
                'transition-colors duration-fast',
                sendDisabled
                  ? 'bg-ink-4 text-ink-fg-3 cursor-not-allowed'
                  : 'bg-ink-4 hover:bg-coral/100 text-ink-fg-1 hover:text-accent-fg'
              )}
            >
              <ArrowUp size={12} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
