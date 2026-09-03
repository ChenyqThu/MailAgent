import type {
  ContactSuggestion,
  EmailBody,
  EmailDetail,
  EmailMeta,
  ResyncResult,
  SearchResult
} from './core'
import type { JobEnqueueResult } from './jobs'
import type { EmailSortDir, EmailSortKey } from '@shared/lib/emailSort'

// ---- Sprint 2 frontend-only enriched views ---------------------------------
//
// These three views (listEnriched / listMailboxes / aiFields) are joined by
// the Electron main handlers from `email_metadata` + `email_body` (snippet) +
// `llm_processing.labels_json` (AI fields). They deliberately live OUTSIDE
// `cli.gen.ts` — the backend CLI doesn't return them and the schema-
// conformance tests treat `cli.gen.ts` as the boundary anchor (REVIEW-LOG
// C-03). Both the renderer (`shared/api/ElectronApi.ts`) and the handler
// (`electron/main/handlers/email.ts`) import these names from here so the
// type stays single-source.

/** DESIGN.md §2.3 / §5.2 — 5-tier priority enum used by <AIBadge> variant. */
export type AIPriority = 'critical' | 'urgent' | 'important' | 'normal' | 'low'

export interface EnrichedEmailMeta extends EmailMeta {
  /** ISO 2-letter from `labels_json.language`. `'unknown'` if LLM hasn't seen it. */
  lang: 'zh' | 'en' | 'unknown'
  /** Mapped from `labels_json.priority` (emoji-Chinese) to the 5-slug enum. */
  ai_priority: AIPriority | null
  /** `labels_json.action_type` — Chinese label passed through verbatim for the chip. */
  ai_action: string | null
  /** `labels_json.category` — LLM-emitted closed enum (CATEGORY_ENUM in
   *  src/llm_agent/schema.py), passed through verbatim (e.g. "💼 产品管理").
   *  Null if no LLM run yet. Drives the filter popover's Category section. */
  ai_category: string | null
  /** User-visible attachment count: excludes inline-only images. Includes derived (docx→pdf). */
  attach_count: number
  /** v9 — 邮件原生重要性（reader._parse_importance: Importance / X-Priority /
   *  X-MSMail-Priority 任一为 high → true）。EmailRow 的 ❗ 角标读这个字段，
   *  与 LLM 推断的 ai_priority 互相独立。 */
  is_important: boolean
  /** Sprint 15 D 块 — Notion Processing Status 镜像 (CLI email flag 写, 反向
   *  webhook handler 也维护). EmailRow 用 `processing_status === '已完成'`
   *  判 'done' 三态显示 (v3 的 sync_status==='deleted' 判定永远 false, 已失效).
   *  可能值: '未处理' / 'AI Reviewed' / '已同步' / '已完成' / '草稿已创建';
   *  老邮件未被任何写入触达时为 null. */
  processing_status: string | null
  /** 08-31 — `llm_processing.status` **原始值**（pending / success / failed；无行 = null）。
   *  🔴 `ai_review_status` 把 failed 与 pending 都映成 'pending'，失败的预处理在读侧因此
   *  分不出来（团队页记录列里根本看不见）。列表面要区分失败行只能看这个。老后端无此字段
   *  → undefined，消费方必须容忍。 */
  llm_status?: string | null
}

export interface MailboxSummary {
  /** NULL-mailbox rows are excluded from this list. */
  mailbox: string
  /** Excludes `skipped` rows so the count matches what EmailList actually
   *  shows (Sprint 10 user-acceptance follow-up). */
  total: number
  /** Sum of `is_read = 0`. Production data may show all-zero — real-world signal, not a bug. */
  unread: number
  /** Sum of `is_flagged = 1`. Powers the Sidebar "已标旗" virtual entry. */
  flagged: number
  /** Sum of `sync_status IN ('failed', 'dead_letter')`. Powers the
   *  "Failed" filter chip + future Sidebar entry. */
  failed: number
}

