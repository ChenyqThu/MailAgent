// V2.1 阶段 3 — 3b-5：HttpChatPlatform，ChatPlatform 的远程实现（UI 进程 = 本地
// renderer 3c cutover 后 / 远程 browser）。
//
// B-pure-unified：chat harness/dispatcher 已下沉 shared 并经注入的 ChatPlatform
// 访问外部能力。桌面端是 ElectronChatPlatform（直调 chat_db/db/config/kos，字节级
// 零回归）；远程端是本文件 —— 全部能力 fetch serve-api（3b-1~3b-4 落地的端点），
// 与 electron_platform.ts 对称实现同一组分层接线板（Infra + Model + NotionAgent + Tool）。
//
// 🔴 不变式 1：本文件**零 Electron/Node-only 依赖**。只引 shared/chat 类型 + shared/api
//    （HttpApi 委托读工具 + http_client.request 解包 envelope）+ 浏览器全局 fetch/
//    TextDecoder/setTimeout。pnpm build:web 验证 —— 方案成败根本。
//
// ── 端点对照（逐板对 serve-api，3b-1~3b-4）────────────────────────────────────
//   Infra.persist 12 法 → chat 持久化端点（3b-3，POST/PATCH/DELETE/GET /api/chat/*）；
//     streamContent 在此做 **debounce**（~1/s 合并 PATCH），finalizeMessage 先 flush 再写终态。
//   Infra.loadEmailContext → GET /email/{id} + /body（ai_priority/action/processing 是
//     email_metadata 列，serve-api /email/{id} 不返回 → degrade null；模型可用 email_get_ai_fields
//     工具补，远程可接受）。
//   Infra.resolveConfig / Model.modelConfig / Tool.kosConfig → 构造快照（远程无 env，由
//     构造时注入的 config 决定；省略用远程默认）。prefetch / getCachedSenderDigest → no-op（L1 OFF）。
//   Model.llmFetch → POST /api/chat/llm-proxy（3b-1，注入 key 透传原始 SSE）。
//   NotionAgent.notionAgentStream → POST /api/chat/notion-agent（3b-2，asyncio spawn）+ parseSse。
//   Tool 8 读 → 委托 httpApi.email.* / attachment.list（api/types = cli.gen 别名/超集，零投影）
//     + searchAttachments → GET /attachment/search；flagEmail → httpApi.email.flag；
//     draftReply → throw E_NOT_IMPLEMENTED（host-local，fork 3 远程推迟）；kosCallTool/saveToKos
//     → POST /api/chat/kos-call · /save-to-kos（3b-4）。

import { request, type QueryValue } from '../api/http_client'
import type { AIFields, MailApi, SearchResult } from '../api/types'
import type {
  AttachmentList_AttachmentItem,
  EmailGet_EmailRecord,
  EmailList_EmailListItem,
  MailagentEmailBody
} from '../types/cli.gen'
import type {
  AppendMessageInput,
  AppendToolCallInput,
  ChatMessage,
  ChatSession,
  ChatToolCall,
  OpenSessionInput,
  UpdateMessagePatch,
  UpdateToolCallPatch
} from './model'
import type {
  ChatInfraPlatform,
  ChatModelConfig,
  ChatModelPlatform,
  ChatNotionAgentPlatform,
  ChatPersistPort,
  ChatRuntimeConfig,
  ChatToolDraftResult,
  ChatToolFlagPatch,
  ChatToolKosConfig,
  ChatToolListEmailsOpts,
  ChatToolPlatform,
  ChatToolSearchOpts,
  LlmFetchRequest,
  SaveConversationInput,
  SaveConversationResult
} from './platform'
import type { ChatStreamEvent, ChatStreamRequest, EmailContext } from './types'

// loadEmailContext 正文截断（与 electron_platform.queryEmailContext 同 MAX_BODY_CHARS，
// match Sprint 3 translate.ts + backend LLM_BODY_MAX_CHARS）。
const MAX_BODY_CHARS = 12_000

// streamContent debounce 窗口：流式期间每 ~1s 最多一次 PATCH /stream（中途增量合并覆盖）。
// 终态由 finalizeMessage flush 待发增量后写（不丢尾段）。D1（设计 §6.3）。
export const STREAM_DEBOUNCE_MS = 1_000

