// MailApi data-layer abstraction. All React components consume this through
// useMailApi(); the Electron build resolves to ElectronApi (IPC + better-sqlite3),
// the Web build (V2) to HttpApi (fetch + Cloudflare Access). See ARCHITECTURE.md §2.2.
//
// The concrete shapes are pulled from the schema codegen output (REVIEW-LOG C-03):
// shared/types/cli.gen.ts is regenerated from docs/cli-schema/*.schema.json via
// `pnpm gen:types`. When the backend bumps a schema, the unit tests in
// Sprint 1.8 fail loudly via ajv against the same source-of-truth.
//
// Sub-types in cli.gen.ts are prefixed (`EmailList_EmailListItem` etc.) to
// avoid cross-schema name collisions — we re-export the friendly aliases here
// so components write `EmailMeta` instead of the schema-slug verbosity.

import type {
  EmailList_EmailListItem,
  EmailGet_EmailRecord,
  EmailSearch_SearchHit,
  AttachmentList_AttachmentItem,
  MailagentEmailBody,
  MailagentEmailResync
} from '@shared/types/cli.gen'

export type EmailMeta = EmailList_EmailListItem
/**
 * EmailDetail = schema-typed EmailGet_EmailRecord + the fields the Electron
 * main handler returns that the cli-schema codegen doesn't yet expose.
 * Sprint 14 should fold these into email-get.schema.json + `pnpm gen:types`.
 *
 *   - `is_important` — v9 RFC-header importance bit, written by
 *     `reader._parse_importance` and surfaced verbatim by
 *     `handlers/email.ts:520` (asBool of the SQLite column).
 */
export type EmailDetail = EmailGet_EmailRecord & {
  is_important?: boolean
}
export type EmailBody = NonNullable<MailagentEmailBody['data']>
export type SearchHit = EmailSearch_SearchHit
export type AttachmentMeta = AttachmentList_AttachmentItem
export type ResyncResult = MailagentEmailResync['data']

/**
 * Search-module 1:1 mockup-search.html — IPC wrapper around `SearchHit[]`.
 *
 * The palette footer needs the FTS5 indexed-row total to render
 * "N of total_indexed" (mockup-search.html line 798). Returning it inline
 * with the hits keeps the palette to a single IPC roundtrip per keystroke
 * (debounce 250ms × ~4ms each = effectively free).
 *
 * Both fields are required; an empty query still returns `items: []` plus
 * the cached `total_indexed`.
 *
 * PR-2a: 当 smart mode 改写了 query (CJK-aware FTS5 transform) 时,
 * transformed_query 含实际打给 FTS5 的 query, UI 可显示 "your query
 * '产品' was expanded to ..." 提示. 跟原 query 一样时省略.
 */
export interface SearchResult {
  items: SearchHit[]
  total_indexed: number
  transformed_query?: string
  mode?: 'smart' | 'raw'
}

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

export interface EnrichedEmailMeta extends EmailList_EmailListItem {
  /** First ~100 chars of `email_body.body_markdown`. Sprint 19: listEnriched
   *  no longer reads the body blob (perf — 800-row blob read froze the sync
   *  main process ~1.5s); this arrives as `null` and is filled lazily for
   *  visible rows via `listSnippets`. */
  snippet: string | null
  /** Sprint 19 — does a body row exist (cheap PK join, no blob read). Drives
   *  EmailList row height so it stays stable before the lazy snippet lands. */
  has_body: boolean
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
}

export interface BodyOpts {
  format?: 'markdown' | 'html' | 'raw'
}

export interface SearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
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

export interface ComposeDraftOpts {
  internalId: number
  mode: ComposeMode
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  bodyHtml?: string
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
  /** Default true. Mail-sync is always online in production, so the CLI's
   *  pm2 conflict check must be bypassed. */
  allowConcurrent?: boolean
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
  /** Sprint 19 — batch body-snippet fetch for visible list rows. listEnriched
   *  dropped the body-blob read for perf; the renderer lazily fetches snippets
   *  for the ~15-40 rows actually on screen. Returns {internal_id: snippet};
   *  ids with no body / empty snippet are absent from the map. */
  listSnippets(internalIds: number[]): Promise<Record<number, string>>
  get(internalId: number): Promise<EmailDetail | null>
  body(internalId: number, opts?: BodyOpts): Promise<EmailBody | null>
  /** Sprint 2 — joined LLM labels + processing_status for <AIFieldsBlock>. */
  aiFields(internalId: number): Promise<AIFields | null>
  /**
   * Search-module 1:1 mockup-search.html — returns wrapped
   * `{ items, total_indexed }` so the palette footer can render
   * "N of total_indexed" without a second IPC roundtrip.
   */
  search(opts: SearchOpts): Promise<SearchResult>
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
  /** Compose — write a reply/reply-all/forward draft into Drafts (IMAP
   *  APPEND via `mailagent email draft`). Returns the CLI `data` block
   *  (drafts_folder / appended_uid / method / …). Throws Error & { code }
   *  on failure (E_AUTH / E_INVALID_ARG / E_DISPATCH …). */
  draft(opts: ComposeDraftOpts): Promise<unknown>
  /** Compose — SMTP real send (irreversible) via `mailagent email send`.
   *  The IPC handler always passes `--yes`; the renderer must show its own
   *  SendConfirmDialog before calling. Throws Error & { code } on failure. */
  send(opts: SendEmailOpts): Promise<unknown>
  /** Compose — `email draft --dry-run` plan used to pre-fill the composer
   *  (recipients / subject / body HTML). Read-only, no auth. Throws
   *  Error & { code } on failure. */
  draftPlan(opts: DraftPlanOpts): Promise<DraftPlanResult>
  /** v8 — set pinned (true) / unpinned (false) via the `mailagent email
   *  pin/unpin` CLI. Returns the new state, or null on E_NOT_FOUND. The
   *  renderer's optimistic store reconciles against the next
   *  listPinnedIds refetch. */
  pin(internalId: number, pinned: boolean): Promise<boolean | null>
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
}

// ---- D2b — async_jobs 长任务子系统 (C1 后端 POST /api/jobs + GET /api/jobs/{id}) --
//
// batch resync (选中多封重传 Notion) 走 async_jobs: enqueue 立即返 job_id
// (queued), serve 进程 JobWorker 串行执行, 进度经 SSE job.* + GET 轮询。前端经
// daemon_api.daemonRequest (Electron) / http_client (web SPA) 起任务 + 查进度;
// 进度展示 + 终态 toast 由 shared/state/resyncJob.ts::watchResyncJob 编排。

/** async_jobs.job_type — 与后端 src/sync/job_runners.py JOB_TYPES 对齐。 */
export type JobType = 'resync' | 'backfill_body' | 'backfill_derivatives' | 'backfill_metadata'

/** async_jobs.status 状态机 (queued → running → 终态)。 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial_failure'
  | 'failed'
  | 'aborted'

/** POST /api/jobs 的 data — enqueue 结果 (立即返回, status 恒 'queued')。 */
export interface JobEnqueueResult {
  job_id: number
  status: 'queued'
  /** false ⇒ 命中既有 idempotencyKey (弱网重发去重, 返既有 job)。batch resync
   *  不传 idempotencyKey, 故恒 true。 */
  was_created: boolean
  job_type: string
  target_kind: string
  target_key: string
}

/** GET /api/jobs/{id} 的 data — 镜像后端 async_jobs 行 (jobs.py::_job_to_dict)。 */
export interface JobRecord {
  job_id: number
  job_type: string
  target_kind: string
  target_key: string
  status: JobStatus
  progress_done: number
  progress_total: number
  checkpoint_internal_id: number | null
  /** 终态 summary (LongTaskSummary.as_dict: total/succeeded/failed/skipped/…);
   *  非终态为 null。 */
  result: Record<string, unknown> | null
  last_error: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}

export interface JobsApi {
  /** 查 job 状态 / 进度 / 终态 summary (轮询兜底: SSE 断线 / web 无 SSE 时拿终态)。
   *  E_NOT_FOUND 抛 Error & {code}。 */
  get(jobId: number): Promise<JobRecord>
}

// ---- 多文件夹同步 (P3) — discover + whitelist (davmail-only) ----------------
//
// serve-api `GET /api/folder/discover` / `GET|PUT /api/folder/whitelist` 的 wire
// 形状 (src/api/routers/folder.py + src/mail/backend/imap_client.FolderInfo)。
// 白名单存 IMAP 原始名 (modified-UTF7 ASCII, 可能含逗号如 `&W,mL3VOGU,KLsF9V-`);
// display_name 是解码后中文, 仅展示。勾选用 imap_name 作 key, 展示用 display_name。
// 远程 (HttpApi 直连) + 本地 (Electron→daemon→serve-api 转发) 同一 wire。

