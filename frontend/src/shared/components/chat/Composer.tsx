// Sprint 4 §6.6 — composer textarea + round send button.
// ⌘↩ shortcut wired here via useShortcut (Sprint 4 Day 1 keydown bus).
// allowInEditable: true so the binding fires when focus is in our own
// textarea.

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, X } from 'lucide-react'

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
}

export function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  isStreaming,
  canSend
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!canSend || isStreaming || trimmed.length === 0) return
    onSend(trimmed)
  }, [canSend, isStreaming, onSend, value])

  // ⌘↩ to send. allowInEditable: true so the textarea focus doesn't gate
  // the shortcut. Disabled when streaming or not allowed.
  useShortcut(
    'cmd+enter',
    () => {
      submit()
      return true
    },
    { allowInEditable: true, enabled: focused }
  )

  return (
    <div className="px-3 py-3 border-t border-ink-border-soft">
      <div
        className={cn(
          'relative rounded-lg bg-ink-3 border transition-colors duration-fast',
          focused ? 'border-coral/50' : 'border-ink-border'
        )}
      >
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
            'w-full resize-none bg-transparent text-body text-ink-fg',
            'px-3 pt-2 pb-9',
            'placeholder:text-ink-fg-3',
            'focus:outline-none',
            'max-h-40 overflow-y-auto scrollbar-thin'
          )}
          // grow up to 8 lines then scroll. Implementation idiom from
          // mockup-inbox.html — height auto + max-h.
          onInput={(e) => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 160) + 'px'
          }}
        />
        <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between text-micro font-mono text-ink-fg-3">
          <span className="uppercase tracking-wider">
            ⌘↩ {t('chat.composer.send').toUpperCase()}
          </span>
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label={t('chat.composer.cancel')}
              className={cn(
                'inline-flex items-center justify-center w-7 h-7 rounded-full',
                'bg-ink-4 text-ink-fg-1 hover:bg-ink-5 transition-colors duration-fast'
              )}
            >
              <X size={13} strokeWidth={2} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend || value.trim().length === 0}
              aria-label={t('chat.composer.send')}
              className={cn(
                'inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors duration-fast',
                value.trim().length === 0 || !canSend
                  ? 'bg-ink-4 text-ink-fg-3 cursor-not-allowed'
                  : 'bg-coral/100 text-accent-fg hover:bg-coral-hover'
              )}
            >
              <Send size={13} strokeWidth={2} className="-ml-0.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
