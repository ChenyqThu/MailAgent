// Sprint 4 — chat orchestrator. Owns:
//   - per-session AbortController (so renderer cancel works no matter which
//     backend is mid-stream)
//   - DB writes (every backend event is durable; reload restores the
//     conversation up to wherever the abort/error landed)
//   - IPC fanout (every event the backend yields gets wrapped in a
//     `ChatStreamEnvelope` and fired to the requesting webContents)
//
// Why the dispatch loop is here and not in handlers/chat.ts: the loop has
// no IPC opinions of its own — it just consumes the backend's iterator
// and persists/forwards each event. handlers/chat.ts is the IPC adapter
// (request → dispatch start, abort signal → cancel). Keeping the two
// layers separate makes the dispatcher testable without mocking ipcMain.
//
// V2.1 阶段 3 step 5：从 main 下沉 shared/chat/dispatcher.ts（B-pure-unified，在
// UI 进程跑 —— 本地 renderer / 远程 browser）。所有外部能力经注入的
// ChatDispatcherDeps 访问：platform（ChatInfraPlatform：persist 流式/终态/abort +
// loadEmailContext + resolveConfig + prefetchSenderDigest）+ getBackend（注册表
// 查询；3c renderer 注入 HttpChatPlatform 对应的 backend）。`_inflight` 进 closure
// （per-dispatcher 实例隔离，3c renderer 可独立构造）。本文件零 Electron/Node
// import（不变式 1，pnpm build:web 验证）。
//
// V2.1 阶段 3c-4 cutover 后：sink = renderer 进程内 emitter（shared/chat/runtime.ts 的
// ChatStreamEmitter，无 IPC / 无序列化）；StreamSink 纯类型仍在本文件声明（注入式抽象）。
// 旧的 main-only makeWebContentsSink / drainNotionAgentGate / abortAllChatSessions wrapper
// 已随 chat 直跑路径一并删除（notion-agent 子进程串行闸由 serve-api asyncio spawn 接管）。

import type { BackendKind, ChatMessage, ChatSession } from './model'
import { runHarness } from './harness'
import { cancelConfirmationsForSession } from './tools/confirmation'
import type { ChatInfraPlatform } from './platform'
import type { ToolRegistry } from './tools/registry'
import type { ChatBackend, ChatStreamEnvelope, EmailContext } from './types'

export interface StartChatInput {
  emailId: number
  userMessage: string
  backendKind: BackendKind
  backendModel: string | null
  backendAgentPageId: string | null
  /** Sprint 19 — explicit target session id. null/undefined = legacy
   *  getOrCreateSession path (find latest by email+backend); number =
   *  use this exact session row (must exist + belong to emailId, else
   *  E_DISPATCH). Threaded from renderer's activeSessionIdRef after
   *  chat.newSession() creates a fresh row. */
  sessionId?: number | null
}

export interface StartChatResult {
  sessionId: number
  userMessageId: number
  assistantMessageId: number
}

// Sprint 14 PR B — inline edit. Drops `editingMessageId` and the tail
// after it, then appends a fresh user message with `newContent` + an
// empty streaming assistant message in the same session, and reruns
// the backend stream. Reuses runStream's IPC/DB plumbing so all the
// edge cases (abort, error event, partial DB writes) flow through one
// path. Returns the new ids so the renderer can pre-render the empty
// assistant bubble, matching startChat's contract.
export interface EditChatInput {
  sessionId: number
  editingMessageId: number
  newContent: string
  backendKind: BackendKind
  backendModel: string | null
  backendAgentPageId: string | null
}

export interface StreamSink {
  send(envelope: ChatStreamEnvelope): void
}

/** Dependencies injected at construction. `platform` = the infra board
 *  (electron direct-DB impl in main / http fetch impl in renderer); `getBackend`
 *  = backend registry lookup (main: registry.getChatBackend; 3c renderer: its
 *  own factory). Keeping both injected is what lets the same dispatcher run in
 *  either process. */
export interface ChatDispatcherDeps {
  platform: ChatInfraPlatform
  getBackend: (kind: BackendKind) => ChatBackend
  /** 工具 registry（3b-4 注入式）：caller 用 createBuiltinTools(platform) 构造后注入；runStream
   *  传给 runHarness，取代 module-global defaultToolRegistry。main = electron 工具板 registry；
   *  3c renderer = http 工具板 registry（per-dispatcher 隔离）。 */
  toolRegistry: ToolRegistry
}

