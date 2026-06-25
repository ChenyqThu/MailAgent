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

import { useMemo, useRef } from 'react'
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
  /** Phase 06a (cutover) — lazily create the ai-sdk session on the FIRST send of a brand-new
   *  conversation (sessionId null), returning the new id. Called at most once per thread (latched);
   *  a reject surfaces as a stream error and clears the latch so a retry re-attempts. Omitted →
   *  the body sends sessionId: null and the gateway skips persistence (Phase 02 behaviour). */
  onEnsureSession?: () => Promise<number>
}

/** Per-thread session-id latch (held in a ref by the hook). `id` is the resolved session for this
 *  thread (null until created / seeded); `inflight` dedups the create so concurrent first sends call
 *  onEnsureSession exactly once. */
export interface AiSdkSessionLatch {
  id: number | null
  inflight: Promise<number> | null
}

/** Resolve the session id to put in the gateway request body, creating it lazily on the FIRST send
 *  when the thread started without one (a brand-new ai-sdk conversation). At-most-once per thread:
 *  a non-null prop / already-latched id short-circuits (no create); a null id triggers a single
 *  onEnsureSession() whose result is cached on the latch; concurrent sends await the same in-flight
 *  promise; a create failure clears `inflight` (and leaves `id` null) so a retry re-attempts. No empty
 *  session leaks — the renderer owns the id and the gateway only persists when it is non-null. The
 *  body runs this synchronously up to the `return`, so two concurrent calls share one create. */
export async function resolveAiSdkSessionId(
  latch: AiSdkSessionLatch,
  sessionIdProp: number | null | undefined,
  onEnsureSession?: () => Promise<number>
): Promise<number | null> {
  if (sessionIdProp != null) return sessionIdProp
  if (latch.id != null) return latch.id
  if (!onEnsureSession) return null
  if (!latch.inflight) {
    latch.inflight = (async (): Promise<number> => {
      const id = await onEnsureSession()
      latch.id = id
      return id
    })().finally(() => {
      latch.inflight = null
    })
  }
  return latch.inflight
}

export function useMailAgentAiSdkRuntime(opts: UseMailAgentAiSdkRuntimeOptions): AssistantRuntime {
  const {
    gatewayBaseUrl,
    sessionId,
    model,
    system,
    contextSnapshot,
    initialMessages,
    onEnsureSession
  } = opts

  // Phase 06a — per-thread session-id latch. Seeded from the sessionId prop (reload → an existing id;
  // a new conversation → null, created lazily on the first send). The panel remounts this provider
  // keyed by (email, session), so within a mount the prop is stable and the latch owns the
  // null→created transition; the ref lets the memoized transport read the latest id without rebuilding.
  const latchRef = useRef<AiSdkSessionLatch>({ id: sessionId ?? null, inflight: null })
  if (sessionId != null && latchRef.current.id !== sessionId) {
    latchRef.current = { id: sessionId, inflight: null }
  }

  // Extra body fields ride along with `messages` on every send (AI SDK HttpChatTransportInitOptions
  // .body). Phase 06a: `body` is a FUNCTION (ai@6 Resolvable<object>) resolved per send, so the latch
  // creates the ai-sdk session on the first send (onEnsureSession) and injects its id; the gateway
  // reads sessionId for the dual-write, model/system for streamText, and (Phase 06) the contextSnapshot
  // + anchor + options.enabledSkills for the system prompt. sessionId is intentionally NOT a useMemo
  // dep — the latch owns it and the panel remounts (key) on a session switch, so the transport never
  // rebuilds mid-thread (which would drop the resumable adapter).
  const transport = useMemo(() => {
    const anchor = contextSnapshot
      ? { type: contextSnapshot.scope.anchorType, id: contextSnapshot.scope.anchorId }
      : null
    const enabledSkills = contextSnapshot?.capabilities.enabledSkills ?? []
    return new AssistantChatTransport({
      api: `${gatewayBaseUrl}/api/ai/chat`,
      body: async () => {
        const sid = await resolveAiSdkSessionId(latchRef.current, sessionId, onEnsureSession)
        return {
          sessionId: sid ?? null,
          ...(model ? { model } : {}),
          ...(system ? { system } : {}),
          ...(contextSnapshot ? { contextSnapshot } : {}),
          ...(anchor ? { anchor } : {}),
          ...(enabledSkills.length > 0 ? { options: { enabledSkills } } : {})
        }
      }
    })
    // sessionId intentionally excluded from deps — owned by latchRef (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayBaseUrl, model, system, contextSnapshot, onEnsureSession])

  return useChatRuntime({
    transport,
    // Phase 06 — seed prior history when reloading an existing session. Omitted when empty so a
    // fresh thread starts blank (Phase 02 behaviour). The cast narrows to the runtime's UIMessage.
    ...(initialMessages && initialMessages.length > 0
      ? { messages: initialMessages as MailAgentUIMessage[] }
      : {})
  })
}
