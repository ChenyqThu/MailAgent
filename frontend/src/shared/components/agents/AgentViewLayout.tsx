// redesign — MailAgent general-agent VIEW shell (renders at /sessions). Two-pane: LEFT =
// AgentThreadList (session history, collapsible), RIGHT = one ChatTabHost (the live general-agent
// thread; ai-sdk gateway with a legacy degrade fallback).
//
// 09-02 对话域拆分 — 「AI｜群聊」分段没有了：群聊升一级域（`/groups` + GroupsLayout），
// 本组件只剩主 agent 会话这一半；同批 `chats` 升对象域，一个会话 = 一个顶栏标签：
//   - 点左列某行 / 「新会话」= 开（或激活）一个 chat 标签（active-chat 的 openChatTab /
//     openNewChatTab；⌘O 与原生菜单走同一个入口）；
//   - 详情区**单挂载**：ChatTabHost 按 `useActiveChat().mountKey` keyed，切标签 = 重挂
//     （标签框架红线：不做多实例常驻；切走的在途 run 由 useBackgroundChatRun 兜底）；
//   - 会话引擎 useGeneralChat 住在宿主实例内（团队页 TeamChatHost 同款），不再是本层的共享态。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Plus } from 'lucide-react'

import type { ChatSession, ChatSessionListItem } from '@shared/api/types'
import type { ComposerDraftBridgeProps } from '@shared/assistant/components/ComposerDraftBridge'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat, type UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
import { toastError } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import {
  adoptChatSession,
  openChatTab,
  openNewChatTab,
  readChatTabDraft,
  saveChatTabDraft,
  useActiveChat
} from '@shared/state/active-chat'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useDomainCollapsed } from '@shared/state/nav-shell'
import { closeObjectTab, setObjectTabTitle } from '@shared/state/tab-workspace-bridge'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'

import { AgentThreadList } from './AgentThreadList'
import { AgentConversation } from './AgentConversation'
import { useNarrow } from './hooks'
import { titleOf } from './sessionTitle'

const ALL_SESSIONS_KEY = [...qk.chat.allSessions(), 'interactive'] as const

