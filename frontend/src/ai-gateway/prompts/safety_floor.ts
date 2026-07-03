// PR4 (task 06-22-harness-agent-polish) — PRODUCT_SAFETY_FLOOR: the immutable
// product safety prefix.
//
// Phase -1 / 0A splits the old monolithic SOUL_MARKDOWN into two layers:
//   1. PRODUCT_SAFETY_FLOOR (this file) — the hard safety guardrails, ALWAYS
//      prepended FIRST and NEVER sourced from user-editable config. A user (or an
//      agent patch) editing SOUL/AGENT/RULES/USER physically cannot remove these
//      bytes — they live in code, not in agent_config.db. This is the structural
//      guarantee behind "RULES.md cannot weaken the safety floor".
//   2. Standing Context (SOUL+AGENT+RULES+USER) — user-editable, assembled
//      backend-side and delivered as `standingContext` via /chat/config.
//
// The text below is BYTE-IDENTICAL to the `## Safety guardrails` section of
// prompts/custom_ai/soul.md (the legacy combined prompt). A contract test
// (safety_floor.test.ts) asserts `SOUL_MARKDOWN.includes(PRODUCT_SAFETY_FLOOR)`
// so the two never drift — changing the safety text in soul.md forces the same
// change here. Keeping it verbatim preserves the exact safety behaviour when the
// new layered assembly is on (default ON) — zero safety regression, only the
// identity/working-style/rules text is now user-configurable.
//
// Zero Electron/Node import (invariant 1, pnpm build:web).

export const PRODUCT_SAFETY_FLOOR = [
  '## Safety guardrails (M1 polish):',
  '- NEVER call email_flag / email_archive in a loop or against multiple emails',
  '  unless the user explicitly named the count or scope ("mark all 12 vendor',
  '  emails as read" — OK; "clean up my inbox" — NOT OK, ask for specifics).',
  '- For email_draft_reply, the user MUST see and confirm the body in the',
  '  ConfirmToolDialog. Never bypass with a different tool.',
  '- If the user phrases sound destructive ("delete everything", "wipe", "send',
  '  to all"), refuse + ask for a narrower scope; do NOT propose a write tool.',
  '- KOS / search read tools (kos_query / kos_recall / kos_get_page /',
  '  email_search_fulltext / email_search_attachments) are read-only — safe to',
  '  call freely; cap to 3 calls per turn unless iteratively narrowing.',
  '- kos_put_page WRITES the knowledge brain — the user MUST confirm it in the',
  '  ConfirmToolDialog; only use it for genuinely durable facts.'
].join('\n')
