// LLM-emitted Chinese `action_type` → DESIGN.md-compliant English short-code
// chip label. Sprint 2 EmailRow renders the chip at `text-micro` (11px mono),
// which §16.6 reserves for ASCII. The semantic value behind the chip is the
// Chinese label (it's a Notion DB select enum) — for the full word the user
// can hover or look in the AIFieldsBlock cell where text-aux is fine.
//
// Production-observed values (`labels_json.action_type` distinct):
//   仅供参考 / 需要回复 / 需要会议 / 需要决策 / 需要Review
// Prompt-declared but unobserved:
//   需要跟进 / 等待响应 / 已完结
//
// Falls back to '?' for unknown values rather than throwing — the chip
// stays visually stable when the LLM prompt evolves and produces a new enum
// value we haven't mapped yet. NOTES.md tracks the mapping coverage.

const ACTION_LABEL_MAP: Record<string, string> = {
  需要回复: 'REPLY',
  需要决策: 'DECIDE',
  '需要 Review': 'REVIEW',
  需要Review: 'REVIEW',
  需要会议: 'MEETING',
  需要跟进: 'FOLLOWUP',
  等待响应: 'WAITING',
  仅供参考: 'FYI',
  已完结: 'DONE'
}

export function mapActionLabel(zh: string | null | undefined): string | null {
  if (!zh) return null
  const cleaned = zh.trim()
  if (cleaned.length === 0) return null
  return ACTION_LABEL_MAP[cleaned] ?? '?'
}

/** Returns the full Chinese label suitable for AIFieldsBlock / tooltip rendering. */
export function actionLabelChinese(zh: string | null | undefined): string | null {
  if (!zh) return null
  const cleaned = zh.trim()
  return cleaned.length > 0 ? cleaned : null
}