export interface AIFields {
  internal_id: number
  processing_status: string | null
  /** Duplicated from email_metadata for one-shot rendering convenience. */
  mailbox: string | null
  is_read: boolean
  is_flagged: boolean
  ai_priority: AIPriority | null
  ai_action: string | null
  /** Mapped from `llm_processing.status`. Null if no llm_processing row exists. */
  ai_review_status: 'pending' | 'reviewed' | null
  /** Passthrough from `labels_json.sentiment` — agent does not emit yet (REVIEW-LOG H-14 follow-up). */
  sentiment: string | null
  /** AI 模型/来源标识 — `llm_processing.model` 列 (如 'claude-sonnet-4-6' /
   *  'external:notion')。不在 labels_json, 头部右侧显示。Null = 无 LLM run。 */
  ai_model: string | null
  /** Raw labels blob for Sprint 4 AI Chat context / V1.5 debug. Null if no LLM run. */
  labels_raw: Record<string, unknown> | null
  /** 08-31 — 团队页「AI 邮件预处理」执行详情用的六个字段（命名沿 `llm_processing` 列名）。
   *  它们**一直在库里**，只是从没投影出来（r10 §2.4）。旧后端 → undefined。
   *  `llm_status` 是原始 status（pending / success / failed），见 EnrichedEmailMeta 同名字段。 */
  llm_status?: string | null
  latency_ms?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  retry_count?: number | null
  last_error?: string | null
}

export interface ListOpts {
  mailbox?: string
  status?: string
  sinceDate?: string
  untilDate?: string
  fromAddr?: string
  subject?: string
  isRead?: boolean
  isFlagged?: boolean
  hasNotion?: boolean
  /** Restrict to a specific set of internal_id values. 配合其他 filter
   *  叠加 (AND), 主要给 pinned-supplement / 已知 id 批量取 enriched 用. */
  internalIds?: number[]
  limit?: number
  offset?: number
  /** 排序键 / 方向 —— 词表单源 @shared/lib/emailSort。**只有 `listEnriched`
   *  消费**（两端: Electron DAO + serve-api /email/list-enriched）；`list` 等
   *  其它读面维持各自的固定序。省略 = date DESC（历史行为）。 */
  orderBy?: EmailSortKey
  sortDir?: EmailSortDir
}

export interface BodyOpts {
  format?: 'markdown' | 'html' | 'raw'
  mode?: 'preview' | 'full'
}

export interface SearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
  mode?: 'smart' | 'raw'
  /** Cross-language fixture injection; production callers omit both fields. */
  now?: string
  tzOffsetMinutes?: number
}

export interface ResyncOpts {
  replaceExisting?: boolean
  skipParentLookup?: boolean
  dryRun?: boolean
}

// ---- Sprint 5 §2.2 — write surfaces ---------------------------------------

export interface CreateDraftOpts {
  internalId: number
  /** Optional plaintext body to prepend above the quoted source.
   *  Sprint 5 keeps it plaintext; Sprint 6 HTML clipboard ramp adds rich text. */
  body?: string
}

export interface CreateDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  /** AppleScript-returned draft message id. */
  draftId: string
}

export interface SetReplySuggestionOpts {
  internalId: number
  /** Full reply markdown to persist as the new reply_suggestion_md (SSoT).
   *  Replaces the prior stored suggestion. The composer's draftPlan reads the
   *  same field, so persisting a user edit makes the top reply/reply-all
   *  prefill pick it up (F1). */
  body: string
}

export interface SetReplySuggestionResult {
  internal_id: number
  reply_suggestion_md: string
  chars: number
}

export interface LlmRunOpts {
  dryRun?: boolean
  /** Overwrite existing AI fields. Without this the CLI no-ops when labels exist. */
  force?: boolean
  /** Preserve user-edited non-null fields when force=true. */
  noOverwrite?: boolean
}

export interface UpdateFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  /** Notion DB enum: 未处理 / AI Reviewed / 已同步 / 已完成 / 草稿已创建. */
  processingStatus?: string
  dryRun?: boolean
}

