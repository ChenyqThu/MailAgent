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
// docs/reference/remote-chat-report/v2.1-stage3-chat-platform-design.md §3。

import type {
  AgentMemoryEntry,
  AppendMessageInput,
  AppendToolCallInput,
  ChatMessage,
  ChatSession,
  OpenSessionInput,
  UpdateMessagePatch,
  UpdateToolCallPatch,
  WriteMemoryInput
} from './model'
import type { ChatStreamEvent, ChatStreamRequest, EmailContext } from './types'
// 工具板读原语返回类型 = 既有 cli.gen / api 形状（均 shared 零 Electron，不变式 1）。
import type {
  AttachmentList_AttachmentItem,
  EmailGet_EmailRecord,
  EmailList_EmailListItem,
  MailagentEmailBody
} from '../types/cli.gen'
import type {
  AIFields,
  ReportDetail,
  ReportListItem,
  ReportRunResult,
  SearchResult
} from '../api/types'

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
  /** KOS consumer 原始开关（MAILAGENT_KOS_CONSUMER_ENABLED）。仅状态展示用；注入 gate
   *  一律用 kosConfigured（开关 AND 凭据），勿再用本字段 gate 工具 / 指南。 */
  kosConsumerEnabled: boolean
  /** KOS 工具真正可用 = 启用 AND 凭据齐全（serve-api kosConfigured = consumer AND
   *  KOS_MCP_BASE/CLIENT_ID/CLIENT_SECRET 非空）。buildKosGuidanceBlock 注入 + 9 个 KOS
   *  工具注册同 gate 它 —— 开关开着但未对接时都不注入，避免叫 AI 用未注册的工具。 */
  kosConfigured: boolean
  /** 注入 L1 sender digest hot block gate（MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED）。 */
  kosL1HotBlockEnabled: boolean
  /** task 06-08-chat 第二波 Bug B — Notion context page markdown (user profile /
   *  Sender Priority / focus projects / 研发课组 / 邮件风格 / 时区), injected into
   *  the stable (cacheable) system prefix so the custom-api assistant knows who
   *  the user is. null / "" → not injected (LLM_CONTEXT_PAGE_ID unset or fetch
   *  failed; graceful). Sourced from serve-api GET /chat/config (ContextLoader,
   *  TTL-cached). notion-agent carries its own Notion context → not injected. */
  userContext: string | null
  /** P2f — compact user-scope memory summary, injected into the stable system
   *  prefix AFTER userContext (both are cacheable "user profile" overlays). From
   *  serve-api /chat/config (ChatDb.memory_summary). null / "" → not injected. */
  memorySummary: string | null
  /** P3 — concatenated prompt fragments of the ENABLED + AVAILABLE Skills,
   *  injected into the stable system prefix AFTER memorySummary (cacheable). The
   *  runtime computes this from the Skill manifest + the user's per-skill toggles
   *  (shared/chat/skill_enablement.computeSkillEnablement); a disabled skill's
   *  fragment is excluded here AND its tools are filtered from the catalog.
   *  null / "" → not injected (manifest unreachable or no skills enabled). */
  skillFragments: string | null
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

// ─── 工具板 ChatToolPlatform（3b-4 定形：tools/builtin + kos_save 下沉消费）────────
// 工具逻辑（input 校验 + shape massage + kos_query rerankByRecency）下沉 shared 单一真源
// createBuiltinTools(toolPlatform): ToolDef[]；electron/http 只提供后端原语两实现（零 parity）。
// harness 经注入的 registry 取工具（取代 module-global defaultToolRegistry，dispatcher 注入）。
//
// 读原语统一 Promise 签名（electron 实现包同步 handler 返回值；http fetch serve-api）。返回 shape
// = 既有 serve-api/handlers data 块（cli.gen / api 类型，均 shared）；search* 结果工具直接塞、
// 不读字段 → unknown 足够（AttachmentSearchResult 形状在 main handlers，不为类型拖进 shared）。

