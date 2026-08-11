// Matters MVP P6-A lane A5 — the Matter Agent body adapter for the existing AssistantChatModal.
//
// The former 372px standalone aside is gone. This component now owns only matter-specific behavior
// around the shared AI SDK thread: anchored context, audited scope switching, MatterWriteCard undo
// context, the removable context chip, matter quick actions, and matter-branded empty state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Globe, Shield } from 'lucide-react'

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'
import { AssistantThread } from '@shared/assistant/components/thread'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import type { CapabilityContext, ContextScope } from '@shared/assistant/context/contextSnapshot'
import { ConversationContextChip } from '@shared/components/agents/AgentConversation'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import type { MatterChatTarget } from '@shared/state/ai-chat-panel'
import { toastError } from '@shared/state/toast'

import { useMatterChatApi, useMattersApi } from './hooks'
import { MatterContextGapCard } from './MatterContextGapCard'
import { MatterChatSurfaceContext, type MatterChatSurface } from './matterChatContext'
import { useMatterChatSession } from './useMatterChatSession'
import { useMatterContextSnapshot, type MatterChatScope } from './useMatterContextSnapshot'
import { useMatterUndoRunner } from './useMatterUndoRunner'

const QUICK_PROMPT_KEYS = ['status', 'nextStep', 'draftFollowup', 'updateSummary'] as const

interface MatterChatPanelProps {
  matter: MatterChatTarget
  /** Every explicit 事项对话 / 新会话 action increments this and starts a clean round. */
  conversationEpoch: number
}