// ---- Compose (回复 / 回复所有 / 转发) — `mailagent email draft|send` --------
//
// `email.draft`     → 把 compose 内容写进 Drafts folder (IMAP APPEND), 可重入。
// `email.send`      → SMTP 真实发送 (不可逆); 前端先弹 SendConfirmDialog 再调,
//                     IPC handler 始终带 `--yes`。
// `email.draftPlan` → `email draft --dry-run`; compose 打开时调一次预填收件人 /
//                     主题 / 正文 HTML (reply 用 LLM reply_suggestion 转的 HTML,
//                     forward 用原文引用块 HTML)。无 auth (dry-run)。
//
// to/cc/bcc 是 compose 用户编辑后的**权威**收件人列表 (覆盖后端推导);
// subject 覆盖 Re:/Fwd: 自动前缀; bodyHtml 是 TipTap getHTML() 输出 (零转换,
// IPC handler 落临时文件 → --body-html-file)。

export type ComposeMode = 'reply' | 'reply-all' | 'forward'

/** 邮件重要性 — 写进发出邮件的 Importance / X-Priority MIME 头。'normal' / 缺省 = 不写头。 */
export type ComposeImportance = 'high' | 'normal' | 'low'

/** wire mode 比 UI ComposeMode 多一个 'new' —— 草稿编辑(draft-edit)保存/发送时用,
 *  后端走显式收件人/正文、零回复线程派生 (src/api/routers/email.py VALID_COMPOSE_MODES)。 */
export type ComposeWireMode = ComposeMode | 'new'

/** D1 附件引用 — compose draft/send 请求体 `attachments` 数组元素。key 是 **snake_case**
 *  (对齐 PRD D1 契约字面): stage_id = staging 上传回执引用; attachment_id = 库内已有附件
 *  (email_attachment.id, 服务端复用 forward 收集器读取路径); library_file_id = 资料库内
 *  已有文件 (library_file.id, P2-L9: 服务端经 LibraryService.stream_target() 读盘, 经资料库
 *  自己的路径 jail, 见 mail_write.py::_resolve_attachment_refs)。 */
export type ComposeAttachmentRef =
  | { stage_id: string }
  | { attachment_id: number }
  | { library_file_id: number }

/** `PUT /email/compose-attachment?filename=…` 的 data 块 (staging 暂存回执, snake_case)。 */
export interface StagedAttachment {
  stage_id: string
  filename: string
  size?: number | null
  mime?: string | null
}

/** 附件上传入参 — renderer 读 File 成 ArrayBuffer 后经 IPC / raw PUT 送 staging 端点。 */
export interface UploadComposeAttachmentOpts {
  filename: string
  bytes: ArrayBuffer
  mime?: string
}

export interface ComposeDraftOpts {
  internalId: number
  mode: ComposeWireMode
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  /** reply/reply-all 改主题断线程守卫的逃生口 (服务层默认拒绝与原主题规范化后不同的
   *  subject)。UI composer 恒传 true — 用户在主题框里改是明确意图; 守卫防 agent/CLI 误用。 */
  forceSubject?: boolean
  bodyHtml?: string
  /** 纯文本/markdown 正文 (serve-api `_compose_request_from_body` 读 `bodyText`)。
   *  "只给纯回复正文、服务端推导收件人 + 拼引用原文" 的调用方 (正文 Craft / chat
   *  email_draft_reply 工具) 走这条：传 bodyText + quoteOriginal、不传 to/cc。 */
  bodyText?: string
  /** quoteOriginal=true → 即便传了显式正文也在其下方拼引用原文 (reply/reply-all)。
   *  正文 Craft / chat email_draft_reply 用 (等效顶部「回复所有 + 带原文引用」)。 */
  quoteOriginal?: boolean
  /** 重要性 (高/普通/低)；'normal'/缺省时后端不写 Importance 头。 */
  importance?: ComposeImportance
  /** D1 — 附件引用列表 (staging 上传 / 库内已有)。缺省 = 无附件 (forward 的原邮件附件
   *  仍由服务端自动收集, 不在此列表重复引用, 防双份)。 */
  attachments?: ComposeAttachmentRef[]
  /** D1 Bug A — 草稿行自己的 internal_id, 仅 mode='new' (draft-edit 保存/发送) 有意义:
   *  服务端读该行 draft_in_reply_to/draft_references/thread_id 恢复回复线程头,
   *  linkage 空则回退现状零派生。HTTP body key 逐字 `sourceDraftId` (serve-api
   *  _compose_request_from_body 直读; 非 int 静默置 None)。task 08-20 起 draft
   *  保存还按它执行 replace: 服务端删该旧行 (墓碑 + 本地删 + EXPUNGE 后台化),
   *  响应带 mirror_internal_id / mirror_attachment_ids 供前端换锚。 */
  sourceDraftId?: number
}

