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

import { useMemo } from 'react'
import type { AssistantRuntime } from '@assistant-ui/react'
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk'

export interface UseMailAgentAiSdkRuntimeOptions {
  /** Loopback base URL of the embedded Gateway (resolveAiGatewayBaseUrl()). */
  gatewayBaseUrl: string
  /** Persist turns into this ai_chat.db session. null → Gateway skips persistence
   *  (unsaved temporary session). */
  sessionId?: number | null
  /** Model id override; null/undefined → the Gateway's configured default. */
  model?: string | null
  /** Optional system prompt; null/undefined → none (Phase 02 is context-light —
   *  standing-context injection lands when tools migrate in phase-03). */
  system?: string | null
}

export function useMailAgentAiSdkRuntime(opts: UseMailAgentAiSdkRuntimeOptions): AssistantRuntime {
  const { gatewayBaseUrl, sessionId, model, system } = opts

  // Extra body fields ride along with `messages` on every send (AI SDK
  // HttpChatTransportInitOptions.body). The Gateway reads sessionId for the
  // dual-write and model/system for the streamText call.
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${gatewayBaseUrl}/api/ai/chat`,
        body: {
          sessionId: sessionId ?? null,
          ...(model ? { model } : {}),
          ...(system ? { system } : {})
        }
      }),
    [gatewayBaseUrl, sessionId, model, system]
  )

  return useChatRuntime({ transport })
}
