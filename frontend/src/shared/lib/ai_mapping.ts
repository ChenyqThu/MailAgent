// Decode the `labels_json` blob written by src/llm_agent/processor.py into
// the shapes the renderer's <AIBadge> / <AIFieldsBlock> expect.
//
// Two layers of indirection to bridge:
//   1. LLM output is emoji-decorated Chinese ("🟢 一般") — DESIGN.md §2.3
//      wants the 5 enum slugs (critical/urgent/important/normal/low) so
//      Tailwind variants pick up the right color token.
//   2. Schema-vs-reality mismatch (REVIEW-LOG H-14 trail). BACKEND-INTERFACES
//      §8 lists `Sentiment` as one of the 8 V1 AI fields, but the actual
//      `labels_json` written by the agent has no `sentiment` key — Lucien's
//      production data has only:
//        ai_summary / key_points / category / language / sender_priority /
//        action_required / action_type / priority / urgency_reason /
//        mail_actions / daily_digest_date / related_project / mailbox + cost
//      So we surface what's there and let <AIFieldsBlock> render "—" for
//      the missing slot. The day the agent starts writing `sentiment`,
//      `mapSentiment` below picks it up without further changes.

import type { AIPriority } from '@shared/api/types'

// Re-export so existing callers `import { type AIPriority } from './ai_mapping'`
// keep working — the canonical declaration lives in @shared/api/types.
export type { AIPriority }

/**
 * Map the emoji-decorated Chinese priority string the LLM writes to the
 * 5-slug enum DESIGN.md §2.3 expects.
 *
 * Real production values (`labels_json.priority` distinct distribution):
 *   "🟡 重要" / "🟢 一般" / "⚪ 低"
 * The two missing tiers (Critical / Urgent) are predefined in the prompt
 * (`prompts/email_inbox.md`) but rare in the sample — we pre-wire them so
 * a future high-stakes email is rendered correctly.
 *
 * Matching is by **substring of the Chinese label**, not the emoji, so
 * stripping or swapping the emoji never breaks the mapping.
 */
export function mapPriority(raw: string | null | undefined): AIPriority | null {
  if (!raw || typeof raw !== 'string') return null
  // Order matters — "重要" before "一般" so an LLM that writes "次重要" lands
  // in important, not normal. But these are exact buckets so it doesn't
  // matter much in practice.
  if (raw.includes('紧急') || raw.includes('Critical')) return 'critical'
  if (raw.includes('紧迫') || raw.includes('严重') || raw.includes('Urgent')) return 'urgent'
  if (raw.includes('重要') || raw.includes('Important')) return 'important'
  if (raw.includes('一般') || raw.includes('普通') || raw.includes('Normal')) return 'normal'
  if (raw.includes('低') || raw.includes('Low')) return 'low'
  return null
}

/**
 * Map the LLM-detected language to the 2-letter ISO code used by the
 * <EmailRow> `<LanguagePip>` (DESIGN.md §5.1 — coral chip shown when
 * `lang !== 'zh'`).
 *
 * Production values seen: "中文" / "English".
 */
export function mapLanguage(raw: string | null | undefined): 'zh' | 'en' | 'unknown' {
  if (!raw || typeof raw !== 'string') return 'unknown'
  const s = raw.toLowerCase()
  if (raw.includes('中文') || s === 'chinese' || s === 'zh' || s === 'zh-cn') return 'zh'
  if (s === 'english' || s === 'en' || s === 'en-us' || s === 'en-gb') return 'en'
  return 'unknown'
}

/**
 * `Sentiment` is listed in BACKEND-INTERFACES.md §8 V1 grid but the agent
 * doesn't emit it yet — return null and let the renderer placeholder.
 * Kept as a stub so the contract is one-sided not undocumented.
 */
export function mapSentiment(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  return raw // pass-through whatever value if/when the agent starts writing it
}

/**
 * Map `llm_processing.status` → `AI Review Status` enum the grid renders.
 * Stored values: success / failed / gave_up / (no row = pending).
 * Notion side enum: Pending / Reviewed.
 */
export function mapReviewStatus(raw: string | null | undefined): 'pending' | 'reviewed' | null {
  if (!raw || typeof raw !== 'string') return null
  if (raw === 'success') return 'reviewed'
  if (raw === 'failed' || raw === 'gave_up' || raw === 'pending') return 'pending'
  return null
}

/**
 * Safe parse of `labels_json` blob; tolerates malformed JSON without
 * killing the IPC handler. Caller decides what fields to read.
 */
export function parseLabels(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
