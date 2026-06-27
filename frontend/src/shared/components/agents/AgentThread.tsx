// MailAgent agent-view thread — demo-fidelity layout (chat-panel demo parity).
//
// Demo Thread paradigm: a SINGLE scroll viewport holding the welcome heading, the message column
// (44rem, centered), AND the composer in a sticky ViewportFooter. Empty state → the viewport is
// justify-center so welcome + composer sit vertically centered ("new chat"); after the first turn the
// footer docks to the bottom (sticky) and messages scroll above it. A floating ScrollToBottom appears
// when scrolled up; quick-action chips show below the composer only while the thread is empty.
// Built on the same headless ThreadPrimitive as the right pane but a SEPARATE component (independent
// demo styling) — it renders inside the same AssistantRuntimeProvider (no singleton, safe).

import { useEffect, useRef } from 'react'

import { AuiIf, ThreadPrimitive, useAuiState, type AssistantState } from '@assistant-ui/react'
import { ArrowDown, CornerDownRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'

import { AgentComposer } from './AgentComposer'
import {
  AgentAssistantMessage,
  AgentUserMessage,
  EditComposer,
  SystemMessage
} from './AgentMessage'

const THREAD_MESSAGE_COMPONENTS = {
  UserMessage: AgentUserMessage,
  AssistantMessage: AgentAssistantMessage,
  EditComposer,
  SystemMessage
}

// New-chat view = no messages yet → center the composer + show welcome / suggestions.
const isNewChatView = (s: AssistantState): boolean => s.thread.messages.length === 0

interface AgentThreadProps {
  /** Quick-action chips rendered below the composer while the thread is empty (AgentQuickActions). */
  quickActions?: React.ReactNode
  /** Read-only history (retired notion-agent / degraded ai-sdk) — suppress the composer. */
  readOnly?: boolean
  /** Legacy pending-confirmation ConfirmToolDialog (custom-api fallback), scrolls with the stream. */
  pendingSlot?: React.ReactNode
  /** Phase 10b — fires on the running→idle edge after an assistant reply (a turn just completed). The
   *  parent (ai-sdk path only) uses it to trigger configurable LLM auto-title. Omitted → no watcher. */
  onTurnComplete?: () => void
  /** dogfood-3 — dynamic follow-up suggestions for the latest completed turn (ai-sdk path). Rendered as
   *  autoSend chips above the composer in an active, idle thread. Empty / omitted → no chips. */
  followUps?: string[]
  /** assistant-modal P2 — welcome heading alignment. The floating modal left-aligns its welcome (the
   *  截图 layout); the /sessions agent view keeps the centered hero. Default 'center' → /sessions unchanged. */
  welcomeAlign?: 'center' | 'left'
  /** assistant-modal P5 — a removable context chip (the current email) rendered just above the composer.
   *  The modal passes the email chip; /sessions omits it → nothing rendered. */
  contextChip?: React.ReactNode
}

export function AgentThread({
  quickActions,
  readOnly = false,
  pendingSlot,
  onTurnComplete,
  followUps,
  welcomeAlign = 'center',
  contextChip
}: AgentThreadProps): React.JSX.Element {
  const isEmpty = useAuiState(isNewChatView)
  return (
    <ThreadPrimitive.Root
      className="flex min-h-0 flex-1 flex-col bg-ink-1 text-ink-fg"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      {onTurnComplete && <TurnCompleteWatcher onComplete={onTurnComplete} />}
      {/* dogfood round-7 — turnAnchor="top"：发送后用户消息钉到视口顶部、回复向下铺开，不再每个 chunk 瞬跳追底
          （旧 bottom-anchor 的 resize-follow 硬编码 scrollToBottom("instant") → "滚动生硬/跳变"）。这也实现了
          用户之前 deferred 的"首条消息上移 + 聚焦阅读"。scroll-smooth 给余下的 auto 滚动（ScrollToBottom 按钮）补平滑。 */}
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        className={cn(
          'scrollbar-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth px-4 pt-4',
          isEmpty && 'justify-center'
        )}
      >
        <AuiIf condition={isNewChatView}>
          <AgentWelcome align={welcomeAlign} />
        </AuiIf>

        <div className="mb-10 flex flex-col gap-y-5 empty:hidden">
          <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
        </div>
        {pendingSlot}

        <ThreadPrimitive.ViewportFooter
          className={cn(
            'relative mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-3 bg-ink-1 pb-3',
            !isEmpty && 'sticky bottom-0 mt-auto'
          )}
        >
          <AgentScrollToBottom />
          {/* dogfood-3 (follow-ups) — dynamic next-question chips above the composer for the latest
              completed turn (ai-sdk only). Active + idle thread only: AuiIf hides them while running so
              stale chips never overlap a new reply, and the welcome screen owns quick-actions instead.
              autoSend (assistant-ui Suggestion) → one tap sends the question through the runtime. */}
          {!readOnly && followUps && followUps.length > 0 && (
            <AuiIf condition={(s) => s.thread.messages.length > 0 && !s.thread.isRunning}>
              <div className="flex flex-wrap gap-2">
                {followUps.map((fu, i) => (
                  <ThreadPrimitive.Suggestion
                    key={`${i}-${fu}`}
                    prompt={fu}
                    autoSend
                    className="inline-flex items-center gap-1.5 rounded-full border border-ink-border-soft bg-ink-2 px-3 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
                  >
                    <CornerDownRight size={13} strokeWidth={1.75} className="shrink-0 text-coral" />
                    {fu}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </AuiIf>
          )}
          {/* assistant-modal P5 — removable email-context chip directly above the composer (modal only;
              /sessions omits contextChip → nothing here). */}
          {!readOnly && contextChip}
          {!readOnly && <AgentComposer />}
          <AuiIf condition={isNewChatView}>
            <AuiIf condition={(s) => s.composer.isEmpty}>
              <div className="min-h-[4.5rem]">{quickActions}</div>
            </AuiIf>
          </AuiIf>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function AgentWelcome({ align = 'center' }: { align?: 'center' | 'left' }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'mx-auto mb-6 flex w-full max-w-[var(--thread-max-width)] flex-col px-4',
        align === 'left' ? 'items-start text-left' : 'items-center text-center'
      )}
    >
      <h1 className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both text-2xl font-semibold text-ink-fg duration-200">
        {t('agentView.welcome')}
      </h1>
      <p className="mt-2 text-aux text-ink-fg-3">{t('agentView.emptyHint')}</p>
    </div>
  )
}

/** Phase 10b — fires `onComplete` on the running→idle edge once an assistant reply exists (a turn just
 *  completed). Renders nothing; lives inside the runtime provider so it can read thread state. The
 *  parent dedups per session, so firing every turn is harmless (the gateway is idempotent on an
 *  already-titled session). */
function TurnCompleteWatcher({ onComplete }: { onComplete: () => void }): null {
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const hasAssistant = useAuiState((s) => s.thread.messages.some((m) => m.role === 'assistant'))
  const prevRunningRef = useRef(isRunning)
  useEffect(() => {
    // running→idle edge with an assistant reply = a turn just completed. onComplete is in deps (the
    // parent memoizes it); a changing identity re-runs the effect but can't false-fire — prevRunning
    // already equals isRunning by then, so the edge condition is false.
    if (prevRunningRef.current && !isRunning && hasAssistant) onComplete()
    prevRunningRef.current = isRunning
  }, [isRunning, hasAssistant, onComplete])
  return null
}

function AgentScrollToBottom(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        aria-label={t('agentView.scrollToBottom')}
        className="absolute -top-12 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-[var(--hairline)] bg-ink-2 text-ink-fg-1 shadow-md transition-colors duration-fast hover:bg-ink-3 disabled:invisible"
      >
        <ArrowDown size={16} strokeWidth={2} />
      </button>
    </ThreadPrimitive.ScrollToBottom>
  )
}