/** email_search 工具构造的元数据过滤 opts（handlers ListOpts 子集；shared 自有，
 *  不引 main handlers 的 Electron 类型）。 */
export interface ChatToolListEmailsOpts {
  subject?: string
  fromAddr?: string
  mailbox?: string
  sinceDate?: string
  untilDate?: string
  isRead?: boolean
  isFlagged?: boolean
  limit?: number
}

/** email_search_fulltext / email_search_attachments 工具构造的 FTS opts（SearchOpts 子集）。 */
export interface ChatToolSearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
}

/** email_flag / email_archive 工具构造的 flag patch（EmailFlagOpts 子集，至少一项非空由工具校验）。 */
export interface ChatToolFlagPatch {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string
}

/** report_list 工具构造的过滤 opts（GET /api/reports query 子集）。 */
export interface ChatToolReportListOpts {
  cadence?: 'daily' | 'weekly' | 'monthly'
  agentId?: string
  limit?: number
}

/** email_list_folders 工具返回的单个文件夹（imap_name = raw modified-UTF7，move 用；
 *  display_name = 解码后中文/展示名）。从 folder discover 的 FolderInfo 投影而来。 */
export interface ChatToolFolderItem {
  imap_name: string
  display_name: string
  special_use: string | null
  is_synced: boolean
}

/** email_draft_reply 工具读的 createDraft 结果形状（main CreateDraftResult 镜像；shared 自有）。 */
export interface ChatToolDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  draftId: string
}

/** email_set_reply_suggestion 工具读的 set_reply_suggestion 结果形状（serve-api
 *  POST /email/{id}/reply-suggestion 的 data 块；shared 自有，不引 Electron 类型）。 */
export interface ReplySuggestionData {
  internalId: number
  replySuggestionMd: string
  chars: number
}

/** email_set_ai_fields 工具读的 set_ai_fields 结果形状（serve-api POST /email/{id}/ai-fields
 *  的 data 块；snake_case → camelCase 投影；未传字段为 null = 实际落库值）。 */
export interface AiFieldsData {
  internalId: number
  /** 实际落库的 AI Action（中文枚举，labels_json.action_type；未传则 null）。 */
  aiAction: string | null
  /** 实际落库的 AI Priority（中文枚举，labels_json.priority；未传则 null）。 */
  aiPriority: string | null
  /** 实际落库的 AI Review Status（'reviewed'/'pending'，映自 llm_processing.status；未传则 null）。 */
  aiReviewStatus: string | null
}

/** kos 工具注册 + rerank gate 的配置快照（同步）。configured = 注册 gate
 *  （electron: isKosConsumerEnabled()，零回归注册语义，非 OAuth 凭据齐）；
 *  timeDecayEnabled = kos_query rerankByRecency gate（isKosTimeDecayEnabled()）。 */
export interface ChatToolKosConfig {
  configured: boolean
  timeDecayEnabled: boolean
}

/** chat:saveToKos 入参（main kos_save.ts 真源迁此，工具板契约 + electron impl 共用）。 */
export interface SaveConversationInput {
  /** assistant message 的 id；service 自己向前找最近 user message 配对。 */
  messageId: number
  /** Optional override — 不传走 default `chat-history/mailagent/<email>/<sess>/<msg>`。 */
  slug?: string
  /** Optional override title — 不传从 user message 首句生成（≤ 50 字符）。 */
  title?: string
}

/** chat:saveToKos 结果。 */
export interface SaveConversationResult {
  slug: string
  status: string
  contentBytes: number
}

/** notion_agent_chat tool 结果（P2g）= serve-api POST /chat/notion-agent-once 收集的
 *  非流式结果。threadId 续接（带回供下一轮 input.threadId）；status='error' 时带 errorCode/Message。 */
export interface NotionAgentChatResult {
  text: string
  threadId: string | null
  status: 'ok' | 'error'
  metadata: Record<string, unknown> | null
  errorCode?: string
  errorMessage?: string
}

