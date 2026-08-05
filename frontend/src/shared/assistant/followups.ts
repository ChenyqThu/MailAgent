// chat UI 优化 W6 — follow-up suggestions single source (回合内 suggest_followups 工具).
//
// The old flow was a SECOND generation after the turn (POST /api/ai/followups → renderer state);
// W6 replaces it with an in-turn `suggest_followups` tool call: the model proposes 2-3 short
// next questions as tool args, the gateway tool cleans them (no side effects), and BOTH chat
// surfaces (email AiChatPanel thread + agent view AgentThread) extract them from the LAST
// assistant message's tool part and render tappable chips above the composer.
//
// 🔴 Zero-dependency leaf (no react / electron / ai / zod): imported by BOTH the Electron-main
//    gateway tool (relative import, pure-Node harness loadable) and the renderer chip component.
//    The cleaning discipline lives here ONCE so the two sides can never drift (跨边界手抄常量
//    的一致性纪律 — 单源下沉, not a mirrored copy).

/** The gateway tool name. Registered ONLY in manual_chat (interactive UI supply). */
export const SUGGEST_FOLLOWUPS_TOOL_NAME = 'suggest_followups'

/** At most 3 chips (the old parseFollowups cap). */
export const FOLLOWUP_MAX_COUNT = 3

/** Per-suggestion length cap in chars (the old parseFollowups 80-char discipline). */
export const FOLLOWUP_MAX_CHARS = 80

/**
 * Clean a model-proposed prompts array into the renderable list: strings only, trimmed,
 * de-bulleted / quote-stripped (defensive — the args are structured, but models still wrap),
 * clipped to FOLLOWUP_MAX_CHARS, empties + duplicates dropped, capped at FOLLOWUP_MAX_COUNT.
 * Mirrors the retired parseFollowups clean-up minus the JSON/fence parsing (no free text here).
 * Non-array / junk input → [] (the caller renders nothing).
 */
export function sanitizeFollowupPrompts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    let t = item
      .trim()
      .replace(/^[-*\d.)\s]+/, '')
      .replace(/^["'「『]+/, '')
      .replace(/["'」』]+$/, '')
      .trim()
    if (t.length > FOLLOWUP_MAX_CHARS) t = t.slice(0, FOLLOWUP_MAX_CHARS).trim()
    if (t.length > 0 && !out.includes(t)) out.push(t)
    if (out.length >= FOLLOWUP_MAX_COUNT) break
  }
  return out
}

/** Structural view of a tool part in EITHER shape we may meet:
 *  - assistant-ui converted ThreadMessage part: { type:'tool-call', toolName, args, result }
 *  - AI SDK wire/persisted UIMessage part:      { type:'tool-suggest_followups', input, output } */
interface ToolPartLike {
  type?: unknown
  toolName?: unknown
  args?: unknown
  result?: unknown
  input?: unknown
  output?: unknown
}

/** Is this part a suggest_followups tool part (either shape)? */
export function isSuggestFollowupsPart(part: unknown): boolean {
  if (part == null || typeof part !== 'object') return false
  const p = part as ToolPartLike
  if (p.type === 'tool-call') return p.toolName === SUGGEST_FOLLOWUPS_TOOL_NAME
  return p.type === `tool-${SUGGEST_FOLLOWUPS_TOOL_NAME}`
}

/** Extract the cleaned prompts from one suggest_followups tool part. Prefers the execute output
 *  (already cleaned server-side), falls back to the model args; both run through
 *  sanitizeFollowupPrompts (idempotent) so a raw/partial part still degrades to [] safely. */
export function followupPromptsFromPart(part: unknown): string[] {
  if (!isSuggestFollowupsPart(part)) return []
  const p = part as ToolPartLike
  for (const source of [p.result, p.output, p.args, p.input]) {
    if (source == null || typeof source !== 'object') continue
    const prompts = (source as { prompts?: unknown }).prompts
    const cleaned = sanitizeFollowupPrompts(prompts)
    if (cleaned.length > 0) return cleaned
  }
  return []
}

/** Extract follow-up prompts from an ASSISTANT message (aui ThreadMessage `content` or AI SDK
 *  UIMessage `parts` — whichever array the caller's message shape carries). The LAST matching
 *  tool part wins (a resumed/multi-step turn keeps only its freshest suggestions). Non-assistant
 *  / partless / promptless messages → []. */
export function extractFollowupPrompts(message: unknown): string[] {
  if (message == null || typeof message !== 'object') return []
  const m = message as { role?: unknown; content?: unknown; parts?: unknown }
  if (m.role !== 'assistant') return []
  const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : null
  if (!parts) return []
  for (let i = parts.length - 1; i >= 0; i--) {
    const prompts = followupPromptsFromPart(parts[i])
    if (prompts.length > 0) return prompts
  }
  return []
}
