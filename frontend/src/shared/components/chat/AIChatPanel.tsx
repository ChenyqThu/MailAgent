// Sprint 4 §6 — AI Chat panel root. 360px right-side fixed pane that
// hosts the BackendSelector + ContextChips + MessageList + QuickActions +
// Composer. Subscribes to `useEmailChat(activeId)` for live messages /
// streaming state / error UI; quick action chips just prefill the composer
// (Sprint 4 keeps explicit user submit; Sprint 5 may auto-submit).
//
// V1 redesign (Sprint 10 polish): header is a 40px tab bar (AI / Thread / Sync)
// with a coral underline indicator on the active tab, plus right-side New
// conversation / History / Close affordances. Mirrors mockup-inbox.html
// lines 1093-1116. Non-AI tabs paint a placeholder until V1.5 wires them.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { History, Plus, Sparkles, X } from 'lucide-react'

import type { AIFields, EmailMeta } from '@shared/api/types'
import { useActiveEmail } from '@shared/state/active-email'
import { hideAIChatPanel } from '@shared/state/ai-chat-panel'
import { useEmailChat } from '@shared/hooks/useEmailChat'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'
import { toastError, toastSuccess } from '@shared/state/toast'
import {
  STORAGE_AGENT_ID,
  STORAGE_AGENT_NAME,
  STORAGE_CHANGE_EVENT
} from '@shared/state/notion-agent-storage'

import { BackendSelector, type BackendChoice } from './BackendSelector'
import { Composer } from './Composer'
import { ContextChips } from './ContextChips'
import { MessageList, type DraftHandlers } from './MessageList'
import { QuickActions } from './QuickActions'

type PanelTab = 'ai' | 'thread' | 'sync'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function subscribeToAgentStorage(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('storage', callback)
  window.addEventListener(STORAGE_CHANGE_EVENT, callback)
  return () => {
    window.removeEventListener('storage', callback)
    window.removeEventListener(STORAGE_CHANGE_EVENT, callback)
  }
}

// Module-level snapshot getters — passing a fresh closure each render
// would defeat useSyncExternalStore's identity-based bail-out.
const getAgentIdSnapshot = (): string | null => readStored(STORAGE_AGENT_ID)
const getAgentNameSnapshot = (): string | null => readStored(STORAGE_AGENT_NAME)
const getServerSnapshot = (): null => null

/** Short, ASCII-safe label for the active backend — used by the Composer
 *  footer chip. For Custom API we trim the longest model id (`claude-sonnet-4-6`
 *  → `sonnet-4-6`) so it fits next to ⌘↩ without truncation in 99% of cases. */
function backendShortLabel(b: BackendChoice, agentName: string | null): string {
  if (b.kind === 'notion-agent') return agentName ?? 'Jarvis'
  const model = b.model ?? 'sonnet-4-6'
  // claude-sonnet-4-6 → sonnet-4-6 ; gpt-5.4 → gpt-5.4 ; keep dotted versions.
  const parts = model.split('-')
  return parts.length > 2 ? parts.slice(-3).join('-') : model
}

