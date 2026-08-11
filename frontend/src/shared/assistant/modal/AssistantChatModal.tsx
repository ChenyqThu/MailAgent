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
// The default body is AgentConversation (the SAME general-agent conversation as /sessions). A matter
// invocation swaps in MatterChatPanel as a body-only adapter; the outer dock, controls, model/grant
// settings and gateway tool ceiling stay shared. fullscreen remains an ACTION to the general /sessions
// view, not a persisted mode.
//
// Mount-once: the body (useGeneralChat session load) only mounts after the FIRST open, then stays mounted
// (hidden via CSS when minimised) so the conversation survives minimise/restore + a mode switch.
//
// InboxLayout mounts this unconditionally (S3: the ASSISTANT_MODAL flag was GA'd away).

import { useEffect, useRef, useState } from 'react'
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
import { AgentConversation } from '@shared/components/agents/AgentConversation'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'
import { MatterChatPanel } from '@shared/components/matters/MatterChatPanel'
import { ChatModalHistoryDropdown } from './ChatModalHistoryDropdown'
import { titleOf } from './sessionTitle'

// sidebar 内嵌可调宽 — 宽度缓存（范式同 InboxLayout 旧 AI 面板：clamp + localStorage + try-catch）。
// 独立 key（不复用旧面板的 mailagent.chat.panelWidth）：dock 与旧面板是两套不同实体。
const SIDEBAR_WIDTH_DEFAULT = 400
const SIDEBAR_WIDTH_MIN = 320
const SIDEBAR_WIDTH_MAX = 720
const SIDEBAR_WIDTH_PREF = 'mailagent.chat.dockSidebarWidth'
function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px))
}
function readSidebarWidthPref(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_PREF))
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_WIDTH_DEFAULT
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}
function writeSidebarWidthPref(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_PREF, String(px))
  } catch {
    /* localStorage 在 sandbox / privacy 模式可能拒写; 偏好丢失无伤大雅 */
  }
}

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
  const startNewMatterConversation = useAIChatPanel((s) => s.startNewMatterConversation)
  const clearMatterChat = useAIChatPanel((s) => s.clearMatterChat)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const sidebar = mode === 'sidebar'

  // harness-chat lane A（07-15 owner 需求「切出回来原样呈现」）— 唤出（FAB / ⌘J，最小化→展开）
  // **恢复上次活跃会话**，不再在 visible 上升沿强开新会话（旧行为把最小化→展开也当"新对话"，
  // 正在后台输出/待审批的会话被丢在视野外）。body 是 mount-once + CSS 隐藏，useGeneralChat 状态
  // 跨最小化存活 → 什么都不做就是"原样恢复"。显式「新对话」入口保留（header PenSquare 按钮 →
  // chat.newSession）。首次打开天然是空会话；AgentConversation 的 email-context effect 仍只在
  // 空会话上 seed 当前 activeEmailId（chatIsEmpty 门未变）。

  // sidebar 内嵌可调宽：宽度 state + 左缘拖拽手柄（仅 sidebar 模式；floating 用固定尺寸）。拖拽中直接写
  // inline width 跟手（不走 React state 避免每帧 re-render），mouseup 才落 state + localStorage。teardown
  // 存 ref，onUp 与 unmount 共用 → 拖拽中卸载不漏 listener / 不留 body col-resize·user-select 残留。
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidthPref)
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

  // fullscreen = ACTION: park the active session for AgentViewLayout to select (P6), navigate, minimise.
  const onFullscreen = (): void => {
    setMenuOpen(false)
    if (matterTarget === null && chat.activeSessionId != null) {
      requestOpenAgentSession(chat.activeSessionId)
    }
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
          'fixed bottom-8 right-5 z-40 flex h-[min(40rem,calc(100vh-7.5rem))] w-[min(28rem,calc(100vw-2.5rem))] flex-col',
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
        <div className="relative min-w-0 flex-1">
          {matterTarget ? (
            <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
              <span className="shrink-0 text-body font-semibold text-ink-fg">
                {t('matters.chat.agentName')}
              </span>
              <span className="truncate font-mono text-meta text-ink-fg-3">
                {matterTarget.publicId}
              </span>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => (matterTarget ? startNewMatterConversation() : chat.newSession())}
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
      {/* body: general AgentConversation or the matter-only body adapter, inside one shared dock. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* P2-9 — local boundary: a streaming-render crash resets in place
            instead of blanking the whole window; switching session while
            crashed auto-clears via resetKeys. */}
        <ChatPanelBoundary
          resetKeys={[
            matterTarget?.id ?? chat.activeSessionId,
            matterTarget ? matterConversationEpoch : 'general'
          ]}
        >
          {matterTarget ? (
            <MatterChatPanel
              key={matterTarget.id}
              matter={matterTarget}
              conversationEpoch={matterConversationEpoch}
            />
          ) : (
            <AgentConversation
              chat={chat}
              activeItem={activeItem}
              welcomeAlign="left"
              initialMentionEmailId={activeEmailId ?? undefined}
            />
          )}
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