export interface ChatDispatcher {
  startChat(input: StartChatInput, sink: StreamSink): Promise<StartChatResult>
  editChatMessage(input: EditChatInput, sink: StreamSink): Promise<StartChatResult>
  /** Renderer-initiated cancel. Async now that abortStreamingMessages is a
   *  platform (Promise) call; IPC handlers fire-and-forget the returned
   *  promise. */
  abortChatSession(sessionId: number): Promise<number>
  /** App-quit hook — abort + clear every in-flight stream. drainNotionAgentGate
   *  (main-only) is composed by the handlers wrapper, NOT here (no Electron in
   *  shared). */
  abortAllChatSessions(): void
  /** Test-only — clear in-flight map without firing abort. Use sparingly. */
  __resetForTests(): void
}

// Sprint 19 P1 — sliding window cap on per-turn history sent to the LLM.
// Without this, full session history goes into every turn → cost scales
// linearly with conversation length (100 turns ≈ $0.6/turn vs $0.015 for
// a 1-turn fresh session, design doc §1.2). 20 is the dogfood default:
// most sessions fit, old turns past 20 are still in chat_db for sidebar
// switch / inline edit. Tune via env if needed (see config.ts).
const HISTORY_WINDOW_SIZE = 20

interface RunStreamArgs {
  sessionId: number
  assistantMessageId: number
  backend: ChatBackend
  history: ChatMessage[]
  model: string | null
  agentPageId: string | null
  emailContext: EmailContext | null
  ac: AbortController
  sink: StreamSink
}

