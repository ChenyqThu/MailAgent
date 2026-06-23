// chat-panel P4 Phase 01 — assistant-ui chat panel (email surface).
//
// The flag-on (MAILAGENT_ASSISTANT_UI_PANEL=1) replacement for the legacy
// AIChatPanel. Same panel CHROME — 360px right rail / full-window popout, the
// 40px header (New / History / Popout / Close), BackendSelector, ContextChips,
// session-history popover, error banner, quota cooldown, onboarding/empty states
// — but the message list + composer become assistant-ui primitives driven by the
// legacy ExternalStore adapter (MailAgentRuntimeProvider → AssistantThread). The
// legacy useEmailChat hook stays the SSoT (IPC stream, race guards) — this panel
// only re-projects its state into assistant-ui and routes send/edit/retry/stop
// back. No new LLM provider path: every turn still flows through chat.send →
// mailApi.chat.start → the existing dispatcher.
//
// Deferred to later phases (legacy-composer features, not Phase 01 shell scope):
// @mention / attachment chips, in-composer model picker + thinking toggle, the
// rich DraftPreviewCard / KOS-Notion message footer (→ phase-04 A2UI cards).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { History, Maximize2, Plus, Settings, Sparkles, X } from 'lucide-react'

import type { ChatMessage, ChatToolCall } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useActiveEmail } from '@shared/state/active-email'
import { hideAIChatPanel, useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useEmailChat } from '@shared/hooks/useEmailChat'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'
import { toastError } from '@shared/state/toast'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { BackendSelector, type BackendChoice } from '@shared/components/chat/BackendSelector'
import { ChatHistoryPopover } from '@shared/components/chat/ChatHistoryPopover'
import { ConfirmToolDialog } from '@shared/components/chat/ConfirmToolDialog'
import { ContextChips } from '@shared/components/chat/ContextChips'

import { MailAgentRuntimeProvider } from './runtime/MailAgentRuntimeProvider'
import { AssistantThread } from './components/thread'
import { useChatContextChips } from './context/useChatContextChips'

// custom-api is the only selectable backend (notion-agent retired as a new
// session backend — task 06-18). Phase 01 shell defaults to the user's last
// model pref; the in-composer model picker is deferred (legacy-composer feature).
const CUSTOM_MODEL_PREF = 'mailagent.chat.customModel'
const DEFAULT_CUSTOM_MODEL = 'claude-sonnet-4-6'
function readModelPref(): string {
  try {
    return localStorage.getItem(CUSTOM_MODEL_PREF) || DEFAULT_CUSTOM_MODEL
  } catch {
    return DEFAULT_CUSTOM_MODEL
  }
}

/** Map a chat error code → i18n key (parity with legacy AIChatPanel.mapErrorKey).
 *  Only the codes custom-api can surface matter here; notion-agent is retired. */
function mapErrorKey(code: string): string {
  switch (code) {
    case 'E_NO_LLM_KEY':
      return 'chat.error.noKey'
    case 'E_QUOTA':
      return 'chat.error.quota'
    case 'E_ABORTED':
      return 'chat.error.abort'
    case 'E_NETWORK':
      return 'chat.error.network'
    case 'E_MODEL_UNSUPPORTED':
      return 'chat.error.modelUnsupported'
    case 'E_UPSTREAM':
    default:
      return 'chat.error.upstream'
  }
}

interface AIChatPanelProps {
  fullScreen?: boolean
  fillWrapper?: boolean
}

/** chat-panel P4 Phase 01 — fetch persisted tool audit rows for SETTLED assistant
 *  messages, once each. Hoisted from the legacy per-bubble useToolCalls because
 *  the assistant-ui converter (panel closure) needs them keyed by message id.
 *  Streaming rows are skipped (they ride the live event map); the fetch fires
 *  once per id (fetchedRef guard) — audit is non-critical, failures stay silent. */