/** 单个 Exchange 文件夹 (LIST → FolderInfo)。flat 列表带 `is_synced`; tree 节点
 *  额外带 `children` 但不带 `is_synced` (后端 build_folder_tree 用 bare to_dict)。 */
export interface FolderInfo {
  imap_name: string
  display_name: string
  delimiter: string
  special_use: string | null
  is_system: boolean
  has_children: boolean
  parent: string | null
  message_count: number | null
  /** 仅 discover 的 flat 列表带此字段 (= imap_name ∈ 当前白名单)。 */
  is_synced?: boolean
}

/** 嵌套树节点 = FolderInfo + children。 */
export interface FolderTreeNode extends FolderInfo {
  children: FolderTreeNode[]
}

export interface FolderDiscoverResult {
  folders: FolderInfo[]
  tree: FolderTreeNode[]
  /** 当前已同步的 imap_name 列表 (= SYNC_FOLDERS 白名单, 已排序)。 */
  whitelist: string[]
}

export interface FolderWhitelistResult {
  folders: string[]
}

export interface FolderSetWhitelistResult {
  folders: string[]
  restart_required: boolean
}

// 多文件夹同步 (P4) — 文件夹管理 (新建/重命名/删除)。serve-api
// `POST|PATCH|DELETE /api/folder/manage` 的 wire (davmail-only, 回写真实 Exchange
// + 本地副本)。失败时后端把本地树回滚到服务器真实状态, 前端 refetch discover。
export interface FolderManageResult {
  /** 操作影响后的 imap_name (新建 = 新文件夹名; 重命名 = 新名; 删除 = 已删名)。 */
  imap_name: string
  /** 删除/重命名牵动了白名单时为 true → 前端标记需重启同步服务。 */
  restart_required?: boolean
}

// 多文件夹同步 (P5) — 本地副本清理。serve-api `POST /api/folder/cleanup`
// body `{imap_name}` → 仅删本地已同步邮件 (email_metadata 级联 body/附件/FTS +
// 从白名单移除)。**不碰 Exchange 文件夹/邮件**, 非 davmail 也可 (纯本地操作)。
export interface FolderCleanupResult {
  /** 被清理的文件夹 imap_name。 */
  imap_name: string
  /** 实际删除的本地行数。 */
  affected_local_rows: number
  /** true → 白名单已变动, 需重启同步服务。 */
  restart_required: boolean
}

export interface FolderApi {
  // 多文件夹同步 (P3, davmail-only). discover 走 serve-api (IMAP LIST); 本地经
  // daemon 转发, 远程 HttpApi 直连。非 davmail 后端 serve-api 返回 400
  // E_INVALID_ARG → 抛带 code 的 Error (前端据此 gate)。
  discover(opts?: { counts?: boolean }): Promise<FolderDiscoverResult>
  getWhitelist(): Promise<FolderWhitelistResult>
  /** 覆盖式保存白名单 (imap 原始名)。返回去重排序后的列表 + restart_required。 */
  setWhitelist(imapNames: string[]): Promise<FolderSetWhitelistResult>
  // 文件夹管理 (P4, davmail-only). serve-api POST/PATCH/DELETE /api/folder/manage,
  // 回写真实 Exchange (新建 IMAP CREATE / 重命名 RENAME / 删除 DELETE + 清本地副本)。
  // 失败抛带 `code` 的 Error (本地树由后端回滚到服务器真实状态, 前端 refetch discover)。
  /** 在 parentImapName 下新建子文件夹 name (顶层 = parentImapName 传 null)。 */
  createFolder(parentImapName: string | null, name: string): Promise<FolderManageResult>
  /** 重命名 imapName → newName (叶子名, 后端拼父路径)。 */
  renameFolder(imapName: string, newName: string): Promise<FolderManageResult>
  /** 删除 imapName (含 Exchange 文件夹 + 本地已同步副本, 不可撤销)。 */
  deleteFolder(imapName: string): Promise<FolderManageResult>
  // 本地副本清理 (P5) — 仅删本地已同步邮件, 不碰 Exchange (非 davmail 也可)。
  /** 清理 imapName 对应的本地已同步邮件副本 + 从白名单移除; **不操作 Exchange**。 */
  cleanup(imapName: string): Promise<FolderCleanupResult>
}

// ---- Sprint 6 §2.2 — LLM dashboard surface --------------------------------

export interface LlmStatsData {
  total: number
  by_status: Record<string, number>
  days: number
  since_ts: number
  cost: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    cache_hit_rate_pct: number
    avg_latency_ms: number
    success_rows: number
  }
}

export interface LlmSelfTestData {
  healthy: boolean
  detail?: string
  latency_ms?: number
}

/** dynamic-models — serve-api GET /api/llm/models response. */
export interface LlmUpstreamModelsData {
  models: string[]
  cached: boolean
  cached_at: number | null
  error?: string
}

export interface LlmApi {
  /** Sprint 5 — re-run AI classification for one email via `mailagent llm run`. */
  run(internalId: number, opts?: LlmRunOpts): Promise<unknown>
  /** Sprint 6 — aggregate stats for the LLM dashboard (cost / cache hit / latency). */
  stats(days?: number): Promise<LlmStatsData>
  /** Sprint 6 — no-token health probe for the LLM gateway. */
  selftest(): Promise<LlmSelfTestData>
  /** dynamic-models — fetch upstream model list (GET /api/llm/models).
   *  Pass refresh=true to bypass the server-side 5-min TTL cache.
   *  Pass provider='translate' to fetch from the translation provider instead of
   *  the main LLM gateway (falls back to main if LLM_TRANSLATE_BASE_URL is unset). */
  listUpstreamModels(opts?: {
    refresh?: boolean
    provider?: 'main' | 'translate'
  }): Promise<LlmUpstreamModelsData>
}

// ---- Sprint 6 §2.2 — admin dashboard surface ------------------------------

export interface AdminHealthData {
  db_path: string
  db_accessible: boolean
  db_version: number
  db_version_expected: number
  schema_ok: boolean
  tables_present: string[]
  tables_missing: string[]
  healthy: boolean
}

export interface AdminStatsData {
  watcher?: Record<string, unknown>
  sync_store?: {
    total_emails: number
    by_status: Record<string, number>
    by_mailbox: Record<string, number>
    failure_queue: number
    last_max_row_id: number | null
    last_sync_time: string | null
    db_size_mb: number
    db_size_bytes: number
    _source?: string
  }
  handlers?: Record<string, unknown>
  v4_rollout?: {
    from_sqlite_hit: number
    fallback_miss: number
    fallback_error: number
    route_latency_p99_ms: number
    body_miss_internal_ids: number[]
    window_seconds: number
    _staleness_seconds?: number
    _source?: string
  }
}

export interface DeadLetterItem {
  internal_id: number
  mailbox: string | null
  subject: string | null
  sender: string | null
  date_received: string | null
  retry_count: number
  sync_status: string
  sync_error: string | null
  updated_at: string | null
}

export interface DeadLetterListOpts {
  limit?: number
  mailbox?: string
}

export interface CleanupDeadLetterOpts {
  olderThan?: number
  dryRun?: boolean
}

// ── DavMail health snapshot (roadmap §4.5.1-3) — frontend reads sync_state
// davmail.* keys via direct better-sqlite3 (no CLI fork) every 5s for the
// red-dot badge + AdminPage card. Source-of-truth: DavMailWatchdog writes
// these keys every 60s.
export interface DavMailHealthData {
  /** False when mail-sync isn't in davmail mode (no watchdog ticks yet). */
  enabled: boolean
  level: 'ok' | 'warning' | 'critical' | 'unknown'
  last_probe_at: string | null
  imap_reachable: boolean
  smtp_reachable: boolean
  consecutive_imap_failures: number
  consecutive_smtp_failures: number
  /** Days since token.dat mtime. Null when token.dat missing. */
  token_age_days: number | null
  token_mtime_iso: string | null
  /** Count of EWSThrottlingException headers in last 5 min log tail. */
  throttle_events_5min: number
  last_oauth_error: string | null
  last_oauth_error_at: string | null
  /** Watchdog auto-pauses uid-mapper when throttling >= 3 in 5min. */
  uid_backfill_paused: boolean
}

