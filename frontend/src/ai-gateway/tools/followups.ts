// chat UI 优化 W6 — the in-turn suggest_followups tool (replaces POST /api/ai/followups).
//
// One SILENT no-op tool the model calls once at the very end of a manual-chat answer with 2-3
// short next-question suggestions. execute has ZERO side effects: it cleans the prompts
// (sanitizeFollowupPrompts — the ONE shared discipline the renderer also uses) and returns them
// as a tiny confirmation object. The renderer extracts the prompts from the persisted/streamed
// tool part and renders composer-top chips; the tool call ALSO serves as the turn's stop signal
// (prepareChatRun adds hasToolCall('suggest_followups') to stopWhen — 调完即停, no trailing text).
//
// 🔴 manual_chat-ONLY registration (tools/index.ts): headless custom-agent runs / im_chat / the
//    search agent never see it — follow-ups are interactive UI supply, and the hasToolCall stop
//    condition must never leak into an unattended run. Class 'read' (policy.ts) + CORE_UNGATED
//    (skill_gating.ts): silent, never approval-gated, never skill-gated — the venue gate is the
//    only gate.

import type { Tool } from 'ai'

import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import { suggestFollowupsSchema } from './schemas'
// RELATIVE import (not @shared) so the pure-Node poc harness can load the gateway tools —
// same rationale as sessions.ts's contextSerializer import. followups.ts is a zero-dep leaf.
import {
  sanitizeFollowupPrompts,
  SUGGEST_FOLLOWUPS_TOOL_NAME
} from '../../shared/assistant/followups'

/** Exported for tests + the eval catalog completeness gate. 🔴 QUOTED literal on purpose:
 *  test_gateway_catalog_completeness / validate_catalog statically regex-extract quoted tool-name
 *  strings from GATEWAY_*_TOOL_NAMES arrays — a constant reference is invisible to them. The
 *  compile-time check below pins it to the shared canonical constant (drift = type error). */
export const GATEWAY_FOLLOWUP_TOOL_NAMES = ['suggest_followups'] as const
// Type-level equality guard: the literal above IS the shared constant (no runtime cost).
const _followupNameGuard: typeof SUGGEST_FOLLOWUPS_TOOL_NAME = GATEWAY_FOLLOWUP_TOOL_NAMES[0]
void _followupNameGuard

/** Build the W6 follow-up suggestion tool (manual chat only — the caller gates registration). */
export function createFollowupTools(
  collector: GatewayToolAuditCollector = []
): Record<string, Tool> {
  const suggest_followups = auditedReadTool(
    {
      // Quoted literal (not the constant) — validate_catalog's tier extraction pairs the nearest
      // preceding audited*Tool( factory with a line-anchored quoted `name:` literal.
      name: 'suggest_followups',
      // 🔴 0805 — the scope of "once" is PER REPLY, and it must say so. The earlier wording said
      // only "call this exactly once": with the previous turn's own suggest_followups tool part
      // sitting in the model's history, that reads just as well as "once per conversation" (or as
      // "the user already took one of my suggestions, so that loop is closed") — and the model
      // then skipped every turn after the first (owner dogfood; reproduced 2/2 in ai_chat.db, both
      // second turns started by tapping a chip). systemPrompt.ts FOLLOWUP_SUGGESTIONS_GUIDANCE
      // states the SAME scope; the two must never drift into contradicting rules.
      description:
        'Offer the user 2-3 short follow-up questions they are likely to ask next. Call this ' +
        'once per reply: every reply you finish ends with one call. Having called it on an ' +
        'earlier turn of this conversation does not excuse this reply, and neither does the user ' +
        'having started this turn by tapping one of your earlier suggestions — an adopted ' +
        'suggestion is a new question, not a closed loop. Call it only AFTER your answer is ' +
        'fully complete (never mid-task, never before a pending approval is resolved). The ' +
        'suggestions render as tappable chips in the UI — do not repeat them in your reply ' +
        'text. This tool has no side effects and returns no data.',
      inputSchema: suggestFollowupsSchema,
      run: async (input) => {
        // No side effects — clean once server-side so the persisted tool part already carries the
        // renderable list (the renderer re-sanitizes anyway; the discipline is shared + idempotent).
        const prompts = sanitizeFollowupPrompts(input.prompts)
        return { prompts, count: prompts.length }
      }
    },
    collector
  )
  return { [SUGGEST_FOLLOWUPS_TOOL_NAME]: suggest_followups }
}