/** Send 与 draft 同形 (内部 IPC handler 给 send 追加 --yes)。 */
export type SendEmailOpts = ComposeDraftOpts

export interface DraftPlanOpts {
  internalId: number
  mode: ComposeMode
}

/** `email draft --dry-run` 的 plan data — compose 预填单一数据源。
 *
 *  字段名是 **snake_case**, 直接对齐 CLI JSON 输出 (email.py dry-run plan) +
 *  项目其它 codegen 类型惯例 (unwrap 只解 envelope, 不做 case 转换)。早期手写成
 *  camelCase 导致 plan.replyHtml/forwardIntroHtml 永远 undefined, 正文引用填不上。 */
export interface DraftPlanResult {
  internal_id: number
  mode: ComposeMode
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** 'reply_suggestion' (LLM) / 'fallback' 等 — 来源标识, 调试用。 */
  reply_source?: string | null
  /** reply/reply-all: LLM reply_suggestion 转的 HTML → TipTap 初始内容 (仅建议, 不含引用块)。 */
  reply_html: string
  /** forward: 原文引用块 HTML (兼容旧字段; 新前端统一读 quote_html)。 */
  forward_intro_html: string
  /** 原文引用块 HTML (reply:「在…写道」+ blockquote; forward: Forwarded 头 + 正文)。
   *  与 reply_html 分离 —— 前端折叠展示, **不**灌进 TipTap (整条线程 HTML 几十~几百 KB
   *  灌进 ProseMirror 会卡 + 重排格式), 发送/存草稿时拼回正文。 */
  quote_html?: string
  /** quote_html 的纯文本版 (摘要/降级用)。 */
  quote_text?: string
  /** 原邮件附件数量 (compose 本期不重新上传, 仅提示)。 */
  attachments: number
  warnings: string[]
}

/**
 * Sprint 15 — `mailagent email flag` opts. Mirrors `EmailFlagOpts` declared
 * in `src/electron/main/handlers/write_ops.ts` (same shape, kept duplicated
 * to keep main / renderer free of cross-imports — same convention as
 * `UpdateFlagOpts`).
 *
 * Replaces the v3 `notion.updateFlag` path: writes SQLite flag intent + a
 * dual-target outbox row (mailapp + notion), then mail-sync's FanoutWorker
 * dispatches both sides async. Pass `internalId = null` + `opts.ids = [...]`
 * to batch (single CLI fork enqueues N×2 outbox rows).
 */
export interface EmailFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string
  /** Batch mode: ids ↔ internalId are mutually exclusive at the CLI level. */
  ids?: number[]
  /** 线程虚拟头「标完成」—— 目标 id 应用完整 mutation 后, 服务端按其 thread_id 把
   *  线程内**其他仍带旗**的成员一并摘旗 (只清 is_flagged, 不动 processing_status)。
   *  仅 `isFlagged: false` 时合法, 否则服务端 400。级联到的成员经 SSE 批量事件回来。 */
  cascadeThread?: boolean
  /** Default true. Mail-sync is always online in production, so the CLI's
   *  pm2 conflict check must be bypassed. */
  allowConcurrent?: boolean
}

/** v8 pin 写的可选参数 (线程虚拟头级联取消置顶)。省略 = 历史单封语义。 */
export interface EmailPinOpts {
  /** 批量目标 (与 internalId 互斥, 镜像 EmailFlagOpts.ids)。 */
  ids?: number[]
  /** 线程虚拟头级联: 按目标 id 的 thread_id 展开线程内其他仍置顶的成员一并取消。
   *  仅 `pinned = false` 时合法, 否则服务端 400。 */
  cascadeThread?: boolean
}