export interface SystemAlertItem {
  level: 'critical' | 'warning' | 'info'
  source: string
  title: string
  message: string
  ts: string | null
}

export interface SystemAlertsData {
  alerts: SystemAlertItem[]
  critical_count: number
  warning_count: number
  /** Server-side ISO timestamp; renderer uses it for tooltip "as of". */
  generated_at: string
}

export interface AdminApi {
  health(): Promise<AdminHealthData>
  stats(): Promise<AdminStatsData>
  deadLetterList(opts?: DeadLetterListOpts): Promise<DeadLetterItem[]>
  /** Re-arms a dead-letter email for retry (write+auth). Throws Error & { code }
   *  on failure exactly like the other write methods. */
  deadLetterRetry(internalId: number): Promise<unknown>
  /** Run the cleanup-deadletter command (write+auth unless dryRun). */
  cleanupDeadLetter(opts?: CleanupDeadLetterOpts): Promise<unknown>
  /** roadmap §4.5 — current davmail backend health snapshot (direct SQLite
   *  read, ~1ms). Returns enabled=false when watchdog hasn't ticked. */
  davmailHealth(): Promise<DavMailHealthData>
  /** Current active system alerts derived from davmail health + (future)
   *  other sources. Polled by SystemAlertBadge every 5s. */
  systemAlerts(): Promise<SystemAlertsData>
}

// ---- Sprint 6 §2.2 — calendar (recurring meeting) surface -----------------

export interface RecurringInviteItem {
  /** Phase 2.4 — vEvent UID (RFC 5545). Replay 按钮调 eventReplay 用这个,
   *  跟 source 无关 (任何 source 都可 replay). 等于 series_uid. */
  ical_uid: string
  /** Source email (the meeting invite carrier). Phase 1.5 caldav-only events = 0. */
  internal_id: number
  subject: string | null
  organizer: string | null
  rrule: string | null
  notion_page_id: string | null
  first_occurrence: string | null
  last_occurrence: string | null
  occurrence_count: number | null
  date_received: string | null
}

export interface RecurringDiscoverOpts {
  /** ISO date (YYYY-MM-DD). Defaults to CLI's "last 30 days" if omitted. */
  since?: string
}

export interface RecurringReplayOpts {
  internalId?: number
  ids?: number[]
  dryRun?: boolean
}

export interface CalendarExpandOpts {
  horizonWeeks?: number
  dryRun?: boolean
}

// Phase 3 §3.1 (frontend-view-silly-knuth.md) — Calendar SSoT 类型 (前端直读 SQLite
// calendar_event 表 + npm rrule 展开 occurrences). source 三态对应灰度共存:
// 'caldav' (CalendarSyncWorker 拉的) / 'email_ics' (meeting_sync 派生) /
// 'legacy_calendar_app' (老 calendar_main.py 路径).

export type CalendarEventSource = 'caldav' | 'email_ics' | 'legacy_calendar_app'

export interface CalendarEventAttendee {
  email: string
  name?: string
  /** PARTSTAT — ACCEPTED / TENTATIVE / DECLINED / NEEDS-ACTION */
  response?: string
  /** ROLE — CHAIR / REQ-PARTICIPANT / OPT-PARTICIPANT */
  role?: string
}

/** RRULE 展开后的单 occurrence (前端日历 timeline 渲染拿到的). */
export interface CalendarEventOccurrence {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  /** ISO UTC datetime — 前端 toLocaleString 转本地 TZ 展示. */
  occurrence_start_iso: string
  occurrence_end_iso: string
  /** True = 来自 RRULE 展开; False = 单次 event. */
  is_recurrence_instance: boolean
  is_all_day: boolean
  calendar_name: string
  organizer: string
  attendees: CalendarEventAttendee[]
  location: string
  url: string
  /** CONFIRMED / TENTATIVE / CANCELLED */
  status: string
  response_status: string
  source: CalendarEventSource
  notion_page_id: string | null
  related_email_internal_id: number | null
}

/** calendar_event 表完整 row (event-get 输出, 含 dtstart_iso / ics_raw 等). */
export interface CalendarEventDetail {
  id: number
  ical_uid: string
  recurrence_id: string | null
  sequence: number
  summary: string
  description: string
  location: string
  organizer: string
  attendees: CalendarEventAttendee[]
  dtstart_iso: string | null
  dtend_iso: string | null
  is_all_day: boolean
  rrule: string
  exdates: string[]
  rdates: string[]
  status: string
  response_status: string
  url: string
  calendar_name: string
  source: string
  notion_page_id: string | null
  related_email_internal_id: number | null
  ics_raw: string
}

export interface CalendarSyncStateItem {
  calendar_name: string
  ctag: string | null
  sync_token: string | null
  last_full_sync_at_iso: string | null
  last_incremental_sync_at_iso: string | null
  last_error: string | null
}

export interface EventsListOpts {
  /** Window start (ISO datetime, UTC). Default = today 00:00 UTC. */
  fromIso?: string
  /** Window end. Default = fromIso + 7 days. */
  toIso?: string
  calendarName?: string
  source?: CalendarEventSource
  /** Default true. False = only return master events (skip RRULE expansion). */
  expandRecurrences?: boolean
  /** Cap on returned occurrences. Default 1000. */
  limit?: number
}

export interface EventGetOpts {
  icalUid: string
  recurrenceId?: string | null
  source?: CalendarEventSource
}

export interface SyncNowOpts {
  /** Default true. False = try sync-collection (DavMail 支持有限). */
  full?: boolean
  calendarName?: string
}

// Phase 2.4 — replay 单 calendar_event 行到 Notion mirror (任何 source).
export interface EventReplayOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** 非空 = replay 单次跳脱 occurrence; 留空 = 主事件. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = 按 caldav → email_ics → legacy 顺序自动查. */
  source?: CalendarEventSource
  /** 仅查 row 列 plan, 不写 Notion (无需 auth). */
  dryRun?: boolean
}

// Phase 2.1 — RSVP iTIP REPLY to organizer (drawer accept/tentative/decline button).
export type RsvpResponse = 'accept' | 'tentative' | 'decline'

export interface EventRsvpOpts {
  /** vEvent UID (RFC 5545); 必填. */
  icalUid: string
  /** accept / tentative / decline. */
  response: RsvpResponse
  /** 非空 = RSVP 单次跳脱 occurrence; 留空 = 整系列 REPLY. */
  recurrenceId?: string | null
  /** 限定 source; 留空 = caldav → email_ics → legacy 自动查. */
  source?: CalendarEventSource
  /** True = 仅查 row + 拼 plan, 不发 SMTP (无需 auth). */
  dryRun?: boolean
}

// Phase 2.2/2.3 — calendar event CRUD via CalDAV PUT/DELETE.
export type EventStatusCode = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'

export interface EventAttendeeInput {
  email: string
  name?: string
}

export interface EventCreateOpts {
  summary: string
  /** ISO datetime with tz (必填); e.g. '2026-05-30T14:00:00+08:00' or 'Z' 结尾. */
  startIso: string
  endIso: string
  location?: string
  description?: string
  attendees?: EventAttendeeInput[]
  /** 目标 calendar 名; 留空 = 默认 (Outlook 主日历). */
  calendarName?: string
  status?: EventStatusCode
  /** Phase 4·#3 — RFC 5545 RRULE (不含 'RRULE:' 前缀); 留空 = 单次事件. */
  rrule?: string
  /** Phase 4·#2 — 全天事件; start/end 端到端用 UTC midnight Z + end exclusive. */
  isAllDay?: boolean
}

export interface EventUpdateOpts {
  icalUid: string
  /** All optional — 不传 = 保留原值. */
  summary?: string
  startIso?: string
  endIso?: string
  location?: string
  description?: string
  /** Phase 4·#4 — 替换与会者; 不传 = 保留原与会者 (含 partstat, 防退化). 清空用 clearAttendees. */
  attendees?: EventAttendeeInput[]
  /** Phase 4·#4 — 显式清空所有与会者 (前端删光 chips); 与 attendees 互斥. */
  clearAttendees?: boolean
  status?: EventStatusCode
  calendarName?: string
  /** Phase 4·#3 — 改整系列 RRULE: 不传=保留原值; 'FREQ=...' 覆盖; '' 删除(周期→单次). */
  rrule?: string
  /** Phase 4·#2 — 全天状态: 不传=保持原状态; true=改全天; false=改定时. */
  isAllDay?: boolean
  /** Phase 4·#3c — 改这一次 occurrence (ISO datetime = 该次原始 dtstart);
   *  留空 = 改整系列. 传了走 detached occurrence (RECURRENCE-ID override). */
  recurrenceId?: string
  /** Phase 4·#3d — 改未来: 配合 recurrenceId, 从该次起 split 成新 series. */
  splitFuture?: boolean
  /** 默认 SEQUENCE +1 (RFC 5545 标准). */
  noSequenceBump?: boolean
}

