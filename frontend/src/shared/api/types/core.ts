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

export type EmailMeta = EmailList_EmailListItem & {
  snippet: string | null
  /**
   * 收件人原始头 (逗号分隔，可能带显示名)。列表面的「收件人是我」筛选轴唯一判据。
   * SQL 早就 SELECT 了它，只是从没投影出来；schema 里是 optional (CLI `email list`
   * 不发)，故这里也是 optional。与 `EmailDetail.is_important` 同款理由把它写进交集：
   * `cli.gen.ts` 是 gitignored 的 postinstall 产物，本地陈旧副本会静默丢字段。
   */
  to_addr?: string | null
  /**
   * v58 派生列 —— `sender` 的归一裸小写地址（`email_metadata.sender_email`，
   * Python `derive_sender_email` 在持久化边界算，前端不再自己解析）。
   *
   * 🔴 `sender` **不保证是裸地址**：AppleScript 路径写的是整个 From 头
   * `Gary W <gary.w@…>`（活库 13014 行里 8850 行 = 68%）。任何「判发件人地址」
   * 的判据（`isBotSender` 等）必须读这个字段，读 `sender` 就是在读发件人
   * 自己填的显示名。取不到地址的行为 null。
   *
   * optional 同 `to_addr`：schema 里是 optional（CLI `email list` 不发），且
   * `cli.gen.ts` 是 gitignored 的 postinstall 产物，本地陈旧副本会静默丢字段。
   */
  sender_email?: string | null
}
/**
 * EmailDetail = schema-typed EmailGet_EmailRecord (+ historically, fields the
 * codegen didn't expose).
 *
 *   - `is_important` — v9 RFC-header importance bit, written by
 *     `reader._parse_importance`. Folded into email-get.schema.json (optional:
 *     CLI `email get` omits it, serve-api + desktop IPC emit it), so the codegen
 *     now carries it. The intersection is kept because `cli.gen.ts` is a
 *     gitignored postinstall artifact — a stale local copy would otherwise drop
 *     the field and break `EmailDetail.tsx`'s ❗ badge at compile time.
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
 * PR-2a/T2: smart mode 返回 parser/smart transform 后的实际查询表达式，
 * 可能与原 query 相同；raw mode 通常省略。
 */
export interface SearchResult {
  items: SearchHit[]
  total_indexed: number
  /**
   * Phase A G-A2 — 本次查询命中数（= `items.length`，≤ 请求 limit）。**不是** 语料总量
   * `total_indexed`。配合 `has_more` 给 agentic 搜索自我收敛信号（太多→缩小 query）。
   * serve-api（桌面 AI 搜索经 loopback）与 TS 引擎（桌面人工搜索）两端都填。
   */
  total_matches?: number
  /** Phase A G-A2 — 是否还有超出本次 limit 的命中（后端 limit+1 探针精确判定）。 */
  has_more?: boolean
  transformed_query?: string
  parse_warnings?: string[]
  mode?: 'smart' | 'raw'
}

export interface ContactSuggestion {
  email: string
  name?: string
  /** 通讯录 organization（只有通讯录 lane 的候选带）。展示用，不参与排序。 */
  org?: string
  score: number
  last_seen?: string
}