export function AgentViewLayout(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const narrow = useNarrow()
  const [collapsed, setCollapsed] = useState(false)
  // 会话列 = 对话域的「二级栏」（registry second:'page'）：折叠读 nav-shell store（09-01 侧栏批，
  // 按域一份）。窄窗（<780）单栏由 useNarrow 自治，列是整页，不藏。
  const navHidden = useDomainCollapsed('chats')
  // Narrow single-pane back-stack: the list and the conversation alternate (a row tap / "New" pushes
  // the conversation; the back arrow returns to the list).
  const [mobileDetail, setMobileDetail] = useState(false)
  const activeChatTargetId = useActiveChat((s) => s.activeChatTargetId)
  const mountKey = useActiveChat((s) => s.mountKey)

  // Phase 9 — UNIFIED history (email + general) for the left list, from listAllSessions (same query key
  // as ChatsTab → shared cache). Each row carries its own title (email subject / first user message).
  const sessionsQ = useQuery({
    queryKey: ALL_SESSIONS_KEY,
    // dogfood-3 — include archived sessions so the left list can render the bottom "归档" group
    // (active vs archived are split client-side in AgentThreadList).
    queryFn: () => mailApi.chat.listAllSessions({ includeArchived: true, origin: 'interactive' }),
    staleTime: 10_000
  })
  const items = sessionsQ.data ?? []
  const invalidateSessions = useCallback((): void => {
    void qc.invalidateQueries({ queryKey: ALL_SESSIONS_KEY })
  }, [qc])

  // assistant-modal P6 — consume a fullscreen-jump request: the floating modal（and the peek list /
  // notification deeplink / run-history jump）parked a session id (requestOpenAgentSession) then
  // navigated here; open its tab so the agent view lands on that exact chat. Declared BEFORE the
  // auto-open below: effects run in order, and the auto-open must see this tab already active.
  const pendingAgentSessionId = useAIChatPanel((s) => s.pendingAgentSessionId)
  const consumeOpenAgentSession = useAIChatPanel((s) => s.consumeOpenAgentSession)
  useEffect(() => {
    if (pendingAgentSessionId == null) return
    openChatTab(pendingAgentSessionId)
    consumeOpenAgentSession()
  }, [pendingAgentSessionId, consumeOpenAgentSession])

  // 进域时没有任何 chat 标签（rail 点进来 / 关掉最后一个之后再进来）→ 开一张新会话标签，
  // 与老行为「进 /sessions 就是一张新对话」一致。只在挂载时判一次：关掉最后一个标签时激活槽
  // 回主标签、路由随之离开本页，这里不能再补开一张把人留住。StrictMode 双跑读到刚开的那张 →
  // 不再开。
  useEffect(() => {
    if (useActiveChat.getState().activeChatTargetId === null) openNewChatTab()
  }, [])

  const actionFail = (err: unknown): void => {
    toastError(t('agentView.actionFail', { error: errorMessage(err) }))
  }

  const list = (
    <AgentThreadList
      items={items}
      // 临时负 id 还不是列表里的行，高亮只认真 id。
      activeSessionId={
        activeChatTargetId !== null && activeChatTargetId > 0 ? activeChatTargetId : null
      }
      onSelect={(id) => {
        const item = items.find((s) => s.id === id)
        openChatTab(id, item === undefined ? undefined : titleOf(item, t))
        if (narrow) setMobileDetail(true)
      }}
      onNew={() => {
        openNewChatTab()
        if (narrow) setMobileDetail(true)
      }}
      onDelete={(id) => {
        // 标签先收（指着已删行的标签重启后是死标签；激活的那张被关 → 宿主随 key 卸载），
        // 服务端删完再刷新列表。
        closeObjectTab('chat', id)
        void mailApi.chat.deleteSession(id).then(invalidateSessions).catch(actionFail)
      }}
      onRename={(id, title) => {
        // Persist the rename (serve-api → ai_chat.db) then refresh the list so the new title shows;
        // the tab title follows at once (the list refresh would catch it too, a beat later).
        setObjectTabTitle('chat', id, title)
        void mailApi.chat.updateSessionTitle(id, title).then(invalidateSessions).catch(actionFail)
      }}
      onArchive={(id) => {
        // dogfood-2: 归档 = 软删(从日期分组移到底部「归档」组；行/消息保留)。serve-api → ai_chat.db，刷新。
        void mailApi.chat.updateSessionArchived(id, true).then(invalidateSessions).catch(actionFail)
      }}
      onRestore={(id) => {
        // dogfood-3: 恢复 = 取消归档(archived=false)，从「归档」组移回日期分组。
        void mailApi.chat
          .updateSessionArchived(id, false)
          .then(invalidateSessions)
          .catch(actionFail)
      }}
      onPin={(id, pinned) => {
        void mailApi.chat.updateSessionPinned(id, pinned).then(invalidateSessions).catch(actionFail)
      }}
      onStar={(id, starred) => {
        void mailApi.chat
          .updateSessionStarred(id, starred)
          .then(invalidateSessions)
          .catch(actionFail)
      }}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      fluid={narrow}
      navHidden={navHidden}
    />
  )

  // mountKey === null 只在两种时刻出现：关掉最后一个 chat 标签、路由还没离开本页的那一帧；
  // 或上面的自动开标签被拒（满且全锁定，toast 已出）。后者要给用户一个手动入口。
  const conversation =
    mountKey === null ? (
      <div className="flex flex-1 items-center justify-center">
        <button
          type="button"
          onClick={() => openNewChatTab()}
          className="flex h-8 items-center gap-2 rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 text-body font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3"
        >
          <Plus size={15} strokeWidth={2} className="shrink-0 text-coral" />
          {t('chat.tabs.newChat')}
        </button>
      </div>
    ) : (
      <ChatTabHost
        key={mountKey}
        targetId={mountKey}
        items={items}
        sessionsReady={sessionsQ.isSuccess}
        invalidateSessions={invalidateSessions}
      />
    )

  if (narrow) {
    return mobileDetail ? (
      <div className="flex h-full w-full flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-border px-2">
          <button
            type="button"
            onClick={() => setMobileDetail(false)}
            aria-label={t('agents.reports.backToList')}
            className="grid size-8 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <span className="truncate text-body font-medium text-ink-fg">{t('nav.agentView')}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{conversation}</div>
      </div>
    ) : (
      <div className="h-full w-full">{list}</div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      <div className="flex min-w-0 flex-1 flex-col">{conversation}</div>
    </div>
  )
}

/** 一张 chat 标签的宿主：会话引擎 + 换锚 + 标题回填 + 草稿快照 + 「会话不存在」空态。
 *  宿主按 mountKey keyed，`targetId` 视为 mount 常量（真 id > 0 = 既有会话；负 = 新会话）。 */
function ChatTabHost({
  targetId,
  items,
  sessionsReady,
  invalidateSessions
}: {
  targetId: number
  items: ChatSessionListItem[]
  sessionsReady: boolean
  invalidateSessions: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const chat = useGeneralChat()

  // 既有会话：挂载即一次性 select（对同 id no-op，effect 幂等）。临时负 id = 新会话，引擎的
  // activeSessionId 保持 null，首发经 onEnsureSession 懒建。
  const selectSession = chat.selectSession
  useEffect(() => {
    if (targetId > 0) void selectSession(targetId)
  }, [targetId, selectSession])

  // 本标签当前指着的会话（首发换锚后是真 id）—— 卸载时写草稿快照用，读 ref 不读 prop。
  const tabTargetRef = useRef(targetId)

  // 首发换锚：把引擎的 adoptSession 包一层，同步调 adoptChatSession。它在 ensureSession 的
  // `.then(adopt)` 里被调，宿主已被切走（卸载）时也照样换锚 —— 用 effect 盯 activeSessionId
  // 的写法在那种时序下会漏掉，标签就永远停在临时 id。
  const chatAdoptSession = chat.adoptSession
  const adoptSession = useCallback(
    (session: ChatSession): void => {
      chatAdoptSession(session)
      if (targetId < 0) {
        adoptChatSession(targetId, session.id)
        tabTargetRef.current = session.id
      }
    },
    [chatAdoptSession, targetId]
  )
  const chatForTab: UseGeneralChatReturn = { ...chat, adoptSession }

  // A new general session created via send / adoptSession grows useGeneralChat.sessions — mirror it
  // into the unified list so the fresh chat shows up promptly (message_count freshness rides staleTime).
  useEffect(() => {
    invalidateSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.sessions])

  // The active session's unified item (anchor_type / email_id / backend_kind) drives the conversation's
  // runtime + context routing (email vs general). null for a brand-new chat → general default.
  const sid = chat.activeSessionId
  const listedActiveItem = items.find((s) => s.id === sid) ?? null
  const directSessionQ = useQuery({
    queryKey: ['chat', 'session', sid],
    queryFn: () => mailApi.chat.getSession(sid as number),
    enabled: sid != null && listedActiveItem == null,
    staleTime: 10_000
  })
  // Agent-run records are intentionally absent from the interactive sidebar, but a run-history jump
  // still needs the exact row metadata so AgentConversation enters locked record mode.
  const activeItem = listedActiveItem ?? directSessionQ.data ?? null
  // 重启恢复 / 在别处删除：标签指着的会话已不存在（列表里没有、按 id 直取也是 null）→ 空态并
  // 允许关标签；不静默移除，免得用户困惑「标签哪去了」。
  const missing =
    targetId > 0 &&
    sid === targetId &&
    sessionsReady &&
    listedActiveItem === null &&
    directSessionQ.isSuccess &&
    directSessionQ.data === null

  // 标签标题随会话标题（手动改名 / 自动标题 / 首条用户消息）。「未命名」兜底不写：标签条对空
  // 标题自有 i18n 兜底，写死一份会在切语言后过时。
  const title = activeItem === null ? null : titleOf(activeItem, t)
  useEffect(() => {
    if (sid == null || title === null || title === t('sessions.untitled')) return
    setObjectTabTitle('chat', sid, title)
  }, [sid, title, t])

  // 草稿快照：挂载时从标签读一次初值；输入框文本经 ComposerDraftBridge 同步进 ref；卸载
  // （切标签 / 离开本页）时写一次 —— updateTab 每次落 localStorage，不逐键写。
  const [initialDraft] = useState(() => readChatTabDraft(targetId))
  const draftTextRef = useRef(initialDraft)
  const composerDraft = useMemo<ComposerDraftBridgeProps>(
    () => ({
      restore: () => draftTextRef.current,
      onChange: (text) => {
        draftTextRef.current = text
      }
    }),
    []
  )
  useEffect(
    () => (): void => {
      saveChatTabDraft(tabTargetRef.current, draftTextRef.current)
    },
    []
  )

  if (missing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-aux text-ink-fg-2">{t('chat.tabs.missing')}</div>
        <button
          type="button"
          onClick={() => closeObjectTab('chat', targetId)}
          className="rounded-md border border-ink-border bg-ink-2 px-3 py-1.5 text-aux font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3"
        >
          {t('tabs.close')}
        </button>
      </div>
    )
  }

  // The welcome heading + quick-action chips live INSIDE AgentThread (heading at the viewport top,
  // chips below the centered composer), so AgentConversation owns the empty state.
  // P2-9 — local boundary: the list stays interactive when the conversation crashes, and picking
  // another session auto-clears the held error via resetKeys.
  return (
    <ChatPanelBoundary resetKeys={[chat.activeSessionId]}>
      <AgentConversation chat={chatForTab} activeItem={activeItem} composerDraft={composerDraft} />
    </ChatPanelBoundary>
  )
}