export interface EventDeleteOpts {
  icalUid: string
  calendarName?: string
}

export interface CalendarApi {
  recurringDiscover(opts?: RecurringDiscoverOpts): Promise<RecurringInviteItem[]>
  recurringReplay(opts: RecurringReplayOpts): Promise<unknown>
  expand(opts?: CalendarExpandOpts): Promise<unknown>

  // Phase 3 §3.1 — Calendar SSoT 直读
  eventsList(opts?: EventsListOpts): Promise<CalendarEventOccurrence[]>
  eventGet(opts: EventGetOpts): Promise<CalendarEventDetail | null>
  syncStatus(): Promise<CalendarSyncStateItem[]>
  calendarNames(): Promise<string[]>
  syncTrigger(opts?: SyncNowOpts): Promise<unknown>

  // Phase 2.4 — 重导出 calendar_event 行到 Notion (any source)
  eventReplay(opts: EventReplayOpts): Promise<unknown>

  // Phase 2.1 — 发 iTIP REPLY 给 organizer (accept/tentative/decline)
  eventRsvp(opts: EventRsvpOpts): Promise<unknown>

  // Phase 2.2/2.3 — CalDAV PUT/DELETE (create / update / delete event)
  eventCreate(opts: EventCreateOpts): Promise<unknown>
  eventUpdate(opts: EventUpdateOpts): Promise<unknown>
  eventDelete(opts: EventDeleteOpts): Promise<unknown>
}

// ---- Sprint 6 §2.2 — SettingsPage surface --------------------------------

export type SecretSlot = 'cliApiKey' | 'llmApiKey' | 'llmTranslateApiKey' | 'customApiKey'

export interface SecretsStatus {
  cliApiKey: boolean
  llmApiKey: boolean
  llmTranslateApiKey: boolean
  customApiKey: boolean
}

export interface PersistentSettings {
  dbPath: string | null
  attachmentDir: string | null
  pollIntervalSec: 5 | 10 | 30 | 0
  notionAgentPageId: string | null
  notionAgentName: string | null
  customApiEndpoint: string | null
  /** feat/auto-update — auto-download an available update when the master
   *  AUTO_UPDATE_ENABLED flag is on. Default true; IslandUpdatesTab toggles it. */
  autoDownloadUpdates: boolean
  /** Owner's email — sourced from repo-root `.env` USER_EMAIL on every
   *  settings:get read. Read-only; the renderer doesn't write this. */
  userEmail: string | null
}

export interface PingResult {
  ok: boolean
  detail?: string
  code?: string
}

export interface SettingsApi {
  /** Returns booleans only — the secret values never leave keytar. */
  secretsStatus(): Promise<SecretsStatus>
  /** Empty string clears the slot; otherwise stores in keytar. */
  setSecret(slot: SecretSlot, value: string): Promise<SecretsStatus>
  clearSecret(slot: SecretSlot): Promise<SecretsStatus>
  get(): Promise<PersistentSettings>
  set(partial: Partial<PersistentSettings>): Promise<PersistentSettings>
  /** Native folder picker. Returns absolute path or null on cancel. */
  pickFolder(title?: string): Promise<string | null>
  /** Pings the LLM gateway via `mailagent llm selftest`. */
  testLlm(): Promise<PingResult>
  /** Soft check: confirms custom-api-key + endpoint configured. */
  testCustomApi(): Promise<PingResult>
}

export interface NotionWriteApi {
  /** Sprint 5 — push read/flagged/processing_status to the Notion mail page. */
  updateFlag(internalId: number, opts: UpdateFlagOpts): Promise<unknown>
}

export interface AttachmentApi {
  list(internalId: number): Promise<AttachmentMeta[]>
  /** Returns a `file://`-safe local absolute path, or null if the attachment
   *  hasn't been persisted to disk (e.g. inline images that live only in MIME). */
  localPath(attachmentId: number): Promise<string | null>
  /** Sprint 13 — same content as `localPath` but inlined as a
   *  `data:<mime>;base64,...` URL. The sandboxed body iframe can't load
   *  `file://` URLs (same-origin policy under srcdoc) so inline images
   *  (cid: refs) substitute the data URL instead. Returns null when
   *  the file is missing or the read fails. */
  readDataUrl(attachmentId: number): Promise<string | null>
  /** Copy the on-disk attachment into the user's ~/Downloads, returning the
   *  final absolute path. Collides safely (appends `_1`, `_2`, …). Returns
   *  null when the row has no on-disk content or the source file is missing.
   *  Renderer cannot open `file://` URLs from the dev-server origin, so this
   *  exists as the user-visible "download attachment" affordance. */
  download(attachmentId: number): Promise<string | null>
}

// ---- Immersive translate (DB v12) ------------------------------------------
//
// 翻译路径双轨制：
//   - Path A (LLM 分类顺带): src/llm_agent/runner.py 在 LLM 分类时同步返回
//     translation_segments, 写 email_translation 表 (source='llm_agent').
//   - Path B (用户按 "翻译"): translateBatch IPC, html-extractor 抽块级 →
//     pLimit(2) batches of 10 → 写 email_translation 表 (source='on_demand').
//
// Renderer 不在乎是哪条路径写的, 拿到 segments 后让 EmailBodyFrame 通过
// iframe.contentDocument 用 textContent.includes(src) fuzzy 配对 DOM 节点
// 注入译文。

export type TargetLang = 'zh' | 'en'

export interface TranslationSegment {
  /** Source paragraph plaintext, verbatim substring of the email body
   *  paragraph. Used to fuzzy-match DOM nodes in the iframe via
   *  `textContent.includes(src)`. */
  src: string
  /** Translation of the segment (Simplified Chinese, mainland usage). */
  tgt: string
}

/** Cached translation envelope (returned by AiApi.getCached and AiApi.translateBatch). */
export interface TranslationCache {
  internalId: number
  targetLang: TargetLang
  segments: TranslationSegment[]
  /** Provenance — 'llm_agent' (Path A) | 'on_demand' (Path B). null on
   *  ad-hoc results before they're persisted. */
  source: string | null
  /** Model that produced the translation; empty string if empty cache. */
  model: string | null
  /** Unix seconds when the cache row was written; null for un-persisted result. */
  fetchedAt: number | null
}

/** Result of translateBatch — TranslationCache + batch run statistics. */
export interface TranslateBatchResult extends TranslationCache {
  latencyMs: number
  /** Number of batches that failed (LLM error / JSON parse / abort). When 0,
   *  the translation is complete. Renderer shows a partial-failure banner
   *  when this is > 0 but segments.length > 0. */
  failedBatches: number
  totalBatches: number
}

export interface AiApi {
  /**
   * Run an on-demand batch translation of an email's body (Path B). Extracts
   * block-level paragraphs from body_html in the main process, batches them
   * (10 per request, 2 concurrent), calls the LLM gateway, and writes the
   * result to email_translation (DB v12). Returns the full TranslateBatchResult
   * including failedBatches for partial-failure UX.
   *
   * API key + endpoint stay in the main process (REVIEW-LOG C-04). Errors
   * carry `code`: E_NO_BODY / E_NO_LLM_KEY / E_INVALID_ARG / E_UPSTREAM.
   */
  translateBatch(internalId: number, targetLang?: TargetLang): Promise<TranslateBatchResult>
  /** Read cached translation segments from email_translation table. Returns
   *  null on cache miss. Used to render the immersive translation on email
   *  open without re-running the LLM. */
  getCached(internalId: number, targetLang?: TargetLang): Promise<TranslationCache | null>
  /** Delete the cached translation row. Renderer fires this before
   *  re-translation so the new run overwrites cleanly. */
  deleteCached(internalId: number, targetLang?: TargetLang): Promise<boolean>
  /** Abort all in-flight batches for `internalId`. Renderer fires this when
   *  switching emails so stale batches don't keep CRS slots wedged. */
  abortTranslate(internalId: number): void
}

