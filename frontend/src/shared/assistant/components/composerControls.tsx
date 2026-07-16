// chat-panel P4 composer-parity — controls context.
//
// Bridges PANEL-owned chat state (extended-thinking toggle / model picker, and —
// C2 — @mention / attachments) into the assistant-ui ThreadComposer, which renders
// INSIDE the runtime provider (below the panel) where it can't reach panel state by
// prop. The panel computes a ChatComposerControls value and wraps the thread in the
// provider; ThreadComposer reads it via useChatComposerControls().
//
// 🔴 Back-compat / flag discipline: useChatComposerControls() returns null when no
//    provider is mounted, and ThreadComposer renders its bare Phase-01 text-only form
//    in that case. So a render path that does NOT supply controls (older tests, the
//    read-only notion-agent thread) is byte-identical to the pre-parity composer.

import { createContext, useContext } from 'react'

import type { SearchHit } from '@shared/api/types'
import type { ChatAttachment } from '@shared/lib/chat-attachments'

export interface ChatComposerControls {
  // C1-① extended thinking. `supported` gates visibility (Claude-only); `enabled` is
  // the current toggle; onToggle flips + persists (panel owns the localStorage pref).
  thinkingSupported: boolean
  thinkingEnabled: boolean
  onToggleThinking: () => void
  // C1-② model picker. `model` is the active id (null → backend default); availableModels
  // is the enabled list (from /chat/config); onModelChange re-scopes the panel backend.
  model: string | null
  availableModels: string[]
  onModelChange: (model: string) => void
  /** Disable the picker (e.g. a turn is streaming) — mirror of legacy modelPickerDisabled. */
  modelPickerDisabled: boolean
  /** P1-2 (07-15 codex r1) — hard-disable SENDING while an approval decide → server-side resume
   *  holds this session's run lease (a send would 409 E_RUN_ACTIVE). codex r2 [D] — consumed as
   *  the composer's real submit gate, not just the Send button: Input disabled + Root submit
   *  preventDefault (ThreadComposer), Lexical submitMode 'none' + slash execute guard
   *  (AgentComposer), quick-action Suggestion disabled (AgentQuickActions). codex r2 [E] — the
   *  value is session-scoped by useApprovalDecideBusy (only the deciding session is fenced).
   *  Optional: absent/undefined → byte-identical to the pre-P1-2 composer. */
  sendDisabled?: boolean
  // C2-① @mention — referenced-email chips. The panel resolves each chip's body excerpt at SEND time
  // (buildMentionContext) and prepends an untrusted-framed block to the turn; chips clear after send.
  mentions: ReadonlyArray<SearchHit>
  onAddMention: (hit: SearchHit) => void
  onRemoveMention: (internalId: number) => void
  // C2-② attachments — local text/binary chips. Text content (≤5k chars) is prepended as an untrusted
  // block; binary chips are metadata-only (the model acknowledges but can't read them).
  attachments: ReadonlyArray<ChatAttachment>
  onAddAttachment: (attachment: ChatAttachment) => void
  onRemoveAttachment: (id: string) => void
}

const ChatComposerControlsContext = createContext<ChatComposerControls | null>(null)

export function ChatComposerControlsProvider({
  value,
  children
}: {
  value: ChatComposerControls
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ChatComposerControlsContext.Provider value={value}>
      {children}
    </ChatComposerControlsContext.Provider>
  )
}

/** Read the panel-supplied composer controls. null when no provider is mounted (the
 *  bare text-only composer path) — callers must handle null by hiding the extra chrome. */
export function useChatComposerControls(): ChatComposerControls | null {
  return useContext(ChatComposerControlsContext)
}
