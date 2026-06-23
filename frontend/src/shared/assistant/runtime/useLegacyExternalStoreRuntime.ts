// chat-panel P4 Phase 01 — legacy → assistant-ui ExternalStore adapter.
//
// Bridges the legacy chat state (useEmailChat / useGeneralChat — same shape) to
// assistant-ui's `useExternalStoreRuntime`. The legacy hooks remain the SSoT:
// they own the IPC stream, the ChatMessage state machine, the race guards. This
// adapter only re-projects that state into ThreadMessageLike (via
// legacyMessageMapper) and routes the four thread actions back:
//   onNew    → onSend(text)            (composer submit)
//   onEdit   → onEdit(messageId, text) (edit user message + re-stream)
//   onReload → onReload()              (retry last; omitted → Reload hidden)
//   onCancel → chat.abortCurrent()     (stop generating)
//
// Per-message tool steps merge the legacy two sources exactly like the legacy
// AssistantBubble dovetail: live LiveToolCall map while streaming, persisted
// ChatToolCall audit rows once settled (with a live fallback to bridge the gap).

import { useMemo } from 'react'
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime
} from '@assistant-ui/react'

import type { ChatMessage, ChatToolCall } from '@shared/api/types'
import type { LiveToolCall } from '@shared/hooks/useEmailChat'
import { auditSteps, liveSteps, type ToolStepData } from '@shared/components/chat/tool_steps'

import { legacyMessageToThreadMessage, type LegacyEnrichedMessage } from './legacyMessageMapper'

/** Minimal slice of useEmailChat / useGeneralChat the adapter reads. Both hooks
 *  expose these identically, so the runtime is surface-agnostic. */
export interface LegacyRuntimeChat {
  messages: ChatMessage[]
  isStreaming: boolean
  streamingMessageId: number | null
  liveToolCalls: Map<number, LiveToolCall[]>
  abortCurrent: () => void
}

export interface UseLegacyExternalStoreRuntimeOptions {
  chat: LegacyRuntimeChat
  /** Persisted tool audit rows keyed by assistant message id (settled steps).
   *  Omitted → settled messages show no tool history (live-only). */
  toolCallsByMessage?: Map<number, ReadonlyArray<ChatToolCall>>
  /** New user turn (composer submit). The panel closes over backend/thinking. */
  onSend: (text: string) => Promise<void> | void
  /** Edit a user message and re-stream. `messageId` is the edited user row id. */
  onEdit?: (messageId: number, text: string) => Promise<void> | void
  /** Regenerate the last turn. null/undefined → assistant-ui hides Reload. */
  onReload?: (() => Promise<void> | void) | null
  /** Gate sending without disabling the input (e.g. quota cooldown). Maps to the
   *  adapter `isSendDisabled` — composer stays usable, `send()` becomes a no-op. */
  sendDisabled?: boolean
}

/** Concatenate the text parts of an AppendMessage (composer / edit submit). */
function extractText(message: AppendMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/** Tool steps for one assistant message — mirrors the legacy AssistantBubble
 *  dovetail: live steps while streaming, persisted audit rows once settled, with
 *  a live fallback for the frames between `done` and the audit fetch resolving. */
function toolStepsFor(
  message: ChatMessage,
  isStreaming: boolean,
  live: ReadonlyArray<LiveToolCall> | undefined,
  audit: ReadonlyArray<ChatToolCall> | undefined
): ToolStepData[] {
  if (message.role !== 'assistant') return []
  const liveNormalized = liveSteps(live)
  const auditNormalized = auditSteps(audit ?? [])
  // While streaming, the live event map is authoritative (legacy uses liveSteps
  // unconditionally — the streaming row is never in toolCallsByMessage anyway).
  if (isStreaming) return liveNormalized
  return auditNormalized.length > 0 ? auditNormalized : liveNormalized
}

export function useLegacyExternalStoreRuntime(
  opts: UseLegacyExternalStoreRuntimeOptions
): AssistantRuntime {
  const { chat, toolCallsByMessage, onSend, onEdit, onReload, sendDisabled } = opts

  const enriched = useMemo<LegacyEnrichedMessage[]>(() => {
    return chat.messages.map((message) => {
      const isStreaming = message.id === chat.streamingMessageId
      const toolSteps = toolStepsFor(
        message,
        isStreaming,
        chat.liveToolCalls.get(message.id),
        toolCallsByMessage?.get(message.id)
      )
      return { message, toolSteps, isStreaming }
    })
  }, [chat.messages, chat.streamingMessageId, chat.liveToolCalls, toolCallsByMessage])

  return useExternalStoreRuntime<LegacyEnrichedMessage>({
    messages: enriched,
    isRunning: chat.isStreaming,
    isSendDisabled: sendDisabled,
    convertMessage: legacyMessageToThreadMessage,
    unstable_capabilities: { copy: true },
    onNew: async (message) => {
      const text = extractText(message)
      if (text.trim().length === 0) return
      await onSend(text)
    },
    onEdit: onEdit
      ? async (message) => {
          const id = Number(message.sourceId)
          const text = extractText(message)
          if (!Number.isFinite(id) || text.trim().length === 0) return
          await onEdit(id, text)
        }
      : undefined,
    onReload: onReload
      ? async () => {
          await onReload()
        }
      : undefined,
    onCancel: async () => {
      chat.abortCurrent()
    }
  })
}
