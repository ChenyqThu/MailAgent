// Sprint 10 user-acceptance follow-up — AI Chat panel visibility state.
//
// Before: AIChatPanel rendered unconditionally as the inbox's fourth column,
// forcing the user into a 4-column layout at 1280px (240 + 340 + flex + 360
// → detail pane squeezed under 320px after gutters).
//
// After: panel is closed by default. Users open it via ⌘L (existing keymap),
// the toolbar's "AI Assistant" icon, or the sidebar AI Agents entries. Same
// pattern as keyboard-help.ts / command-palette.ts — zustand store with
// module-level helpers for non-React callers.

import { create } from 'zustand'

import type { ChatBackendKind } from '@shared/api/types'

export interface MatterChatTarget {
  id: number
  publicId: string
  title: string
}

/** assistant-modal (新大版本) — dock mode of the floating AI chat modal. `fullscreen` is an ACTION
 *  (navigate to the agent view), NOT a persisted dock mode, so only these two are cached. */
export type AssistantMode = 'floating' | 'sidebar'

interface AIChatPanelStore {
  visible: boolean
  setVisible(next: boolean): void
  toggle(): void
  // Sprint 14 PR A — session history sidebar. Default collapsed so the
  // 360 px panel stays roomy for the message list; user toggles via the
  // history button in the tab bar (AIChatPanel.tsx). Persisted in
  // localStorage by useAIChatSidebarPersist() so a reload restores the
  // last open/closed state.
  sidebarOpen: boolean
  setSidebarOpen(next: boolean): void
  toggleSidebar(): void
  // Global "AI 会话历史" → click a row → jump to that email + load that exact
  // session. The page sets `pendingOpen` + flips the active email; AIChatPanel
  // consumes it once the matching email's sessions are in hand (see
  // consumePendingOpen). One-shot.
  //
  // 交付文档 §3.1 — `backendKind` rides along so AIChatPanel can switch the panel
  // onto the SESSION's own agent before selecting it (a legacy kind renders the
  // D6 read-only transcript). With per-kind session scoping the target row only
  // lives in `chat.sessions` once the panel is on the matching kind, so opening
  // a cross-kind history row must flip the kind first.
  pendingOpen: { emailId: number; sessionId: number; backendKind: ChatBackendKind } | null
  requestOpenSession(emailId: number, sessionId: number, backendKind: ChatBackendKind): void
  consumePendingOpen(): void

  // assistant-modal (新大版本) — three-mode AI chat modal, ORTHOGONAL to `visible` (visible = expanded
  // vs minimised-to-FAB). `mode` is the cached dock mode (floating/sidebar, persisted in localStorage);
  // fullscreen is an action that navigates to the agent view (parks `pendingAgentSessionId` for
  // AgentViewLayout to consume). All fields are additive — the legacy panel / ⌘L never touch them.
  mode: AssistantMode
  setMode(next: AssistantMode): void
  openChatModal(): void
  hideChatModal(): void
  pendingAgentSessionId: number | null
  requestOpenAgentSession(sessionId: number): void
  consumeOpenAgentSession(): void

  // Matters MVP P6-A lane A5 / 0812 收口 — 事项**不再有第二套 chat UI**：`matterTarget` 现在只是
  // 「这次唤出 dock 时默认带上哪件事」的**种子**（与 activeEmailId 同性质），由 AgentConversation
  // 渲染成一枚可移除的 context chip。`matterConversationEpoch` 每次显式「事项对话」自增 —— dock 已
  // 经开着时也要能重新定位到这件事（epoch 变 = 重新按这个 matter 找它最近一次会话）。
  matterTarget: MatterChatTarget | null
  matterConversationEpoch: number
  openMatterChat(target: MatterChatTarget): void
  clearMatterChat(): void

