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

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Paperclip, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
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
}

export function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  isStreaming,
  canSend,
  backendName
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)

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
    <div className="px-3 py-3 border-t border-ink-border-soft bg-ink-2">
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

        {/* Footer affordance strip — English-mono only, sits at text-meta */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-ink-border-soft">
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 text-meta font-mono',
              'text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast'
            )}
            title="Attach context"
          >
            <Paperclip size={11} strokeWidth={2} />
            attach
          </button>
          <span className="text-ink-fg-3 text-meta font-mono">·</span>
          <button
            type="button"
            className={cn(
              'text-meta font-mono text-ink-fg-2',
              'hover:text-ink-fg transition-colors duration-fast'
            )}
          >
            /slash
          </button>
          <span className="text-ink-fg-3 text-meta font-mono">·</span>
          <span className="text-meta font-mono text-ink-fg-2">@thread</span>

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
