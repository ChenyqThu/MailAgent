// V2.1 阶段 3 — ChatPlatform seam（分层接线板）。
//
// B-pure-unified：chat harness/dispatcher 逻辑下沉 shared/ 后在 UI 进程
// （本地 renderer / 远程 browser）跑，经 ChatPlatform 抽象访问所有外部能力；
// 背后由各端实现：main = ElectronChatPlatform 直调既有 chat_db/db/config/kos
// （字节级零回归）；远程 = HttpChatPlatform fetch serve-api（3b/3c 落地）。
//
// 🔴 不变式 1：本文件零 Electron/Node-only 依赖（只引 shared/chat 内类型）。
//    pnpm build:web 验证 —— 方案成败根本。
//
// ── 分层接线板（用户拍板 2026-06-05）─────────────────────────────────────
// 不把外部能力堆成一个大 interface，而按「变更频率 + 职责」拆成几块独立小板，
// 组件各取所需的板。红利：未来海量工具/后端补充只动对应板 interface + 各端
// 实现，地基板（ChatInfraPlatform）与 harness/dispatcher 核心零改动。
//
//   板                     | 定形 | 含                                          | 消费方
//   ──────────────────────┼──────┼─────────────────────────────────────────────┼────────────────────
//   ChatInfraPlatform     | 3a   | persist / loadEmailContext / resolveConfig / | harness + dispatcher
//   （基础设施板，本文件） |      | prefetchSenderDigest                         |
//   ChatModelPlatform     | 3b   | llmFetch / notionAgentStream /               | custom_api/notion_agent
//   （模型板）             |      | getCachedSenderDigest                        | 下沉时
//   ChatToolPlatform      | 3b   | 工具集 / saveToKos                           | tools/builtin + kos_save
//   （工具板）             |      |                                              | 下沉时
//
// 为何 3a 只定基础设施板：harness + dispatcher 全部外部调用实测只落这 4 类
// （grep 钉死）。模型/工具板的 7 原语其消费方（两后端 / 工具 / KOS 保存）3a
// 全留 main 走现有注入口，根本不调 platform → 3a 写它们 = 无消费方占位假线。
// 按真实形状 3b 定形，避免「猜的形状 3b 还得改」。详见
// docs/v2.1-stage3-chat-platform-design.md §3。

import type {
  AppendMessageInput,
  AppendToolCallInput,
  ChatMessage,
  ChatSession,
  OpenSessionInput,
  UpdateMessagePatch,
  UpdateToolCallPatch
} from './model'
import type { ChatStreamEvent, ChatStreamRequest, EmailContext } from './types'

// ─── 基础设施板：持久化端口（ai_chat.db 写读）────────────────────────────
//
// 全部方法返回 Promise（http 实现异步）；streamContent 例外 = fire-and-forget
// void（守 harness 每 chunk 同步写热路径零回归 —— electron 实现同步直写）。
// ElectronChatPlatform 直接转发同步 chat_db.* 函数（包成 async），字节级零回归。
export interface ChatPersistPort {
  getOrCreateSession(input: OpenSessionInput): Promise<ChatSession>
  createNewSession(input: OpenSessionInput): Promise<ChatSession>
  getSession(sessionId: number): Promise<ChatSession | null>
  getMessage(messageId: number): Promise<ChatMessage | null>
  listLastNMessages(sessionId: number, limit: number): Promise<ChatMessage[]>
  appendMessage(input: AppendMessageInput): Promise<ChatMessage>
  /** 流式正文增量。**fire-and-forget，不 await**——守 harness 每 chunk 同步写
   *  热路径零回归。cadence 由实现定：electron 同步直写 chat_db；http debounce
   *  ~1/s 合并 PATCH（终态由 finalizeMessage flush）。 */
  streamContent(messageId: number, content: string): void
  /** 终态落库（complete/error/aborted + token/cost/model/metadata）。await。
   *  http 实现**必须先 flush（落库）**该 messageId 待发的 debounced streamContent
   *  增量、**再**写终态 patch —— 不丢最后一段 partial 正文（codex review MEDIUM-2；
   *  「取消未发增量」会丢 error/cost/max_iter 终态前的尾段）。另：harness 所有终态
   *  patch 均带 `content=buffer`（complete/error/cost/max_iter），即使 http 实现误
   *  cancel pending 增量也不丢正文 —— 双保险。 */
  finalizeMessage(messageId: number, patch: UpdateMessagePatch): Promise<void>
  deleteMessagesFromId(sessionId: number, fromMessageId: number): Promise<number>
  abortStreamingMessages(sessionId: number): Promise<number>
  appendToolCall(input: AppendToolCallInput): Promise<{ id: number }>
  updateToolCall(toolCallId: number, patch: UpdateToolCallPatch): Promise<void>
  getToolCallByUseId(messageId: number, toolUseId: string): Promise<{ id: number } | null>
}

// ─── 基础设施板：运行配置快照（env 读，harness 启动时一次性取）─────────────
export interface ChatRuntimeConfig {
  /** harness 每用户消息最大迭代次数（AGENT_MAX_ITER，默认 8）。 */
  maxIter: number
  /** harness 每轮成本上限 USD（AGENT_MAX_COST_USD，默认 0.5）。 */
  maxCostUsd: number
  /** KOS L1 hot block 注入开关（MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED，默认 OFF）。
   *  harness 据此决定是否 fire-and-forget 预取发件人 digest。 */
  kosL1HotBlockEnabled: boolean
  /** 多轮 harness 总开关（MAILAGENT_AGENT_HARNESS，默认 ON）。dispatcher 据此
   *  + backendSupportsTools(kind) 双门 gate harness vs legacy 单遍。 */
  harnessEnabled: boolean
}