  // 0812 —— 外部入口（邮件工具栏「创建事项」）把一条**指令**递给 dock 里的主 agent。
  // 走既有注入面：指令本身是一条普通用户消息，邮件引用仍由 AgentConversation 的 email context chip
  // （→ injectedContext）承载 —— 不新造注入路径。
  // `nonce` 让同一条指令能被连点两次（内容相同也算两次请求）；`emailId` 是「等这封邮件的 chip 就位
  // 再发」的门（没有它就会发出一条指着空气的指令）。
  pendingPrompt: { text: string; emailId: number | null; nonce: number } | null
  requestChatPrompt(text: string, emailId: number | null): void
  consumeChatPrompt(nonce: number): void
}

const SIDEBAR_STORAGE_KEY = 'mailagent.chat.sidebarOpen'

function readPersistedSidebar(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writePersistedSidebar(open: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (open) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, '1')
    } else {
      localStorage.removeItem(SIDEBAR_STORAGE_KEY)
    }
  } catch {
    // localStorage unavailable — in-memory state still works for the session.
  }
}

// assistant-modal (新大版本) — cached dock mode so re-opening the modal restores the last floating /
// sidebar choice. Default floating; only 'sidebar' is stored explicitly (anything else → floating).
const DOCK_MODE_STORAGE_KEY = 'mailagent.chat.dockMode'

function readDockModePref(): AssistantMode {
  try {
    if (typeof localStorage === 'undefined') return 'floating'
    return localStorage.getItem(DOCK_MODE_STORAGE_KEY) === 'sidebar' ? 'sidebar' : 'floating'
  } catch {
    return 'floating'
  }
}

function writeDockModePref(mode: AssistantMode): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(DOCK_MODE_STORAGE_KEY, mode)
  } catch {
    // localStorage unavailable — in-memory state still works for the session.
  }
}

export const useAIChatPanel = create<AIChatPanelStore>((set, get) => ({
  visible: false,
  setVisible(next) {
    set({ visible: next })
  },
  toggle() {
    set({ visible: !get().visible })
  },
  sidebarOpen: readPersistedSidebar(),
  setSidebarOpen(next) {
    set({ sidebarOpen: next })
    writePersistedSidebar(next)
  },
  toggleSidebar() {
    const next = !get().sidebarOpen
    set({ sidebarOpen: next })
    writePersistedSidebar(next)
  },
  pendingOpen: null,
  requestOpenSession(emailId, sessionId, backendKind) {
    set({ pendingOpen: { emailId, sessionId, backendKind } })
  },
  consumePendingOpen() {
    set({ pendingOpen: null })
  },
  // assistant-modal (新大版本) — three-mode modal state.
  mode: readDockModePref(),
  setMode(next) {
    set({ mode: next })
    writeDockModePref(next)
  },
  openChatModal() {
    // mode already holds the cached dock mode; just reveal (expand) the modal.
    set({ visible: true })
  },
  hideChatModal() {
    set({ visible: false })
  },
  pendingAgentSessionId: null,
  requestOpenAgentSession(sessionId) {
    set({ pendingAgentSessionId: sessionId })
  },
  consumeOpenAgentSession() {
    set({ pendingAgentSessionId: null })
  },
  matterTarget: null,
  matterConversationEpoch: 0,
  openMatterChat(target) {
    set((state) => ({
      visible: true,
      matterTarget: target,
      matterConversationEpoch: state.matterConversationEpoch + 1
    }))
  },
  clearMatterChat() {
    set({ matterTarget: null })
  },
  pendingPrompt: null,
  requestChatPrompt(text, emailId) {
    set((state) => ({
      pendingPrompt: { text, emailId, nonce: (state.pendingPrompt?.nonce ?? 0) + 1 }
    }))
  },
  consumeChatPrompt(nonce) {
    // 只清「自己那一条」：消费与新请求可能交错（用户在派发落地前又点了一次），
    // 无条件置 null 会把后来的那条一起吞掉。
    set((state) => (state.pendingPrompt?.nonce === nonce ? { pendingPrompt: null } : {}))
  }
}))

