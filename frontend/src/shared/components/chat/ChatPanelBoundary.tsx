// fe-review P2-9 — local error boundary for the AI chat surfaces (popout
// shell / assistant modal / agent view). The chat subtree — third-party
// assistant-ui plus streaming tool events — has the highest crash odds in the
// app; without a local boundary a crash falls through to the root boundary
// and blanks the whole window. Reset re-renders the children as a fresh mount
// (React unmounted the crashed subtree on catch): render state is dropped,
// while the conversation itself lives in ai_chat.db / zustand and survives.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, RefreshCw } from 'lucide-react'

import { ErrorBoundary } from '../ErrorBoundary'

export function ChatPanelBoundary({
  children,
  resetKeys
}: {
  children: ReactNode
  /** Identity of the content under the boundary (e.g. active session id).
   *  Switching it while crashed auto-clears the error so a dead session's
   *  error screen never blocks a healthy one. */
  resetKeys?: readonly unknown[]
}): React.ReactElement {
  return (
    <ErrorBoundary
      label="chat-panel"
      resetKeys={resetKeys}
      fallback={({ error, reset }) => <ChatPanelErrorFallback error={error} onReset={reset} />}
    >
      {children}
    </ErrorBoundary>
  )
}

// Visual mirrors CalendarErrorBoundary's fallback (coral alert dot, truncated
// message, hint, reset) — the established in-app pattern for panel crashes.
function ChatPanelErrorFallback({
  error,
  onReset
}: {
  error: Error
  onReset: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const msg = error.message || String(error)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-coral/15">
        <AlertCircle size={22} strokeWidth={2} className="text-coral" />
      </div>
      <div className="text-aux font-medium text-ink-fg">{t('chat.panelError.title')}</div>
      {msg && (
        <div className="max-w-md break-words font-mono text-meta text-ink-fg-2">
          {msg.slice(0, 200)}
          {msg.length > 200 ? '…' : ''}
        </div>
      )}
      <div className="text-meta text-ink-fg-3">{t('chat.panelError.hint')}</div>
      <button
        type="button"
        onClick={onReset}
        className="mt-2 flex items-center gap-1.5 rounded-md border border-ink-border px-3 py-1.5 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
      >
        <RefreshCw size={13} strokeWidth={2} />
        {t('chat.panelError.reset')}
      </button>
    </div>
  )
}