/** HttpChatPlatform 运行配置快照（远程无 env，构造时注入；可选 → 用远程默认）。
 *  resolveConfig / modelConfig / kosConfig 同步返回此快照的对应子集。3c renderer
 *  构造前 await GET /api/chat/config 预取真实值（同步方法无法 fetch）并覆盖默认。 */
export interface HttpPlatformConfig {
  /** harness 每用户消息最大迭代（AGENT_MAX_ITER）。 */
  maxIter: number
  /** harness 每轮成本上限 USD（AGENT_MAX_COST_USD）。 */
  maxCostUsd: number
  /** L1 hot block 注入 gate（MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED）。远程默认 false。 */
  kosL1HotBlockEnabled: boolean
  /** 多轮 harness 总开关（MAILAGENT_AGENT_HARNESS）。 */
  harnessEnabled: boolean
  /** req.model 为 null 时的默认（LLM_MODEL）。 */
  defaultModel: string
  /** KOS 使用指南块注入 gate（MAILAGENT_KOS_CONSUMER_ENABLED）。 */
  kosConsumerEnabled: boolean
  /** KOS 工具是否注册（createBuiltinTools 据此 push 9 KOS 工具）。= serve-api /chat/config
   *  的 kosConfigured = MAILAGENT_KOS_CONSUMER_ENABLED（对齐 electron kosConfig().configured
   *  = isKosConsumerEnabled()，**非** OAuth 凭据齐的 kos-available）。同步快照 → caller 预取传入。 */
  kosConfigured: boolean
  /** kos_query rerankByRecency gate（MAILAGENT_KOS_TIME_DECAY_ENABLED）。 */
  kosTimeDecayEnabled: boolean
  /** task 06-08-chat 第二波 Bug B — Notion context page markdown (user profile /
   *  Sender Priority / focus projects), from serve-api /chat/config（ContextLoader
   *  TTL-cached）。注入 custom-api system prompt（buildStableSystemPrompt）。远程默认
   *  ""（不注入；端点未返回该字段 / 未配置 LLM_CONTEXT_PAGE_ID → 降级空串）。 */
  userContext: string
  /** dynamic-models — LLM_ENABLED_MODELS from serve-api /chat/config (dotenv_values
   *  hot-read). Empty array = not configured → consumers fall back to FALLBACK_MODELS. */
  enabledModels: string[]
}

/** 远程默认快照（对齐 electron chat/config.ts 默认：harness ON / timeDecay ON / 其余
 *  KOS·L1 OFF / maxIter 8 / maxCostUsd 0.5 / sonnet）。3c 传真实快照覆盖。 */
export const DEFAULT_HTTP_CONFIG: HttpPlatformConfig = {
  maxIter: 8,
  maxCostUsd: 0.5,
  kosL1HotBlockEnabled: false,
  harnessEnabled: true,
  defaultModel: 'claude-sonnet-4-6',
  kosConsumerEnabled: false,
  kosConfigured: false,
  kosTimeDecayEnabled: true,
  // task 06-08-chat 第二波 Bug B — no user context until /chat/config supplies it.
  userContext: '',
  // dynamic-models — empty until /chat/config supplies it; consumers fall back to FALLBACK_MODELS.
  enabledModels: []
}

/** per-messageId 的 streamContent debounce 状态。`latest` = 最近一次累积全量正文
 *  （dispatcher 传 `buffer += delta` 后的全量，非 delta → 覆盖即可）；`timer` armed
 *  时表示有一次 PATCH 排队，null = 空闲可重新 arm。 */
interface StreamDebounceEntry {
  latest: string
  timer: ReturnType<typeof setTimeout> | null
}

/** notion-agent SSE 块（`data: {json}` 行）→ ChatStreamEvent。serve-api sse_encode 把
 *  完整 ChatStreamEvent（camelCase）写成 `data: {json}\n\n`，client 直接 JSON.parse。
 *  malformed / 空块 → null（跳过，下一个事件重新同步）。
 *  cf. custom_api.ts parseSseChunk —— 那是带 Anthropic/OpenAI 状态机 + [DONE] sentinel 的变体；
 *  此处是「整事件 per block、无 sentinel」的简化版（notion-agent 流性质，不复用以免拖入无关分支）。 */