export function hideAIChatPanel(): void {
  useAIChatPanel.getState().setVisible(false)
}

/** Open the AI panel pinned to a specific (email, session) pair. The caller
 *  is responsible for flipping the active email (active-email store) so the
 *  panel re-keys onto it; this only parks the target session + reveals the
 *  panel. AIChatPanel.selectSession's the row once that email's sessions load.
 *
 *  交付文档 §3.1 — `backendKind` is the session's own agent; AIChatPanel switches
 *  the panel onto it before selecting (per-kind session scoping). */
export function openAIChatSession(
  emailId: number,
  sessionId: number,
  backendKind: ChatBackendKind
): void {
  const s = useAIChatPanel.getState()
  s.clearMatterChat()
  s.requestOpenSession(emailId, sessionId, backendKind)
  s.setVisible(true)
}

// ── assistant-modal (新大版本) — non-React entry points for the FAB / shortcuts / fullscreen jump ──
/** Open (expand) the AI chat modal in its cached dock mode. Called by the FAB
 *  (⌘J goes through toggleChatModal below). */
export function openChatModal(): void {
  const state = useAIChatPanel.getState()
  state.clearMatterChat()
  state.openChatModal()
}
/** Minimise the modal back to the FAB (keeps the cached mode; next open restores it). */
export function hideChatModal(): void {
  useAIChatPanel.getState().hideChatModal()
}
/** ⌘J — 开关 dock：展开中则收回 FAB，否则按缓存的 dock mode 展开。
 *
 *  语义完全复用上面两个入口（开的那支照旧走 clearMatterChat —— ⌘J 是「通用」唤出，
 *  不继承上一次的事项身份）；关的那支只翻 visible，缓存的 dock mode 与会话内容都不动。 */
export function toggleChatModal(): void {
  if (useAIChatPanel.getState().visible) {
    hideChatModal()
  } else {
    openChatModal()
  }
}
/** fullscreen jump — park the session id for AgentViewLayout to select on mount; the caller does the
 *  router navigate + hideChatModal(). */
export function requestOpenAgentSession(sessionId: number): void {
  useAIChatPanel.getState().requestOpenAgentSession(sessionId)
}

/** Open the main-window assistant dock carrying THIS matter as its default context chip. */
export function openMatterChat(target: MatterChatTarget): void {
  useAIChatPanel.getState().openMatterChat(target)
}

/** 0812 —— 从别的界面把一条指令递给 dock 里的**主** agent（邮件工具栏「创建事项」）。
 *
 *  展开 dock（不换事项身份：这是一次通用请求，故先 clearMatterChat）+ 排队指令。真正「立即发出还是
 *  预填 composer」由 AgentConversation / ChatPromptDispatcher 判定 —— 只有它们看得见 run 是否在途、
 *  composer 是否被审批闸锁着、以及 `emailId` 那枚引用 chip 就位了没有。 */
export function startChatWithPrompt(text: string, emailId: number | null): void {
  const state = useAIChatPanel.getState()
  state.clearMatterChat()
  state.openChatModal()
  state.requestChatPrompt(text, emailId)
}

/** 0813 dogfood #17b —— 事项详情的「立即跟进」：唤出 dock **带着这件事的身份**，再把一条跟进
 *  指令递给主 agent。与 `startChatWithPrompt` 的差别只有一处、也正是要点：**不** clearMatterChat
 *  —— 事项 chip 就是这轮对话的上下文。指令本身走既有 `pendingPrompt` 面（一条普通用户消息），
 *  `emailId=null` ⇒ AgentConversation 不必等任何邮件 chip 就位。 */
export function startMatterChatWithPrompt(target: MatterChatTarget, text: string): void {
  const state = useAIChatPanel.getState()
  state.openMatterChat(target)
  state.requestChatPrompt(text, null)
}
