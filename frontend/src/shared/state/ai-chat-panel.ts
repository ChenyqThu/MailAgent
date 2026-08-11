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

  // Matters MVP P6-A lane A5 — the main-window dock can wear the Matter Agent identity without
  // changing the gateway/tool policy. `matterConversationEpoch` is a UI reset signal: every explicit
  // 事项对话 invocation starts a fresh interactive round, including when the dock is already visible.
  matterTarget: MatterChatTarget | null
  matterConversationEpoch: number
  openMatterChat(target: MatterChatTarget): void
  startNewMatterConversation(): void
  clearMatterChat(): void
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
  startNewMatterConversation() {
    set((state) => ({ matterConversationEpoch: state.matterConversationEpoch + 1 }))
  },
  clearMatterChat() {
    set({ matterTarget: null })
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
/** Open (expand) the AI chat modal in its cached dock mode. Called by the FAB + ⌘J. */
export function openChatModal(): void {
  const state = useAIChatPanel.getState()
  state.clearMatterChat()
  state.openChatModal()
}
/** Minimise the modal back to the FAB (keeps the cached mode; next open restores it). */
export function hideChatModal(): void {
  useAIChatPanel.getState().hideChatModal()
}
/** fullscreen jump — park the session id for AgentViewLayout to select on mount; the caller does the
 *  router navigate + hideChatModal(). */
export function requestOpenAgentSession(sessionId: number): void {
  useAIChatPanel.getState().requestOpenAgentSession(sessionId)
}

/** Open the main-window assistant dock as the Matter Agent, anchored by the matter's INTERNAL id. */
export function openMatterChat(target: MatterChatTarget): void {
  useAIChatPanel.getState().openMatterChat(target)
}
