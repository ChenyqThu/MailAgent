// chat-panel P4 Phase 02 — AI SDK runtime adapter (assistant-ui × embedded Gateway).
//
// Phase 02 — the AI SDK runtime hook: instead of bridging
// the legacy useEmailChat state, it hands assistant-ui an AI SDK `useChatRuntime`
// whose transport POSTs to the embedded Gateway's /api/ai/chat. The Gateway runs
// `streamText` and pipes an AI SDK UIMessage stream back, which useChatRuntime
// renders natively. A new (empty) thread streams immediately; persistence is the
// Gateway's job (onFinish → chat_db dual-write, keyed by the `sessionId` body).
//
// 🔴 The provider key never reaches here — the renderer only knows the loopback
//    Gateway base URL (from ?aiGatewayPort=); the key lives in main (llm_settings).
//    This hook is only imported by AiSdkRuntimeProvider, which the panel renders
//    only when the Gateway base URL is discovered (S3: the runtime flags are gone;
//    reachability is the only gate).
//
// chat-panel P4 Phase 06 (context injection) — the transport body now also carries the typed
// AgentContextSnapshot + anchor + options.enabledSkills (the gateway assembles the system prompt
// from them), and the runtime accepts prior-session `initialMessages` for session reload
// (chatMessageToUIMessage → useChatRuntime({ messages }), architecture §13.8.5). S3 — context
// injection is always on (the CONTEXT_INJECTION flag was GA'd away).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantRuntime } from '@assistant-ui/react'
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk'

import type { AgentContextSnapshot } from '@shared/assistant/context/contextSnapshot'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { EffortTier } from '@shared/modelCatalog/effortTiers'

import {
  createMailAgentAttachmentAdapter,
  type AttachmentPanelBridge
} from './chatAttachmentAdapter'
import { recordOwnRun, registerOwnRunOwner, type OwnRunOwner } from './ownRuns'

type AiSdkMessageLike = { role?: unknown; parts?: unknown[] }
type AiSdkToolPartLike = { type: string; state?: unknown }

function isToolPartLike(part: unknown): part is AiSdkToolPartLike {
  return (
    !!part &&
    typeof part === 'object' &&
    typeof (part as { type?: unknown }).type === 'string' &&
    (part as { type: string }).type.startsWith('tool-')
  )
}

/** Resume trigger after a tool approval is responded. AI SDK records the approval locally
 *  (addToolApprovalResponse) but only re-POSTs when sendAutomaticallyWhen returns true. Mirrors AI
 *  SDK's lastAssistantMessageIsCompleteWithApprovalResponses; local predicate avoids the v6/v7 type
 *  split (renderer helper is ai@6, gateway is ai@7). */
