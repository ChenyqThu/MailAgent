// assistant-modal P2/P3 — floating AI chat modal shell (the FAB expands into this), three display modes.
//
// Self-built fixed floating container, NOT AssistantModalPrimitive.Root: that primitive needs useAui()
// (runtime context) which lives INSIDE the body, and its unstable_openOnRunStart conflicts with our
// external FAB/⌘J/minimise control. So the shell is a plain portal'd <div> whose open state is the
// useAIChatPanel store; the assistant-ui runtime lives one layer down inside AgentConversation.
//
// 🔴 Body = AgentConversation (the SAME general-agent conversation as the /sessions view), so the three
//    modes share one component and the fullscreen jump (P6) is seamless. P3 floating↔sidebar switching
//    ONLY swaps the container className — the body (AgentConversation + its useGeneralChat stream +
//    runtime) is the SAME React subtree at the SAME portal mount point, so a mode switch never remounts
//    it (no dropped stream / lost timing). fullscreen is an ACTION (navigate to /sessions), not a mode.
//
// flag-gated: InboxLayout mounts this only when isAssistantModalEnabled(); flag-off it never renders.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronsRight,
  Minus,
  PenSquare,
  SlidersHorizontal
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { useActiveEmail } from '@shared/state/active-email'
import {
  useAIChatPanel,
  hideChatModal,
  requestOpenAgentSession,
  type AssistantMode
} from '@shared/state/ai-chat-panel'
import { AgentConversation } from '@shared/components/agents/AgentConversation'
import { ChatModalHistoryDropdown } from './ChatModalHistoryDropdown'
import { titleOf } from './sessionTitle'

/** Outer gate: only MOUNT the body (and its useGeneralChat session load + stream subscription) while the
 *  modal is expanded. Minimised → render nothing (the FAB is showing instead). Keeps hooks unconditional
 *  in the inner component. */
export function AssistantChatModal(): React.JSX.Element | null {
  const visible = useAIChatPanel((s) => s.visible)
  if (!visible) return null
  return <AssistantChatModalInner />
}

const HEADER_BTN = cn(
  'grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-2',
  'transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg'
)