export function createChatDispatcher(deps: ChatDispatcherDeps): ChatDispatcher {
  // One AbortController per (sessionId). A new chat:start on the same
  // session pre-empts the previous in-flight stream (rapid-click guard, same
  // pattern as Sprint 3 translate). Renderer-initiated abort goes through
  // `abortChatSession()`. In closure (not module-level) so each dispatcher
  // instance — and 3c's renderer-side dispatcher — owns an isolated map.
  const _inflight = new Map<number, AbortController>()

  /**
   * Start a chat turn. Returns immediately with the persisted session +
   * message ids; the actual streaming runs in the background and pushes
   * events to `sink`. Caller (IPC handler) can return the ids to the
   * renderer so it can pre-render an empty assistant bubble while the
   * stream fills it in.
   */
  async function startChat(input: StartChatInput, sink: StreamSink): Promise<StartChatResult> {
    if (!Number.isInteger(input.emailId) || input.emailId < 0) {
      throw new Error(`startChat: invalid emailId ${input.emailId}`)
    }
    if (typeof input.userMessage !== 'string' || input.userMessage.length === 0) {
      throw new Error('startChat: userMessage must be a non-empty string')
    }

    // Sprint 19 — when renderer threaded an explicit sessionId (post-
    // newSession() send), use that row directly. Else fall back to the
    // legacy email-keyed find-or-create-latest path (first-time email open).
    let session: ChatSession
    if (input.sessionId !== undefined && input.sessionId !== null) {
      const existing = await deps.platform.persist.getSession(input.sessionId)
      if (!existing) {
        throw new Error(
          `startChat: sessionId=${input.sessionId} not found (caller passed stale id)`
        )
      }
      if (existing.email_id !== input.emailId) {
        throw new Error(
          `startChat: sessionId=${input.sessionId} belongs to email ${existing.email_id}, not ${input.emailId}`
        )
      }
      session = existing
    } else {
      session = await deps.platform.persist.getOrCreateSession({
        emailId: input.emailId,
        backendKind: input.backendKind,
        backendModel: input.backendModel,
        backendAgentPageId: input.backendAgentPageId
      })
    }

    // Pre-empt any prior stream on the same session BEFORE appending new rows.
    // V2.1 阶段 3 step 5-6（codex review MEDIUM）：旧 dispatcher 从 append 到 pre-empt 是
    // 同步连续段；下沉后 persist 转 Promise，若 pre-empt 仍排在 append 之后，rapid resend
    // 期间每个 await 让步窗口都给旧 stream 跑完的机会 → 旧 assistant 被错标 complete 而非
    // aborted，破坏 rapid-click guard 零回归。故在任何新行落库前先 abort 旧 AC。
    _inflight.get(session.id)?.abort()

    const userMsg = await deps.platform.persist.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: input.userMessage,
      status: 'complete'
    })

    const assistantMsg = await deps.platform.persist.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: input.backendModel
    })

    const ac = new AbortController()
    _inflight.set(session.id, ac)

    const backend = deps.getBackend(input.backendKind)
    const emailContext = await deps.platform.loadEmailContext(input.emailId)
    const history = await deps.platform.persist.listLastNMessages(session.id, HISTORY_WINDOW_SIZE)

    // Kick off the consumer loop without awaiting — handler returns ids
    // immediately so the renderer can mount the empty bubble.
    void runStream({
      sessionId: session.id,
      assistantMessageId: assistantMsg.id,
      backend,
      history,
      model: input.backendModel,
      agentPageId: input.backendAgentPageId,
      emailContext,
      ac,
      sink
    }).catch((err) => {
      // 最后防线（codex step5-6 复审 LOW）：runStream 内部已 try/catch/finally 兜底，但
      // catch-path 的 finalizeMessage 自身 reject（persist 完全不可用）时，fire-and-forget
      // 仍会成未捕获 rejection。这层 .catch 把背景任务的 rejection 完全收口。
      console.warn('[chat] startChat runStream rejected after internal handling', err)
    })

    return {
      sessionId: session.id,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id
    }
  }

  async function runStream(args: RunStreamArgs): Promise<void> {
    const {
      sessionId,
      assistantMessageId,
      backend,
      history,
      model,
      agentPageId,
      emailContext,
      ac,
      sink
    } = args
    // V2.1 阶段 3c-4（D4）：删 legacy 单遍 + harnessEnabled gate —— 所有 backend 统一走
    // harness。notion-agent（不支持 tool_use 协议；http backend 剥离 tools/iterHistory）首轮
    // collected.length===0 即 end_turn = 等价单遍（设计 §6.6.5 D4）。harness 内部自管 buffer /
    // 每 chunk forward / 全部终态（complete/error/cost/max_iter/abort），dispatcher 不再持
    // legacy 的 buffer/usage/forward 状态。
    //
    // 本 try/catch/finally 是 harness 自身抛出未捕获异常的最后防线（codex step5-6 HIGH：
    // startChat/editChatMessage 用 `void runStream(...)` fire-and-forget，harness 抛出会致
    // assistant 行永久 streaming + _inflight 不清）。harness 内部已 catch backend crash + 落
    // error 终态，故正常路径不进此 catch；resolveConfig 在 harness 内最先调，它抛（如 http
    // config 端点挂）由此兜底。finalize 不带 content → 保留 harness 经 streamContent 已落库的
    // partial 正文（finalizeMessage 契约：http 实现先 flush pending 再写终态）。finally 无条件
    // 按当前 AC 清 _inflight。
    try {
      await runHarness({
        sessionId,
        assistantMessageId,
        backend,
        initialHistory: history,
        model,
        agentPageId,
        emailContext,
        ac,
        sink,
        platform: deps.platform,
        registry: deps.toolRegistry
      })
    } catch (err) {
      if (ac.signal.aborted) {
        await deps.platform.persist.abortStreamingMessages(sessionId)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      await deps.platform.persist.finalizeMessage(assistantMessageId, {
        status: 'error',
        errorMessage: message,
        model
      })
      sink.send({
        sessionId,
        messageId: assistantMessageId,
        event: { type: 'error', code: 'E_BACKEND_CRASH', message }
      })
    } finally {
      if (_inflight.get(sessionId) === ac) _inflight.delete(sessionId)
    }
  }

  async function editChatMessage(input: EditChatInput, sink: StreamSink): Promise<StartChatResult> {
    if (!Number.isInteger(input.sessionId) || input.sessionId < 0) {
      throw new Error(`editChatMessage: invalid sessionId ${input.sessionId}`)
    }
    if (!Number.isInteger(input.editingMessageId) || input.editingMessageId < 0) {
      throw new Error(`editChatMessage: invalid editingMessageId ${input.editingMessageId}`)
    }
    if (typeof input.newContent !== 'string' || input.newContent.length === 0) {
      throw new Error('editChatMessage: newContent must be a non-empty string')
    }

    const session = await deps.platform.persist.getSession(input.sessionId)
    if (!session) {
      const err = new Error(`session ${input.sessionId} not found`) as Error & { code?: string }
      err.code = 'E_NOT_FOUND'
      throw err
    }
    const editing = await deps.platform.persist.getMessage(input.editingMessageId)
    if (!editing || editing.session_id !== input.sessionId) {
      const err = new Error(
        `message ${input.editingMessageId} not in session ${input.sessionId}`
      ) as Error & { code?: string }
      err.code = 'E_NOT_FOUND'
      throw err
    }
    if (editing.role !== 'user') {
      const err = new Error(
        `message ${input.editingMessageId} is role=${editing.role}; only user messages can be edited`
      ) as Error & { code?: string }
      err.code = 'E_INVALID_ARG'
      throw err
    }

    // Pre-empt any in-flight stream before mutating DB rows so the
    // soon-to-be-deleted assistant row doesn't get a late chunk write.
    await abortChatSession(input.sessionId)

    // Drop editing user message + everything after it. The fresh user
    // message we append below will land with a new id and current
    // created_at, so the assistant turn that follows reads naturally as
    // "the user said X, the assistant replied Y" without a stale tail.
    await deps.platform.persist.deleteMessagesFromId(input.sessionId, input.editingMessageId)

    const userMsg = await deps.platform.persist.appendMessage({
      sessionId: input.sessionId,
      role: 'user',
      content: input.newContent,
      status: 'complete'
    })

    const assistantMsg = await deps.platform.persist.appendMessage({
      sessionId: input.sessionId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: input.backendModel
    })

    const ac = new AbortController()
    _inflight.set(input.sessionId, ac)

    const backend = deps.getBackend(input.backendKind)
    const emailContext = await deps.platform.loadEmailContext(session.email_id)
    const history = await deps.platform.persist.listLastNMessages(
      input.sessionId,
      HISTORY_WINDOW_SIZE
    )

    void runStream({
      sessionId: input.sessionId,
      assistantMessageId: assistantMsg.id,
      backend,
      history,
      model: input.backendModel,
      agentPageId: input.backendAgentPageId,
      emailContext,
      ac,
      sink
    }).catch((err) => {
      // 最后防线（codex step5-6 复审 LOW）：同 startChat —— 收口 runStream 背景任务在
      // catch-path finalizeMessage 自身 reject 时的未捕获 rejection。
      console.warn('[chat] editChatMessage runStream rejected after internal handling', err)
    })

    return {
      sessionId: input.sessionId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id
    }
  }

  /** Renderer-initiated cancel. Idempotent; safe to call when nothing is
   *  in flight. Returns the number of streaming/pending rows it flipped
   *  (0 when the session was already done or never started).
   *
   *  Sprint 19 PR-1d.1: also cancels any harness-pending confirmation
   *  dialogs — without this they'd hang forever waiting for a chat:confirmTool
   *  IPC that the renderer will never send (panel closed). */
  async function abortChatSession(sessionId: number): Promise<number> {
    const ac = _inflight.get(sessionId)
    if (ac) {
      ac.abort()
      if (_inflight.get(sessionId) === ac) _inflight.delete(sessionId)
    }
    cancelConfirmationsForSession(sessionId)
    return deps.platform.persist.abortStreamingMessages(sessionId)
  }

  /** App-quit hook. Aborts every in-flight stream and clears the map so
   *  backend fetch loops don't keep running into the void. The notion-agent
   *  serial gate drain (a main-only timer not tied to any signal) is composed
   *  by the handlers/chat.ts wrapper after this — it can't live in shared. */
  function abortAllChatSessions(): void {
    for (const ac of _inflight.values()) ac.abort()
    _inflight.clear()
  }

  function __resetForTests(): void {
    _inflight.clear()
  }

  return { startChat, editChatMessage, abortChatSession, abortAllChatSessions, __resetForTests }
}