// ---- Sprint 4 §2.1 — AI Chat surface ------------------------------------
//
// These types mirror the main-process `chat_db.ts` + `chat/types.ts`
// shapes. They are duplicated (not imported) because the renderer must
// not import from `src/electron/main/**` — that would pull in
// better-sqlite3 + node:fs into the browser bundle. The IPC boundary is
// the seam; types align by hand and are guarded by the schema-ish unit
// tests in `tests/main/chat_db.test.ts` + `tests/components/useEmailChat.test.tsx`.

export type ChatBackendKind = 'notion-agent' | 'custom-api'
export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type ChatMessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'aborted'

export interface ChatMessage {
  id: number
  session_id: number
  role: ChatMessageRole
  content: string
  tokens_input: number | null
  tokens_output: number | null
  cost_usd: number | null
  model: string | null
  status: ChatMessageStatus
  error_message: string | null
  /** JSON-encoded backend-specific extras (e.g. notion_agent thread_id).
   *  Renderer treats it as opaque — only the backend that wrote it knows
   *  how to read it. See ai_chat.db schema_version 2 (Sprint 4 opus L). */
  metadata: string | null
  /** task 06-08-chat 需求 5 — Claude extended-thinking summary. Rendered in a
   *  collapsible block above the answer; null for non-thinking turns + pre-v6
   *  rows. Mirror of ai_chat.db schema_version 6 (model.ts ChatMessage). */
  thinking: string | null
  created_at: number
  updated_at: number
}

export interface ChatSession {
  id: number
  email_id: number
  backend_kind: ChatBackendKind
  backend_model: string | null
  backend_agent_page_id: string | null
  created_at: number
  updated_at: number
}

// Row of the global "AI 会话历史" page (chat.listAllSessions). A ChatSession
// enriched with an aggregated first-user-message preview + message count
// (from ai_chat.db) and the owning email's subject/sender (joined from
// sync_store.db by handlers/chat.ts). Mirror of ChatSessionListItem in
// `src/electron/main/handlers/chat.ts`; kept in sync by hand across the IPC
// seam like ChatSession / ChatMessage above.
export interface ChatSessionListItem extends ChatSession {
  first_user_message: string | null
  message_count: number
  email_subject: string | null
  email_sender: string | null
}

// Sprint 19 §D #3 — chat_tool_call audit row, mirrored from main-side
// `src/electron/main/chat_db.ts` so the renderer can type the ChatApi
// listToolCalls() result without crossing the main-process import line.
// Keep the two definitions in sync; payload is plain JSON (better-sqlite3
// → IPC structured-clone).
export type ChatToolCallStatus = 'pending' | 'confirmed' | 'running' | 'ok' | 'error' | 'canceled'
export type ChatConfirmationTier = 'silent' | 'preview' | 'edit'

export interface ChatToolCall {
  id: number
  message_id: number
  tool_use_id: string
  tool_name: string
  /** Original LLM-proposed input JSON. */
  input_json: string
  /** Set only when the user edited the input via ConfirmToolDialog
   *  (confirmation_tier='edit'); null otherwise. */
  user_edited_input_json: string | null
  /** Tool handler's ToolResult serialized; null until the tool completes. */
  output_json: string | null
  status: ChatToolCallStatus
  duration_ms: number | null
  confirmation_tier: ChatConfirmationTier
  confirmed_at: number | null
  /** task 06-08-chat Bug 2 — char offset into the parent assistant message's
   *  `content` where this tool call was proposed; the renderer splits `content`
   *  at these offsets to interleave tool chips in time order. Null for v4 rows
   *  → renderer falls back to "all chips after the body". */
  content_offset: number | null
  created_at: number
  updated_at: number
}

export interface ChatChunkEvent {
  type: 'chunk'
  delta: string
}
/** task 06-08-chat 需求 5 — extended-thinking delta. Mirror of chat/types
 *  ThinkingEvent across the IPC/emitter seam. Carries the model's reasoning
 *  summary increment (rendered in a collapsible block, kept out of `content`). */
export interface ChatThinkingEvent {
  type: 'thinking'
  delta: string
}
export interface ChatToolCallEvent {
  type: 'tool_call'
  name: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  detail?: string
}
/** Sprint 19 — LLM proposes a tool call inside the agent harness loop.
 *  Mirror of main-process ToolUseEvent (chat/types.ts). */
export interface ChatToolUseEvent {
  type: 'tool_use'
  toolUseId: string
  name: string
  input: unknown
}
/** Sprint 19 — Tool execution finished (or was canceled by the user).
 *  Mirror of main-process ToolResultEvent. */
export interface ChatToolResultEvent {
  type: 'tool_result'
  toolUseId: string
  status: 'ok' | 'error' | 'canceled'
  output?: unknown
  errorMessage?: string
  durationMs: number
}
/** Sprint 19 — Harness needs user confirmation before running a write tool.
 *  Renderer pops ConfirmToolDialog; user click → chat:confirmTool IPC. */
export interface ChatPendingConfirmationEvent {
  type: 'pending_confirmation'
  toolUseId: string
  toolName: string
  input: unknown
  preview?: string
  tier: 'preview' | 'edit'
}
export interface ChatUsageEvent {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  model: string | null
  metadata?: Record<string, unknown> | null
}
export interface ChatDoneEvent {
  type: 'done'
  finalContent: string
  model: string | null
  /** Sprint 19 — Anthropic stop_reason carried to the renderer. Optional
   *  for backends that don't emit it (notion-agent CLI). */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  metadata?: Record<string, unknown> | null
}
export interface ChatErrorEvent {
  type: 'error'
  code: string
  message: string
}

export type ChatStreamEvent =
  | ChatChunkEvent
  | ChatThinkingEvent
  | ChatToolCallEvent
  | ChatToolUseEvent
  | ChatToolResultEvent
  | ChatPendingConfirmationEvent
  | ChatUsageEvent
  | ChatDoneEvent
  | ChatErrorEvent

export interface ChatStreamEnvelope {
  sessionId: number
  messageId: number
  event: ChatStreamEvent
}

export interface ChatStartOpts {
  emailId: number
  message: string
  backendKind: ChatBackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
  /** Sprint 19 — explicit target session row. When provided, dispatcher
   *  uses `getSession(sessionId)` (must exist + match emailId) instead of
   *  running `getOrCreateSession(email + backend + agent_page_id)`. The
   *  renderer threads `activeSessionIdRef.current` here after
   *  `chat.newSession()` so the next message lands in the freshly-created
   *  row, not the latest pre-existing one. `null` / undefined keeps the
   *  legacy "find or create the latest session for this email" behaviour. */
  sessionId?: number | null
  /** task 06-08-chat 需求 5 — per-turn extended-thinking toggle. When true, the
   *  custom-api Anthropic path streams the model's reasoning summary into a
   *  collapsible block + (MVP) drops tools for this turn. Undefined/false →
   *  today's behaviour. Ignored by notion-agent + OpenAI-protocol models. */
  thinking?: boolean
}

// Sprint 14 PR B — inline message edit. The renderer sends the session +
// the user-message id being edited + the replacement content + the same
// backend choice fields chat.start uses (model can change between edits).
// Backend truncates everything from `editingMessageId` onward, appends a
// fresh user row with `newContent`, and re-streams the assistant turn.
export interface ChatEditOpts {
  sessionId: number
  editingMessageId: number
  newContent: string
  backendKind: ChatBackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
  /** task 06-08-chat 需求 5 — per-turn extended-thinking toggle (parity with
   *  ChatStartOpts). Applies to the re-streamed assistant reply. */
  thinking?: boolean
}

export interface ChatStartResult {
  sessionId: number
  userMessageId: number
  assistantMessageId: number
}

