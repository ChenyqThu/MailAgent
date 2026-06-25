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
import { AiSdkRuntimeProvider } from './runtime/AiSdkRuntimeProvider'
import {
  getChatRuntimeMode,
  isAiSdkContextInjectionEnabled,
  isAiSdkGatewayEnabled,
  resolveAiGatewayBaseUrl
} from './runtime/flags'
import { AssistantThread } from './components/thread'
import { useChatContextChips } from './context/useChatContextChips'
import { useAgentContextSnapshot } from './context/useAgentContextSnapshot'
import type { CapabilityContext, ContextScope } from './context/contextSnapshot'
import { chatMessageToUIMessage } from './uiMessage'

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

  // chat-panel P4 Phase 02/06a — the embedded AI SDK Gateway path is live when the runtime resolves
  // to 'ai-sdk', the gateway is enabled, and its loopback port was discovered (?aiGatewayPort=).
  // resolveAiGatewayBaseUrl reads window.location.search once; the flags are build-time constants.
  const gatewayBaseUrl = useMemo(() => resolveAiGatewayBaseUrl(), [])
  const aiSdkEnabled =
    getChatRuntimeMode() === 'ai-sdk' && isAiSdkGatewayEnabled() && gatewayBaseUrl !== null

  // Phase 06a (cutover) — backend is now STATEFUL (was hardcoded custom-api). A fresh conversation
  // defaults to the 'ai-sdk' kind when the gateway path is live, else legacy 'custom-api'. Opening an
  // OLD session from the global history page (pendingOpen carries its backend_kind) re-scopes the
  // panel to that kind via selectBackend so it renders on the matching runtime (custom-api → legacy,
  // retired notion-agent → read-only). "+New" returns to the default kind.
  const [backend, setBackend] = useState<BackendChoice>(() => ({
    kind: aiSdkEnabled ? 'ai-sdk' : 'custom-api',
    model,
    agentPageId: null
  }))
  const selectBackend = useCallback((next: BackendChoice): void => setBackend(next), [])

  const sidebarOpen = useAIChatPanel((s) => s.sidebarOpen)
  const toggleSidebar = useAIChatPanel((s) => s.toggleSidebar)
  const setSidebarOpen = useAIChatPanel((s) => s.setSidebarOpen)
  // Phase 06a — one-shot signals from the sidebar tabs + the global session-history page (the same
  // store the legacy panel consumes): requestedBackendKind switches the panel's kind; pendingOpen
  // opens a specific (email, session) re-scoping the kind first. consume* clears them once applied.
  const requestedBackendKind = useAIChatPanel((s) => s.requestedBackendKind)
  const consumeRequestedBackend = useAIChatPanel((s) => s.consumeRequestedBackend)
  const pendingOpen = useAIChatPanel((s) => s.pendingOpen)
  const consumePendingOpen = useAIChatPanel((s) => s.consumePendingOpen)

  const chat = useEmailChat(activeInternalId, backend.kind)
  const ctx = useChatContextChips(activeInternalId)
  const toolCallsByMessage = useSessionToolCalls(chat.messages, chat.streamingMessageId)

  // AI SDK runtime engages when the ACTIVE backend kind is 'ai-sdk' AND the gateway path is live. An
  // old custom-api / notion-agent session (opened via pendingOpen) re-scopes backend.kind, so the
  // render routes by kind below even while aiSdkEnabled is globally true.
  const useAiSdkRuntime = backend.kind === 'ai-sdk' && aiSdkEnabled

  // chat-panel P4 Phase 06 — context injection (flag-gated). On → build + send the typed
  // AgentContextSnapshot, read ContextChips from it, and seed prior-session messages (reload). Off
  // (default) → the AI SDK path stays Phase-02 context-light, byte-identical.
  const contextInjectionOn = useAiSdkRuntime && isAiSdkContextInjectionEnabled()
  const contextScope = useMemo<ContextScope>(
    () => ({
      surface: 'email-chat',
      anchorType: 'email',
      anchorId: activeInternalId,
      sessionId: chat.activeSessionId,
      backendKind: 'ai-sdk'
    }),
    [activeInternalId, chat.activeSessionId]
  )
  // Phase 01 shell defers the in-composer thinking toggle + attachment chips; tool calling is always
  // available on the gateway. enabledSkills is empty here (the panel doesn't compute manifest skill
  // enablement) → the capabilities block honestly reads "none beyond the built-in tools".
  const contextCapabilities = useMemo<CapabilityContext>(
    () => ({
      thinkingEnabled: false,
      attachmentsEnabled: false,
      toolCallingEnabled: true,
      humanApprovalRequired: true,
      enabledSkills: []
    }),
    []
  )
  const { snapshot: contextSnapshot } = useAgentContextSnapshot({
    activeInternalId,
    scope: contextScope,
    capabilities: contextCapabilities,
    panelMode: fullScreen ? 'fullscreen' : 'dock',
    enabled: contextInjectionOn
  })
  // Session reload (§13.8.5): seed the AI SDK runtime with the active session's prior messages. Guard
  // the selectSession race (activeSessionId flips BEFORE refresh reloads messages) by gating on
  // useEmailChat's messagesSessionId — the session id `messages` actually reflect (set only after a
  // load lands). Empty matters: a `.some()` check would read a 0-row session OR a stale empty array
  // both as ready, mounting an empty thread that never re-seeds; messagesSessionId distinguishes a
  // loaded-empty session (===activeSessionId → ready) from a still-loading stale array (≠ → defer).
  const reloadMessagesReady =
    chat.activeSessionId === null || chat.messagesSessionId === chat.activeSessionId
  const initialMessages = useMemo(
    () =>
      contextInjectionOn && reloadMessagesReady
        ? chat.messages.map(chatMessageToUIMessage)
        : undefined,
    [contextInjectionOn, reloadMessagesReady, chat.messages]
  )

  // ── Phase 06a: old-session re-scope (lifted from the legacy panel's proven pattern) ──────────
  // Alias the two chat members the pendingOpen effect reads so exhaustive-deps tracks each as a
  // distinct identifier (multi-member access on the un-memoized `chat` collapses to "the whole chat",
  // which changes identity every render and would re-run the effect spuriously).
  const chatSessions = chat.sessions
  const chatSelectSession = chat.selectSession
  // Sidebar tab click → switch the panel onto that kind. Consume even when the kind already matches
  // so a later same-kind click isn't swallowed by a stale flag.
  useEffect(() => {
    if (requestedBackendKind === null) return
    if (requestedBackendKind !== backend.kind) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot signal action, not derived
      selectBackend({
        kind: requestedBackendKind,
        model: requestedBackendKind === 'custom-api' ? (backend.model ?? readModelPref()) : null,
        agentPageId: null
      })
    }
    consumeRequestedBackend()
  }, [requestedBackendKind, backend.kind, backend.model, selectBackend, consumeRequestedBackend])

  // Global session-history row click → after the active email re-keyed + this email's sessions
  // loaded, select the exact target. If it's a different kind, switch first (re-scope) and bail; the
  // next render (now on the right kind, the hook re-filtered + reloaded that kind's sessions) finds
  // and selects it. One-shot pendingOpen consumed only after the select fires.
  useEffect(() => {
    if (pendingOpen === null) return
    if (activeInternalId !== pendingOpen.emailId) return
    if (backend.kind !== pendingOpen.backendKind) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot signal action, not derived
      selectBackend({
        kind: pendingOpen.backendKind,
        model: pendingOpen.backendKind === 'custom-api' ? (backend.model ?? readModelPref()) : null,
        agentPageId: null
      })
      return
    }
    const loadedForThisEmail = chatSessions.some((s) => s.email_id === pendingOpen.emailId)
    if (!loadedForThisEmail) return
    if (chatSessions.find((s) => s.id === pendingOpen.sessionId)) {
      void chatSelectSession(pendingOpen.sessionId)
    }
    consumePendingOpen()
  }, [
    pendingOpen,
    activeInternalId,
    backend.kind,
    backend.model,
    selectBackend,
    chatSessions,
    chatSelectSession,
    consumePendingOpen
  ])

  // Phase 06a — eager ai-sdk session creation on the FIRST send of a fresh conversation. The AI SDK
  // transport calls this (via the runtime latch) only when there's no session yet; we create the
  // backend_kind='ai-sdk' row through the same IPC the legacy path uses, adopt it into the hook state
  // (history / title / reload), and hand the id back so the gateway persists the turn into it.
  const onEnsureSession = useCallback(async (): Promise<number> => {
    if (activeInternalId === null) {
      throw new Error('cannot create an ai-sdk session without an active email')
    }
    const session = await mailApi.chat.newSession({
      anchorType: 'email',
      emailId: activeInternalId,
      backendKind: 'ai-sdk',
      backendModel: backend.model
    })
    chat.adoptSession(session)
    return session.id
  }, [activeInternalId, mailApi, backend.model, chat])

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
            snapshot={contextInjectionOn ? contextSnapshot : undefined}
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

              {useAiSdkRuntime && gatewayBaseUrl ? (
                contextInjectionOn && !reloadMessagesReady ? (
                  // Phase 06 — session switch in flight: defer the mount until chat.messages match the
                  // active session, so the runtime never seeds stale history. Brief; refresh() then
                  // flips reloadMessagesReady and the runtime mounts seeded with the right messages.
                  emptyMessages
                ) : (
                  // Phase 02/06 AI SDK path: a fresh thread streams straight from the embedded
                  // Gateway; turns persist into chat.activeSessionId (Gateway dual-write). Phase 06:
                  // keyed by (email, session) so picking a history session remounts seeded with that
                  // session's prior messages (initialMessages) + sends the typed context snapshot.
                  // Flag-off → context-light, keyed by email only (byte-identical to Phase 02).
                  <AiSdkRuntimeProvider
                    key={
                      // Phase 06a — key on the session id ONLY when RELOADING an existing session
                      // (initialMessages non-empty); a fresh / just-adopted conversation (empty
                      // messages) keeps `:new` so onEnsureSession setting activeSessionId mid-first-
                      // send does NOT remount the provider and interrupt the in-flight turn. Email
                      // switch (activeInternalId) + history select (seeded id) still remount + re-seed.
                      contextInjectionOn
                        ? `${activeInternalId ?? 'none'}:${
                            initialMessages && initialMessages.length > 0
                              ? chat.activeSessionId
                              : 'new'
                          }`
                        : (activeInternalId ?? 'none')
                    }
                    gatewayBaseUrl={gatewayBaseUrl}
                    sessionId={chat.activeSessionId}
                    model={backend.model}
                    contextSnapshot={contextSnapshot}
                    initialMessages={initialMessages}
                    onEnsureSession={onEnsureSession}
                  >
                    <AssistantThread emptyState={emptyMessages} />
                  </AiSdkRuntimeProvider>
                )
              ) : backend.kind === 'notion-agent' ? (
                // Phase 06a — a retired notion-agent session opened from history renders READ-ONLY:
                // its prior messages show via the legacy adapter, but the composer is suppressed (no
                // new turns on a retired agent — the user starts a fresh ai-sdk chat to continue).
                <MailAgentRuntimeProvider
                  chat={chat}
                  toolCallsByMessage={toolCallsByMessage}
                  onSend={onSend}
                  onEdit={onEditMessage}
                  onReload={null}
                  sendDisabled
                >
                  <AssistantThread emptyState={emptyMessages} readOnly />
                </MailAgentRuntimeProvider>
              ) : (
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
              )}
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