export interface EmailApi {
  list(opts: ListOpts): Promise<EmailMeta[]>
  /** Sprint 2 — list + body snippet + LLM labels + attach count, all in one IPC. */
  listEnriched(opts: ListOpts): Promise<EnrichedEmailMeta[]>
  /** Sprint 2 — sidebar mailbox totals + unread counts. */
  listMailboxes(): Promise<MailboxSummary[]>
  /** Sprint 3 — sibling emails of a thread, ascending by date. Empty list
   *  for unknown/empty threadId so the Thread sidebar can blanket-handle. */
  listByThread(threadId: string | null): Promise<EmailMeta[]>
  /** Sprint 19 — batch sibling fetch for the list pane. One IPC + one SQL
   *  for many thread_ids (replaces the per-thread useQueries fan-out that
   *  fired hundreds of round-trips on an 800-row list). Returns a map keyed
   *  by thread_id; each value is the same ascending-date EmailMeta[] shape
   *  listByThread returns. Threads with no rows are absent from the map. */
  listByThreads(threadIds: string[]): Promise<Record<string, EmailMeta[]>>
  get(internalId: number): Promise<EmailDetail | null>
  /** task 08-27 P5 —— 「在新窗口打开」这封邮件（Electron 轻窗）。放法同
   *  `chat.openPopout`：shared/web 载体是 no-op（远程 web 没有第二窗口的概念），
   *  Electron 由 ElectronApi 注入真实的 `window:openDetached` IPC。 */
  openDetached(internalId: number): void
  body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null>
  /** Sprint 2 — joined LLM labels + processing_status for <AIFieldsBlock>. */
  aiFields(internalId: number): Promise<AIFields | null>
  /**
   * Search-module 1:1 mockup-search.html — returns wrapped
   * `{ items, total_indexed }` so the palette footer can render
   * "N of total_indexed" without a second IPC roundtrip.
   */
  search(opts: SearchOpts): Promise<SearchResult>
  contactSuggest(
    q: string,
    limit?: number,
    exclude?: string | string[]
  ): Promise<ContactSuggestion[]>
  /** Sprint 5 — Notion resync via `mailagent email resync`. Returns whatever
   *  the CLI's `data` envelope contains (page_id, status, etc.). */
  resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult>
  /** D2b — 批量重传 Notion: 选中多封 → enqueue 一个 async_jobs resync 长任务
   *  (POST /api/jobs {jobType:'resync', params:{internal_ids}}), 立即返
   *  {job_id, status:'queued', …}。serve 进程 JobWorker 串行执行, 进度经 SSE
   *  job.* + jobs.get 轮询 (watchResyncJob)。不传 idempotencyKey —— 每次点击
   *  是明确的新意图 (允许重跑同一批)。Throws Error & {code} on enqueue failure。 */
  batchResync(internalIds: number[], opts?: ResyncOpts): Promise<JobEnqueueResult>
  /** Sprint 5 — open Mail.app reply window (AppleScript). User edits +
   *  sends in Mail.app; we don't relay the send. */
  createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult>
  /** F1 — persist a user-edited reply suggestion back to the SQLite SSoT
   *  (POST /email/{id}/reply-suggestion → set_reply_suggestion). The composer's
   *  draftPlan reads the same reply_suggestion_md, so after saving + invalidating
   *  the compose plan cache the top reply/reply-all buttons prefill the edited
   *  body instead of the AI original. Throws Error & { code } on failure. */
  setReplySuggestion(opts: SetReplySuggestionOpts): Promise<SetReplySuggestionResult>
  /** Compose — write a reply/reply-all/forward draft into Drafts (IMAP
   *  APPEND via `mailagent email draft`). Returns the CLI `data` block
   *  (drafts_folder / appended_uid / method / …). Throws Error & { code }
   *  on failure (E_AUTH / E_INVALID_ARG / E_DISPATCH …). */
  draft(opts: ComposeDraftOpts): Promise<unknown>
  /** 草稿真删除 (IMAP \Deleted+EXPUNGE Exchange Drafts + 本地行清理) — 草稿箱
   *  列表行的删除按钮。区别于收件箱删除按钮的归档语义 (flag→done)。davmail-only,
   *  仅 mailbox=草稿箱 的行 (否则 E_INVALID_ARG)。Throws Error & { code }。 */
  deleteDraft(internalId: number): Promise<unknown>
  /** Compose — SMTP real send (irreversible) via `mailagent email send`.
   *  The IPC handler always passes `--yes`; the renderer must show its own
   *  SendConfirmDialog before calling. Throws Error & { code } on failure. */
  send(opts: SendEmailOpts): Promise<unknown>
  /** D1 — compose 附件 staging 上传 (raw bytes PUT, 非 multipart)。返回暂存回执,
   *  其 stage_id 进 draft/send 的 attachments refs。单文件 20MB cap 由前端先拦 +
   *  服务端权威复核。Throws Error & { code } on failure。 */
  uploadComposeAttachment(opts: UploadComposeAttachmentOpts): Promise<StagedAttachment>
  /** Compose — `email draft --dry-run` plan used to pre-fill the composer
   *  (recipients / subject / body HTML). Read-only, no auth. Throws
   *  Error & { code } on failure. */
  draftPlan(opts: DraftPlanOpts): Promise<DraftPlanResult>
  /** v8 — set pinned (true) / unpinned (false) via the `mailagent email
   *  pin/unpin` CLI. Returns the new state, or null on E_NOT_FOUND. The
   *  renderer's optimistic store reconciles against the next
   *  listPinnedIds refetch. `opts` widens the write to a batch / thread
   *  cascade (see EmailPinOpts); the returned boolean is the target state
   *  either way. */
  pin(internalId: number, pinned: boolean, opts?: EmailPinOpts): Promise<boolean | null>
  /** v8 — current set of pinned internal_ids (pinned_at DESC). Drives
   *  the `pinned` zustand store and the "📌 已固定" group in EmailList. */
  listPinnedIds(): Promise<number[]>
  /**
   * Sprint 15 — SSoT inversion. Writes flag / processing_status intent to
   * SQLite (with echo-prevention) + a dual-target outbox row (mailapp +
   * notion). The mail-sync FanoutWorker then dispatches both sides async,
   * so this method returns as soon as the SQL has landed — actual Mail.app
   * / Notion mutations follow within ~5-10s.
   *
   * Single email: `flag(<id>, {isFlagged: true})`.
   * Batch: `flag(null, {ids: [...], isRead: true})` — one CLI fork, N×2
   * outbox rows. The two modes are mutually exclusive at the CLI level.
   *
   * Replaces `mailApi.notion.updateFlag(...)`; the old method stays during
   * Sprint 15 grayscale (frontend/SPRINT15-D handoff §6).
   */
  flag(internalId: number | null, opts: EmailFlagOpts): Promise<unknown>
  /** 归档收件箱邮件: CLI `email archive` 做 IMAP MOVE INBOX→Archive + SQLite/Notion
   *  Mailbox→存档 (davmail-only)。成功后 renderer 失效 emails/email 查询, 邮件移出收件箱
   *  视图 (Archive 副本留在 Exchange 端; 若 Archive 在 SYNC_FOLDERS 白名单则走主链路可见)。
   *  返回 CLI data 块 {success, from_mailbox, to_mailbox, notion_updated} 或抛 Error&{code}。 */
  archive(internalId: number): Promise<unknown>
  /** P4b — AI 自然语言检索: 一句自然语言 → 搜索 DSL (单次 LLM 调用, main 进程,
   *  不碰 P4a 搜索逻辑)。结果由调用方填回搜索框跑既有搜索。永不 reject —— 失败
   *  以 {dsl:'', error} 形态返回 (E_NO_LLM_KEY / E_EMPTY / E_UPSTREAM / E_QUOTA /
   *  E_TIMEOUT / E_NO_OUTPUT), 前端据 error 码给友好提示。web 端无 LLM key/端点,
   *  返回 E_UNSUPPORTED。 */
  nlToDsl(nl: string): Promise<NlToDslResult>
}

/** P4b — `email.nlToDsl` 的返回形状 (镜像 main 侧 handlers/nl_search.ts)。 */
export interface NlToDslResult {
  /** 翻译出的 DSL; error 非空时为 ''。 */
  dsl: string
  /** 结构化错误码; 成功时省略。 */
  error?: string
  /** 人类可读的兜底信息 (i18n 以 error 码为准, message 仅 debug)。 */
  message?: string
}
