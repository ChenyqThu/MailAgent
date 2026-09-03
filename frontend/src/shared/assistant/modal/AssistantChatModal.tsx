// assistant-modal — AI chat dock with two presentations (floating card / embedded resizable sidebar)
// + an action (fullscreen → the /sessions agent view). The FAB expands into this.
//
// Rendered INLINE as a flex child of InboxLayout's master-detail row (NOT a portal): so the SIDEBAR
// mode is a real embedded column that PUSHES the email content (resizable + width-cached, matching the
// legacy AIChatPanel) rather than a floating overlay. The FLOATING mode positions the SAME element
// `fixed` (0 flow footprint). Switching floating↔sidebar only swaps this wrapper's className/positioning
// — the active conversation body remains at the SAME mount point, so a mode switch never remounts it
// (no dropped stream / lost timing).
//
// The body is ALWAYS AgentConversation (the SAME general-agent conversation as /sessions).
// 🔴 0812 收口：事项对话曾在这里换成 MatterChatPanel 这个第二套 chat UI —— 设计稿
// (`matters/chat.jsx`) 开头就写着 *No second chat UI*，而那套面板还漏掉了模型选择器 / effort 档 /
// @mention / 附件（它没有 ChatComposerControlsProvider）。现在事项只是 AgentConversation 上的一枚
// context chip + 一组事项控件（见 useMatterConversation），dock / header / 历史下拉全部共用。
// fullscreen remains an ACTION to the general /sessions view, not a persisted mode.
//
// Mount-once: the body (useGeneralChat session load) only mounts after the FIRST open, then stays mounted
// (hidden via CSS when minimised) so the conversation survives minimise/restore + a mode switch.
//
// InboxLayout mounts this unconditionally (S3: the ASSISTANT_MODAL flag was GA'd away).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import {
  Check,
  ChevronDown,
  ChevronsRight,
  Minus,
  PenSquare,
  SlidersHorizontal
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { useActiveEmail } from '@shared/state/active-email'
import {
  useAIChatPanel,
  hideChatModal,
  requestOpenAgentSession,
  type AssistantMode
} from '@shared/state/ai-chat-panel'
import { selectDockAnchorTab, useTabWorkspace, type TabId } from '@shared/state/tab-workspace'
import { bindTabChatSession } from '@shared/state/tab-workspace-bridge'
import { AgentConversation } from '@shared/components/agents/AgentConversation'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'
import { ChatModalHistoryDropdown } from './ChatModalHistoryDropdown'
import { openDockForTab } from './dockForTab'
import { titleOf } from './sessionTitle'
import {
  clampSidebarWidth,
  readSidebarWidthPref,
  writeSidebarWidthPref,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN
} from './sidebarWidth'

/** Mount-once gate: the dock body (useGeneralChat + its session load) only mounts after the FIRST open,
 *  so a user who never opens it pays no IPC. After that it stays mounted (hidden via CSS when minimised)
 *  so the conversation + stream survive minimise/restore AND a floating↔sidebar mode switch. */