export interface ChatApi {
  /**
   * Open or reuse the (emailId, backendKind, agentPageId) session, append
   * the user message, kick the backend stream, and return ids the
   * renderer needs to render an empty assistant bubble. Throws
   * `Error & { code }` on dispatch failure (E_INVALID_ARG /
   * E_BACKEND_UNAVAILABLE / E_DISPATCH).
   */
  start(opts: ChatStartOpts): Promise<ChatStartResult>
  /** Fire-and-forget renderer-side cancel. Safe to call when nothing is
   *  in flight. */
  abort(sessionId: number): void
  listMessages(sessionId: number): Promise<ChatMessage[]>
  listSessions(emailId: number): Promise<ChatSession[]>
  /**
   * Global cross-email session history for the "AI 会话历史" page. Returns
   * newest-first rows enriched with a first-user-message preview, message
   * count, and the owning email's subject/sender (best-effort — null when
   * sync_store.db is unavailable). Read-only; never throws (degrades to []).
   */
  listAllSessions(): Promise<ChatSessionListItem[]>
  /**
   * Sprint 14 PR B — truncate session messages from `editingMessageId`
   * onward, append a new user message with `newContent`, and re-stream
   * the assistant reply. Throws `Error & { code }` on dispatch failure
   * (E_INVALID_ARG / E_NOT_FOUND / E_BACKEND_UNAVAILABLE / E_DISPATCH).
   * Only user-role messages can be edited.
   */
  editMessage(opts: ChatEditOpts): Promise<ChatStartResult>
  /**
   * Sprint 14 PR E — spawn a dedicated popout window pinned to the
   * given email's AI chat. Fire-and-forget: the new window shows
   * itself; no resolved promise. Same ai_chat.db backing store as the
   * main inbox panel, so flipping between the two windows is
   * transparent (WAL + busy_timeout already configured in chat_db.ts).
   */
  openPopout(emailId: number): void
  /**
   * Sprint 14 PR J — delete a session + its message rows (CASCADE).
   * Fire-and-forget; caller (useEmailChat.deleteSession) updates
   * renderer state synchronously after dispatching.
   */
  deleteSession(sessionId: number): void
  /**
   * Sprint 19 — INSERT a fresh ai_chat_sessions row, bypassing the
   * (email_id, backend_kind, backend_agent_page_id) reuse lookup. Used by
   * useEmailChat.send() when the user clicked "+ 新建会话" before this
   * turn — without this the next dispatcher.startChat() would resurrect
   * the latest pre-existing session row via getOrCreateSession.
   *
   * Schema v4 dropped the UNIQUE on (email_id, backend_kind,
   * backend_agent_page_id) so this INSERT always creates a brand-new row.
   *
   * Throws `Error & { code }` on dispatch failure (E_INVALID_ARG /
   * E_DISPATCH). Caller can fall through to a regular send() on failure;
   * the legacy resurrection path still works as a fallback.
   */
  newSession(input: {
    emailId: number
    backendKind: ChatBackendKind
    backendModel?: string | null
    backendAgentPageId?: string | null
  }): Promise<ChatSession>
  /**
   * Sprint 19 PR-1d.2 — reply to a ConfirmToolDialog. The harness is
   * blocked on a per-toolUseId promise (main-process tools/confirmation.ts)
   * waiting for this. `approved=false` → tool result is 'canceled' (LLM
   * sees a structured "user declined"). `editedInput` is only used when
   * the dialog tier is 'edit' and the user changed the LLM proposal.
   * Returns `{ ok: false, code: 'E_NOT_PENDING' }` for late clicks after
   * the session aborted.
   */
  confirmTool(
    toolUseId: string,
    approved: boolean,
    editedInput?: unknown
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  /**
   * Sprint 19 P1-C — explicit "save this assistant turn to KOS" action.
   * Renderer wires a [✨ 保存到 KOS] button per assistant bubble; click
   * invokes this. Service builds a markdown page from (preceding user
   * message + this assistant message) + frontmatter, pushes to KOS at
   * slug `chat-history/mailagent/<email>/<session>/<message>` (D3 default per Lucien 2026-05-23 spec,
   * pending Lucien sync on gbrain namespace).
   *
   * Resolves with the final slug + KOS status + content bytes pushed.
   * Throws `Error & { code }` on E_NOT_FOUND (bad messageId) /
   * E_INVALID_ARG (non-assistant message) / E_KOS_* (KOS unreachable).
   * Renderer surfaces failures in a toast rather than auto-retrying;
   * KOS down is non-fatal — user can retry once it's back.
   */
  saveToKos(input: {
    messageId: number
    slug?: string
    title?: string
  }): Promise<{ slug: string; status: string; contentBytes: number }>
  /**
   * Sprint 19 P1-C — whether the [✨ 保存到 KOS] action is available, i.e.
   * KOS OAuth credentials (KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID +
   * KOS_OAUTH_CLIENT_SECRET) are configured in the main process. The
   * renderer can't read process.env, so the AssistantMessageFooter queries
   * this once on mount and only renders the save button when true. V2 web
   * (HttpApi) returns false — chat-save is Electron-only. Never throws.
   */
  kosAvailable(): Promise<boolean>
  /**
   * Sprint 19 §D #3 — list chat_tool_call audit rows for one assistant
   * message. Renderer ToolCallRow mounts when a message bubble renders;
   * each tool_use the LLM emitted shows up as one row (tool_name, status,
   * input/output JSON, duration). Returns chronological. Empty array when
   * the message had no tool_use blocks (legacy single-pass or no
   * harness involvement). Backed by `listToolCallsForMessage` in chat_db.ts.
   */
  listToolCalls(messageId: number): Promise<ChatToolCall[]>
  /** Subscribe to backend stream events. Returns an unsubscribe function. */
  onStream(handler: (envelope: ChatStreamEnvelope) => void): () => void
}

// ---- Sprint 9 §2.3 — Island bridge surface --------------------------------
//
// Status state machine mirrors `src/electron/main/island/probe.ts`:
//   idle          → fresh boot, no probe attempted yet (first 100ms)
//   connected     → /tmp/island.sock present + last Ping accepted
//   degraded      → socket present but Ping failed (timeout / parse error)
//   disconnected  → socket file missing (ping-island.app not running)
//   dev-disabled  → `is.dev = true`, auto-probe skipped (Settings can still
//                   trigger `testConnection` manually)
//   disabled      → user toggled the integration off via Settings

export type IslandConnectionState =
  | 'idle'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'dev-disabled'
  | 'disabled'

export interface IslandStatus {
  state: IslandConnectionState
  /** Resolved unix socket path (default `/tmp/island.sock`, overridable via
   *  `ISLAND_SOCKET_PATH` env). Read-only on the renderer. */
  socketPath: string
  /** Epoch ms of the last probe attempt, or null if probe loop hasn't run. */
  lastProbeAt: number | null
  /** Free-form last error from a probe / send attempt. */
  lastError: string | null
}

export interface IslandAppearancePayload {
  accent: string
  theme: 'dark' | 'light'
  lang?: string
}

export interface IslandAIDraftStartPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** Plain-text user prompt; clipped server-side to 240 chars. */
  prompt: string
}

export interface IslandAIDraftStreamPayload {
  emailId: number
  /** Running count of streamed characters (cumulative, monotonic). */
  streamedChars: number
}

export interface IslandAIDraftReadyPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** First ~240 chars of the final draft for the island preview pill. */
  preview: string
}

export interface IslandApi {
  /** Current island connection snapshot. */
  status(): Promise<IslandStatus>
  /** Trigger an immediate probe (fs.existsSync + Ping envelope). Resolves
   *  with the post-probe status. */
  testConnection(): Promise<IslandStatus>
  /** Toggle the integration on/off from Settings. */
  setEnabled(enabled: boolean): Promise<IslandStatus>
  /** Fire-and-forget: theme/accent change → AppearanceChange envelope. */
  appearance(payload: IslandAppearancePayload): void
  /** Fire-and-forget: AI Chat composer kicked off a draft turn. */
  aiDraftStart(payload: IslandAIDraftStartPayload): void
  /** Fire-and-forget: streaming progress tick. Throttled by caller. */
  aiDraftStream(payload: IslandAIDraftStreamPayload): void
  /** Fire-and-forget: draft turn finished (status.kind=completed). */
  aiDraftReady(payload: IslandAIDraftReadyPayload): void
  /** Subscribe to status broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (status: IslandStatus) => void): () => void
}

// ---- Sprint 8 §2.2 — auto-updater surface ---------------------------------

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'dev-disabled'

export interface UpdaterStatus {
  state: UpdaterState
  /** From `app.getVersion()` (package.json at build time). */
  currentVersion: string
  latestVersion: string | null
  /** 0-100; defined only while state === 'downloading'. */
  downloadPercent: number | null
  message: string | null
  /** Epoch ms of the last state transition. */
  updatedAt: number
  /** feat/auto-update — true ONLY when (master AUTO_UPDATE_ENABLED on) AND
   *  (state !== 'dev-disabled') AND (an updater is bound). The renderer uses
   *  this to gate the proactive UpdateReadyBanner + the unsigned-build notice;
   *  false on unsigned/dev builds where updates can't actually install. */
  enabled: boolean
}