export function AIChatPanel(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const activeInternalId = useActiveEmail((s) => s.activeInternalId)

  // Sprint 6 SettingsPage will write these via a proper form; Sprint 4 ships
  // a localStorage seam so power users can paste their `agent_page_id`
  // straight from `notion-agent agents list --json` to enable the
  // Notion Agent backend without an in-app UI yet.
  const agentPageId = useSyncExternalStore(
    subscribeToAgentStorage,
    getAgentIdSnapshot,
    getServerSnapshot
  )
  const agentName = useSyncExternalStore(
    subscribeToAgentStorage,
    getAgentNameSnapshot,
    getServerSnapshot
  )

  const [tab, setTab] = useState<PanelTab>('ai')
  const [backend, setBackend] = useState<BackendChoice>({
    kind: agentPageId ? 'notion-agent' : 'custom-api',
    model: agentPageId ? null : 'claude-sonnet-4-6',
    agentPageId: agentPageId ?? null
  })
  const [draft, setDraft] = useState('')

  const chat = useEmailChat(activeInternalId)

  // Pull AI fields + email detail (for thread_id) + thread sibling count
  // for the ContextChips header.
  const detailQ = useQuery({
    queryKey: ['email', activeInternalId],
    queryFn: () => mailApi.email.get(activeInternalId as number),
    enabled: activeInternalId !== null,
    staleTime: 30_000
  })
  const threadId = detailQ.data?.thread_id ?? null

  const aiQ = useQuery({
    queryKey: ['email', activeInternalId, 'ai'],
    queryFn: () => mailApi.email.aiFields(activeInternalId as number),
    enabled: activeInternalId !== null,
    staleTime: 30_000
  })
  const threadQ = useQuery({
    queryKey: ['email', threadId, 'thread-count'],
    queryFn: () => mailApi.email.listByThread(threadId),
    enabled: threadId !== null,
    staleTime: 30_000,
    select: (rows: EmailMeta[]) => rows.length
  })

  const aiFields: AIFields | null = aiQ.data ?? null
  const aiFieldsCount = aiFields ? countNonNullAiFields(aiFields) : 0
  const threadCount = threadQ.data ?? 0

  const quotaCooldownUntil = chat.quotaCooldownUntil
  const inQuotaCooldown = quotaCooldownUntil !== null
  const canSend = activeInternalId !== null && !chat.isStreaming && !inQuotaCooldown

  // Sprint 13 — DraftPreviewCard buttons. send → real mailApi.email.createDraft;
  // regenerate → chat.retryLast (only when retry is available); edit + popout
  // are intentionally `coming in Sprint 14` toasts so the user can see the
  // affordance without us pretending to wire something that isn't.
  const [draftSending, setDraftSending] = useState(false)
  const handleDraftSend = useCallback(
    async (body: string) => {
      if (activeInternalId === null) return
      setDraftSending(true)
      try {
        await mailApi.email.createDraft({ internalId: activeInternalId, body })
        toastSuccess(t('chat.draftReply.toast.sendOk'))
      } catch (err) {
        const e = err as { code?: string; message?: string }
        const key =
          e.code === 'E_AUTOMATION_DENIED'
            ? 'chat.draftReply.toast.sendFailAuto'
            : e.code === 'E_MAIL_NOT_RUNNING'
              ? 'chat.draftReply.toast.sendFailMail'
              : e.code === 'E_NO_MAILBOX' || e.code === 'E_NOT_FOUND'
                ? 'chat.draftReply.toast.sendFailNoBin'
                : 'chat.draftReply.toast.sendFailGeneric'
        const detail = e.code ? `${e.code} · ${e.message ?? ''}` : (e.message ?? String(err))
        toastError(t(key), detail)
      } finally {
        setDraftSending(false)
      }
    },
    [activeInternalId, mailApi, t]
  )
  // chat.retryLast resends whatever the user last asked. For a draft turn
  // that's "起草回复给 oncall…" → produces a fresh draft. If retryLast is
  // null (no last failed input on file), DraftPreviewCard surfaces the
  // `regenPending` hint via HoverTip instead of pretending the button works.
  const draftHandlers: DraftHandlers = {
    onSend: handleDraftSend,
    onRegenerate: chat.retryLast ?? null,
    onEdit: undefined, // Sprint 14 — inline editor
    onOpenInWindow: undefined, // Sprint 14 — popout decision
    isSending: draftSending,
    recipient: detailQ.data?.sender ?? null
  }

  const handleSend = useCallback(
    async (text: string) => {
      if (activeInternalId === null) return
      setDraft('')
      try {
        await chat.send({
          message: text,
          backendKind: backend.kind,
          backendModel: backend.model,
          backendAgentPageId: backend.agentPageId,
          senderName: detailQ.data?.sender_name ?? null,
          subject: detailQ.data?.subject ?? null
        })
      } catch {
        // Errors are surfaced via chat.error; nothing else to do here.
      }
    },
    [activeInternalId, backend, chat, detailQ.data]
  )

  const handlePickAction = useCallback((prompt: string) => setDraft(prompt), [])
  const handleCancel = useCallback(() => chat.abortCurrent(), [chat])

  // ⌥⇧B — toggle backend kind. Sprint 11 V1.4 moved from bare ⌥B because
  // the global nav-shell collapse claimed that keystroke per DESIGN.md
  // §2.11. Backend cycling is rare enough that the extra modifier is fine.
  useShortcut('alt+shift+b', () =>
    setBackend((cur) =>
      cur.kind === 'notion-agent'
        ? { kind: 'custom-api', model: cur.model ?? 'claude-sonnet-4-6', agentPageId: null }
        : { kind: 'notion-agent', model: null, agentPageId: agentPageId ?? cur.agentPageId }
    )
  )

  const errorBanner = chat.error ? mapErrorKey(chat.error.code) : null
  // Sprint 5 ship-review (codex MEDIUM #2): retry CTA + dismiss icon live on
  // the error banner; both surfaces resolve to zh-CN text under CJK locale.
  // Swap text-meta mono → text-aux so the 14px CJK floor (DESIGN.md §14 #2)
  // holds.
  const retryActionKlass = useCjkMonoSwap('text-meta font-mono')

  const backendName = backendShortLabel(backend, agentName)

  return (
    <aside
      aria-label="ai-chat-panel"
      className="w-[360px] shrink-0 border-l border-ink-border ai-bg flex flex-col min-h-0"
    >
      {/* ── Tab bar (40px) — AI / Thread / Sync + New / History / Close ── */}
      <div className="h-10 border-b border-ink-border flex items-center px-1 shrink-0">
        <TabButton
          active={tab === 'ai'}
          onClick={() => setTab('ai')}
          icon={<Sparkles size={13} strokeWidth={0} className="fill-current" />}
          label={t('chat.tabAI')}
        />
        <TabButton
          active={tab === 'thread'}
          onClick={() => setTab('thread')}
          // Inline SVG to match mockup; lucide MessageCircle has too much padding.
          icon={
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          }
          label={t('chat.tabThread')}
          badge={threadCount > 0 ? String(threadCount) : null}
        />
        <TabButton
          active={tab === 'sync'}
          onClick={() => setTab('sync')}
          icon={
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          }
          label={t('chat.tabSync')}
        />
        <div className="ml-auto pr-1 flex items-center gap-1">
          {/* + New chat — real wiring: chat.newSession() (Sprint 13). Resets
              activeSessionId so next send creates a fresh session. */}
          <HoverTip text={`${t('chat.newChat')}\n${t('chat.newChatHint')}`} side="bottom">
            <button
              type="button"
              aria-label={t('chat.newChat')}
              onClick={() => chat.newSession()}
              className={cn(
                'text-ink-fg-2 hover:text-ink-fg p-1.5 rounded',
                'transition-colors duration-fast hover:bg-ink-4'
              )}
            >
              <Plus size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          {/* History — Sprint 14 will surface session switcher sidebar. */}
          <HoverTip text={t('chat.historyBlocked')} side="bottom">
            <button
              type="button"
              aria-label={t('chat.history')}
              disabled
              data-disabled=""
              tabIndex={-1}
              className={cn(
                'p-1.5 rounded transition-colors duration-fast',
                'text-ink-fg-3 opacity-50 cursor-not-allowed'
              )}
            >
              <History size={13} strokeWidth={2} />
            </button>
          </HoverTip>
          <HoverTip text={t('chat.closePanel')} side="bottom">
            <button
              type="button"
              onClick={hideAIChatPanel}
              aria-label={t('chat.closePanel')}
              className={cn(
                'text-ink-fg-2 hover:text-ink-fg p-1.5 rounded',
                'transition-colors duration-fast hover:bg-ink-4'
              )}
            >
              <X size={13} strokeWidth={2} />
            </button>
          </HoverTip>
        </div>
      </div>

      {tab !== 'ai' ? (
        <TabPlaceholder
          label={tab === 'thread' ? t('chat.tabThread') : t('chat.tabSync')}
          subline={t('shortcutHelp.soon')}
        />
      ) : (
        <>
          <BackendSelector value={backend} onChange={setBackend} agentName={agentName} />
          <ContextChips
            hasEmailBody={activeInternalId !== null}
            aiFieldsCount={aiFieldsCount}
            threadCount={threadCount}
            notionProjectCount={0}
          />

          {activeInternalId === null ? (
            <div className="flex-1 flex items-center justify-center px-6 text-aux text-ink-fg-2 text-center">
              {t('chat.empty.noEmail')}
            </div>
          ) : (
            <>
              {errorBanner && (
                <div className="px-3 py-2 mx-3 my-2 rounded-md text-aux text-fail bg-fail/10 border border-fail/30 flex items-start gap-2">
                  <span className="flex-1">{t(errorBanner)}</span>
                  {chat.retryLast && (
                    <button
                      type="button"
                      onClick={() => void chat.retryLast?.()}
                      className={cn(
                        retryActionKlass,
                        'text-fail hover:bg-fail/15 px-2 py-0.5 rounded transition-colors duration-fast'
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

              {chat.messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center px-6 text-aux text-ink-fg-2 text-center">
                  {t('chat.empty.noMessages')}
                </div>
              ) : (
                <MessageList
                  messages={chat.messages}
                  streamingMessageId={chat.streamingMessageId}
                  draftHandlers={draftHandlers}
                />
              )}

              <QuickActions onPick={handlePickAction} disabled={chat.isStreaming} />
              <Composer
                value={draft}
                onChange={setDraft}
                onSend={handleSend}
                onCancel={handleCancel}
                isStreaming={chat.isStreaming}
                canSend={canSend}
                backendName={backendName}
                // Sprint 13 — model switcher lives in Composer Cpu button
                // (mockup L2530). Notion Agent has no model picker — the
                // agent decides; Custom API exposes the 3 supported models.
                currentModel={backend.kind === 'custom-api' ? backend.model : null}
                availableModels={
                  backend.kind === 'custom-api'
                    ? ['claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5.4']
                    : []
                }
                onModelChange={(model) =>
                  setBackend({ kind: 'custom-api', model, agentPageId: null })
                }
                modelPickerDisabled={backend.kind === 'notion-agent'}
              />
            </>
          )}
        </>
      )}
    </aside>
  )
}

// ─── Tab pieces ───────────────────────────────────────────────────────────

interface TabButtonProps {
  active: boolean
  onClick(): void
  icon: React.ReactNode
  label: string
  badge?: string | null
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge = null
}: TabButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 px-3 py-2 text-aux font-medium',
        'transition-colors duration-fast',
        active ? 'tab-active' : 'text-ink-fg-1 hover:text-ink-fg'
      )}
    >
      <span className="shrink-0">{icon}</span>
      {label}
      {badge && <span className="text-micro font-mono text-ink-fg-2 ml-0.5">{badge}</span>}
    </button>
  )
}

function TabPlaceholder({
  label,
  subline
}: {
  label: string
  subline: string
}): React.ReactElement {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
      <span className="text-aux text-ink-fg-2">
        {label}
        <span className="text-ink-fg-3"> · {subline}</span>
      </span>
    </div>
  )
}