// ─── 基础设施板（3a 定形）────────────────────────────────────────────────
// harness + dispatcher 的形参类型 = 此 interface（只声明依赖基础设施板）；
// 传入实现了全部板的 ElectronChatPlatform / HttpChatPlatform 实例（TS 结构化兼容）。
export interface ChatInfraPlatform {
  persist: ChatPersistPort
  /** 从 SQLite SSoT 读邮件元数据 + markdown 正文，供 backend system prompt
   *  inline。行缺失 / DB 不可达 → null（chat 仍可跑，模型看不到邮件正文）。 */
  loadEmailContext(emailId: number): Promise<EmailContext | null>
  /** 取运行配置快照（harness 启动时一次性取，整轮用同一份）。 */
  resolveConfig(): Promise<ChatRuntimeConfig>
  /** fire-and-forget 预取发件人 KOS digest（L1 hot block 用）。harness 启动时
   *  调；**不 await**（不阻塞 backend.stream 启动，通常首 chunk 前已返回）。
   *  实现内部幂等 + 并发去重 + 失败缓存（见 kos/sender_digest_cache.ts）。 */
  prefetchSenderDigest(senderAddr: string): void
}

// ─── 模型板 ChatModelPlatform（3b-1 定形：custom_api 下沉消费）─────────────
// custom-api SSE 解析下沉 shared/chat/backends/custom_api.ts 后，经此访问 3 类外部
// 能力：key 注入的 LLM fetch（key 永不进 shared）+ L1 hot block 的 sender digest 同步
// 读 + system prompt/protocol 路由的配置快照。electron 实现直调 llm_settings/kos cache/
// config getter（字节级零回归）；http 实现 fetch serve-api /api/chat/llm-proxy（注入 key 透传）。

/** custom-api 上游 LLM 请求（shared 构造 body + 判 protocol，实现侧注入 key + 选 endpoint + fetch）。 */
export interface LlmFetchRequest {
  /** shared 据 model 前缀判定：'anthropic'→/v1/messages(x-api-key+anthropic-version)；
   *  'openai'→/v1/chat/completions(Bearer)。实现侧据此选 endpoint + header 风格。 */
  protocol: 'anthropic' | 'openai'
  /** shared 已构造好的上游请求体（model/max_tokens/system/messages/tools/stream:true）。 */
  body: Record<string, unknown>
  /** 已组合 deadline+parent 的取消信号（shared 持有 timeout 逻辑，实现侧只透传给 fetch）。 */
  signal: AbortSignal
}

/** custom-api buildSystemBlocks + protocol 路由需要的配置快照（同步读，session 级）。 */
export interface ChatModelConfig {
  /** req.model 为 null 时的默认（electron: getLlmModel()=LLM_MODEL/claude-sonnet-4-6）。 */
  defaultModel: string
  /** 注入 KOS 使用指南块（buildKosGuidanceBlock gate；MAILAGENT_KOS_CONSUMER_ENABLED）。 */
  kosConsumerEnabled: boolean
  /** 注入 L1 sender digest hot block gate（MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED）。 */
  kosL1HotBlockEnabled: boolean
}

export interface ChatModelPlatform {
  /** 发起 LLM 上游请求 → 原始 SSE Response（body 由 shared custom_api 解析）。key 不进 shared。
   *  返回**未检查**的 Response（shared 查 !ok/!body 分类 E_QUOTA/E_UPSTREAM，避免 body 泄漏）；
   *  key 缺失 → throw Error&{code:'E_NO_LLM_KEY'}；fetch 失败 → 自然 throw（shared catch 读
   *  code 归 E_NO_LLM_KEY，否则 E_UPSTREAM）。 */
  llmFetch(req: LlmFetchRequest): Promise<Response>
  /** L1 hot block 同步读 sender digest cache（与 ChatInfraPlatform.prefetchSenderDigest 配对）。
   *  electron: getCachedSenderDigest(addr)；http: 暂返 null（L1 默认 OFF，后续接）。 */
  getCachedSenderDigest(senderAddr: string): string | null
  /** custom_api 构造 system prompt + protocol 路由的配置快照（同步）。 */
  modelConfig(): ChatModelConfig
}

// ─── 模型板②：notion-agent http backend 消费（3b-2 定形；仅 http 实现）───────────
// serve-api 复刻 notion_agent.ts 全语义（asyncio spawn `notion-agent chat --stream`，见
// src/chat/notion_agent.py），输出「语义 event SSE」。http 实现 fetch POST /api/chat/notion-agent
// + parseSse 反序列化为 ChatStreamEvent —— 与 custom_api backend 在 UI 进程产出的 event 同形，
// harness 直接消费（3b-5 的 HttpChatPlatform.notionAgentStream + createHttpNotionAgentBackend）。
// electron **不实现此板**：NotionAgentBackend = execa 子进程留 main，经 args.backend 注入、不经
// platform（execa 浏览器跑不了是硬约束，按后端性质分 D2）。故拆成独立小板，避免逼 electron 实现
// 用不到的 notionAgentStream（占位假线）。
export interface ChatNotionAgentPlatform {
  /** notion-agent 子进程流。req = ChatStreamRequest（CLI 无工具，忽略 tools/iterHistory）；
   *  yield 语义 ChatStreamEvent（tool_call/chunk/usage/done/error），与 custom_api backend 同形。 */
  notionAgentStream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>
}

// ─── 工具板 ChatToolPlatform（仍占位，3b-4 定形）──────────────────────────────
// 8 读+3 写原语 / kosCallTool / kosConfig / saveToKos，工具逻辑下沉 shared createBuiltinTools
// 单一真源。按「有消费方才定」纪律，tools/builtin + kos_save 下沉时定义。
