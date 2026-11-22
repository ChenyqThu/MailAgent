// KOS, reports, and notion-agent tool zod input schemas.
import { z } from 'zod'
import { REPORT_CADENCES, reportBlockInputSchema } from '../../../shared/api/reportBlocks'

/** kos_query — cross-domain KOS retrieval. */
export const kosQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).default(10),
  expand: z.boolean().default(false),
  source_id: z.string().optional()
})
export type KosQueryInput = z.infer<typeof kosQuerySchema>

// ── extra KOS read tools (issue #57) — keyword full-text / page read / expert lookup /
//    page listing / backlinks. All proxy through domain.kosCall(<mcp name>, args) to the
//    generic serve-api /chat/kos-call passthrough (KOSClient.call_tool) — zero new Python.
//    All silent reads (no write tool is registered). ──────────────────────────────────────

/** kos_search — keyword full-text search (a lighter, faster sibling of kos_query).
 *  NO `mode`: KOS's own tools/list documents it as "Local callers only" and a live probe
 *  (v0.42.64.0) returned byte-identical hits + scores for every value incl. garbage — an
 *  optional param the model believes tunes the search but cannot is exactly the #57 bug. */
export const kosSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
})
export type KosSearchInput = z.infer<typeof kosSearchSchema>

/** kos_get_page — read one page's full content by slug (fuzzy = tolerate near-miss slugs). */
export const kosGetPageSchema = z.object({
  slug: z.string().min(1),
  fuzzy: z.boolean().optional()
})
export type KosGetPageInput = z.infer<typeof kosGetPageSchema>

/** kos_find_experts — "who knows X" — people/concepts related to a topic (with scores). */
export const kosFindExpertsSchema = z.object({
  topic: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
})
export type KosFindExpertsInput = z.infer<typeof kosFindExpertsSchema>

/** kos_list_pages — list people/concept/etc. pages (all filters optional). `sort` is the
 *  KOS enum (tools/list): a free-form string silently falls back to updated_desc, so the
 *  model must not be able to invent one. `type` stays open (the brain grows types —
 *  person/company/concept/project/note/email/source/atom/… all observed live). */
export const kosListPagesSchema = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  updated_after: z.string().optional(),
  sort: z.enum(['updated_desc', 'updated_asc', 'created_desc', 'slug']).optional()
})
export type KosListPagesInput = z.infer<typeof kosListPagesSchema>

/** kos_get_backlinks — pages/people that reference a given page (empty = no edges yet).
 *  `limit` is applied CLIENT-side: KOS's get_backlinks takes only {slug} and returns the
 *  full edge set (a live probe returned 337 rows / 65KB for one person page), which would
 *  dump ~16k tokens of third-party text into the context on a single call. */
export const kosGetBacklinksSchema = z.object({
  slug: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50)
})
export type KosGetBacklinksInput = z.infer<typeof kosGetBacklinksSchema>

/** report_list — generated reports (all filters optional). */
export const reportListSchema = z.object({
  cadence: z.enum(REPORT_CADENCES).optional(),
  agent_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type ReportListInput = z.infer<typeof reportListSchema>

/** report_get — one report by id. */
export const reportGetSchema = z.object({
  report_id: z.string().min(1)
})
export type ReportGetInput = z.infer<typeof reportGetSchema>

/** report_write — local structured artifact. The shared block schema also enforces the
 * internal-only image source policy. */
export const reportWriteSchema = z.object({
  title: z.string().min(1).max(200),
  blocks: z.array(reportBlockInputSchema).min(1).max(100),
  mode: z.enum(['new', 'replace']).default('new')
})
export type ReportWriteInput = z.infer<typeof reportWriteSchema>

/** notion_agent_chat (task 07-21) — delegate a Notion-workspace request to the notion-agent CLI.
 *  `prompt` is the natural-language ask (question OR task); `thread_id` continues a prior Notion
 *  conversation; `model` overrides the bound default. Field names mirror the Python builtin skill
 *  tool schema (src/skills/builtin/notion_agent.py) so the gateway → /api/skills/invoke body matches. */
export const notionAgentChatSchema = z.object({
  prompt: z.string().min(1).max(8000),
  thread_id: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional()
})
export type NotionAgentChatInput = z.infer<typeof notionAgentChatSchema>