function parseSemanticEvent(block: string): ChatStreamEvent | null {
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) data += line.slice(6)
    else if (line.startsWith('data:')) data += line.slice(5)
  }
  if (data.length === 0) return null
  try {
    return JSON.parse(data) as ChatStreamEvent
  } catch {
    return null
  }
}

export class HttpChatPlatform
  implements ChatInfraPlatform, ChatModelPlatform, ChatNotionAgentPlatform, ChatToolPlatform
{
  private readonly httpApi: MailApi
  private readonly baseUrl: string
  private readonly config: HttpPlatformConfig
  // per-messageId streamContent debounce 状态（finalize / abort 清理防泄漏）。
  private readonly _streamPending = new Map<number, StreamDebounceEntry>()

  /** 基础设施板的持久化端口（fetch chat 持久化端点 + streamContent debounce）。 */
  readonly persist: ChatPersistPort

  /**
   * @param httpApi 委托读工具 + flag 的 MailApi 实例（3c = HttpApi(baseUrl)）。
   * @param baseUrl serve-api 基址（同 HttpApi，默认 '/api'）—— request() + 裸 fetch 共用。
   * @param config 运行配置快照（可选，省略字段用 DEFAULT_HTTP_CONFIG；3c 传真实快照）。
   */
  constructor(httpApi: MailApi, baseUrl: string, config: Partial<HttpPlatformConfig> = {}) {
    this.httpApi = httpApi
    this.baseUrl = baseUrl
    this.config = { ...DEFAULT_HTTP_CONFIG, ...config }
    this.persist = this._buildPersist()
  }

  // ── 内部 fetch helper（envelope 端点统一经 http_client.request 解包）─────────
  private _req<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; query?: Record<string, QueryValue> }
  ): Promise<T> {
    return request<T>(this.baseUrl, method, path, opts)
  }

  // ── 基础设施板：持久化端口（镜像 chat_db 写读 → 3b-3 端点）──────────────────
  private _buildPersist(): ChatPersistPort {
    return {
      getOrCreateSession: (input: OpenSessionInput): Promise<ChatSession> =>
        this._req<ChatSession>('POST', '/chat/sessions', { body: input }),

      createNewSession: (input: OpenSessionInput): Promise<ChatSession> =>
        this._req<ChatSession>('POST', '/chat/sessions/new', { body: input }),

      getSession: (sessionId: number): Promise<ChatSession | null> =>
        this._req<ChatSession | null>('GET', `/chat/sessions/${sessionId}`),

      getMessage: (messageId: number): Promise<ChatMessage | null> =>
        this._req<ChatMessage | null>('GET', `/chat/messages/${messageId}`),

      // serve-api 暴露整 session 消息（升序）；ChatPersistPort 要「最后 N 条」→ 客户端
      // slice(-limit)。生产 HISTORY_WINDOW=20 + session 通常不大，全量传输可接受。
      listLastNMessages: async (sessionId: number, limit: number): Promise<ChatMessage[]> => {
        const all = await this._req<ChatMessage[]>('GET', `/chat/sessions/${sessionId}/messages`)
        return limit >= all.length ? all : all.slice(-limit)
      },

      appendMessage: (input: AppendMessageInput): Promise<ChatMessage> => {
        // sessionId 进 path，其余字段进 body（camelCase，对齐 serve-api append_message）。
        const { sessionId, ...body } = input
        return this._req<ChatMessage>('POST', `/chat/sessions/${sessionId}/messages`, { body })
      },

      // fire-and-forget void：守 harness 每 chunk 同步写热路径。debounce 在此（~1/s）。
      streamContent: (messageId: number, content: string): void => {
        this._streamContent(messageId, content)
      },

      finalizeMessage: (messageId: number, patch: UpdateMessagePatch): Promise<void> =>
        this._finalizeMessage(messageId, patch),

      deleteMessagesFromId: async (sessionId: number, fromMessageId: number): Promise<number> => {
        const data = await this._req<{ deleted: number }>(
          'DELETE',
          `/chat/sessions/${sessionId}/messages/from/${fromMessageId}`
        )
        return data.deleted
      },

      abortStreamingMessages: async (sessionId: number): Promise<number> => {
        // abort = 流终止：清所有 pending stream timer 防泄漏（生产单活跃 stream；无需
        // flush —— aborted 行不关心尾段增量，且 dispatcher 已不再 streamContent）。
        this._cancelAllPendingStreams()
        const data = await this._req<{ aborted: number }>(
          'POST',
          `/chat/sessions/${sessionId}/abort`
        )
        return data.aborted
      },

      appendToolCall: async (input: AppendToolCallInput): Promise<{ id: number }> => {
        const { messageId, ...body } = input
        // serve-api 返回完整 ChatToolCall（超集）；ChatPersistPort 仅需 .id。
        const call = await this._req<ChatToolCall>(
          'POST',
          `/chat/messages/${messageId}/tool-calls`,
          { body }
        )
        return { id: call.id }
      },

      updateToolCall: async (toolCallId: number, patch: UpdateToolCallPatch): Promise<void> => {
        await this._req<{ ok: true }>('PATCH', `/chat/tool-calls/${toolCallId}`, { body: patch })
      },

      getToolCallByUseId: async (
        messageId: number,
        toolUseId: string
      ): Promise<{ id: number } | null> => {
        const call = await this._req<ChatToolCall | null>(
          'GET',
          `/chat/messages/${messageId}/tool-calls/${encodeURIComponent(toolUseId)}`
        )
        return call ? { id: call.id } : null
      }
    }
  }

  // ── streamContent debounce（trailing throttle ~1s）─────────────────────────
  private _streamContent(messageId: number, content: string): void {
    let entry = this._streamPending.get(messageId)
    if (!entry) {
      entry = { latest: content, timer: null }
      this._streamPending.set(messageId, entry)
    } else {
      entry.latest = content
    }
    // 仅在空闲时 arm：~1s 后 PATCH 当前 latest 并 disarm，期间的多次 streamContent 合并
    // 进 latest（覆盖）。下一次 streamContent 再重新 arm → 流式期间 ~1/s 写库。
    if (entry.timer === null) {
      entry.timer = setTimeout(() => {
        const e = this._streamPending.get(messageId)
        if (!e) return
        e.timer = null
        void this._flushStream(messageId, e.latest)
      }, STREAM_DEBOUNCE_MS)
    }
  }

  /** PATCH /stream 写一次流式增量。失败仅 warn 不阻断（终态由 finalizeMessage 带
   *  content=buffer 双保险；丢一次中途增量不影响最终正文）。 */
  private async _flushStream(messageId: number, content: string): Promise<void> {
    try {
      await this._req<{ ok: true }>('PATCH', `/chat/messages/${messageId}/stream`, {
        body: { content }
      })
    } catch (err) {
      console.warn(`[chat] http streamContent PATCH failed for message ${messageId}`, err)
    }
  }

  private async _finalizeMessage(messageId: number, patch: UpdateMessagePatch): Promise<void> {
    // 先 flush 该 msg 待发的 debounced 增量（清 timer + 立即 await PATCH latest），再写
    // 终态 —— 防一个晚到的 stream PATCH 在终态之后覆盖正文（codex review MEDIUM-2）。
    const entry = this._streamPending.get(messageId)
    if (entry) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      this._streamPending.delete(messageId)
      if (entry.latest.length > 0) {
        await this._flushStream(messageId, entry.latest)
      }
    }
    // 终态 patch（status/content/token/cost/model/metadata/error 任意子集；patch 已带
    // content=buffer，即使上面 flush 漏了也不丢正文 —— 双保险）。
    await this._req<{ ok: true }>('PATCH', `/chat/messages/${messageId}`, { body: patch })
  }

  private _cancelAllPendingStreams(): void {
    for (const entry of this._streamPending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
    }
    this._streamPending.clear()
  }

  // ── 基础设施板：邮件上下文 / 配置快照 / 预取 ───────────────────────────────
  /** GET /email/{id}（元数据）+ /body（markdown 正文）→ EmailContext。ai_priority /
   *  ai_action / processing_status 是 email_metadata 列，serve-api /email/{id} 不返回 →
   *  degrade null（远程 chat 仍见正文，模型可用 email_get_ai_fields 工具补，handoff 冻结）。
   *  行缺失 / serve-api 不可达 → null（chat 仍可跑，模型看不到正文）。 */
  async loadEmailContext(emailId: number): Promise<EmailContext | null> {
    try {
      const detail = await this.httpApi.email.get(emailId)
      if (!detail) return null
      let bodyMarkdown: string | null = null
      try {
        const body = await this.httpApi.email.body(emailId, { format: 'markdown' })
        const content = body?.content
        if (typeof content === 'string' && content.length > 0) {
          bodyMarkdown = content.slice(0, MAX_BODY_CHARS)
        }
      } catch {
        // 正文取不到不致命（元数据仍有用）—— 保 bodyMarkdown=null。
      }
      return {
        internalId: detail.internal_id,
        subject: detail.subject ?? null,
        senderName: detail.sender_name ?? null,
        senderAddr: detail.sender ?? null,
        dateIso: detail.date_received ?? null,
        bodyMarkdown,
        notionPageId: detail.notion_page_id ?? null,
        aiPriority: null,
        aiAction: null,
        processingStatus: null
      }
    } catch {
      return null
    }
  }

  async resolveConfig(): Promise<ChatRuntimeConfig> {
    return {
      maxIter: this.config.maxIter,
      maxCostUsd: this.config.maxCostUsd,
      kosL1HotBlockEnabled: this.config.kosL1HotBlockEnabled,
      harnessEnabled: this.config.harnessEnabled
    }
  }

  // L1 hot block 默认 OFF（远程暂不接 KOS sender digest 预取）→ no-op。
  prefetchSenderDigest(_senderAddr: string): void {
    /* no-op — L1 OFF */
  }

  // ── 模型板①（custom-api 下沉消费）─────────────────────────────────────────
  /** POST /api/chat/llm-proxy（serve-api 注入 key 透传原始上游 SSE）。返回未检查 Response
   *  （shared custom_api 查 !ok/!body 分类 E_QUOTA/E_UPSTREAM）。serve-api host 无 key →
   *  E_NO_LLM_KEY envelope（HTTP 500）→ 本方法识别后 throw Error&{code}（custom_api catch
   *  读 code 归 E_NO_LLM_KEY）；其余非 2xx（上游透传 status，空 body）→ 原样返回 Response。 */
  async llmFetch(req: LlmFetchRequest): Promise<Response> {
    const resp = await fetch(`${this.baseUrl}/chat/llm-proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ protocol: req.protocol, body: req.body }),
      signal: req.signal,
      credentials: 'include'
    })
    if (resp.ok) return resp
    // 非 2xx：peek body 区分 E_NO_LLM_KEY envelope（JSON）vs 上游透传 status（空 body）。
    // clone() 防消费原 resp body（custom_api 对 !ok 只读 status，但 clone 更安全）。
    let code: string | undefined
    try {
      const env = (await resp.clone().json()) as { error?: { code?: string } }
      code = env?.error?.code
    } catch {
      /* 空 body / 非 JSON → 上游透传 status，无 envelope */
    }
    if (code === 'E_NO_LLM_KEY') {
      const err = new Error('LLM API key not configured on serve-api host') as Error & {
        code: string
      }
      err.code = 'E_NO_LLM_KEY'
      throw err
    }
    return resp
  }

  // L1 hot block 默认 OFF → 无 cache。
  getCachedSenderDigest(_senderAddr: string): string | null {
    return null
  }

  modelConfig(): ChatModelConfig {
    return {
      defaultModel: this.config.defaultModel,
      kosConsumerEnabled: this.config.kosConsumerEnabled,
      kosL1HotBlockEnabled: this.config.kosL1HotBlockEnabled,
      // task 06-08-chat 第二波 Bug B — "" → null (not injected). custom_api
      // buildStableSystemPrompt only injects when non-null + non-empty.
      userContext: this.config.userContext.length > 0 ? this.config.userContext : null
    }
  }

  // ── 模型板②：notion-agent http backend 流 ──────────────────────────────────
  /** POST /api/chat/notion-agent（serve-api asyncio spawn `notion-agent chat --stream`，
   *  输出语义 event SSE）+ parseSse 反序列化为 ChatStreamEvent。body 去 signal/tools/
   *  iterHistory（CLI 无工具，serve-api 只读 history/model/agentPageId/emailContext）。
   *  abort（req.signal）→ 静默退出（对齐 custom_api：不 yield 残余）。 */
  async *notionAgentStream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
    let resp: Response
    try {
      resp = await fetch(`${this.baseUrl}/chat/notion-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          history: req.history,
          model: req.model,
          agentPageId: req.agentPageId,
          emailContext: req.emailContext
        }),
        signal: req.signal,
        credentials: 'include'
      })
    } catch (err) {
      if (req.signal.aborted) return
      yield {
        type: 'error',
        code: 'E_NETWORK',
        message: `notion-agent request failed: ${err instanceof Error ? err.message : String(err)}`
      }
      return
    }

    if (!resp.ok || !resp.body) {
      // pre-stream 错误（serve-api body 不可解析 → APIError envelope）。读 envelope code/message。
      let code = 'E_UPSTREAM'
      let message = `notion-agent request failed (${resp.status})`
      try {
        const env = (await resp.json()) as { error?: { code?: string; message?: string } }
        if (env?.error?.code) code = env.error.code
        if (env?.error?.message) message = env.error.message
      } catch {
        /* 空 body */
      }
      yield { type: 'error', code, message }
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (req.signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const evt = parseSemanticEvent(block)
          if (evt) yield evt
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }
  }

  // ── 工具板：8 读委托 httpApi（api/types = cli.gen 别名/超集，零投影）+ 写/KOS ──
  listEmails(opts: ChatToolListEmailsOpts): Promise<EmailList_EmailListItem[]> {
    return this.httpApi.email.list(opts)
  }

  getEmail(internalId: number): Promise<EmailGet_EmailRecord | null> {
    return this.httpApi.email.get(internalId)
  }

  getEmailBody(internalId: number): Promise<MailagentEmailBody['data'] | null> {
    // 固定 format=markdown（12000 截断是工具纯逻辑；原语返回完整 body）。
    return this.httpApi.email.body(internalId, { format: 'markdown' })
  }

  getAiFields(internalId: number): Promise<AIFields | null> {
    return this.httpApi.email.aiFields(internalId)
  }

  listEmailsByThread(threadId: string): Promise<EmailList_EmailListItem[]> {
    return this.httpApi.email.listByThread(threadId)
  }

  searchEmailsFulltext(opts: ChatToolSearchOpts): Promise<SearchResult> {
    return this.httpApi.email.search(opts)
  }

  listAttachments(internalId: number): Promise<AttachmentList_AttachmentItem[]> {
    return this.httpApi.attachment.list(internalId)
  }

  searchAttachments(opts: ChatToolSearchOpts): Promise<unknown> {
    // httpApi 无 attachment.search → 裸 request GET /attachment/search（q/mailbox/since/
    // until/limit，对齐 email search 命名）。结果工具直接塞、不读字段 → unknown 足够。
    return this._req<unknown>('GET', '/attachment/search', {
      query: {
        q: opts.query,
        mailbox: opts.mailbox,
        since: opts.since,
        until: opts.until,
        limit: opts.limit
      }
    })
  }

  flagEmail(internalId: number, patch: ChatToolFlagPatch): Promise<unknown> {
    // electron + http 都 → 本机/远程 serve-api outbox SSoT（D1 统一 daemon 转发，零 parity）。
    return this.httpApi.email.flag(internalId, patch)
  }

  // 回复草稿 = Mail.app AppleScript（host-local）→ 远程无场景，throw E_NOT_IMPLEMENTED（fork 3）。
  draftReply(_internalId: number, _bodyMarkdown: string): Promise<ChatToolDraftResult> {
    const err = new Error(
      'email_draft_reply is host-local (Mail.app AppleScript) — not available on remote'
    ) as Error & { code: string }
    err.code = 'E_NOT_IMPLEMENTED'
    return Promise.reject(err)
  }

  kosConfig(): ChatToolKosConfig {
    return {
      configured: this.config.kosConfigured,
      timeDecayEnabled: this.config.kosTimeDecayEnabled
    }
  }

  /** 9 KOS 工具收敛 tools/call → POST /api/chat/kos-call（serve-api 代理 KOSClient）。
   *  KOS 不可达 → serve-api 502 envelope code=E_KOS_* → request() throw ApiError{code}，
   *  工具 duck-type 读 code → LLM fallback 本地 FTS5（kos.ts exceptionToToolResult）。 */
  kosCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this._req<unknown>('POST', '/chat/kos-call', { body: { name, args } })
  }

  saveToKos(input: SaveConversationInput): Promise<SaveConversationResult> {
    return this._req<SaveConversationResult>('POST', '/chat/save-to-kos', { body: input })
  }
}
