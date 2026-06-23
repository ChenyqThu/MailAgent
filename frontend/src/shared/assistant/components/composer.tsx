// chat-panel P4 Phase 01 — thread composer (assistant-ui ComposerPrimitive).
//
// MailAgent-token composer: bg-ink-2 footer strip, bg-ink-3 input, accent send
// chip. While the thread is running the Send swaps to a Cancel (stop generating)
// via ThreadPrimitive.If — onCancel routes to the adapter (legacy abortCurrent).
// ComposerPrimitive.Send is auto-disabled on empty input (native), matching the
// legacy composer's send gate. @mention / attach / model-picker chrome is a
// legacy-composer feature deferred past the Phase 01 shell (goal §4 scope).

import { useTranslation } from 'react-i18next'
import { ArrowUp, X } from 'lucide-react'
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'

export function ThreadComposer(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 border-t border-[var(--hairline)] bg-ink-2 px-3 py-2.5">
      <ComposerPrimitive.Input
        placeholder={t('chat.composer.placeholder')}
        aria-label={t('chat.composer.placeholder')}
        className={cn(
          'scrollbar-thin max-h-32 flex-1 resize-none rounded-lg border bg-ink-3 px-3 py-2',
          'text-body leading-snug text-ink-fg outline-none placeholder:text-ink-fg-3',
          'border-[rgb(var(--ink-border))] focus-visible:border-[rgb(var(--c-accent))]'
        )}
        rows={1}
        autoFocus
      />
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
    </ComposerPrimitive.Root>
  )
}