function useSessionToolCalls(
  messages: ReadonlyArray<ChatMessage>,
  streamingMessageId: number | null
): Map<number, ChatToolCall[]> {
  const mailApi = useMailApi()
  const [byId, setById] = useState<Map<number, ChatToolCall[]>>(new Map())
  const fetchedRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    const missing = messages
      .filter(
        (m) =>
          m.role === 'assistant' && m.id !== streamingMessageId && !fetchedRef.current.has(m.id)
      )
      .map((m) => m.id)
    if (missing.length === 0) return undefined
    missing.forEach((id) => fetchedRef.current.add(id))
    let cancelled = false
    void Promise.all(
      missing.map(async (id) => {
        try {
          return [id, await mailApi.chat.listToolCalls(id)] as const
        } catch {
          return [id, [] as ChatToolCall[]] as const
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      setById((prev) => {
        const next = new Map(prev)
        for (const [id, rows] of pairs) next.set(id, rows)
        return next
      })
    })
    return (): void => {
      cancelled = true
    }
  }, [messages, streamingMessageId, mailApi])

  return byId
}

export function AssistantUIChatPanel({
  fullScreen = false,
  fillWrapper = false
}: AIChatPanelProps = {}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const activeInternalId = useActiveEmail((s) => s.activeInternalId)

  const [model] = useState(() => readModelPref())
  const backend: BackendChoice = useMemo(
    () => ({ kind: 'custom-api', model, agentPageId: null }),
    [model]
  )

  const sidebarOpen = useAIChatPanel((s) => s.sidebarOpen)
  const toggleSidebar = useAIChatPanel((s) => s.toggleSidebar)
  const setSidebarOpen = useAIChatPanel((s) => s.setSidebarOpen)

  const chat = useEmailChat(activeInternalId, backend.kind)
  const ctx = useChatContextChips(activeInternalId)
  const toolCallsByMessage = useSessionToolCalls(chat.messages, chat.streamingMessageId)

  // custom-api readiness = keychain llmApiKey present (mirror of legacy gate).
  const secretsQ = useQuery({
    queryKey: ['settings', 'secrets-status'],
    queryFn: () => mailApi.settings.secretsStatus(),
    staleTime: 30_000
  })
  const backendConfigured = secretsQ.data?.llmApiKey === true

  // Sidebar session preview cache (lazy on open) — same shape as legacy.
  const [sessionPreviews, setSessionPreviews] = useState<Record<number, string | null>>({})
  useEffect(() => {
    if (!sidebarOpen) return undefined
    const missing = chat.sessions.filter((s) => !(s.id in sessionPreviews))
    if (missing.length === 0) return undefined
    let cancelled = false
    void Promise.all(
      missing.map(async (s) => {
        try {
          const msgs = await mailApi.chat.listMessages(s.id)
          const firstUser = msgs.find((m) => m.role === 'user')
          const preview = firstUser?.content?.trim() ?? null
          return [s.id, preview === null ? null : preview.slice(0, 80)] as const
        } catch {
          return [s.id, null] as const
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      setSessionPreviews((cur) => {
        const next = { ...cur }
        for (const [id, preview] of pairs) next[id] = preview
        return next
      })
    })
    return (): void => {
      cancelled = true
    }
  }, [sidebarOpen, chat.sessions, sessionPreviews, mailApi])

  const quotaCooldownUntil = chat.quotaCooldownUntil
  const inQuotaCooldown = quotaCooldownUntil !== null && chat.quotaCooldownKind === backend.kind

  // ── adapter action callbacks (close over backend + email context) ──────────
  const onSend = useCallback(
    async (text: string): Promise<void> => {
      if (activeInternalId === null) return
      await chat.send({
        message: text,
        backendKind: backend.kind,
        backendModel: backend.model,
        backendAgentPageId: backend.agentPageId,
        senderName: ctx.detail?.sender_name ?? null,
        subject: ctx.detail?.subject ?? null,
        // Phase 01 shell: extended-thinking toggle is a legacy-composer feature
        // (deferred). Sends false — identical to legacy with the toggle off.
        thinking: false
      })
    },
    [activeInternalId, chat, backend, ctx.detail]
  )

  const onEditMessage = useCallback(
    async (messageId: number, text: string): Promise<void> => {
      await chat.editMessage({
        messageId,
        newContent: text,
        backendKind: backend.kind,
        backendModel: backend.model,
        backendAgentPageId: backend.agentPageId,
        thinking: false
      })
    },
    [chat, backend]
  )

  // ── pending tool confirmation (legacy ConfirmToolDialog fallback) ──────────
  const headConfirmation = chat.pendingConfirmations[0] ?? null
  const handleConfirmTool = useCallback(
    async (editedInput?: unknown): Promise<void> => {
      if (!headConfirmation) return
      const result = await chat.confirmTool(headConfirmation.toolUseId, true, editedInput)
      if (!result.ok && result.code !== 'E_NOT_PENDING') {
        toastError(t('chat.confirmTool.failed', { defaultValue: 'Confirm failed' }))
      }
    },
    [chat, headConfirmation, t]
  )
  const handleCancelTool = useCallback(async (): Promise<void> => {
    if (!headConfirmation) return
    await chat.confirmTool(headConfirmation.toolUseId, false)
  }, [chat, headConfirmation])

  // ⇧⌥H toggles the session history popover (same mnemonic as legacy).
  useShortcut('alt+shift+h', () => toggleSidebar())
  useShortcut('alt+shift+w', () => {
    if (activeInternalId === null) return
    mailApi.chat.openPopout(activeInternalId)
    hideAIChatPanel()
  })

  const errorBanner = chat.error ? mapErrorKey(chat.error.code) : null
  const retryActionKlass = useCjkMonoSwap('text-meta font-mono')

  const handleNewSession = useCallback(() => {
    chat.newSession()
  }, [chat])

  const emptyMessages = (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-aux text-ink-fg-2">
      {t('chat.empty.noMessages')}
    </div>
  )

  const pendingSlot =
    headConfirmation !== null ? (
      <div className="px-1 pt-2">
        <ConfirmToolDialog
          key={headConfirmation.toolUseId}
          pending={headConfirmation}
          onConfirm={(editedInput) => handleConfirmTool(editedInput)}
          onCancel={() => handleCancelTool()}
        />
      </div>
    ) : undefined

  return (
    <aside
      aria-label="ai-chat-panel"
      data-assistant-ui-panel
      className={cn(
        'glass-panel flex min-h-0 flex-col border-l border-ink-border',
        fullScreen
          ? 'w-full flex-1 border-l-0'
          : fillWrapper
            ? 'w-full shrink-0'
            : 'w-[360px] max-w-[92vw] shrink-0'
      )}
    >
      {/* Header bar (40px) — title + New / History / Popout / Close (legacy chrome). */}
      <div
        className={cn(
          'relative flex h-10 shrink-0 items-center border-b border-ink-border',
          fullScreen ? 'pl-[78px] pr-3' : 'px-3'
        )}
        style={fullScreen ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
      >
        <div className="flex items-center gap-1.5 text-aux font-medium text-ink-fg">
          <Sparkles size={13} strokeWidth={0} className="fill-coral text-coral" />
          {t('chat.title')}
        </div>
        <div
          className="ml-auto flex items-center gap-1"
          style={fullScreen ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          <HoverTip text={`${t('chat.newChat')}\n${t('chat.newChatHint')}`} side="bottom">
            <button
              type="button"
              aria-label={t('chat.newChat')}
              onClick={handleNewSession}
              className={cn(
                'rounded p-1.5 text-ink-fg-2 hover:text-ink-fg',
                'transition-colors duration-fast hover:bg-ink-4'
              )}
            >
              <Plus size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          <HoverTip text={`${t('chat.history')}\n${t('chat.historyHint')}`} side="bottom">
            <button
              type="button"
              data-chat-history-toggle
              aria-label={t('chat.history')}
              aria-pressed={sidebarOpen}
              onClick={() => toggleSidebar()}
              className={cn(
                'rounded p-1.5 transition-colors duration-fast',
                sidebarOpen
                  ? 'bg-ink-4 text-ink-fg'
                  : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
              )}
            >
              <History size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          {!fullScreen && (
            <HoverTip text={t('chat.popout.button')} side="bottom">
              <button
                type="button"
                aria-label={t('chat.popout.button')}
                disabled={activeInternalId === null}
                onClick={() => {
                  if (activeInternalId === null) return
                  mailApi.chat.openPopout(activeInternalId)
                  hideAIChatPanel()
                }}
                className={cn(
                  'rounded p-1.5 transition-colors duration-fast',
                  activeInternalId === null
                    ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
                    : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
                )}
              >
                <Maximize2 size={13} strokeWidth={2} />
              </button>
            </HoverTip>
          )}
          <HoverTip text={fullScreen ? t('chat.popout.close') : t('chat.closePanel')} side="bottom">
            <button
              type="button"
              onClick={() => {
                if (fullScreen) window.close()
                else hideAIChatPanel()
              }}
              aria-label={fullScreen ? t('chat.popout.close') : t('chat.closePanel')}
              className={cn(
                'rounded p-1.5 text-ink-fg-2 hover:text-ink-fg',
                'transition-colors duration-fast hover:bg-ink-4'
              )}
            >
              <X size={13} strokeWidth={2} />
            </button>
          </HoverTip>
        </div>

        {sidebarOpen && (
          <ChatHistoryPopover
            backendKind={backend.kind}
            sessions={chat.sessions}
            activeSessionId={chat.activeSessionId}
            previews={sessionPreviews}
            onSelectSession={(sid) => void chat.selectSession(sid)}
            onNewSession={handleNewSession}
            onClose={() => setSidebarOpen(false)}
            onDeleteSession={(sid) => chat.deleteSession(sid)}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
          <BackendSelector value={backend} agentName={null} />
          <ContextChips
            hasEmailBody={ctx.hasEmailBody}
            aiFieldsCount={ctx.aiFieldsCount}
            threadCount={ctx.threadCount}
            notionProjectCount={0}
          />

          {!backendConfigured ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="grid h-10 w-10 place-items-center rounded-lg border border-coral/30 bg-coral/15">
                <Settings size={18} strokeWidth={2} className="text-coral" />
              </div>
              <div className="text-aux text-ink-fg">
                {t('chat.onboarding.notConfigured', { backend: t('chat.backend.customApi') })}
              </div>
              <button
                type="button"
                onClick={() => void navigate({ to: '/settings', search: { tab: 'ai' } })}
                className={cn(
                  'mt-1 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5',
                  'text-aux font-medium text-accent-fg bg-coral/100 hover:bg-coral-hover',
                  'transition-colors duration-fast'
                )}
              >
                <Settings size={12} strokeWidth={2} />
                {t('chat.onboarding.openSettings')}
              </button>
            </div>
          ) : activeInternalId === null ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-aux text-ink-fg-2">
              {t('chat.empty.noEmail')}
            </div>
          ) : (
            <>
              {errorBanner && (
                <div className="mx-3 my-2 flex items-start gap-2 rounded-md border border-fail/30 bg-fail/10 px-3 py-2 text-aux text-fail">
                  <span className="flex-1">{t(errorBanner)}</span>
                  {chat.retryLast && (
                    <button
                      type="button"
                      onClick={() => void chat.retryLast?.()}
                      className={cn(
                        retryActionKlass,
                        'rounded px-2 py-0.5 text-fail transition-colors duration-fast hover:bg-fail/15'
                      )}
                    >
                      {t('chat.error.retry')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={chat.clearError}
                    className={cn(retryActionKlass, 'text-ink-fg-2 hover:text-ink-fg-1')}
                    aria-label="dismiss"
                  >
                    ×
                  </button>
                </div>
              )}

              {inQuotaCooldown && quotaCooldownUntil !== null && (
                <QuotaCooldownTimer until={quotaCooldownUntil} />
              )}

              <MailAgentRuntimeProvider
                chat={chat}
                toolCallsByMessage={toolCallsByMessage}
                onSend={onSend}
                onEdit={onEditMessage}
                onReload={chat.retryLast ?? null}
                sendDisabled={inQuotaCooldown}
              >
                <AssistantThread pendingSlot={pendingSlot} emptyState={emptyMessages} />
              </MailAgentRuntimeProvider>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}

// Quota cooldown timer — re-renders every ~250ms so the seconds readout stays
// current without polluting useEmailChat with timer state (parity with legacy).
function QuotaCooldownTimer({ until }: { until: number }): React.ReactElement | null {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const bannerKlass = useCjkMonoSwap('text-meta font-mono')
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 250)
    return (): void => clearInterval(interval)
  }, [])
  const remainingMs = Math.max(0, until - now)
  if (remainingMs === 0) return null
  const seconds = Math.ceil(remainingMs / 1000)
  return (
    <div
      className={cn(
        'mx-3 mb-2 rounded-md border border-urg/30 bg-urg/10 px-3 py-1.5 text-urg',
        bannerKlass
      )}
    >
      {t('chat.error.quotaCooldown', { seconds })}
    </div>
  )
}