export function AssistantChatModal(): React.JSX.Element | null {
  const visible = useAIChatPanel((s) => s.visible)
  const [mountedOnce, setMountedOnce] = useState(visible)
  useEffect(() => {
    // 一次性 false→true latch（同 InboxLayout mountPanel 范式）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setMountedOnce(true)
  }, [visible])
  if (!mountedOnce) return null
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
  const visible = useAIChatPanel((s) => s.visible)
  const mode = useAIChatPanel((s) => s.mode)
  const setMode = useAIChatPanel((s) => s.setMode)
  const matterTarget = useAIChatPanel((s) => s.matterTarget)
  const matterConversationEpoch = useAIChatPanel((s) => s.matterConversationEpoch)
  const clearMatterChat = useAIChatPanel((s) => s.clearMatterChat)
  const pendingTabSession = useAIChatPanel((s) => s.pendingTabSession)
  const consumeTabSession = useAIChatPanel((s) => s.consumeTabSession)
  const pendingPrompt = useAIChatPanel((s) => s.pendingPrompt)
  const anchorTabId = useTabWorkspace((s) => selectDockAnchorTab(s)?.id ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const sidebar = mode === 'sidebar'

  // harness-chat lane A（07-15 owner 需求「切出回来原样呈现」）— 唤出（⌘J，最小化→展开）
  // **恢复上次活跃会话**，不再在 visible 上升沿强开新会话（旧行为把最小化→展开也当"新对话"，
  // 正在后台输出/待审批的会话被丢在视野外）。body 是 mount-once + CSS 隐藏，useGeneralChat 状态
  // 跨最小化存活 → 什么都不做就是"原样恢复"。显式「新对话」入口保留（header PenSquare 按钮 →
  // chat.newSession）。首次打开天然是空会话；AgentConversation 的 email-context effect 仍只在
  // 空会话上 seed 当前 activeEmailId（chatIsEmpty 门未变）。
  // 09-02 —— FAB 唤出多一层：按激活对象标签的 `chatSessionId` 绑定递请求（见下方 pendingTabSession
  // effect），标签绑了就回它的会话、没绑就开新；dock 开着切对象标签走同一套解析（见下方切标签
  // 同步 effect）。没有对象标签（⌘J / 通用场景）仍是上面那条。

  // sidebar 内嵌可调宽：宽度 state + 左缘拖拽手柄（仅 sidebar 模式；floating 用固定尺寸）。拖拽中直接写
  // inline width 跟手（不走 React state 避免每帧 re-render），mouseup 才落 state + localStorage。teardown
  // 存 ref，onUp 与 unmount 共用 → 拖拽中卸载不漏 listener / 不留 body col-resize·user-select 残留。
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidthPref)

  // 视口上界只在拖拽/首次读取时算过一次，缩窗口时侧栏不会自己让位 —— 补一个 resize 重夹。
  // 🔴 只在真的需要收窄时 setState（缩到一半又拉回来时不覆写用户偏好，也不每帧 re-render）；
  // localStorage 里存的仍是用户拖出来的值，窗口拉宽后自然恢复。
  useEffect(() => {
    const onResize = (): void => {
      setSidebarWidth((current) => {
        const next = clampSidebarWidth(current)
        return next === current ? current : next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)
  const dragTeardownRef = useRef<(() => void) | null>(null)
  const startResize = (e: React.MouseEvent): void => {
    const el = rootRef.current
    if (!el) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = el.getBoundingClientRect().width
    let nextWidth = startWidth
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent): void => {
      // 面板在右侧 → 向左拖变宽（newWidth = startWidth - Δx）。
      nextWidth = clampSidebarWidth(startWidth - (ev.clientX - startX))
      el.style.width = `${nextWidth}px`
    }
    const teardown = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      dragTeardownRef.current = null
    }
    const onUp = (): void => {
      teardown()
      setSidebarWidth(nextWidth)
      writeSidebarWidthPref(nextWidth)
    }
    dragTeardownRef.current = teardown
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  useEffect(() => () => dragTeardownRef.current?.(), [])
  const resizeByKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    // 面板在右侧：ArrowLeft 向左 = 变宽，ArrowRight 向右 = 变窄（与拖拽方向一致）。
    const delta = e.key === 'ArrowLeft' ? 16 : -16
    setSidebarWidth((w) => {
      const next = clampSidebarWidth(w + delta)
      writeSidebarWidthPref(next)
      return next
    })
  }

  // Interactive history only; headless agent records live in the Agents Chats tab. The
  // active session's item drives AgentConversation's runtime + context routing (email vs general).
  const sessionsQ = useQuery({
    queryKey: [...qk.chat.allSessions(), 'interactive'] as const,
    queryFn: () => mailApi.chat.listAllSessions({ includeArchived: true, origin: 'interactive' }),
    staleTime: 10_000
  })
  const items = sessionsQ.data ?? []
  const activeItem = items.find((s) => s.id === chat.activeSessionId) ?? null

  // 0813 dogfood 轮 3 #5 —— 「事项对话」**每次都开一场新对话**（owner：默认进新会话；历史仍从
  // 标题下拉的会话列表里进，一条不删）。
  //
  // 改造前这里去 serve-api 的 list-for-matter 找这件事最近一次会话并选中它。那条路除了不合
  // owner 的默认期待，还**结构性地**打断「立即跟进」（轮 3 #6）：会话发现是异步的，而
  // `startMatterChatWithPrompt` 在同一次点击里还递了一条待发指令 —— 指令先在当前（空）会话上
  // append 出去，几十毫秒后 selectSession 落地把 runtime 换掉，刚发出的那轮连同它的流一起从
  // 界面上消失，用户看到的就是「浮窗出来了，然后什么都没发生」。同步新建把这个竞态从根上删掉。
  //
  // 🔴 `chatIsFresh` 那道门不是优化，是**同一个竞态的另一半**：effect 是父组件的，跑在
  // AgentConversation / ChatPromptDispatcher 这些子组件的 effect **之后**（React 子先父后）。
  // 当前已经是一场空的新对话时，指令这一帧就已经 append 出去了，此时再 newSession() 会 bump
  // navEpoch → runtime 重挂 → 照样把它冲掉。而「已经是空的新对话」本来就等于「新开了一场」，
  // 什么都不做才是对的。取值走 ref：把 messages 放进 deps 会让每次消息变化都重开一场对话。
  const chatNewSession = chat.newSession
  const chatSelectSession = chat.selectSession
  const matterTargetId = matterTarget?.id ?? null
  const chatIsFreshRef = useRef(false)
  chatIsFreshRef.current = chat.activeSessionId === null && chat.messages.length === 0

  // 09-02 —— dock 里这场对话**属于哪个对象标签**（email / matter）。会话变化的写回、切标签时的
  // 同步判据都看它，而不是「此刻激活的标签」：「立即跟进」的指令还在飞时用户切走了标签，首发拿到
  // 的会话 id 必须落回发起它的那个标签。每次显式重定向（FAB / 切标签同步 / 立即跟进 / header
  // 新建·换会话）都把它拨到当时的锚标签；主标签 / chat 标签激活时为 null（无处可记）。
  const ownerTabRef = useRef<TabId | null>(anchorTabId)
  const retargetOwner = useCallback((): void => {
    ownerTabRef.current = selectDockAnchorTab(useTabWorkspace.getState())?.id ?? null
  }, [])
  // 按绑定选会话时记下尝试的 id —— 它已被删除时 selectSession 落 E_LOAD，由下方回落成新会话。
  const attemptedSelectRef = useRef<number | null>(null)
  // 绑了 → 回到那场会话；没绑 → 开新（已经是一场空的新对话则原地不动，理由见 chatIsFresh 门）。
  const applyBinding = useCallback(
    (sessionId: number | null): void => {
      if (sessionId !== null) {
        attemptedSelectRef.current = sessionId
        void chatSelectSession(sessionId)
        return
      }
      if (!chatIsFreshRef.current) chatNewSession()
    },
    [chatSelectSession, chatNewSession]
  )

  // 09-02 —— FAB 在事项标签上唤出时，同一次点击还递了这个标签的会话请求（下一个 effect 消费）；
  // 那条请求才是这场对话的归宿（回到绑定的会话 / 开新），本 effect 让位 —— 否则绑定的会话会先
  // 被这里的 newSession 冲掉。走 ref 读渲染期的值：两个 effect 同一次 commit 里跑，与声明顺序无关。
  const pendingTabSessionRef = useRef(pendingTabSession)
  pendingTabSessionRef.current = pendingTabSession
  useEffect(() => {
    if (matterTargetId === null) return
    if (pendingTabSessionRef.current !== null) return
    retargetOwner()
    if (chatIsFreshRef.current) return
    chatNewSession()
  }, [matterTargetId, matterConversationEpoch, chatNewSession, retargetOwner])

  // 09-02 —— 对象标签 ↔ dock 会话绑定（FAB / 切标签同步递来的一次性请求）。
  useEffect(() => {
    if (pendingTabSession === null) return
    consumeTabSession(pendingTabSession.nonce)
    retargetOwner()
    applyBinding(pendingTabSession.sessionId)
  }, [pendingTabSession, consumeTabSession, retargetOwner, applyBinding])

  // 09-02 —— dock 开着时切对象标签：按 FAB 同一套解析同步会话（新激活标签绑了 → 回它的会话；
  // 没绑 → 开新，首发后写回）。owner 原话：「原来的 ai chat 窗口是保留的，显示为原来的；新开的
  // 显示新会话」。有待发指令（立即跟进的 pendingPrompt）或标签请求在飞时本次跳过 —— 同步会换掉
  // runtime 把它冲掉；它们落地后本 effect 因依赖变化再跑一次，那时再按绑定处理。dock 收着时不动
  // （FAB 点击时才解析）。
  const inFlight = pendingPrompt !== null || pendingTabSession !== null
  useEffect(() => {
    if (!visible || inFlight) return
    const tab = selectDockAnchorTab(useTabWorkspace.getState())
    if (tab === null || tab.id === ownerTabRef.current) return
    openDockForTab(tab)
  }, [visible, anchorTabId, inFlight])

  // 09-02 —— 标签绑定的会话已被删除：selectSession 落 E_LOAD → 回落成新会话（newSession 顺带清
  // 错误；activeSessionId 变 null 让下方写回清掉死绑定，首发拿到新 id 再写回同一标签）。只认自己
  // 按绑定发起的那次选择（attemptedSelectRef），别的 E_LOAD 不归这里管；加载成功即注销记录。
  useEffect(() => {
    const attempted = attemptedSelectRef.current
    if (attempted === null || chat.activeSessionId !== attempted) return
    if (chat.error?.code === 'E_LOAD') {
      attemptedSelectRef.current = null
      chatNewSession()
      return
    }
    if (chat.messagesSessionId === attempted) attemptedSelectRef.current = null
  }, [chat.activeSessionId, chat.error, chat.messagesSessionId, chatNewSession])

  // 会话**变化** → 写回这场对话所属的对象标签（换会话 / header 新建 / 首发拿到真 id）。挂载那一帧的
  // 值不是用户动作，不写：dock 宿主随 layout 重挂时 useGeneralChat 从 null 起步，写下去会把标签
  // 原有的绑定清掉。
  const boundSessionRef = useRef(chat.activeSessionId)
  useEffect(() => {
    if (boundSessionRef.current === chat.activeSessionId) return
    boundSessionRef.current = chat.activeSessionId
    bindTabChatSession(ownerTabRef.current, chat.activeSessionId)
  }, [chat.activeSessionId])

  // fullscreen = ACTION: park the active session for AgentViewLayout to select (P6), navigate, minimise.
  const onFullscreen = (): void => {
    setMenuOpen(false)
    if (chat.activeSessionId != null) requestOpenAgentSession(chat.activeSessionId)
    clearMatterChat()
    void navigate({ to: '/sessions' })
    hideChatModal()
  }
  const onPickMode = (next: AssistantMode): void => {
    setMode(next)
    setMenuOpen(false)
  }

  // GSAP 入场（替代 CSS animate-in，用户反馈：浮窗/抽屉打开动效统一走 GSAP）：floating 缩放+上浮+淡入，
  // sidebar 右滑+淡入。§8 standard ease + base 时长。只依赖 visible → 仅开窗（最小化→展开）时播；floating↔
  // sidebar 切换（visible 不变）不重播，保持顺滑换 className（不重挂 body）。clearProps 复原 inline transform，
  // 不干扰 sidebar 的布局宽度 / 拖拽。reduce 直达终态。
  const reduce = useReducedMotion()
  useGSAP(
    () => {
      const el = rootRef.current
      if (!el || !visible) return
      if (reduce) {
        gsap.set(el, { opacity: 1, x: 0, y: 0, scale: 1 })
        return
      }
      const from = sidebar ? { opacity: 0, x: 28 } : { opacity: 0, y: 12, scale: 0.97 }
      gsap.fromTo(el, from, {
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
        duration: DUR.base,
        clearProps: 'opacity,transform'
      })
    },
    // 只依赖 visible（sidebar 故意不入 deps：切模式不重播入场）。
    { dependencies: [visible] }
  )

  // 容器：minimised → hidden（保状态、零 flow 占位 → FAB 显）；floating → fixed 右下卡片（脱流，不挤压）；
  // sidebar → 内嵌 flex 列（在 master-detail 行内挤压正文）+ 左缘可调宽。
  const wrapperClass = !visible
    ? 'hidden'
    : sidebar
      ? // 侧边态：与 AIChatPanel 一致用 glass-panel（侧面板玻璃），不再孤立 bg-ink-1
        'relative flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--hairline)] glass-panel'
      : cn(
          // dogfood：bottom-8 对齐 FAB（bottom-8 right-5）—— 浮窗右下角锚点跟 FAB 一致，展开/收起视觉连续。
          // dogfood 轮 2 #1：28rem 在模型名较长时挤不下 AgentComposer 工具条右组（环/effort/
          // 模型 chip/发送），32rem 留出的余量配合 ModelPicker chip 的 min-w-0 收缩才够用。
          'fixed bottom-8 right-5 z-40 flex h-[min(40rem,calc(100vh-7.5rem))] w-[min(32rem,calc(100vw-2.5rem))] flex-col',
          // 浮窗态：用 glass-pop（浮层材质，与 popover/menu 同档；2026-08-05 起该配方是不透明
          // 实色，不再自带 blur —— 见 index.css .glass-pop / DESIGN.md §18.1 C10），保留圆角。
          // 投影由 `.glass-pop` 的 --pop-shadow 提供 —— authored 规则排在 `@tailwind utilities`
          // 之后，同特异度源码序胜，原先并挂的 `shadow-[…]` 从来没生效过（死类，08-05 删）。
          // 主题 v3 C8/批 4: 浮层档圆角 rounded-2xl(16) → --r-pop(14)，与其自述「popover/menu 同档」一致
          'rounded-[var(--r-pop)] glass-pop'
        )

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('chat.modal.title')}
      className={cn('overflow-hidden', wrapperClass)}
      style={sidebar && visible ? { width: sidebarWidth } : undefined}
    >
      {/* sidebar 左缘可调宽手柄（仅 sidebar + 展开时）。细条 w-1，col-resize cursor，z-50 接 mousedown。 */}
      {sidebar && visible && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('chat.resizePanel')}
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          tabIndex={0}
          onMouseDown={startResize}
          onKeyDown={resizeByKey}
          className="absolute bottom-0 left-0 top-0 z-50 w-1 cursor-col-resize hover:bg-coral/30 focus:outline-none focus-visible:bg-coral/50"
        />
      )}
      {/* header: 左 标题（P4 下拉切 history session）· 右 三键（新开会话 / switch-mode 菜单 / 最小化或 >>）。 */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--hairline)] px-3">
        {/* P4 标题状态机：新会话→"新对话"；有 activeItem→titleOf（首条输入概览 first_user_message →
            AI 摘要 title，优先级同 AgentThreadList）。点击展开 history 下拉切会话（去 archived）。 */}
        {/* 0812 —— 事项对话不再有自己的 header 分支（那是"第二套 UI"的最后一块）：事项身份
            由 composer 上方的 context chip 承载，标题/历史下拉一视同仁。 */}
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
                // 显式换会话 = 不再跟着上一次的事项种子走（选中的会话若本身锚在某件事上，
                // AgentConversation 会从它自己的 anchor 认出来）。这场对话从此属于当前锚标签。
                clearMatterChat()
                retargetOwner()
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
            onClick={() => {
              retargetOwner()
              chat.newSession()
            }}
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
      {/* body: ONE conversation component. 事项只是它身上的一枚 context chip（+ 一组事项控件）。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* P2-9 — local boundary: a streaming-render crash resets in place
            instead of blanking the whole window; switching session while
            crashed auto-clears via resetKeys. */}
        <ChatPanelBoundary resetKeys={[chat.activeSessionId, matterConversationEpoch]}>
          <AgentConversation
            chat={chat}
            activeItem={activeItem}
            welcomeAlign="left"
            initialMentionEmailId={activeEmailId ?? undefined}
            initialMatterTarget={matterTarget ?? undefined}
            // 0813 #3 —— 浮窗 / 抽屉都是横向紧张的场地：工具行走紧凑档（context 环不写数值）。
            denseControls
          />
        </ChatPanelBoundary>
      </div>
    </div>
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