export function shouldResumeAfterToolApprovalResponses({
  messages
}: {
  messages: readonly AiSdkMessageLike[]
}): boolean {
  const message = messages[messages.length - 1]
  if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) return false
  const lastStepStartIndex = message.parts.reduce<number>(
    (last, part, index) =>
      !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'step-start'
        ? index
        : last,
    -1
  )
  const toolParts = message.parts.slice(lastStepStartIndex + 1).filter(isToolPartLike)
  return (
    toolParts.some((part) => part.state === 'approval-responded') &&
    toolParts.every(
      (part) =>
        part.state === 'approval-responded' ||
        part.state === 'output-available' ||
        part.state === 'output-error'
    )
  )
}

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
  /** chat-panel P4 composer-parity C1-① — per-turn extended-thinking toggle. true → the request body
   *  carries thinking:true and the gateway injects providerOptions (model-family matrix). Off/undefined
   *  → omitted, byte-identical to the no-thinking path. Changing it rebuilds the transport (in deps).
   *
   *  🔴 08-05 WP-16b: **no UI sends this any more** — the Brain toggle was replaced by `effort`
   *  below. The option (and the gateway's legacy boolean branch) stays for the island-resume replay
   *  path, which re-runs a FROZEN originalBody that may still carry `thinking:true`. */
  thinking?: boolean
  /** WP-16b (task 08-05) — effort 档位（canonical `none..max`，词表 @shared/modelCatalog/
   *  effortTiers）。gateway 只在请求体显式携带**合法**档位时走新路径（`effortCallOptions`，跨协议
   *  wire 映射），未携带时旧 Brain 布尔路径逐字节保留。
   *  🔴 面板必须遵守 16a 硬契约：模型没有 reasoning 能力（`EffortModelOptions.applicable === false`）
   *  时传 undefined —— **不带这个键**，而不是发 `'none'`（见 effort.ts 字段注释：那会让 deepseek 多
   *  发 `thinking:{type:'disabled'}`、让 openai chat 分支无条件下发 `reasoning_effort`）。 */
  effort?: EffortTier
  /** composer-parity C2 — resolve the per-send mention/attachment prefix (async: mention excerpts are
   *  fetched). Called once per send; a non-empty result is sent as body.injectedContext (the gateway
   *  prepends it to the model's last user message) and then onConsumeInjected clears the chips. Omitted
   *  → no prefix. */
  buildInjectedContext?: () => Promise<string>
  /** composer-parity C2 — clear the mention/attachment chips after their prefix was captured for a send. */
  onConsumeInjected?: () => void
  /** PART 2 (auto-approval) — when 'auto-reversible' the request body carries approvalMode so the
   *  gateway lets reversible preview-tier writes execute without an approval card (edit + blocking
   *  send still ask). Omitted / 'always' → not sent (gateway defaults to 'always'), byte-identical
   *  to the pre-toggle path. */
  approvalMode?: 'always' | 'auto-reversible'
  /** issue #61 Lane 3 (A2) — panel-state bridge for the MailAgent AttachmentAdapter: non-image
   *  attachments picked/pasted/dropped into the composer sync into the panel's ChatAttachment[]
   *  (the buildInjectedContext source) under the SAME id, so chip removal maps 1:1. Held in a ref
   *  (like buildInjectedContext) so chip churn never rebuilds the runtime. Omitted (read-only
   *  mounts) → chips still work, no panel sync. */
  attachmentBridge?: AttachmentPanelBridge
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
    onEnsureSession,
    thinking,
    effort,
    buildInjectedContext,
    onConsumeInjected,
    approvalMode,
    attachmentBridge
  } = opts

  // codex r3 P1 — own-run ownership is scoped to THIS runtime instance (the mount that actually
  // holds the attached stream), not the renderer. useState's lazy init mints the token exactly once
  // per instance (pure identity, never set again); it survives StrictMode's effect replay (same
  // instance → same token → re-register restores liveness), while a REAL unmount (session switch →
  // keyed provider remount) releases it, so a still-streaming run degrades to a background run that
  // a later mount witnesses + settles normally (ownRuns.ts).
  const [ownRunOwner] = useState<OwnRunOwner>(() => ({}))
  useEffect(() => registerOwnRunOwner(ownRunOwner), [ownRunOwner])

  // Phase 06a — per-thread session-id latch. Seeded from the sessionId prop (reload → an existing id;
  // a new conversation → null, created lazily on the first send). The panel remounts this provider
  // keyed by (email, session), so within a mount the prop is stable and the latch owns the
  // null→created transition; the ref lets the memoized transport read the latest id without rebuilding.
  const latchRef = useRef<AiSdkSessionLatch>({ id: sessionId ?? null, inflight: null })
  if (sessionId != null && latchRef.current.id !== sessionId) {
    latchRef.current = { id: sessionId, inflight: null }
  }

  // composer-parity C2 — refs for the per-send injected-context builder + its post-send consumer. Held
  // in refs (not transport useMemo deps) so adding/removing a chip doesn't rebuild the transport (which
  // would drop the resumable adapter mid-thread); the body reads the latest each send.
  const buildInjectedContextRef = useRef(buildInjectedContext)
  buildInjectedContextRef.current = buildInjectedContext
  const onConsumeInjectedRef = useRef(onConsumeInjected)
  onConsumeInjectedRef.current = onConsumeInjected

  // issue #61 Lane 3 (A2) — one adapter per runtime instance, reading the live bridge through a ref
  // (same discipline as buildInjectedContext above: panel re-renders must not rebuild the runtime).
  // Registering it under adapters.attachments REPLACES react-ai-sdk's default vercelAttachmentAdapter,
  // which base64'd every file — including .txt, whose established path is the injectedContext block.
  const attachmentBridgeRef = useRef(attachmentBridge)
  attachmentBridgeRef.current = attachmentBridge
  const [attachmentAdapter] = useState(() =>
    createMailAgentAttachmentAdapter(() => attachmentBridgeRef.current ?? null)
  )

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
      // harness-chat lane A B1 (task 07-15) — explicit-stop side-channel. With detached runs the
      // gateway no longer aborts the upstream call on client disconnect, so the composer stop button
      // (assistant-ui cancel → useChat.stop() → fetch abort) needs a server-visible signal: hook the
      // request's abort and best-effort POST /api/ai/run/stop for this session. Fires ONLY on an
      // explicit stop — a keyed remount does NOT abort the in-flight fetch (library-verified, research
      // §3.1), so a session switch keeps the run alive. Flag-off gateway answers 404 → harmless.
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal
        if (signal && !signal.aborted) {
          signal.addEventListener(
            'abort',
            () => {
              const sid = latchRef.current.id
              if (sid == null) return
              void fetch(`${gatewayBaseUrl}/api/ai/run/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sid })
              }).catch(() => {
                /* best-effort — flag off / gateway gone */
              })
            },
            { once: true }
          )
        }
        // codex r2 [C] — own-run attribution: the gateway stamps each leased chat response with
        // its ActiveRunRegistry runId; recording it lets useBackgroundChatRun's settle door tell
        // our own turn's persist broadcast from a genuine background settle (per-run, replacing
        // the r1 time-window heuristics). Headers arrive at stream START (well before the persist
        // broadcast) so the record is never late. Absent header (older gateway / unleased run) →
        // no record, the poll-mask degrade path handles it. codex r3 P1 — recorded under THIS
        // runtime instance's owner token: the mask holds only while this mount is alive; a header
        // landing after unmount records against a released owner = background from the start.
        return fetch(input, init).then((res) => {
          const runId = res.headers.get('x-mailagent-run-id')
          if (runId) recordOwnRun(ownRunOwner, runId)
          return res
        })
      },
      body: async () => {
        const sid = await resolveAiSdkSessionId(latchRef.current, sessionId, onEnsureSession)
        // composer-parity C2 — resolve the mention/attachment prefix at send time (async: mention
        // excerpts are fetched), send it as body.injectedContext (the gateway prepends it to the
        // model's last user message; persistence keeps the original text), then clear the chips.
        const injectedContext = buildInjectedContextRef.current
          ? await buildInjectedContextRef.current()
          : ''
        if (injectedContext.length > 0) onConsumeInjectedRef.current?.()
        return {
          sessionId: sid ?? null,
          ...(model ? { model } : {}),
          ...(system ? { system } : {}),
          ...(thinking ? { thinking: true } : {}),
          // WP-16b — 档位存在才带这个键（undefined = 模型没有 reasoning 能力 / 只读线程 →
          // 走 gateway 的旧路径）。与 `thinking` 一样是 transport useMemo 的依赖：换档要重建
          // transport，而用户是在两轮之间换档，不是流中途。
          ...(effort ? { effort } : {}),
          // PART 2 — only send approvalMode when relaxing (auto-reversible); 'always'/absent omits it
          // so the gateway default ('always') applies, byte-identical to the pre-toggle body.
          // approvalMode is a transport useMemo dep (like `thinking`) — a settings change rebuilds the
          // transport, which is fine: the user toggles this in Settings, not mid-stream.
          ...(approvalMode === 'auto-reversible' ? { approvalMode } : {}),
          ...(injectedContext.length > 0 ? { injectedContext } : {}),
          ...(contextSnapshot ? { contextSnapshot } : {}),
          ...(anchor ? { anchor } : {}),
          ...(enabledSkills.length > 0 ? { options: { enabledSkills } } : {})
        }
      }
    })
    // sessionId intentionally excluded from deps — owned by latchRef (see comment above).
    // ownRunOwner is a stable per-instance token (never changes within a mount) → never rebuilds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gatewayBaseUrl,
    model,
    system,
    thinking,
    effort,
    approvalMode,
    contextSnapshot,
    onEnsureSession,
    ownRunOwner
  ])

  return useChatRuntime({
    transport,
    // issue #61 Lane 3 (A2) — MailAgent attachment adapter (images → bounded file parts; text/binary
    // → the panel injectedContext path). Key name pinned by UseChatRuntimeOptions.adapters.
    adapters: { attachments: attachmentAdapter },
    // dogfood — resume after a write-tool approval. AI SDK's addToolApprovalResponse only updates the
    // local message state (approval-responded); without a sendAutomaticallyWhen predicate it never
    // re-POSTs /api/ai/chat, so the approved tool stays stuck "executing". This local predicate fires
    // the second request once every tool part in the last step is responded/done (version-agnostic so
    // it sidesteps the renderer-ai@6 vs gateway-ai@7 type split).
    sendAutomaticallyWhen: shouldResumeAfterToolApprovalResponses,
    // Phase 06 — seed prior history when reloading an existing session. Omitted when empty so a fresh
    // thread starts blank (Phase 02 behaviour). v7: useChatRuntime types `messages` against @ai-sdk/
    // react's UIMessage, which is no longer structurally interchangeable with ai's UIMessage (our
    // MailAgentUIMessage) at the type level — cast through `never` (the runtime shape is identical; the
    // gateway persists/streams the same UIMessage JSON regardless).
    ...(initialMessages && initialMessages.length > 0 ? { messages: initialMessages as never } : {})
  })
}
