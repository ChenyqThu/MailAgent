// chat-panel P4 Phase 06 (context injection) — token-budget truncation + prompt-injection
// detection primitives for AgentContextSnapshot.
//
// Pure TS (no react / electron / ai) so BOTH the renderer (snapshot builder) and the gateway
// core (server-side normalize) can import it. The budget caps mirror context-injection.md §6;
// the injection detector backs §7 (untrusted-content hardening): when an email body / attachment
// excerpt contains a classic "ignore previous instructions"-style pattern, we surface it as a
// privacy.redactions warning so the user (ContextChips) AND the model (the system block notes the
// flagged content is data, not an instruction) both see it.

/** Per-content character caps (context-injection.md §6). The snapshot builder applies these to the
 *  active email body / each reference / each attachment excerpt; the aggregate caps are advisory
 *  (the builder trims per-item first, which keeps totals well under the JSON cap in practice). */
export interface ContextTokenBudget {
  /** active email body markdown. */
  bodyMaxChars: number
  /** each referenced email / page excerpt. */
  referenceMaxChars: number
  /** all references combined. */
  referencesTotalMaxChars: number
  /** each attachment text excerpt. */
  attachmentTextMaxChars: number
  /** all attachment excerpts combined. */
  attachmentsTotalMaxChars: number
  /** the whole serialized context JSON. */
  contextJsonMaxChars: number
}

/** context-injection.md §6 defaults. Centralized so tests + the builder share one source. */
export const DEFAULT_CONTEXT_BUDGET: ContextTokenBudget = {
  bodyMaxChars: 12_000,
  referenceMaxChars: 1_200,
  referencesTotalMaxChars: 6_000,
  attachmentTextMaxChars: 2_000,
  attachmentsTotalMaxChars: 8_000,
  contextJsonMaxChars: 28_000
}

/** The outcome of clipping one string to a budget — carries enough for the snapshot's privacy
 *  fields + ContextChips to render "12k/34k 已截断" without re-measuring. */
export interface TruncationResult {
  /** the (possibly clipped) text. */
  text: string | null
  /** chars actually kept (0 when the input was null/empty). */
  charsIncluded: number
  /** chars in the original input (null when the input was null). */
  charsTotal: number | null
  /** true iff the input exceeded the cap and was clipped. */
  truncated: boolean
}

/** Clip `text` to `maxChars`. null/empty → an empty result (charsTotal null preserves "no body" vs
 *  "empty body"). When clipped, the kept text is the HEAD (the most relevant part of an email body /
 *  excerpt is the top); the caller records the truncation in privacy.userVisibleSummary. */
export function truncateToBudget(
  text: string | null | undefined,
  maxChars: number
): TruncationResult {
  if (text == null) return { text: null, charsIncluded: 0, charsTotal: null, truncated: false }
  const total = text.length
  if (total === 0) return { text: '', charsIncluded: 0, charsTotal: 0, truncated: false }
  if (total <= maxChars) return { text, charsIncluded: total, charsTotal: total, truncated: false }
  return {
    text: text.slice(0, maxChars),
    charsIncluded: maxChars,
    charsTotal: total,
    truncated: true
  }
}

/** Classic prompt-injection phrasings we flag in untrusted content (context-injection.md §7). NOT a
 *  blocklist (we never silently drop the body — the model still needs to read the email); it only
 *  raises a redaction warning so the user + the model are told this content tried to give orders. */
const INJECTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  {
    id: 'ignore-previous-instructions',
    re: /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions/i
  },
  { id: 'disregard-above', re: /disregard\s+(the\s+)?(above|prior|previous|earlier)/i },
  {
    id: 'override-system-prompt',
    re: /(override|replace|forget)\s+(your\s+)?(the\s+)?system\s+prompt/i
  },
  { id: 'you-are-now', re: /you\s+are\s+now\s+(a|an|the)\b/i },
  { id: 'new-instructions', re: /new\s+instructions?\s*[:：]/i },
  {
    id: 'reveal-system-prompt',
    re: /(reveal|print|show|repeat)\s+(your\s+)?(the\s+)?(system\s+prompt|instructions)/i
  }
]

/** Scan untrusted text for injection patterns. Returns the matched pattern ids (de-duplicated, in
 *  declaration order) — empty when clean. The caller folds these into privacy.redactions as
 *  `injection-warning:<scope>:<id>` so the warning is traceable to where it was found. */
export function detectInjectionPatterns(text: string | null | undefined): string[] {
  if (!text) return []
  const hits: string[] = []
  for (const { id, re } of INJECTION_PATTERNS) {
    if (re.test(text) && !hits.includes(id)) hits.push(id)
  }
  return hits
}
