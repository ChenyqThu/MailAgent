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
  score: number
  last_seen?: string
}
