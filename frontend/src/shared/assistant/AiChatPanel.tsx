// AI chat panel (email surface) — the assistant-ui shell on the embedded AI SDK
// Gateway. S3 W2: the legacy runtime (custom-api engine + LegacyAIChatPanel +
// the flag dispatch layer) is deleted; this panel IS `AIChatPanel` now.
//
// Panel CHROME — 360px right rail / full-window popout, the 40px header (New /
// History / Popout / Close), BackendSelector meta row, ContextChips, session-
// history popover, error banner, onboarding/empty states — with assistant-ui
// primitives driven by the AI SDK runtime (useChatRuntime → embedded Gateway).
//
// D6 — old legacy sessions (backend_kind 'custom-api' / retired 'notion-agent')
// opened from history re-scope the panel onto their kind and render READ-ONLY
// via ReadOnlyTranscript (ui_message_json when present, plain-text fallback
// otherwise). "+New" returns to the ai-sdk kind.
//
// D7 — a failed gateway /health probe no longer silently swaps engines (there
// is no other engine): the panel surfaces an error notice + retry and keeps the
// current session readable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { History, Maximize2, Plus, Settings, Sparkles, X } from 'lucide-react'

import type { SearchHit } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useActiveEmail } from '@shared/state/active-email'
import { hideAIChatPanel, useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useEmailChat } from '@shared/hooks/useEmailChat'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { BackendSelector, type BackendChoice } from '@shared/components/chat/BackendSelector'
import { ChatHistoryPopover } from '@shared/components/chat/ChatHistoryPopover'
import { ContextChips } from '@shared/components/chat/ContextChips'
import { backendSupportsThinking } from '@shared/components/chat/backend_thinking'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { buildAttachmentBlock, type ChatAttachment } from '@shared/lib/chat-attachments'
import { buildMentionContext } from '@shared/lib/mention-context'
import { useApprovalMode } from '@shared/lib/approvalMode'

import { AiSdkRuntimeProvider } from './runtime/AiSdkRuntimeProvider'
import { ThreadRunningBridge } from './runtime/ThreadRunningBridge'
import { makeSessionSettledHandler } from './runtime/threadRunningGuard'
import { useBackgroundChatRun } from './runtime/useBackgroundChatRun'
import { useApprovalDecideBusy } from './useApprovalDecideBusy'
import { PendingApprovalPanel } from './PendingApprovalPanel'
import { resolveAiGatewayBaseUrl } from './runtime/flags'
import { AssistantThread } from './components/thread'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from './components/composerControls'
import { ReadOnlyTranscript } from './ReadOnlyTranscript'
import { useChatContextChips } from './context/useChatContextChips'
import { useAgentContextSnapshot } from './context/useAgentContextSnapshot'
import type { CapabilityContext, ContextScope } from './context/contextSnapshot'
import { chatMessageToUIMessage } from './uiMessage'

// Model pref (shared localStorage key with the agent view → one user preference
// across surfaces). New conversations default to the user's last explicit pick.
const CUSTOM_MODEL_PREF = 'mailagent.chat.customModel'
const DEFAULT_CUSTOM_MODEL = 'claude-sonnet-4-6'
function readModelPref(): string {
  try {
    return localStorage.getItem(CUSTOM_MODEL_PREF) || DEFAULT_CUSTOM_MODEL
  } catch {
    return DEFAULT_CUSTOM_MODEL
  }
}
function writeModelPref(model: string): void {
  try {
    localStorage.setItem(CUSTOM_MODEL_PREF, model)
  } catch {
    /* ignore — pref persistence is best-effort */
  }
}

// composer-parity C1-① — extended-thinking toggle pref (localStorage contract:
// '1'/'0'). Panel owns it; the composer toggle reads/writes via controls.
const THINKING_PREF = 'mailagent.chat.thinkingEnabled'
function readThinkingPref(): boolean {
  try {
    return localStorage.getItem(THINKING_PREF) === '1'
  } catch {
    return false
  }
}
function writeThinkingPref(on: boolean): void {
  try {
    localStorage.setItem(THINKING_PREF, on ? '1' : '0')
  } catch {
    /* ignore — pref persistence is best-effort */
  }
}

interface AIChatPanelProps {
  /** Full-window popout mode: drop the 360px fixed width, close = window.close(). */
  fullScreen?: boolean
  /** ≥xl squeeze-column layout — the wrapper owns the width; the panel fills it. */
  fillWrapper?: boolean
}