/** notion_agent_chat tool 入参（P2g）。 */
export interface NotionAgentChatInput {
  message: string
  threadId?: string | null
  model?: string | null
  agentPageId?: string | null
}

export interface ChatToolPlatform {
  // ── 读原语（8 silent 工具）— electron 直调 handlers（同步包 async）/ http fetch serve-api ──
  listEmails(opts: ChatToolListEmailsOpts): Promise<EmailList_EmailListItem[]>
  getEmail(internalId: number): Promise<EmailGet_EmailRecord | null>
  /** markdown 正文（固定 format=markdown；12000 截断是工具纯逻辑，原语返回完整 body）。 */
  getEmailBody(internalId: number): Promise<MailagentEmailBody['data'] | null>
  getAiFields(internalId: number): Promise<AIFields | null>
  listEmailsByThread(threadId: string): Promise<EmailList_EmailListItem[]>
  searchEmailsFulltext(opts: ChatToolSearchOpts): Promise<SearchResult>
  listAttachments(internalId: number): Promise<AttachmentList_AttachmentItem[]>
  searchAttachments(opts: ChatToolSearchOpts): Promise<unknown>
  /** 列出 Exchange 文件夹（imap_name + display_name）供 email_move 把"移到 X"解析成
   *  raw IMAP 名（自定义中文文件夹的 modified-UTF7 名 LLM 猜不出）。davmail-only —
   *  非 davmail 后端 serve-api 抛 → 工具 graceful 上报错误。委托 httpApi.folder.discover
   *  （counts=false 避开慢的逐文件夹 STATUS）。 */
  listFolders(): Promise<ChatToolFolderItem[]>
  // ── 写原语（preview/edit 工具）─────────────────────────────────────────────
  /** flag/archive 经此（electron+http 都→serve-api，runEmailFlag 已 D1 统一，零 parity）。
   *  返回 daemon FlagResult（{updated_ids?,outbox_entries?}），工具内 as 投影。 */
  flagEmail(internalId: number, patch: ChatToolFlagPatch): Promise<unknown>
  /** 回复草稿 → POST /email/draft（bodyText + quoteOriginal、不传 to/cc → 服务端推导
   *  reply-all 收件人 + 拼引用原文，davmail IMAP APPEND）。electron renderer / 远程 browser
   *  均走 HttpChatPlatform 实现（不再走 Mail.app AppleScript）。 */
  draftReply(internalId: number, bodyMarkdown: string): Promise<ChatToolDraftResult>
  /** 写邮件回复建议 markdown 到 SQLite SSoT（llm_processing.labels_json.reply_suggestion_md）。
   *  electron+http 都 → serve-api POST /email/{id}/reply-suggestion（MailWriteService
   *  .set_reply_suggestion）。compose 取建议时读同一字段，故改了建议后 reply/Craft 即用新值。 */
  setReplySuggestion(internalId: number, replyMarkdown: string): Promise<ReplySuggestionData>
  /** 覆盖邮件 AI 分类字段（AI Action / Priority / Review Status）到 SQLite SSoT。electron+http
   *  都 → serve-api POST /email/{id}/ai-fields（MailWriteService.set_ai_fields，写
   *  labels_json.action_type/priority + 镜像主表列 + llm_processing.status）。至少一项非空；
   *  非法枚举值 serve-api 拒（合法值取自 src/llm_agent/schema.py）。返回实际落库值。 */
  setAiFields(
    internalId: number,
    fields: { aiAction?: string; aiPriority?: string; aiReviewStatus?: string }
  ): Promise<AiFieldsData>
  /** 置顶 / 取消置顶 → POST /email/{id}/pin（MailWriteService.set_pin）。返回 {internal_id,
   *  is_pinned, changed}（工具内 as 投影）。 */
  setPin(internalId: number, pinned: boolean): Promise<unknown>
  /** 移动邮件到任意文件夹 → POST /email/{id}/move（davmail IMAP MOVE，MailWriteService
   *  .move_to_folder）。dstImapName = IMAP 原始名（modified-UTF7）。返回 MoveResult data。 */
  moveEmail(internalId: number, dstImapName: string): Promise<unknown>
  /** 重传单封到 Notion → POST /email/{id}/resync（MailWriteService.resync）。返回 ResyncResult data。 */
  resyncEmail(internalId: number): Promise<unknown>
  /** 归档邮件 → POST /email/{id}/archive（davmail IMAP move→Archive + Mailbox→存档，
   *  MailWriteService.archive）。返回 ArchiveResult data。 */
  archiveEmail(internalId: number): Promise<unknown>
  // ── 报告（report_list/get silent；report_run preview/edit）──────────────────
  /** 报告列表 → GET /api/reports（不含 blocks）。委托 httpApi.report.list。 */
  listReports(opts: ChatToolReportListOpts): Promise<ReportListItem[]>
  /** 单份报告详情（含 doc）→ GET /api/reports/{id}。委托 httpApi.report.get。不存在 null。 */
  getReport(reportId: string): Promise<ReportDetail | null>
  /** 立即生成一份报告（跑 LLM，数十秒）→ POST /api/report-agents/{id}/run。委托
   *  httpApi.report.runNow。 */
  runReport(agentId: string, cadence?: 'daily' | 'weekly' | 'monthly'): Promise<ReportRunResult>
  // ── KOS（9 工具，gated by kosConfig().configured）───────────────────────────
  /** kos 注册 + rerank gate 的同步配置快照。 */
  kosConfig(): ChatToolKosConfig
  /** query/put_page/recall/… 全收敛为 tools/call（electron: KOSClient.callTool；http: serve-api 代理）。 */
  kosCallTool(name: string, args: Record<string, unknown>): Promise<unknown>
  /** 手动保存对话到 KOS（electron: saveConversationToKos；http: serve-api /save-to-kos）。 */
  saveToKos(input: SaveConversationInput): Promise<SaveConversationResult>
  // ── memory WAL（P2f，agent_memory_kv）→ serve-api /chat/memory ──────────────
  /** list memory entries (optional scope filter, newest-first). */
  listMemory(scope?: string): Promise<AgentMemoryEntry[]>
  /** single entry or null ("never recorded"). */
  getMemory(scope: string, key: string): Promise<AgentMemoryEntry | null>
  /** UPSERT a memory entry. The memory_write tool gates this behind a preview
   *  confirmation (silent memory writes are a known risk — architecture §3.5). */
  writeMemory(input: WriteMemoryInput): Promise<AgentMemoryEntry>
  /** delete a memory entry → rows removed (0 if absent). */
  deleteMemory(scope: string, key: string): Promise<number>
  // ── notion_agent_chat tool（P2g）→ serve-api /chat/notion-agent-once ────────
  /** Run the notion-agent CLI once (non-streaming collect) and return its text +
   *  thread_id for continuity. Reuses the serial gate / idle timeout. `signal` is
   *  threaded to the fetch so the harness's per-tool timeout / user cancel actually
   *  aborts the request (codex review — notion-agent can otherwise hang to the server
   *  idle timeout). The old streaming notion-agent backend stays (Phase 3 retires UI). */
  notionAgentChat(input: NotionAgentChatInput, signal?: AbortSignal): Promise<NotionAgentChatResult>
  // ── generic Skill invoke（P2b）→ serve-api POST /api/skills/invoke ──────────
  /** Invoke a Skill tool through the authoritative Python registry (the same face
   *  MCP / external agents use). Returns the envelope's `data`; throws Error&{code}
   *  on a SkillError. Used by manifest-driven tools when MAILAGENT_CHAT_MANIFEST_MODE
   *  is on, so a read tool runs against the single source of truth. The local/CF
   *  auth the chat runtime already carries is an owner principal → full scopes. */
  invokeSkillTool(skill: string, tool: string, input: unknown): Promise<unknown>
}
