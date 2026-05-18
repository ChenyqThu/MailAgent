// Sprint 4 §6 — AI Chat panel root. 360px right-side fixed pane that
// hosts the BackendSelector + ContextChips + MessageList + QuickActions +
// Composer. Subscribes to `useEmailChat(activeId)` for live messages /
// streaming state / error UI; quick action chips just prefill the composer
// (Sprint 4 keeps explicit user submit; Sprint 5 may auto-submit).

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AIFields, EmailMeta } from '@shared/api/types'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailChat } from '@shared/hooks/useEmailChat'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useShortcut } from '@shared/hooks/useShortcut'
import { useQuery } from '@tanstack/react-query'

import { BackendSelector, type BackendChoice } from './BackendSelector'
import { Composer } from './Composer'
import { ContextChips } from './ContextChips'
import { MessageList } from './MessageList'
import { QuickActions } from './QuickActions'

const STORAGE_AGENT_ID = 'mailagent.notionAgent.pageId'
const STORAGE_AGENT_NAME = 'mailagent.notionAgent.name'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function AIChatPanel(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const activeInternalId = useActiveEmail((s) => s.activeInternalId)

  // Sprint 6 SettingsPage will write these via a proper form; Sprint 4 ships
  // a localStorage seam so power users can paste their `agent_page_id`
  // straight from `notion-agent agents list --json` to enable the
  // Notion Agent backend without an in-app UI yet.
  const agentPageId = readStored(STORAGE_AGENT_ID)
  const agentName = readStored(STORAGE_AGENT_NAME)

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

  const canSend = activeInternalId !== null && !chat.isStreaming
  const handleSend = useCallback(
    async (text: string) => {
      if (activeInternalId === null) return
      setDraft('')
      try {
        await chat.send({
          message: text,
          backendKind: backend.kind,
          backendModel: backend.model,
          backendAgentPageId: backend.agentPageId
        })
      } catch {
        // Errors are surfaced via chat.error; nothing else to do here.
      }
    },
    [activeInternalId, backend, chat]
  )

  const handlePickAction = useCallback((prompt: string) => setDraft(prompt), [])
  const handleCancel = useCallback(() => chat.abortCurrent(), [chat])

  // ⌥B — toggle backend kind (DESIGN.md §9.5).
  useShortcut('alt+b', () =>
    setBackend((cur) =>
      cur.kind === 'notion-agent'
        ? { kind: 'custom-api', model: cur.model ?? 'claude-sonnet-4-6', agentPageId: null }
        : { kind: 'notion-agent', model: null, agentPageId: agentPageId ?? cur.agentPageId }
    )
  )

  const errorBanner = chat.error ? mapErrorKey(chat.error.code) : null

  return (
    <aside
      aria-label="ai-chat-panel"
      className="w-[360px] shrink-0 border-l border-ink-border bg-ink-2 flex flex-col min-h-0"
    >
      <header className="px-3 h-titlebar flex items-center gap-2 border-b border-ink-border-soft text-aux text-ink-fg font-medium">
        <span className="text-coral">✦</span>
        {t('chat.title')}
      </header>

      <BackendSelector value={backend} onChange={setBackend} agentName={agentName} />
      <ContextChips
        hasEmailBody={activeInternalId !== null}
        aiFieldsCount={aiFieldsCount}
        threadCount={threadCount}
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
              <button
                type="button"
                onClick={chat.clearError}
                className="text-meta font-mono text-ink-fg-2 hover:text-ink-fg-1"
              >
                ×
              </button>
            </div>
          )}

          {chat.messages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center px-6 text-aux text-ink-fg-2 text-center">
              {t('chat.empty.noMessages')}
            </div>
          ) : (
            <MessageList messages={chat.messages} streamingMessageId={chat.streamingMessageId} />
          )}

          <QuickActions onPick={handlePickAction} disabled={chat.isStreaming} />
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            onCancel={handleCancel}
            isStreaming={chat.isStreaming}
            canSend={canSend}
          />
        </>
      )}
    </aside>
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

function mapErrorKey(code: string): string {
  // Sprint 4 review (Opus High #2): every emit-site in the dispatcher /
  // backends gets a dedicated key; unmapped codes still fall through to
  // chat.error.upstream so the banner renders something useful.
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
