// chat-panel P4 Phase 02 — AI SDK runtime adapter (assistant-ui × embedded Gateway).
//
// The Phase 02 counterpart to useLegacyExternalStoreRuntime: instead of bridging
// the legacy useEmailChat state, it hands assistant-ui an AI SDK `useChatRuntime`
// whose transport POSTs to the embedded Gateway's /api/ai/chat. The Gateway runs
// `streamText` and pipes an AI SDK UIMessage stream back, which useChatRuntime
// renders natively. A new (empty) thread streams immediately; persistence is the
// Gateway's job (onFinish → chat_db dual-write, keyed by the `sessionId` body).
//
// 🔴 The provider key never reaches here — the renderer only knows the loopback
//    Gateway base URL (from ?aiGatewayPort=); the key lives in main (llm_settings).
//    This hook is only imported by AiSdkRuntimeProvider, which the panel renders
//    only when getChatRuntimeMode()==='ai-sdk' AND the Gateway is reachable — so
//    @assistant-ui/react-ai-sdk loads only on the opt-in AI SDK path.
//
// chat-panel P4 Phase 06 (context injection) — the transport body now also carries the typed
// AgentContextSnapshot + anchor + options.enabledSkills (the gateway assembles the system prompt
// from them), and the runtime accepts prior-session `initialMessages` for session reload
// (chatMessageToUIMessage → useChatRuntime({ messages }), architecture §13.8.5). All three are
// undefined/empty when MAILAGENT_AI_SDK_CONTEXT_INJECTION is off → byte-identical to Phase 02.

import { useMemo } from 'react'
import type { AssistantRuntime } from '@assistant-ui/react'
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk'

import type { AgentContextSnapshot } from '@shared/assistant/context/contextSnapshot'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'

export interface UseMailAgentAiSdkRuntimeOptions {
  /** Loopback base URL of the embedded Gateway (resolveAiGatewayBaseUrl()). */
  gatewayBaseUrl: string
  /** Persist turns into this ai_chat.db session. null → Gateway skips persistence
   *  (unsaved temporary session). */
  sessionId?: number | null
  /** Model id override; null/undefined → the Gateway's configured default. */
  model?: string | null
  /** Optional system prompt fallback. Phase 06: when context injection is on, the gateway builds
   *  the system from /chat/config + the snapshot and ignores this; null/undefined → Gateway default. */
  system?: string | null
  /** Phase 06 — typed context snapshot sent in every request body. The gateway validates it +
   *  assembles the system prompt + (AG-UI mirror) the STATE_SNAPSHOT from it. null → context-light. */
  contextSnapshot?: AgentContextSnapshot | null
  /** Phase 06 — prior-session messages to seed the runtime (session reload). Empty → fresh thread.
   *  The panel remounts (keyed by session) so this is the initial set per mount, not live-controlled. */
  initialMessages?: MailAgentUIMessage[]
}

export function useMailAgentAiSdkRuntime(opts: UseMailAgentAiSdkRuntimeOptions): AssistantRuntime {
  const { gatewayBaseUrl, sessionId, model, system, contextSnapshot, initialMessages } = opts

  // Extra body fields ride along with `messages` on every send (AI SDK
  // HttpChatTransportInitOptions.body). The Gateway reads sessionId for the
  // dual-write, model/system for the streamText call, and (Phase 06) the
  // contextSnapshot + anchor + options.enabledSkills for the system prompt.
  // The snapshot identity is stable (useAgentContextSnapshot memoizes it), so the
  // transport only rebuilds when context actually changes (email switch / body load) —
  // the same memo pattern Phase 02 uses for sessionId/model.
  const transport = useMemo(() => {
    const anchor = contextSnapshot
      ? { type: contextSnapshot.scope.anchorType, id: contextSnapshot.scope.anchorId }
      : null
    const enabledSkills = contextSnapshot?.capabilities.enabledSkills ?? []
    return new AssistantChatTransport({
      api: `${gatewayBaseUrl}/api/ai/chat`,
      body: {
        sessionId: sessionId ?? null,
        ...(model ? { model } : {}),
        ...(system ? { system } : {}),
        ...(contextSnapshot ? { contextSnapshot } : {}),
        ...(anchor ? { anchor } : {}),
        ...(enabledSkills.length > 0 ? { options: { enabledSkills } } : {})
      }
    })
  }, [gatewayBaseUrl, sessionId, model, system, contextSnapshot])

  return useChatRuntime({
    transport,
    // Phase 06 — seed prior history when reloading an existing session. Omitted when empty so a
    // fresh thread starts blank (Phase 02 behaviour). The cast narrows to the runtime's UIMessage.
    ...(initialMessages && initialMessages.length > 0
      ? { messages: initialMessages as MailAgentUIMessage[] }
      : {})
  })
}