export function AIChatPanel({
  fullScreen = false,
  fillWrapper = false
}: AIChatPanelProps = {}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const activeInternalId = useActiveEmail((s) => s.activeInternalId)

  const [model] = useState(() => readModelPref())

  // The embedded AI SDK Gateway path is live when its base URL was discovered
  // (?aiGatewayPort= loopback / same-origin web proxy). resolveAiGatewayBaseUrl
  // reads window.location.search once. S3 — the flag gates are gone: reachable
  // base URL is the only condition (no other engine exists).
  const gatewayBaseUrl = useMemo(() => resolveAiGatewayBaseUrl(), [])
  const aiSdkEnabled = gatewayBaseUrl !== null

  // S3 W2 — new conversations are ALWAYS 'ai-sdk' (the only engine). The backend
  // stays stateful only for the D6 read-only re-scope: opening an OLD legacy
  // session from history (pendingOpen carries its backend_kind) re-scopes the
  // panel onto that kind so its transcript renders read-only; "+New" returns here.
  const [backend, setBackend] = useState<BackendChoice>(() => ({
    kind: 'ai-sdk',
    model,
    agentPageId: null
  }))
  const selectBackend = useCallback((next: BackendChoice): void => setBackend(next), [])

  const sidebarOpen = useAIChatPanel((s) => s.sidebarOpen)
  const toggleSidebar = useAIChatPanel((s) => s.toggleSidebar)
  const setSidebarOpen = useAIChatPanel((s) => s.setSidebarOpen)
  // One-shot signal from the global session-history surfaces: pendingOpen opens
  // a specific (email, session), re-scoping the panel's kind first (D6).
  // consumePendingOpen clears it once applied.
  const pendingOpen = useAIChatPanel((s) => s.pendingOpen)
  const consumePendingOpen = useAIChatPanel((s) => s.consumePendingOpen)

  const chat = useEmailChat(activeInternalId, backend.kind)
  const ctx = useChatContextChips(activeInternalId)

  // D6 — a re-scoped legacy session renders read-only; live turns require 'ai-sdk'.
  const isLegacySession = backend.kind !== 'ai-sdk'

  // composer-parity C1-①② — panel-owned extended-thinking + model state, surfaced to the assistant-ui
  // ThreadComposer (rendered inside the runtime provider) via ChatComposerControlsProvider below.
  const [thinkingEnabled, setThinkingEnabled] = useState(() => readThinkingPref())
  const onToggleThinking = useCallback((): void => {
    setThinkingEnabled((v) => {
      const next = !v
      writeThinkingPref(next)
      return next
    })
  }, [])
  const thinkingSupported = backendSupportsThinking(backend)
  const thinkingActive = thinkingSupported && thinkingEnabled
  // P1-2 (07-15 codex r1) — an in-panel approval decide runs the server-side resume synchronously
  // and holds that session's run lease; disable the composer for its duration (a send would 409).
  // codex r2 [E] — SESSION-scoped: only the deciding session's composer is fenced; switching to
  // another session unlocks immediately (the original request settles on its own).
  const { sendDisabled: approvalSendDisabled, onDecideBusyChange } = useApprovalDecideBusy(
    chat.activeSessionId
  )
  // PART 2 — auto-approval mode (Settings → AI), threaded into the ai-sdk runtime body.
  const approvalMode = useApprovalMode()
  const { models: availableModels } = useEnabledModels()
  const onModelChange = useCallback(
    (m: string): void => {
      writeModelPref(m)
      selectBackend({ kind: backend.kind, model: m, agentPageId: backend.agentPageId })
    },
    [selectBackend, backend.kind, backend.agentPageId]
  )

  // composer-parity C2 — @mention + attachment chips (panel-owned, surfaced via composerControls). The
  // mention body excerpts are resolved at SEND time; buildInjectedContext assembles the full prefix,
  // sent as body.injectedContext → gateway, chips cleared after a clean send (onConsumeInjected).
  const [mentions, setMentions] = useState<SearchHit[]>([])
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const onAddMention = useCallback((hit: SearchHit): void => {
    setMentions((cur) => (cur.some((m) => m.internal_id === hit.internal_id) ? cur : [...cur, hit]))
  }, [])
  const onRemoveMention = useCallback((internalId: number): void => {
    setMentions((cur) => cur.filter((m) => m.internal_id !== internalId))
  }, [])
  const onAddAttachment = useCallback((attachment: ChatAttachment): void => {
    setAttachments((cur) => [...cur, attachment])
  }, [])
  const onRemoveAttachment = useCallback((id: string): void => {
    setAttachments((cur) => cur.filter((a) => a.id !== id))
  }, [])
  const onConsumeInjected = useCallback((): void => {
    setMentions([])
    setAttachments([])
  }, [])
  // issue #61 Lane 3 (A2) — chips now render from the assistant-ui composer state (fed by the
  // attachment adapter); this panel list is only the injectedContext source, synced via the bridge.
  const attachmentBridge = useMemo(
    () => ({ onAdd: onAddAttachment, onRemove: onRemoveAttachment }),
    [onAddAttachment, onRemoveAttachment]
  )
  const buildInjectedContext = useCallback(async (): Promise<string> => {
    const mentionContext = await buildMentionContext(mentions, mailApi)
    const attachmentContext = buildAttachmentBlock(attachments)
    return `${attachmentContext}${mentionContext}`
  }, [mentions, mailApi, attachments])

  const composerControls = useMemo<ChatComposerControls>(
    () => ({
      thinkingSupported,
      thinkingEnabled,
      onToggleThinking,
      model: backend.model,
      availableModels,
      onModelChange,
      modelPickerDisabled: false,
      sendDisabled: approvalSendDisabled,
      mentions,
      onAddMention,
      onRemoveMention,
      attachments,
      onAddAttachment,
      onRemoveAttachment
    }),
    [
      thinkingSupported,
      thinkingEnabled,
      onToggleThinking,
      backend.model,
      availableModels,
      onModelChange,
      approvalSendDisabled,
      mentions,
      onAddMention,
      onRemoveMention,
      attachments,
      onAddAttachment,
      onRemoveAttachment
    ]
  )

  // Context injection — build + send the typed AgentContextSnapshot, read
  // ContextChips from it, and seed prior-session messages (reload). S3 — always
  // on for live ai-sdk sessions (the CONTEXT_INJECTION flag was GA'd away).
  const contextInjectionOn = !isLegacySession && aiSdkEnabled
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
  const contextCapabilities = useMemo<CapabilityContext>(
    () => ({
      thinkingEnabled: thinkingActive,
      attachmentsEnabled: false,
      toolCallingEnabled: true,
      humanApprovalRequired: true,
      enabledSkills: []
    }),
    [thinkingActive]
  )
  const { snapshot: contextSnapshot } = useAgentContextSnapshot({
    activeInternalId,
    scope: contextScope,
    capabilities: contextCapabilities,
    panelMode: fullScreen ? 'fullscreen' : 'dock',
    enabled: contextInjectionOn
  })
  // Session reload (§13.8.5): seed the AI SDK runtime with the active session's prior messages, gated
  // on useEmailChat's messagesSessionId — the session id `messages` actually reflect — so the runtime
  // never seeds stale history during a session switch. The D6 read-only branch shares this gate.
  const reloadMessagesReady =
    chat.activeSessionId === null || chat.messagesSessionId === chat.activeSessionId
  const initialMessages = useMemo(
    () =>
      contextInjectionOn && reloadMessagesReady
        ? chat.messages.map(chatMessageToUIMessage)
        : undefined,
    [contextInjectionOn, reloadMessagesReady, chat.messages]
  )

  // Part B (island live-refresh) — an island-approved HITL turn was resumed SERVER-SIDE by the
  // gateway, so the active session's ai_chat.db rows changed underneath the open panel (the useChat
  // state still shows the stale approval card). On the lifecycle's 'chat:session-updated' broadcast
  // for THIS session, reload its messages through the hook's existing DB→ChatMessage load path
  // (reloadActiveSession → refresh → chatMessageToUIMessage above), then bump the remount nonce so
  // the KEYED AiSdkRuntimeProvider re-seeds initialMessages — the runtime treats `messages` as a
  // per-mount initial set, so without the remount the reloaded rows never reach the thread. The
  // guard decision (skip other sessions / skip mid-stream) lives in makeSessionSettledHandler,
  // sensed by ThreadRunningBridge below — see that module for why bare thread.isRunning was wrong.
  // 🔴 IPC 订阅必须用返回的 disposer 清理（fe0437e：跨 contextBridge removeListener 匹配不到 →
  // listener 泄漏 + StrictMode 双订阅）。onSessionUpdated 是 optional（web HttpApi 缺省）→ ?. 。
  const [islandRefreshNonce, setIslandRefreshNonce] = useState(0)
  const aiSdkRunningRef = useRef(false)
  // harness-chat lane A (07-15) — reactive mirror of the mid-stream verdict (ThreadRunningBridge
  // onRunningChange) for the background-run placeholder (an own attached stream must not read as a
  // background run).
  const [aiSdkRunning, setAiSdkRunning] = useState(false)
  const chatReloadActiveSession = chat.reloadActiveSession
  const chatActiveSessionId = chat.activeSessionId
  useEffect(() => {
    // Single runtime (S3) — subscribe whenever the live ai-sdk path is the active surface (a D6
    // read-only legacy re-scope has no runtime to refresh). contextInjectionOn = !legacy && gateway.
    if (!contextInjectionOn) return undefined
    const dispose = mailApi.chat.onSessionUpdated?.(
      makeSessionSettledHandler({
        runningRef: aiSdkRunningRef,
        activeSessionId: chatActiveSessionId,
        reload: chatReloadActiveSession,
        onReloaded: () => setIslandRefreshNonce((n) => n + 1)
      })
    )
    return dispose
  }, [contextInjectionOn, mailApi, chatActiveSessionId, chatReloadActiveSession])

  // issue #61 Lane 3 (A2) — the runtime provider's remount key, extracted so the panel-attachment
  // mirror can reset EXACTLY when the runtime remounts (composer chips reset with it). Keying the
  // reset on anything looser (e.g. activeSessionId alone) breaks the first send of a fresh chat:
  // onEnsureSession adopts the session id BETWEEN the transport's session resolve and its
  // buildInjectedContext call, and an early clear would drop the attachment block mid-send (the
  // provider key deliberately stays ':new' through that adoption — see the key comment below).
  const runtimeKey = contextInjectionOn
    ? `${activeInternalId ?? 'none'}:${
        initialMessages && initialMessages.length > 0 ? chat.activeSessionId : 'new'
      }${islandRefreshNonce > 0 ? `:r${islandRefreshNonce}` : ''}`
    : `${activeInternalId ?? 'none'}`
  const attachmentScopeRef = useRef(runtimeKey)
  useEffect(() => {
    if (attachmentScopeRef.current === runtimeKey) return
    attachmentScopeRef.current = runtimeKey
    setAttachments([])
  }, [runtimeKey])

  // harness-chat lane A (B1/B2/B4) — detached-run awareness: probes /api/ai/run/active for THIS
  // session, shows the placeholder while a background run streams, reloads + re-seeds when it
  // settles, and (broadcast glue) refreshes unread badges + marks the watched session read on every
  // 'chat:turn-persisted'. onSessionsTouched refreshes the popover's local session rows (badge
  // source for the email-scoped history list).
  const chatRefreshSessions = chat.refreshSessions
  const { backgroundActive } = useBackgroundChatRun({
    gatewayBaseUrl,
    sessionId: chatActiveSessionId,
    enabled: contextInjectionOn,
    refreshNonce: islandRefreshNonce,
    localRunning: aiSdkRunning,
    onSettled: () => {
      void chatReloadActiveSession().then(() => setIslandRefreshNonce((n) => n + 1))
    },
    onSessionsTouched: () => {
      void chatRefreshSessions()
    }
  })

  // B4 — read watermark: whenever the ACTIVE session's rows are (re)loaded the user is looking at
  // them → mark read (fire-and-forget) + refresh the unified history so its badge clears.
  const queryClientForRead = useQueryClient()
  useEffect(() => {
    if (chatActiveSessionId == null || chat.messagesSessionId !== chatActiveSessionId) return
    void mailApi.chat.markSessionRead(chatActiveSessionId).then(() => {
      void queryClientForRead.invalidateQueries({ queryKey: qk.chat.allSessions() })
    })
  }, [chatActiveSessionId, chat.messagesSessionId, mailApi, queryClientForRead])

  // ── old-session re-scope ────────────────────────────────────────────────────
  // Alias the two chat members the pendingOpen effect reads so exhaustive-deps tracks each as a
  // distinct identifier (multi-member access on the un-memoized `chat` collapses to "the whole chat").
  const chatSessions = chat.sessions
  const chatSelectSession = chat.selectSession
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
        model: pendingOpen.backendKind === 'ai-sdk' ? (backend.model ?? readModelPref()) : null,
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

  // Eager ai-sdk session creation on the FIRST send of a fresh conversation. The AI SDK transport
  // calls this (via the runtime latch) only when there's no session yet; we create the
  // backend_kind='ai-sdk' row, adopt it into the hook state (history / title / reload), and hand the
  // id back so the gateway persists the turn into it.
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

  // Readiness = keychain llmApiKey present (the gateway reads the same slot in main).
  const secretsQ = useQuery({
    queryKey: qk.settings.secretsStatus(),
    queryFn: () => mailApi.settings.secretsStatus(),
    staleTime: 30_000
  })
  const backendConfigured = secretsQ.data?.llmApiKey === true

  // D7 — gateway health probe. When the ai-sdk path is expected live, probe the embedded gateway's
  // /health once per mount (sticky: staleTime Infinity). A definitive failure (after one retry) no
  // longer degrades to another engine (none exists): the panel shows an error notice + retry below
  // and keeps the current session readable (ReadOnlyTranscript).
  const healthQ = useQuery({
    queryKey: qk.aiGateway.health(gatewayBaseUrl),
    queryFn: async () => {
      const res = await fetch(`${gatewayBaseUrl}/health`)
      if (!res.ok) throw new Error('ai-gateway unhealthy')
      const body = (await res.json()) as { status?: string }
      if (body.status !== 'ok') throw new Error('ai-gateway unhealthy')
      return body
    },
    enabled: gatewayBaseUrl !== null,
    retry: 1,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  })
  const gatewayDegraded = aiSdkEnabled && healthQ.isError
  // The live runtime needs the base URL discovered AND a healthy probe.
  const gatewayUnavailable = !aiSdkEnabled || gatewayDegraded

  // B3 (harness-chat lane A, 07-15 owner拍板：无灵动岛方案优先) — the ACTIONABLE in-panel approval
  // card replaces the old informational "act on the island" notice (backlog A2 closed). After
  // seeding a HISTORY session (non-empty initialMessages — the paused turn persists REDACTED per
  // R2-3, so the card is the only actionable surface), the shared PendingApprovalPanel live-probes
  // the gateway stash and renders an approve/reject card on a hit; decisions ride the SAME
  // /api/ai/approval/decide the record view uses (island-independent). Decide → reload + re-seed
  // through the existing islandRefreshNonce machinery; miss → renders nothing (manual sessions have
  // no run read-state to derive an honest expired notice from).
  const pendingApprovalSessionId =
    contextInjectionOn && gatewayBaseUrl != null && initialMessages && initialMessages.length > 0
      ? chat.activeSessionId
      : null
  const pendingApprovalCard =
    pendingApprovalSessionId !== null ? (
      <PendingApprovalPanel
        sessionId={pendingApprovalSessionId}
        refreshKey={islandRefreshNonce}
        onDecided={() => {
          void chatReloadActiveSession().then(() => setIslandRefreshNonce((n) => n + 1))
        }}
        onDecideBusyChange={onDecideBusyChange}
      />
    ) : undefined
  // B1 — "AI 仍在后台输出" placeholder while a detached run streams for this session (truth =
  // /api/ai/run/active); the settle transition reloads + re-seeds automatically.
  const backgroundRunNotice = backgroundActive ? (
    <div
      data-background-run-notice
      className="mt-2 flex shrink-0 items-center gap-2 rounded-md border border-ink-border bg-ink-3/70 px-3 py-2 text-aux text-ink-fg-2"
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-coral/100" aria-hidden />
      {t('chat.aiSdk.backgroundRunning')}
    </div>
  ) : undefined
  const pendingSlotContent =
    pendingApprovalCard || backgroundRunNotice ? (
      <>
        {backgroundRunNotice}
        {pendingApprovalCard}
      </>
    ) : undefined

  // Sidebar session preview cache (lazy on open).
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

  // ⇧⌥H toggles the session history popover; ⇧⌥W pops the conversation out.
  useShortcut('alt+shift+h', () => toggleSidebar())
  useShortcut('alt+shift+w', () => {
    if (activeInternalId === null) return
    mailApi.chat.openPopout(activeInternalId)
    hideAIChatPanel()
  })

  const retryActionKlass = useCjkMonoSwap('text-meta font-mono')

  // "+New" — a fresh conversation is always ai-sdk; a legacy read-only re-scope
  // returns to the default kind here (D6).
  const handleNewSession = useCallback(() => {
    if (backend.kind !== 'ai-sdk') {
      selectBackend({ kind: 'ai-sdk', model: readModelPref(), agentPageId: null })
    }
    chat.newSession()
  }, [backend.kind, selectBackend, chat])

  const emptyMessages = (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-aux text-ink-fg-2">
      {t('chat.empty.noMessages')}
    </div>
  )

  // D6/D7 shared read-only transcript of the active session (only once its load
  // landed, so the seed is never stale).
  const readOnlyTranscript = reloadMessagesReady ? (
    <ReadOnlyTranscript
      messages={chat.messages}
      sessionKey={chat.activeSessionId ?? 'none'}
      emptyState={emptyMessages}
    />
  ) : (
    emptyMessages
  )

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
      {/* Header bar (40px) — title + New / History / Popout / Close. */}
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
              {chat.error && (
                <div className="mx-3 my-2 flex items-start gap-2 rounded-md border border-fail/30 bg-fail/10 px-3 py-2 text-aux text-fail">
                  <span className="flex-1">{t('chat.error.upstream')}</span>
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

              {isLegacySession ? (
                // D6 — old legacy-engine session: read-only transcript + notice.
                <>
                  <div
                    data-legacy-readonly-notice
                    className="mx-3 my-2 rounded-md border border-ink-border bg-ink-3/70 px-3 py-2 text-aux text-ink-fg-2"
                  >
                    {t('chat.aiSdk.readOnlyLegacy')}
                  </div>
                  {readOnlyTranscript}
                </>
              ) : gatewayUnavailable ? (
                // D7 — gateway down / port missing: error notice (+ retry when the
                // probe can re-run) and the current session stays readable.
                <>
                  <div
                    data-gateway-error-notice
                    className="mx-3 my-2 flex items-start gap-2 rounded-md border border-fail/30 bg-fail/10 px-3 py-2 text-aux text-fail"
                  >
                    <span className="flex-1">{t('chat.aiSdk.degraded')}</span>
                    {gatewayDegraded && (
                      <button
                        type="button"
                        onClick={() => void healthQ.refetch()}
                        className={cn(
                          retryActionKlass,
                          'rounded px-2 py-0.5 text-fail transition-colors duration-fast hover:bg-fail/15'
                        )}
                      >
                        {t('chat.aiSdk.retryProbe')}
                      </button>
                    )}
                  </div>
                  {readOnlyTranscript}
                </>
              ) : (
                <ChatComposerControlsProvider value={composerControls}>
                  {/* `gatewayBaseUrl != null` not truthy: '' (same-origin web proxy) is a valid base. */}
                  {contextInjectionOn && !reloadMessagesReady ? (
                    // Session switch in flight: defer the mount until chat.messages match the active
                    // session, so the runtime never seeds stale history.
                    emptyMessages
                  ) : (
                    // AI SDK path: a fresh thread streams straight from the embedded Gateway; turns
                    // persist into chat.activeSessionId (Gateway dual-write). Keyed by (email, session)
                    // so picking a history session remounts seeded with that session's prior messages.
                    <AiSdkRuntimeProvider
                      // Key on the session id ONLY when RELOADING an existing session (initialMessages
                      // non-empty); a fresh / just-adopted conversation (empty messages) keeps `:new`
                      // so onEnsureSession setting activeSessionId mid-first-send does NOT remount the
                      // provider and interrupt the in-flight turn.
                      // Part B — `:rN` suffix only after an island live-refresh (nonce starts at 0 →
                      // byte-identical key until the first settle) so the provider remounts re-seeded
                      // with the reloaded messages. (Expression extracted to runtimeKey above — the
                      // #61 panel-attachment reset must track the SAME identity.)
                      key={runtimeKey}
                      gatewayBaseUrl={gatewayBaseUrl as string}
                      sessionId={chat.activeSessionId}
                      model={backend.model}
                      thinking={thinkingActive}
                      approvalMode={approvalMode}
                      buildInjectedContext={buildInjectedContext}
                      onConsumeInjected={onConsumeInjected}
                      attachmentBridge={attachmentBridge}
                      contextSnapshot={contextSnapshot}
                      initialMessages={initialMessages}
                      onEnsureSession={onEnsureSession}
                    >
                      {/* Part B — feeds the mid-stream guard above (renders nothing); 07-15 also
                          mirrors the verdict into state for the background-run placeholder. */}
                      <ThreadRunningBridge
                        runningRef={aiSdkRunningRef}
                        onRunningChange={setAiSdkRunning}
                      />
                      {/* pendingSlot — B1 background-run placeholder + B3 in-panel approval card
                          (undefined when neither applies → byte-identical thread). */}
                      <AssistantThread
                        pendingSlot={pendingSlotContent}
                        emptyState={emptyMessages}
                      />
                    </AiSdkRuntimeProvider>
                  )}
                </ChatComposerControlsProvider>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
