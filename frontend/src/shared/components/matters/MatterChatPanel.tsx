// Matters MVP P3 (lane ③) — 事项对话 panel (design-handoff 附录 C / chat.jsx).
//
// A 372px right aside that TAKES THE ContextRail's slot while open (narrow → overlay). It is a
// thin shell over the ONE chat engine: `AiSdkRuntimeProvider` (embedded AI SDK Gateway) +
// `AssistantThread` — the same streaming, ToolTrace, approval cards, thinking and composer the
// email panel uses. Nothing about the message stream is re-implemented here; what IS matter-
// specific lives around the thread:
//
//   · header       — message icon + 事项对话 + PubId + 新会话 + 关闭
//   · context      — the five injected-context chips (counts come from the SAME bounded snapshot
//                    the model receives, so screen and prompt can never drift) + the scope row
//   · scope        — 本事项 | 全库 Segmented; switching audits through POST /chat-scope FIRST and
//                    only then flips locally (D8: a failed audit must not silently widen search)
//   · quick prompts— the four design chips, mounted in the thread's runStatusSlot (i.e. between
//                    the scroll viewport and the composer — exactly where the design puts them)
//   · footer       — 「对话历史不是正式事项知识…」
//
// The write receipt + undo are NOT here: they render inside the message stream through the
// registered MatterWriteCard, which reads MatterChatSurfaceContext provided below.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Globe,
  History,
  ListChecks,
  MessageSquare,
  Pin,
  Plus,
  Shield,
  Target,
  Users,
  X
} from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'
import { AssistantThread } from '@shared/assistant/components/thread'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import type { CapabilityContext, ContextScope } from '@shared/assistant/context/contextSnapshot'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { useMatterChatApi } from './hooks'
import { MatterChatSurfaceContext, type MatterChatSurface } from './matterChatContext'
import { useMatterChatSession } from './useMatterChatSession'
import { useMatterContextSnapshot, type MatterChatScope } from './useMatterContextSnapshot'
import { useMatterUndoRunner } from './useMatterUndoRunner'

/** The four design quick prompts (逐字 chat.jsx PROMPTS), localized. */
const QUICK_PROMPT_KEYS = ['blocked', 'changes', 'reviewDate', 'owing'] as const

interface MatterChatPanelProps {
  matter: Matter
  /** narrow layout → float over the detail column instead of taking a column of its own. */
  overlay: boolean
  onClose(): void
}