function AssistantChatModalInner(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const chat = useGeneralChat()
  // The email the body pane is currently showing — the modal carries it as the default removable context
  // chip (P5). null (no active email) → AgentConversation gets undefined → no chip.
  const activeEmailId = useActiveEmail((s) => s.activeInternalId)
  const mode = useAIChatPanel((s) => s.mode)
  const setMode = useAIChatPanel((s) => s.setMode)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Unified history (email + general) — same query key as AgentViewLayout / ChatsTab → shared cache. The
  // active session's item drives AgentConversation's runtime + context routing (email vs general).
  const sessionsQ = useQuery({
    queryKey: ['chat', 'allSessions'],
    queryFn: () => mailApi.chat.listAllSessions(true),
    staleTime: 10_000
  })
  const items = sessionsQ.data ?? []
  const activeItem = items.find((s) => s.id === chat.activeSessionId) ?? null

  const sidebar = mode === 'sidebar'
  // 🔴 floating↔sidebar = SAME portal subtree, only this className differs → body never remounts.
  const containerClass = sidebar
    ? 'fixed inset-y-0 right-0 h-full w-[min(30rem,calc(100vw-3rem))] rounded-none border-l slide-in-from-right-3'
    : 'fixed bottom-5 right-5 h-[min(40rem,calc(100vh-7rem))] w-[min(28rem,calc(100vw-2.5rem))] rounded-2xl border slide-in-from-bottom-2'

  // fullscreen = ACTION: park the active session for AgentViewLayout to select (P6), navigate, minimise.
  const onFullscreen = (): void => {
    setMenuOpen(false)
    if (chat.activeSessionId != null) requestOpenAgentSession(chat.activeSessionId)
    void navigate({ to: '/sessions' })
    hideChatModal()
  }
  const onPickMode = (next: AssistantMode): void => {
    setMode(next)
    setMenuOpen(false)
  }

  return createPortal(
    <div
      role="dialog"
      aria-label={t('chat.modal.title')}
      className={cn(
        'z-40 flex flex-col overflow-hidden border-[var(--hairline)] bg-ink-1',
        'shadow-[0_16px_48px_-16px_rgba(0,0,0,0.4)]',
        'animate-in fade-in duration-200 motion-reduce:animate-none',
        containerClass
      )}
    >
      {/* header: 左 标题（P4 下拉切 history session）· 右 三键（新开会话 / switch-mode 菜单 / 最小化或 >>）。 */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--hairline)] px-3">
        {/* P4 标题状态机：新会话→"新对话"；有 activeItem→titleOf（首条输入概览 first_user_message →
            AI 摘要 title，优先级同 AgentThreadList）。点击展开 history 下拉切会话（去 archived）。 */}
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            aria-label={t('chat.modal.history')}
            aria-expanded={historyOpen}
            className="flex max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-body font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3"
          >
            <span className="truncate">
              {activeItem ? titleOf(activeItem, t) : t('chat.modal.newChat')}
            </span>
            <ChevronDown
              size={14}
              strokeWidth={2}
              className={cn(
                'shrink-0 text-ink-fg-3 transition-transform duration-fast',
                historyOpen && 'rotate-180'
              )}
            />
          </button>
          {historyOpen && (
            <ChatModalHistoryDropdown
              items={items}
              activeSessionId={chat.activeSessionId}
              onSelect={(id) => {
                void chat.selectSession(id)
                setHistoryOpen(false)
              }}
              onClose={() => setHistoryOpen(false)}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => chat.newSession()}
            aria-label={t('chat.modal.newSession')}
            title={t('chat.modal.newSession')}
            className={HEADER_BTN}
          >
            <PenSquare size={15} strokeWidth={2} />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={t('chat.modal.switchMode')}
              title={t('chat.modal.switchMode')}
              aria-expanded={menuOpen}
              className={cn(HEADER_BTN, menuOpen && 'bg-ink-3 text-ink-fg')}
            >
              <SlidersHorizontal size={15} strokeWidth={2} />
            </button>
            {menuOpen && (
              <ModeMenu
                mode={mode}
                onPick={onPickMode}
                onFullscreen={onFullscreen}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
          <button
            type="button"
            onClick={hideChatModal}
            aria-label={sidebar ? t('chat.modal.collapse') : t('chat.modal.minimize')}
            title={sidebar ? t('chat.modal.collapse') : t('chat.modal.minimize')}
            className={HEADER_BTN}
          >
            {sidebar ? (
              <ChevronsRight size={16} strokeWidth={2} />
            ) : (
              <Minus size={16} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>
      {/* body: 通用 agent 对话（三模式共享同一组件，welcomeAlign='left' 对齐截图）。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentConversation
          chat={chat}
          activeItem={activeItem}
          welcomeAlign="left"
          initialMentionEmailId={activeEmailId ?? undefined}
        />
      </div>
    </div>,
    document.body
  )
}

/** switch-mode dropdown — floating / sidebar (cached dock modes) + fullscreen (navigate action). A
 *  transparent fixed overlay catches the outside click to close. Current mode shows a check. */
function ModeMenu({
  mode,
  onPick,
  onFullscreen,
  onClose
}: {
  mode: AssistantMode
  onPick: (next: AssistantMode) => void
  onFullscreen: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const row = cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-meta text-ink-fg-1',
    'transition-colors duration-fast hover:bg-ink-3'
  )
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="menu"
        className="absolute right-0 top-8 z-50 w-40 rounded-lg border border-[var(--hairline)] bg-ink-2 p-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)]"
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mode === 'floating'}
          className={row}
          onClick={() => onPick('floating')}
        >
          <span className="flex-1">{t('chat.modal.modeFloating')}</span>
          {mode === 'floating' && <Check size={13} strokeWidth={2.5} className="text-coral" />}
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={mode === 'sidebar'}
          className={row}
          onClick={() => onPick('sidebar')}
        >
          <span className="flex-1">{t('chat.modal.modeSidebar')}</span>
          {mode === 'sidebar' && <Check size={13} strokeWidth={2.5} className="text-coral" />}
        </button>
        <button type="button" role="menuitem" className={row} onClick={onFullscreen}>
          <span className="flex-1">{t('chat.modal.modeFullscreen')}</span>
        </button>
      </div>
    </>
  )
}
