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
import { generateId as generateFallbackId } from 'ai'

import type { AgentContextSnapshot } from '@shared/assistant/context/contextSnapshot'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { EffortTier } from '@shared/modelCatalog/effortTiers'
import { createLibraryApi } from '@shared/api/library'
import { createChatAttachmentArchiver } from '@shared/lib/chat-attachments'
import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'

import {
  createMailAgentAttachmentAdapter,
  type AttachmentPanelBridge
} from './chatAttachmentAdapter'
import { recordOwnRun, registerOwnRunOwner, type OwnRunOwner } from './ownRuns'
import { publishComposerRecovery } from './composerRecovery'
import { notifyQueuedInputChanged } from './useQueuedInputRows'

/** 会话租约拒绝的唯一判据。gateway 在 register 拿不到位子时回这一对（server.ts 的
 *  `writeJson(res, 409, { error: 'E_RUN_ACTIVE', … })`），而且是在 onTurnStart 之前 —— 库里
 *  一行不落，那句话只活在内存线程里。
 *  🔴 必须同时满足状态码与错误码：别的 409（队列状态冲突）、别的非 2xx（鉴权 / 体积超限 /
 *  上游拒绝）都不是「稍后再发就行」，把它们也转投队列 = 把真错误伪装成「已排队」，用户以为
 *  发出去了其实永远不会发。判不出就维持现状（丢，但至少不撒谎）。 */
const RUN_LEASE_REJECTED_STATUS = 409
const RUN_LEASE_REJECTED_CODE = 'E_RUN_ACTIVE'

/** 这一轮请求体里最后那条用户消息的纯文本；拿不到（resume 轮的末条不是用户消息、体不是 JSON）
 *  返回 null —— 没有「用户刚说的话」可救，就什么都不做。 */
function lastUserTextOf(body: BodyInit | null | undefined): string | null {
  if (typeof body !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const messages = (parsed as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return null
  const last = messages.at(-1) as AiSdkMessageLike | undefined
  if (!last || last.role !== 'user' || !Array.isArray(last.parts)) return null
  const text = last.parts
    .map((part) => {
      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('')
    .trim()
  return text.length > 0 ? text : null
}

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
  // P2-L5 —— 附件发送即入库（design §1.4）。会话 id 从同一个 latch 读：这条对话已经有 id 就
  // 用它，还没有（新会话的第一条消息，session 由 transport 懒创建）就是 null，`source_ref`
  // 的会话段留空。这里**不**调 onEnsureSession —— 拖个附件不该凭空建出一个空会话。
  const [attachmentAdapter] = useState(() =>
    createMailAgentAttachmentAdapter(() => attachmentBridgeRef.current ?? null, undefined, {
      archive: createChatAttachmentArchiver(createLibraryApi(resolveApiBaseUrl())),
      getSessionId: () => latchRef.current.id
    })
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
    // 0903 —— 撞上会话租约的那一句话转投队列，而不是凭空消失。判据见 RUN_LEASE_REJECTED_CODE
    // 的红字（同时认状态码与错误码，别的一律维持现状）。返回是否真的转投成功。
    const redirectRejectedSendToQueue = async (
      rejection: Response,
      init?: RequestInit
    ): Promise<boolean> => {
      let code: unknown
      try {
        code = ((await rejection.json()) as { error?: unknown }).error
      } catch {
        return false // 体不是 JSON → 判不出是哪种拒绝 → 维持现状
      }
      if (code !== RUN_LEASE_REJECTED_CODE) return false
      const sid = latchRef.current.id
      const text = lastUserTextOf(init?.body)
      if (sid == null || text == null) return false
      try {
        const queued = await fetch(`${gatewayBaseUrl}/api/ai/queued-input`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, content: text })
        })
        if (!queued.ok) throw new Error('enqueue rejected')
        // 排队条据此立刻画出那条气泡（Electron 另有 chat:queued-input-changed 广播走同一条失效
        // 路径；这个进程内信号是 web 那侧的等价物）。🔴 不在这里直接用 QueryClient：本闭包所在的
        // 组件树不保证有 QueryClientProvider，`useQueryClient()` 在那种挂载下会直接抛。
        notifyQueuedInputChanged(sid)
        return true
      } catch {
        // 入队端点也挂了：把文本交还 composer。选它而不是「就这么丢掉」，是因为丢掉正是本次
        // 要修的那个 bug；选它而不是「只弹个 toast」，是因为 toast 一消失字就没了。
        // 🔴 无条件覆盖 composer：这中间只隔一次 loopback 往返（毫秒级），用户几乎不可能已经
        // 打了新内容；ChatPromptDispatcher 对同一种失败也是这么做的（那里的窗口还有 4 秒）。
        publishComposerRecovery(sid, text)
        return false
      }
    }
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
        return fetch(input, init).then(async (res) => {
          const runId = res.headers.get('x-mailagent-run-id')
          if (runId) recordOwnRun(ownRunOwner, runId)
          if (res.status === RUN_LEASE_REJECTED_STATUS) {
            const redirected = await redirectRejectedSendToQueue(res.clone(), init)
            if (redirected) {
              // 已经在排队条里等着了 —— 这一轮就此终止，但不是「消息没了」。
              return res
            }
          }
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
    // P2-L5 —— 把附件入库时铸的 UIMessage id 盖到**这条**用户消息上。
    // 🔴 为什么钩 generateId 而不是别处：`source_ref='{sessionId}:{uiMessageId}'` 只有等于持久化
    // 下来的 `ui_message_json.$.id` 才反查得到（`chat_db/messages.ts::findMessageRowIdByUiId`），
    // 而附件 send() 跑在消息造出来之前。ai@7 的 Chat 只在两处发 id，次序固定：先
    // `sendMessage → pushMessage`（用户消息，`uiMessage.id ?? generateId()`），再
    // `makeRequest`（助手消息）。所以「取一次就清空」的 takeArchivedMessageId 恰好落在用户
    // 消息上，助手那次自然回落默认生成器。没入库过的批次返回 null，行为与从前一模一样。
    generateId: () => attachmentAdapter.takeArchivedMessageId() ?? generateFallbackId(),
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
