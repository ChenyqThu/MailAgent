// P3 (task 06-18-custom-ai-harness-agent Phase 3) — General Agent dialog.
//
// The Cmd+O surface: a centered, context-free Custom AI conversation that is NOT
// tied to any single email. Reuses the proven chat sub-components (MessageList /
// Composer / ChatHistoryPopover / the inline ConfirmToolDialog inside MessageList)
// but drives them from useGeneralChat (anchor_type='general') instead of the
// per-email useEmailChat — so a general conversation NEVER appears in an email's
// sidebar, and the email-anchored Custom AI is untouched (邮件态零回归).
//
// notion-agent is RETIRED as a backend for new general sessions: the dialog is
// custom-api only (no BackendSelector). Old notion-agent sessions stay readable
// elsewhere; the agent reaches Notion via the notion_agent_chat tool.
//
// Modal shell mirrors CommandPalette: a glass-pop pane over a soft-blurred veil,
// useExitAnimation for the delayed unmount, useFocusTrap + Esc to close.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { History, Plus, Settings, Sparkles, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useGeneralAgent, closeGeneralAgent } from '@shared/state/general-agent'
import { toastError } from '@shared/state/toast'
import { backendSupportsThinking } from '@shared/components/chat/backend_thinking'
import { ChatHistoryPopover } from '@shared/components/chat/ChatHistoryPopover'
import { Composer } from '@shared/components/chat/Composer'
import { MessageList, type UserHandlers } from '@shared/components/chat/MessageList'

// General agent picks its own custom-api model. Persisted so a reopen keeps the
// user's last choice; defaults to sonnet (the shared chat default).
const GENERAL_MODEL_PREF = 'mailagent.generalAgent.model'
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const GENERAL_THINKING_PREF = 'mailagent.generalAgent.thinking'