export interface UpdaterApi {
  /** Synchronous snapshot of the current status (single IPC roundtrip). */
  status(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.checkForUpdates()`. Returns the post-call status —
   *  events typically follow asynchronously so subscribe via `onEvent`. */
  check(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.downloadUpdate()` (only valid when state ===
   *  'available'). Returns the post-call status. */
  download(): Promise<UpdaterStatus>
  /** Trigger `autoUpdater.quitAndInstall(false, true)`. Quits the app, so
   *  there's nothing useful to return. */
  quitAndInstall(): Promise<void>
  /** Subscribe to status broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (status: UpdaterStatus) => void): () => void
}

// ---- Sprint 16 §SSE — events bridge surface ----------------------------

/** Sprint 16 — SSE event types. 后端 publish 点见 src/events/publisher.py
 *  + docs/sse-events.md. */
export type SseEventType =
  | 'email.synced'
  | 'email.failed'
  | 'email.dead_letter'
  | 'email.flag_changed'
  | 'outbox.enqueued'
  | 'outbox.done'
  | 'outbox.failed'
  | 'outbox.dead_letter'
  | 'llm.success'
  | 'llm.failed'
  | 'llm.gave_up'
  | 'folder.synced'

export interface SseEvent {
  event_type: SseEventType | string
  ts: number
  internal_id: number | null
  data: Record<string, unknown>
  source: string
  /** Phase C — `folder.synced` 事件携带的 folder 名 (archive | drafts). */
  folder?: string
}

export type EventsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'disabled'

export interface EventsStatus {
  state: EventsConnectionState
  lastError: string | null
  lastEventTs: number | null
  url: string
}

export interface EventsApi {
  /** Current snapshot (idempotent invoke). */
  status(): Promise<EventsStatus>
  /** 立即重连 — 清退避 / 取消当前 fetch / 启新 attempt; 返回新 status. */
  reconnect(): Promise<EventsStatus>
  /** Subscribe to incoming SSE events; returns unsubscribe fn. */
  onEvent(handler: (event: SseEvent) => void): () => void
  /** Subscribe to connection-state changes; returns unsubscribe fn. */
  onStatus(handler: (status: EventsStatus) => void): () => void
}

// ---- Sprint 18 §PR B — repo-root .env read/write + pm2 services surface --
//
// Settings tabs (PR D) read the resolved `.env` once via env:get + cache it
// in zustand; on field-blur they call env:set({KEY: value}) which atomic-
// writes the file and returns restartRequired=true. RestartBanner (PR E)
// then surfaces and calls services:restart('mail-sync').

/** Mirror of `EnvSnapshot` in `electron/main/handlers/env.ts`. SECRET keys
 *  carry only '***' (set) or '' (unset) — plaintext never crosses IPC. */
export interface EnvSnapshot {
  path: string
  exists: boolean
  values: Record<string, string>
  managedKeys: readonly string[]
  secretKeys: string[]
}

export type EnvSetResult =
  | { ok: true; path: string; changedKeys: string[]; restartRequired: boolean }
  | {
      ok: false
      path: string
      error: { code: 'E_INVALID_KEY' | 'E_NOT_FOUND' | 'E_WRITE'; message: string }
    }

export interface EnvApi {
  /** Read the resolved `.env` snapshot. Secret values redacted. */
  get(): Promise<EnvSnapshot>
  /** Merge-write keys into the resolved `.env`. `null` value comments out
   *  the line (preserves the key for future re-enable). Returns a result
   *  envelope (not an exception) so the renderer can branch on error codes
   *  without losing the `code` property through the IPC structured-clone. */
  set(patch: Record<string, string | null>): Promise<EnvSetResult>
}

export type ServiceTarget = 'mail-sync' | 'calendar-sync' | 'all' | 'serve-api'

export interface ServiceRestartResult {
  ok: boolean
  target: string
  exitCode: number | null
  stdout: string
  stderr: string
  error?: {
    code: 'E_PM2_NOT_FOUND' | 'E_PM2_FAILED' | 'E_TIMEOUT' | 'E_INVALID_ARG'
    message: string
    /** Set on E_PM2_NOT_FOUND so the renderer toast can quote the exact
     *  terminal command. */
    fallbackCommand?: string
  }
}

export interface ServiceStatus {
  name: 'mail-sync' | 'calendar-sync'
  state: 'online' | 'stopped' | 'errored' | 'unknown'
  pid: number | null
  uptimeMs: number | null
  cpu: number | null
  memMB: number | null
}

export interface ServicesApi {
  /** Spawn `pm2 restart <target>`. Default target = `mail-sync`. */
  restart(target?: ServiceTarget): Promise<ServiceRestartResult>
  /** `pm2 jlist` → both known service slots, even when pm2 doesn't list one
   *  (returns `state: 'unknown'`). */
  status(): Promise<ServiceStatus[]>
}

// ---- LLM prompt files ---------------------------------------------------

export type PromptSlot = 'inbox' | 'sent'

export interface PromptInfo {
  slot: PromptSlot
  path: string
  exists: boolean
}

export interface PromptContent extends PromptInfo {
  content: string
}

export type PromptWriteResult =
  | { ok: true; info: PromptInfo }
  | { ok: false; code: string; message: string }

export interface PromptsApi {
  /** List both prompt slots with their resolved on-disk paths. The renderer
   *  uses `exists` to decide whether to surface a "未配置 / 保存后创建" hint. */
  list(): Promise<{ inbox: PromptInfo; sent: PromptInfo }>
  /** Read one prompt's content. Missing file returns `{exists:false, content:''}`. */
  read(slot: PromptSlot): Promise<PromptContent>
  /** Write content to the resolved path; auto-mkdir parent. */
  write(slot: PromptSlot, content: string): Promise<PromptWriteResult>
}

// ── Notion Agent CLI config (notion-agent-cli) ───────────────────────────
//
// The Notion Agent chat backend shells out to the local `notion-agent` CLI,
// which keeps its own account file (~/.notionagents/notion_account.json)
// holding the token_v2 cookie + the bound Custom Agent. This surface lets
// Settings show that binding and switch the bound agent / default model;
// token auth stays with the CLI (`notion-agent init`).

export interface NotionAgentConfig {
  /** The account file path we read/write (the symlink, not its target). */
  accountPath: string
  /** Resolved `notion-agent` binary path. */
  cliPath: string
  /** Whether that binary exists on disk. */
  cliFound: boolean
  /** account.json readable AND token_v2 present → backend can run. */
  configured: boolean
  /** token_v2 is set (value never leaves the main process). */
  tokenPresent: boolean
  userName: string | null
  userEmail: string | null
  spaceName: string | null
  spaceId: string | null
  /** Bound Custom Agent display name. */
  agentName: string | null
  /** Bound Custom Agent page id (account.agent_context_page_id). */
  agentPageId: string | null
  agentAccessory: string | null
  defaultModel: string | null
  timezone: string | null
}

/** One row of `notion-agent doctor --json`. */
export interface NotionAgentDoctorCheck {
  status: string
  check: string
  detail: string
}

/** One Custom Agent from `notion-agent agents list --json`. */
export interface NotionAgentListItem {
  agent_id: string
  name: string
  agent_page_id: string
  description: string | null
  icon: string | null
  most_recent_thread_title?: string | null
}

export interface NotionAgentApi {
  /** Read account.json binding + token presence. Never throws — a
   *  missing/garbled file yields configured:false. */
  getConfig(): Promise<NotionAgentConfig>
  /** Friendly model alias keys from models.json (empty when absent). */
  listModels(): Promise<string[]>
  /** Live `doctor --json` connectivity/auth readout. Throws (err.code) on
   *  CLI failure (not-installed / produced no output). */
  doctor(): Promise<NotionAgentDoctorCheck[]>
  /** Custom Agents in the bound workspace. Throws (err.code) on failure. */
  listAgents(): Promise<NotionAgentListItem[]>
  /** Bind a Custom Agent (writes account.json). Returns refreshed config. */
  setAgent(pageId: string, name: string, accessory?: string | null): Promise<NotionAgentConfig>
  /** Set the default model alias (writes account.json). Returns refreshed config. */
  setModel(alias: string): Promise<NotionAgentConfig>
}

// ──── Report Agent (Sprint 20 — /agents 页) ────────────────────────────────
// ReportDoc 块模型契约，与 Python src/reports/models.py + docs/report-agent-
// frontend-handoff.md §5 + agents/CHANGES-vs-PRD.md §2 1:1 对齐。
// **改字段名必须同步改后端 models.py + handoff 文档**。

export type ReportTone = 'neutral' | 'info' | 'success' | 'warn' | 'critical'
export type ReportCadence = 'daily' | 'weekly' | 'monthly'
export type ReportStatus = 'generating' | 'ready' | 'empty' | 'failed' | 'skipped'

export interface ReportHeaderBlock {
  type: 'header'
  title: string
  subtitle?: string
  date_label?: string
}
export interface ReportOverviewBlock {
  type: 'overview'
  text: string
}
export interface ReportStat {
  key: string
  label: string
  value: number
  tone: ReportTone
}
export interface ReportStatRowBlock {
  type: 'stat_row'
  stats: ReportStat[]
}
export interface ReportSectionBlock {
  type: 'section'
  id: string
  title: string
  icon?: string
  intro?: string
  /** CHANGES-vs-PRD §2 — 本组整体汇总（含 [文本](#email-<id>) 跳转 + **bold**）。 */
  summary?: string
}
export interface ReportEmailSource {
  notion_url: string | null
  app_deeplink: string
}
export interface ReportEmailItemBlock {
  type: 'email_item'
  internal_id: number
  subject: string
  sender_name: string
  time: string
  sender_addr?: string
  category?: string
  priority?: string
  ai_summary?: string
  ai_action?: string
  source: ReportEmailSource
  badges?: string[]
}
export interface ReportKeyPointsBlock {
  type: 'key_points'
  items: string[]
  title?: string
}
export interface ReportCalloutBlock {
  type: 'callout'
  tone: ReportTone
  body: string
  title?: string
}
export interface ReportKosContextBlock {
  type: 'kos_context'
  entity_slug: string
  title: string
  snippet: string
  source: string
}
export interface ReportActionSuggestionBlock {
  type: 'action_suggestion'
  id: string
  title: string
  internal_ids: number[]
  action_type: string
  enabled: boolean
  detail?: string
}
export interface ReportTrendPoint {
  label: string
  value: number
}
export interface ReportTrendBlock {
  type: 'trend'
  metric: string
  points: ReportTrendPoint[]
  compare?: { label: string; delta: number }
}
export interface ReportDividerBlock {
  type: 'divider'
}
/** 未知 block 优雅降级（BlockRenderer 渲染 UnknownBlock）。 */
export interface ReportUnknownBlock {
  type: string
  [k: string]: unknown
}
export type ReportBlock =
  | ReportHeaderBlock
  | ReportOverviewBlock
  | ReportStatRowBlock
  | ReportSectionBlock
  | ReportEmailItemBlock
  | ReportKeyPointsBlock
  | ReportCalloutBlock
  | ReportKosContextBlock
  | ReportActionSuggestionBlock
  | ReportTrendBlock
  | ReportDividerBlock
  | ReportUnknownBlock

export interface ReportDoc {
  version: number
  agent_id: string
  cadence: ReportCadence
  report_date: string
  window: { start: string; end: string }
  generated_at: string
  model: string
  blocks: ReportBlock[]
}

export interface ReportCounts {
  total?: number
  unread?: number
  urgent?: number
  ai_handled?: number
  todo?: number
  /** 已回复（同 thread 有更晚发件箱邮件）。 */
  replied?: number
  /** 已发出（本窗口发件箱邮件数）。 */
  sent?: number
  /** 已标旗。 */
  flagged?: number
  by_category?: Record<string, number>
}

/** report:list 行（不含 blocks，热路径直读 sync_store.db）。 */
export interface ReportListItem {
  id: string
  agent_id: string
  cadence: ReportCadence
  report_date: string
  window_start: string
  window_end: string
  status: ReportStatus
  counts: ReportCounts
  headline: string
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  error: string | null
  created_at: number | null
  generated_at: number | null
}

/** report:get — 完整行 + 解析后的 doc。 */
export interface ReportDetail extends ReportListItem {
  doc: ReportDoc | null
}

export interface ReportSchedule {
  cadence: ReportCadence
  hours: number[]
  weekday?: number
  day_of_month?: number
}

/** report:getConfig — 解析后的 agent 配置（prompt 缺省已回填默认）。 */
export interface ReportAgentConfig {
  id: string
  type: string
  enabled: boolean
  title: string
  schedule: ReportSchedule
  window_hours: number | null
  prompt: string
  prompt_is_default: boolean
  model: string
  kos_enrich: boolean
  /** daily 触发模式：rolling_24h（往前推 window_hours）| natural_day（指定时区昨天整天）。 */
  trigger_mode: 'rolling_24h' | 'natural_day'
  /** IANA 时区（'' = 本地）；natural_day 边界 + 周/月报自然周/月用。 */
  timezone: string
  /** daily 带完整正文的优先级集合（priority label）；命中的邮件才预载正文，其余只摘要、不带附件。 */
  body_full_priorities: string[]
  updated_at: number | null
}

/** report:setConfig — friendly patch（后端 CLI 映射到 DB 列）。 */
export interface ReportConfigPatch {
  enabled?: boolean
  title?: string
  /** null / '' → 重置为内置默认 prompt。 */
  prompt?: string | null
  model?: string
  window_hours?: number
  schedule?: ReportSchedule
  kos_enrich?: boolean
  trigger_mode?: 'rolling_24h' | 'natural_day'
  timezone?: string
  body_full_priorities?: string[]
}

export interface ReportRunResult {
  report_id: string
  status: ReportStatus
  headline: string
  cadence?: string
  report_date?: string
  error?: string | null
}

export interface ReportApi {
  /** 报告列表（不含 blocks，按 report_date 倒序）。失败返 []。 */
  list(opts?: {
    cadence?: ReportCadence
    agentId?: string
    limit?: number
  }): Promise<ReportListItem[]>
  /** 单份报告详情（含解析后的 doc）。不存在返 null。 */
  get(reportId: string): Promise<ReportDetail | null>
  /** agent 配置列表（v1 一个 daily agent）。失败返 []。 */
  getConfig(): Promise<ReportAgentConfig[]>
  /** 部分更新 agent 配置（写, needs auth）。返回更新后的解析配置。 */
  setConfig(agentId: string, patch: ReportConfigPatch): Promise<ReportAgentConfig>
  /** 立即生成一份报告（runNow, 写, needs auth, 跑 LLM）。 */
  runNow(agentId: string, opts?: { cadence?: ReportCadence }): Promise<ReportRunResult>
  /** 删除一份报告（写, needs auth）。 */
  delete(reportId: string): Promise<void>
}

export interface MailApi {
  email: EmailApi
  /** D2b — async_jobs 长任务查询 (batch resync 进度轮询; backfill UI 未来复用)。 */
  jobs: JobsApi
  /** 多文件夹同步管理: folder discover / whitelist / 文件夹 CRUD / cleanup (davmail-only)。 */
  folder: FolderApi
  attachment: AttachmentApi
  ai: AiApi
  chat: ChatApi
  llm: LlmApi
  notion: NotionWriteApi
  /** Sprint 6 — admin dashboard data. */
  admin: AdminApi
  /** Sprint 6 — recurring meeting list. */
  calendar: CalendarApi
  /** Sprint 6 — SettingsPage IPC surface (keytar + persistent settings). */
  settings: SettingsApi
  /** Sprint 8 — electron-updater bridge (current version + check / download / install). */
  updater: UpdaterApi
  /** Sprint 9 — ping-island bridge (status + appearance broadcast + AI draft envelopes). */
  island: IslandApi
  /** Sprint 16 — SSE events bridge (replaces 5s polling). */
  events: EventsApi
  /** Sprint 18 §PR B — repo-root .env read/write. Settings tabs use this to
   *  persist managed ENV keys directly to the file Python services read. */
  env: EnvApi
  /** Sprint 18 §PR B — pm2 restart/status bridge. Wired to the
   *  RestartBanner (PR E) "立即重启" CTA after env:set returns
   *  restartRequired=true. */
  services: ServicesApi
  /** LLM prompt file CRUD (inbox / sent markdown). */
  prompts: PromptsApi
  /** Notion Agent CLI config — read/edit the bound Custom Agent + default
   *  model in ~/.notionagents/notion_account.json. */
  notionAgent: NotionAgentApi
  /** Sprint 20 — 报告 Agent (/agents 页): list/get 直读 sync_store.db,
   *  runNow/getConfig/setConfig 经 `mailagent report` CLI fork. */
  report: ReportApi
}