function countNonNullAiFields(f: AIFields): number {
  // Count of fields rendered in §5 §8 — Action / Priority / Review / Sentiment /
  // ProcessingStatus / Mailbox / IsRead / IsFlagged. Booleans always count.
  let n = 0
  if (f.ai_action) n++
  if (f.ai_priority) n++
  if (f.ai_review_status) n++
  if (f.sentiment) n++
  if (f.processing_status) n++
  if (f.mailbox) n++
  n += 2 // is_read + is_flagged (booleans are always present)
  return n
}

// Sprint 5 §2.3 state-machine #4 — re-renders every ~250ms so the seconds
// readout in the chat panel header stays current without polluting the
// hook owner (`useEmailChat`) with timer state.
function QuotaCooldownTimer({ until }: { until: number }): React.ReactElement | null {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  // (codex MEDIUM #2) zh-CN "额度冷却中 · X 秒后可再次发送" should sit at
  // text-aux for CJK; English "Quota cooldown · Xs until next send" can stay
  // mono.
  const bannerKlass = useCjkMonoSwap('text-meta font-mono')
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now())
    }, 250)
    return (): void => {
      clearInterval(interval)
    }
  }, [])
  const remainingMs = Math.max(0, until - now)
  if (remainingMs === 0) return null
  const seconds = Math.ceil(remainingMs / 1000)
  return (
    <div
      className={cn(
        'px-3 py-1.5 mx-3 mb-2 rounded-md text-urg bg-urg/10 border border-urg/30',
        bannerKlass
      )}
    >
      {t('chat.error.quotaCooldown', { seconds })}
    </div>
  )
}

function mapErrorKey(code: string): string {
  switch (code) {
    case 'E_NO_LLM_KEY':
      return 'chat.error.noKey'
    case 'E_QUOTA':
      return 'chat.error.quota'
    case 'E_UPSTREAM':
      return 'chat.error.upstream'
    case 'E_ABORTED':
      return 'chat.error.abort'
    case 'E_NOTION_AGENT_AUTH':
      return 'chat.error.agentAuth'
    case 'E_NOTION_AGENT_NETWORK':
    case 'E_NETWORK':
      return 'chat.error.network'
    case 'E_NOTION_AGENT_NOT_INSTALLED':
      return 'chat.error.agentNotInstalled'
    case 'E_NOTION_AGENT_TIMEOUT':
      return 'chat.error.agentTimeout'
    case 'E_MODEL_UNSUPPORTED':
      return 'chat.error.modelUnsupported'
    case 'E_NOTION_AGENT_PARSE':
    case 'E_NOTION_AGENT_FAIL':
    case 'E_BACKEND_CRASH':
    case 'E_BACKEND_UNAVAILABLE':
    case 'E_INVALID_ARG':
    case 'E_LOAD':
    default:
      return 'chat.error.upstream'
  }
}