function readModelPref(): string {
  try {
    return localStorage.getItem(GENERAL_MODEL_PREF) || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}
function writeModelPref(model: string): void {
  try {
    localStorage.setItem(GENERAL_MODEL_PREF, model)
  } catch {
    /* privacy mode — preference loss is harmless */
  }
}
function readThinkingPref(): boolean {
  try {
    return localStorage.getItem(GENERAL_THINKING_PREF) === '1'
  } catch {
    return false
  }
}
function writeThinkingPref(on: boolean): void {
  try {
    localStorage.setItem(GENERAL_THINKING_PREF, on ? '1' : '0')
  } catch {
    /* harmless */
  }
}

function backendShortLabel(model: string): string {
  const parts = model.split('-')
  return parts.length > 2 ? parts.slice(-3).join('-') : model
}

export function GeneralAgentDialog(): React.ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()

  const open = useGeneralAgent((s) => s.open)

  const chat = useGeneralChat()
  const { models: availableModels } = useEnabledModels()

  const [draft, setDraft] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [model, setModel] = useState<string>(() => readModelPref())
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(() => readThinkingPref())

  const selectModel = useCallback((next: string): void => {
    writeModelPref(next)
    setModel(next)
  }, [])
  const toggleThinking = useCallback(() => {
    setThinkingEnabled((cur) => {
      const next = !cur
      writeThinkingPref(next)
      return next
    })
  }, [])

  // custom-api needs the llmApiKey slot. Reused gate shape from AIChatPanel.
  const secretsQ = useQuery({
    queryKey: ['settings', 'secrets-status'],
    queryFn: () => mailApi.settings.secretsStatus(),
    staleTime: 30_000,
    enabled: open
  })
  const backendConfigured = secretsQ.data?.llmApiKey === true
  const thinkingSupported = backendSupportsThinking({
    kind: 'custom-api',
    model,
    agentPageId: null
  })

  const { dialogRef, handleTab } = useFocusTrap({ open })
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '.general-agent-pane',
    backdrop: '.general-agent-veil',
    from: { autoAlpha: 0, xPercent: -50, y: 8, scale: 0.97 }
  })

  const handleSend = useCallback(
    async (text: string): Promise<void> => {
      if (!backendConfigured) return
      setDraft('')
      try {
        await chat.send({
          message: text,
          backendModel: model,
          thinking: thinkingSupported && thinkingEnabled
        })
      } catch {
        // Errors surface via chat.error → the dialog's banner.
      }
    },
    [backendConfigured, chat, model, thinkingSupported, thinkingEnabled]
  )

  const headConfirmation = chat.pendingConfirmations[0] ?? null
  const handleConfirmTool = useCallback(
    async (editedInput?: unknown): Promise<void> => {
      if (!headConfirmation) return
      const r = await chat.confirmTool(headConfirmation.toolUseId, true, editedInput)
      if (!r.ok && r.code !== 'E_NOT_PENDING') toastError(t('generalAgent.confirmFailed'))
    },
    [chat, headConfirmation, t]
  )
  const handleCancelTool = useCallback(async (): Promise<void> => {
    if (!headConfirmation) return
    await chat.confirmTool(headConfirmation.toolUseId, false)
  }, [chat, headConfirmation])

  const userHandlers: UserHandlers = {
    // UserHandlers.onEdit returns void | Promise<void>; swallow editMessage's
    // ChatStartResult (errors land in chat.error → the banner).
    onEdit: async (messageId, newContent): Promise<void> => {
      await chat.editMessage({
        messageId,
        newContent,
        backendKind: 'custom-api',
        backendModel: model,
        thinking: thinkingSupported && thinkingEnabled
      })
    },
    isStreaming: chat.isStreaming
  }

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeGeneralAgent()
        return
      }
      if (e.key === 'Tab') handleTab(e)
    },
    [handleTab]
  )

  // Lazy preview cache for the history popover (first user message per session).
  const [previews, setPreviews] = useState<Record<number, string | null>>({})
  const chatSessions = chat.sessions
  useEffect(() => {
    if (!sidebarOpen) return
    const missing = chatSessions.filter((s) => !(s.id in previews))
    if (missing.length === 0) return
    let cancelled = false
    void Promise.all(
      missing.map(async (s) => {
        try {
          const msgs = await mailApi.chat.listMessages(s.id)
          const first = msgs.find((m) => m.role === 'user')?.content?.trim() ?? null
          return [s.id, first === null ? null : first.slice(0, 80)] as const
        } catch {
          return [s.id, null] as const
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      setPreviews((cur) => {
        const next = { ...cur }
        for (const [id, p] of pairs) next[id] = p
        return next
      })
    })
    return (): void => {
      cancelled = true
    }
  }, [sidebarOpen, chatSessions, previews, mailApi])

  const closeBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const tid = window.setTimeout(() => closeBtnRef.current?.focus(), 0)
    return (): void => window.clearTimeout(tid)
  }, [open])

  if (!shouldRender) return null

  const canSend = backendConfigured && !chat.isStreaming
  const errorBanner = chat.error ? mapErrorKey(chat.error.code) : null

  return createPortal(
    <div ref={scopeRef} style={{ display: 'contents' }}>
      <div className="general-agent-veil" role="presentation" onClick={() => closeGeneralAgent()} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('generalAgent.title')}
        data-general-agent-panel
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="general-agent-pane glass-pop flex flex-col"
      >
        {/* Header */}
        <div className="relative h-11 px-3 border-b border-ink-border flex items-center shrink-0">
          <div className="flex items-center gap-1.5 text-aux font-medium text-ink-fg">
            <Sparkles size={13} strokeWidth={0} className="fill-coral text-coral" />
            {t('generalAgent.title')}
            <span className="text-micro font-mono text-ink-fg-3 ml-1">
              {backendShortLabel(model)}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label={t('generalAgent.newChat')}
              onClick={() => chat.newSession()}
              className="text-ink-fg-2 hover:text-ink-fg p-1.5 rounded transition-colors duration-fast hover:bg-ink-4"
            >
              <Plus size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              data-general-history-toggle
              aria-label={t('generalAgent.history')}
              aria-pressed={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
              className={cn(
                'p-1.5 rounded transition-colors duration-fast',
                sidebarOpen
                  ? 'bg-ink-4 text-ink-fg'
                  : 'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4'
              )}
            >
              <History size={13} strokeWidth={2} />
            </button>
            <button
              ref={closeBtnRef}
              type="button"
              aria-label={t('generalAgent.close')}
              onClick={() => closeGeneralAgent()}
              className="text-ink-fg-2 hover:text-ink-fg p-1.5 rounded transition-colors duration-fast hover:bg-ink-4"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
          {sidebarOpen && (
            <ChatHistoryPopover
              backendKind="custom-api"
              sessions={chat.sessions}
              activeSessionId={chat.activeSessionId}
              previews={previews}
              onSelectSession={(sid) => void chat.selectSession(sid)}
              onNewSession={() => chat.newSession()}
              onClose={() => setSidebarOpen(false)}
              onDeleteSession={(sid) => chat.deleteSession(sid)}
            />
          )}
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {!backendConfigured ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
              <div className="w-10 h-10 rounded-lg grid place-items-center bg-coral/15 border border-coral/30">
                <Settings size={18} strokeWidth={2} className="text-coral" />
              </div>
              <div className="text-aux text-ink-fg">{t('generalAgent.onboarding.title')}</div>
              <div className="text-meta text-ink-fg-2 max-w-[280px]">
                {t('generalAgent.onboarding.hint')}
              </div>
              <button
                type="button"
                onClick={() => {
                  closeGeneralAgent()
                  void navigate({ to: '/settings', search: { tab: 'ai' } })
                }}
                className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux font-medium text-accent-fg bg-coral/100 hover:bg-coral-hover transition-colors duration-fast"
              >
                <Settings size={12} strokeWidth={2} />
                {t('generalAgent.onboarding.openSettings')}
              </button>
            </div>
          ) : (
            <>
              {errorBanner && (
                <div className="px-3 py-2 mx-3 my-2 rounded-md text-aux text-fail bg-fail/10 border border-fail/30 flex items-start gap-2">
                  <span className="flex-1">{t(errorBanner)}</span>
                  <button
                    type="button"
                    onClick={chat.clearError}
                    className="text-ink-fg-2 hover:text-ink-fg-1 text-meta font-mono"
                    aria-label={t('generalAgent.dismiss')}
                  >
                    ×
                  </button>
                </div>
              )}
              {chat.messages.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-2">
                  <Sparkles size={22} strokeWidth={1.5} className="text-ink-fg-3" aria-hidden />
                  <div className="text-aux text-ink-fg-1">{t('generalAgent.empty.title')}</div>
                  <div className="text-meta text-ink-fg-3 max-w-[360px]">
                    {t('generalAgent.empty.hint')}
                  </div>
                </div>
              ) : (
                <MessageList
                  messages={chat.messages}
                  streamingMessageId={chat.streamingMessageId}
                  userHandlers={userHandlers}
                  pendingConfirmations={chat.pendingConfirmations}
                  liveToolCalls={chat.liveToolCalls}
                  onConfirmTool={handleConfirmTool}
                  onCancelTool={handleCancelTool}
                />
              )}
              <Composer
                value={draft}
                onChange={setDraft}
                onSend={(text) => void handleSend(text)}
                onCancel={() => chat.abortCurrent()}
                isStreaming={chat.isStreaming}
                canSend={canSend}
                backendName={backendShortLabel(model)}
                currentModel={model}
                availableModels={availableModels}
                onModelChange={selectModel}
                thinkingEnabled={thinkingEnabled}
                onToggleThinking={toggleThinking}
                thinkingDisabled={!thinkingSupported}
                panelScope="general"
              />
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
  )
}

// Subset of AIChatPanel.mapErrorKey — general agent is custom-api only, so the
// notion-agent codes never fire, but a shared fallback keeps the banner honest.
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
    default:
      return 'chat.error.upstream'
  }
}