export function MatterChatPanel({
  matter,
  overlay,
  onClose
}: MatterChatPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const chatApi = useMatterChatApi()
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

  // D8 — per-panel state, deliberately NOT persisted: closing the panel unmounts this component, so
  // reopening falls back to 'matter' (the stricter side).
  const [scope, setScope] = useState<MatterChatScope>('matter')
  const [scopeBusy, setScopeBusy] = useState(false)

  const contextScope = useMemo<ContextScope>(
    () => ({
      surface: 'general-agent',
      anchorType: 'matter',
      // 🔴 the matter's INTERNAL id — the gateway reads scope.anchorId to build the matter search
      // filter (chatRun.ts matterScopeFilter) and the session anchor. Never the MAT-xxxx text.
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
    isError: snapshotFailed
  } = useMatterContextSnapshot({
    publicId: matter.public_id,
    scope: contextScope,
    chatScope: scope,
    capabilities,
    enabled: true
  })

  // ── session creation (lazily, on the first send — or on an explicit scope switch) ────────────
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

  // ── G5 scope switch: audit first, flip second ───────────────────────────────────────────────
  const onScopeChange = useCallback(
    (next: MatterChatScope): void => {
      if (next === scope || scopeBusy) return
      setScopeBusy(true)
      void (async (): Promise<void> => {
        try {
          const sessionId = await ensureSession()
          await chatApi.recordChatScope(matter.public_id, next, sessionId)
          setScope(next)
          await queryClient.invalidateQueries({ queryKey: qk.matters.detail(matter.public_id) })
        } catch (error) {
          // Failure keeps the CURRENT scope — never widen the search reach without a durable
          // record of the user having asked for it.
          toastError(t('matters.chat.scope.auditFailed'), errorMessage(error))
        } finally {
          setScopeBusy(false)
        }
      })()
    },
    [chatApi, ensureSession, matter.public_id, queryClient, scope, scopeBusy, t]
  )

  // ── D9 undo (renderer-direct REST — see useMatterUndoRunner) ────────────────────────────────
  const { undoStates, runUndo, resetUndoStates } = useMatterUndoRunner(matter.public_id)

  const surface = useMemo<MatterChatSurface>(
    () => ({ publicId: matter.public_id, runUndo, undoStates }),
    [matter.public_id, runUndo, undoStates]
  )

  // A brand-new conversation must not carry the previous session's undo chrome.
  useEffect(() => {
    resetUndoStates()
  }, [navEpoch, resetUndoStates])

  const reloadReady = activeSessionId === null || messagesSessionId === activeSessionId
  const initialMessages = useMemo(
    () => (reloadReady ? messages.map(chatMessageToUIMessage) : undefined),
    [reloadReady, messages]
  )
  // Mirror of the email panel's runtimeKey: key on the session id ONLY when RELOADING an existing
  // conversation, so ensureSession adopting an id mid-first-send does not remount the provider.
  const runtimeKey = `${matter.id}:${
    initialMessages && initialMessages.length > 0 ? activeSessionId : 'new'
  }:${navEpoch}`

  const chipRow = (
    <div className="flex flex-wrap gap-1.5" data-testid="matter-chat-chips">
      <Chip icon={<Target size={11} />} label={t('matters.chat.chips.acceptedState')} />
      <Chip
        icon={<ListChecks size={11} />}
        label={
          chips === null
            ? t('matters.chat.chips.openItemsUnknown')
            : t('matters.chat.chips.openItems', { count: chips.openItems })
        }
      />
      <Chip
        icon={<Users size={11} />}
        label={
          chips === null
            ? t('matters.chat.chips.stakeholdersUnknown')
            : t('matters.chat.chips.stakeholders', { count: chips.stakeholders })
        }
      />
      <Chip
        icon={<Pin size={11} />}
        label={
          chips === null
            ? t('matters.chat.chips.pinnedUnknown')
            : t('matters.chat.chips.pinned', { count: chips.pinnedResources })
        }
      />
      <Chip icon={<History size={11} />} label={t('matters.chat.chips.changes')} />
    </div>
  )

  const emptyState = (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="grid size-9 place-items-center rounded-full bg-ink-3 text-ink-fg-3">
        <MessageSquare size={16} />
      </span>
      <p className="text-body font-medium text-ink-fg">{t('matters.chat.empty.title')}</p>
      <p className="max-w-[260px] text-aux leading-5 text-ink-fg-3">
        {t('matters.chat.empty.hint')}
      </p>
    </div>
  )

  return (
    <aside
      data-testid="matter-chat-panel"
      aria-label={t('matters.chat.title')}
      className={cn(
        'flex h-full w-[372px] max-w-[92%] shrink-0 flex-col overflow-hidden border-l border-ink-border bg-ink-1',
        overlay && 'absolute inset-y-0 right-0 z-30 shadow-md'
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-ink-border px-3 py-2.5">
        <MessageSquare size={14} className="text-coral" />
        <span className="text-body font-semibold text-ink-fg">{t('matters.chat.title')}</span>
        <span className="font-mono text-meta text-ink-fg-3">{matter.public_id}</span>
        <span className="flex-1" />
        <button
          type="button"
          title={t('matters.chat.newSession')}
          aria-label={t('matters.chat.newSession')}
          onClick={resetSession}
          className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          title={t('common.close')}
          aria-label={t('common.close')}
          onClick={onClose}
          className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <X size={14} />
        </button>
      </header>

      <section className="shrink-0 border-b border-ink-border px-3 py-2.5">
        <h2 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-fg-3">
          {t('matters.chat.injectedContext')}
        </h2>
        {chipRow}
        {snapshotFailed ? (
          <p className="mt-1.5 text-meta text-ink-fg-3">{t('matters.chat.chips.unavailable')}</p>
        ) : null}
        <div className="mt-2.5 flex items-center gap-2">
          {scope === 'matter' ? (
            <Shield size={12} className="shrink-0 text-ok" />
          ) : (
            <Globe size={12} className="shrink-0 text-warn" />
          )}
          <span className="flex-1 text-meta text-ink-fg-2">
            {t(
              scope === 'matter' ? 'matters.chat.scope.matterNote' : 'matters.chat.scope.globalNote'
            )}
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
      </section>

      {gatewayBaseUrl === null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            data-testid="matter-chat-gateway-notice"
            className="m-3 rounded-[var(--r-ctl)] border border-fail/30 bg-fail/10 px-3 py-2 text-aux text-fail"
          >
            {t('chat.aiSdk.degraded')}
          </div>
          {emptyState}
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
            <AssistantThread emptyState={emptyState} runStatusSlot={<MatterQuickPrompts />} />
          </AiSdkRuntimeProvider>
        </MatterChatSurfaceContext.Provider>
      )}

      <footer className="shrink-0 border-t border-ink-border px-3 py-2.5 text-meta leading-5 text-ink-fg-3">
        {t('matters.chat.footnote')}
      </footer>
    </aside>
  )
}

/** The four quick prompts. Lives inside the thread (assistant-ui context) so a click can autoSend
 *  through the SAME composer path a typed message takes — no second send path. */
function MatterQuickPrompts(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2" data-testid="matter-chat-prompts">
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

function Chip({ icon, label }: { icon: React.ReactNode; label: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-ink-4 px-2 py-0.5 text-meta text-ink-fg-2">
      {icon}
      {label}
    </span>
  )
}