export function MatterChatPanel({
  matter,
  conversationEpoch
}: MatterChatPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const chatApi = useMatterChatApi()
  const mattersApi = useMattersApi()
  const queryClient = useQueryClient()

  const gatewayBaseUrl = useMemo(() => resolveAiGatewayBaseUrl(), [])
  const session = useMatterChatSession(matter.id)
  const {
    activeSessionId,
    messages,
    messagesSessionId,
    navEpoch,
    adoptSession,
    newSession: resetSession
  } = session

  // D10 — global is the default for each new interactive round; the stricter matter-only option
  // remains available and every change still follows the G5 audit-first chain below.
  const [scope, setScope] = useState<MatterChatScope>('global')
  const [scopeBusy, setScopeBusy] = useState(false)
  const [contextEnabled, setContextEnabled] = useState(true)

  useEffect(() => {
    resetSession()
    setScope('global')
    setContextEnabled(true)
  }, [conversationEpoch, resetSession])

  const contextScope = useMemo<ContextScope>(
    () => ({
      surface: 'general-agent',
      anchorType: 'matter',
      // The gateway's matterScopeFilter requires the INTERNAL id, never the MAT-xxxx public id.
      anchorId: matter.id,
      sessionId: activeSessionId,
      backendKind: 'ai-sdk'
    }),
    [matter.id, activeSessionId]
  )
  const capabilities = useMemo<CapabilityContext>(
    () => ({
      thinkingEnabled: false,
      attachmentsEnabled: false,
      toolCallingEnabled: true,
      humanApprovalRequired: true,
      enabledSkills: []
    }),
    []
  )
  const {
    snapshot,
    chips,
    hasContextGap,
    isError: snapshotFailed
  } = useMatterContextSnapshot({
    publicId: matter.publicId,
    scope: contextScope,
    chatScope: scope,
    capabilities,
    enabled: contextEnabled
  })

  const contextCount =
    contextEnabled && chips
      ? 1 + chips.openItems + chips.stakeholders + chips.pinnedResources + chips.changes
      : 0
  const discovery = useMutation({
    mutationFn: () =>
      mattersApi.discoverResourceSuggestions(matter.publicId, {
        query: matter.title,
        expandReason: 'context_gap',
        limit: 10
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.matters.detail(matter.publicId) }),
        queryClient.invalidateQueries({ queryKey: qk.matters.resources(matter.publicId) }),
        queryClient.invalidateQueries({ queryKey: qk.matters.contextSnapshot(matter.publicId) })
      ])
    },
    onError: (error) => toastError(t('matters.chat.gap.failed'), errorMessage(error))
  })

  // Session creation stays lazy for the first send, except a scope change must create one first so
  // the audit record always has session_id. Concurrent first-send/scope-change calls share one promise.
  const activeSessionIdRef = useRef<number | null>(activeSessionId)
  activeSessionIdRef.current = activeSessionId
  const ensureInflightRef = useRef<Promise<number> | null>(null)
  const ensureSession = useCallback(async (): Promise<number> => {
    const existing = activeSessionIdRef.current
    if (existing !== null) return existing
    if (ensureInflightRef.current === null) {
      ensureInflightRef.current = mailApi.chat
        .newSession({ anchorType: 'matter', matterId: matter.id, backendKind: 'ai-sdk' })
        .then((created) => {
          adoptSession(created)
          activeSessionIdRef.current = created.id
          return created.id
        })
        .finally(() => {
          ensureInflightRef.current = null
        })
    }
    return ensureInflightRef.current
  }, [adoptSession, mailApi, matter.id])

  // G5: ensureSession → durable scope audit → local scope flip. Failure preserves the current scope.
  const onScopeChange = useCallback(
    (next: MatterChatScope): void => {
      if (next === scope || scopeBusy) return
      setScopeBusy(true)
      void (async (): Promise<void> => {
        try {
          const sessionId = await ensureSession()
          await chatApi.recordChatScope(matter.publicId, next, sessionId)
          setScope(next)
          await queryClient.invalidateQueries({ queryKey: qk.matters.detail(matter.publicId) })
        } catch (error) {
          toastError(t('matters.chat.scope.auditFailed'), errorMessage(error))
        } finally {
          setScopeBusy(false)
        }
      })()
    },
    [chatApi, ensureSession, matter.publicId, queryClient, scope, scopeBusy, t]
  )

  const { undoStates, runUndo, resetUndoStates } = useMatterUndoRunner(matter.publicId)
  const surface = useMemo<MatterChatSurface>(
    () => ({ publicId: matter.publicId, runUndo, undoStates }),
    [matter.publicId, runUndo, undoStates]
  )

  useEffect(() => {
    resetUndoStates()
  }, [navEpoch, resetUndoStates])

  const reloadReady = activeSessionId === null || messagesSessionId === activeSessionId
  const initialMessages = useMemo(
    () => (reloadReady ? messages.map(chatMessageToUIMessage) : undefined),
    [reloadReady, messages]
  )
  const runtimeKey = `${matter.id}:${
    initialMessages && initialMessages.length > 0 ? activeSessionId : 'new'
  }:${navEpoch}`

  const contextChip = contextEnabled ? (
    <ConversationContextChip
      icon={<ClipboardList size={12} strokeWidth={2} className="shrink-0 text-coral" />}
      label={`${matter.publicId} ${matter.title}`}
      removeLabel={t('matters.chat.removeContext')}
      onRemove={() => setContextEnabled(false)}
    />
  ) : null

  const scopeControls = (
    <div className="border-t border-[var(--hairline)] px-3 py-2">
      {contextChip}
      {snapshotFailed ? (
        <p className="mt-1.5 text-meta text-ink-fg-3">{t('matters.chat.chips.unavailable')}</p>
      ) : null}
      {hasContextGap ? (
        <MatterContextGapCard
          disabled={discovery.isPending}
          onExpand={() => discovery.mutate()}
          suggestedCount={discovery.data?.items.length ?? null}
          suppressedCount={discovery.data?.suppressed.length ?? 0}
        />
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {scope === 'matter' ? (
          <Shield size={12} className="shrink-0 text-ok" />
        ) : (
          <Globe size={12} className="shrink-0 text-warn" />
        )}
        <span className="flex-1 text-meta text-ink-fg-2">
          {t(scope === 'matter' ? 'matters.chat.scope.matterNote' : 'matters.chat.scope.globalNote')}
        </span>
        <SegmentedControl<MatterChatScope>
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: 'matter', label: t('matters.chat.scope.matter') },
            { value: 'global', label: t('matters.chat.scope.global') }
          ]}
          ariaLabel={t('matters.chat.scope.label')}
        />
      </div>
    </div>
  )
  const runStatusSlot = (
    <div>
      {scopeControls}
      <div className="px-3 pb-2">
        <MatterQuickPrompts />
      </div>
    </div>
  )

  const emptyState = (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <span className="mb-2 text-meta font-medium text-coral">{t('matters.chat.agentName')}</span>
      <h1 className="text-xl font-semibold text-ink-fg">{matter.title}</h1>
      <p className="mt-2 text-aux text-ink-fg-3">
        {t('matters.chat.empty.hint', { count: contextCount })}
      </p>
    </div>
  )

  return (
    <div data-testid="matter-chat-panel" className="flex min-h-0 flex-1 flex-col">
      {gatewayBaseUrl === null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            data-testid="matter-chat-gateway-notice"
            className="m-3 rounded-[var(--r-ctl)] border border-fail/30 bg-fail/10 px-3 py-2 text-aux text-fail"
          >
            {t('chat.aiSdk.degraded')}
          </div>
          {emptyState}
          {scopeControls}
        </div>
      ) : !reloadReady ? (
        <div className="flex min-h-0 flex-1 flex-col">{emptyState}</div>
      ) : (
        <MatterChatSurfaceContext.Provider value={surface}>
          <AiSdkRuntimeProvider
            key={runtimeKey}
            gatewayBaseUrl={gatewayBaseUrl}
            sessionId={activeSessionId}
            contextSnapshot={snapshot}
            initialMessages={initialMessages}
            onEnsureSession={ensureSession}
          >
            <AssistantThread emptyState={emptyState} runStatusSlot={runStatusSlot} />
          </AiSdkRuntimeProvider>
        </MatterChatSurfaceContext.Provider>
      )}
    </div>
  )
}

function MatterQuickPrompts(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="matter-chat-prompts">
      {QUICK_PROMPT_KEYS.map((key) => {
        const prompt = t(`matters.chat.prompts.${key}`)
        return (
          <ThreadPrimitive.Suggestion
            key={key}
            prompt={prompt}
            autoSend
            className="rounded-[var(--r-pill)] border border-ink-border-soft bg-ink-2 px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
          >
            {prompt}
          </ThreadPrimitive.Suggestion>
        )
      })}
    </div>
  )
}
