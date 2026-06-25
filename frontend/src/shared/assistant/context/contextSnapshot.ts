// chat-panel P4 Phase 06 (context injection) — AgentContextSnapshot typed schema + pure builder.
//
// context-injection.md §3: the chat upgrade replaces "concatenate some text in front of the user
// prompt" with a typed context snapshot the renderer builds, the gateway validates, and the system
// prompt + ContextChips both read from ONE source. This module owns the schema (§3) + a PURE builder
// (`buildAgentContextSnapshot`) that takes already-loaded data (email detail / AI fields / thread
// count / body markdown / references / attachments / UI state / capabilities) and assembles the
// snapshot, applying the §6 token budget + §7 untrusted marking. The data loading lives in the
// renderer hook (useAgentContextSnapshot); keeping the assembly pure makes it unit-testable and lets
// the gateway re-validate the same shape.
//
// 🔴 Pure TS (no react / electron / ai) — imported by the renderer (build), the serializer, and the
//    gateway core (validate). Email metadata is trusted; the body / attachment text / reference
//    excerpts are UNTRUSTED user content (§7) and tagged so on the snapshot.

import {
  DEFAULT_CONTEXT_BUDGET,
  detectInjectionPatterns,
  truncateToBudget,
  type ContextTokenBudget
} from './contextRedaction'

/** Schema version — bumped on a breaking change (protocol-contracts §9: new fields are minor and
 *  additive, removals/renames are major). The gateway validator rejects a mismatched version. */
export const CONTEXT_SNAPSHOT_VERSION = 'mailagent.context.v1'
export type ContextSnapshotVersion = typeof CONTEXT_SNAPSHOT_VERSION

export interface AgentContextSnapshot {
  version: ContextSnapshotVersion
  scope: ContextScope
  activeEmail?: ActiveEmailContext | null
  selection?: SelectionContext | null
  references: ReferenceContext[]
  attachments: AttachmentContext[]
  uiState: UIStateContext
  capabilities: CapabilityContext
  privacy: PrivacyContext
  createdAt: string
}

export interface ContextScope {
  surface: 'email-chat' | 'general-agent' | 'search-agent'
  anchorType: 'email' | 'general'
  anchorId: number | null
  sessionId: number | null
  backendKind: 'ai-sdk' | 'legacy-custom-api' | 'legacy-notion-agent'
}

export interface ActiveEmailContext {
  internalId: number
  subject: string | null
  senderName: string | null
  senderAddr: string | null
  recipients?: string[]
  dateIso: string | null
  mailbox: string | null
  threadId: string | null
  threadCount?: number
  notionPageId: string | null
  ai: {
    priority: string | null
    action: string | null
    category?: string | null
    processingStatus: string | null
    reviewStatus?: string | null
  }
  body: {
    markdown: string | null
    charsIncluded: number
    charsTotal?: number | null
    truncated: boolean
    source: 'sqlite-body' | 'snippet' | 'missing'
  }
  /** Metadata above is trusted; the body is untrusted user content (§7). */
  trust: 'trusted-metadata-untrusted-body'
}

export interface SelectionContext {
  selectedEmailIds: number[]
  selectedSender?: string | null
  mailbox?: string | null
  filters?: {
    query?: string
    aiPriority?: string | null
    aiAction?: string | null
    unreadOnly?: boolean
    flaggedOnly?: boolean
  }
}

export interface ReferenceContext {
  type: 'email' | 'attachment' | 'notion-page' | 'kos-doc' | 'report'
  id: string
  title: string | null
  source: string | null
  excerpt: string | null
  charsIncluded: number
  truncated: boolean
  trust: 'untrusted-user-content' | 'trusted-system-metadata'
}

export interface AttachmentContext {
  id: string
  name: string
  contentType: string | null
  sizeBytes: number | null
  textExcerpt?: string | null
  parseStatus: 'parsed' | 'metadata-only' | 'failed'
  trust: 'untrusted-user-content'
}

export interface UIStateContext {
  locale: string
  timezone: string
  route: string
  panelMode: 'dock' | 'popout' | 'fullscreen'
  theme?: 'light' | 'dark' | 'system'
}

export interface CapabilityContext {
  thinkingEnabled: boolean
  attachmentsEnabled: boolean
  toolCallingEnabled: boolean
  humanApprovalRequired: true
  enabledSkills: string[]
  unavailableTools?: Array<{ name: string; reason: string }>
}

export interface PrivacyContext {
  bodyIncluded: boolean
  bodyMaxChars: number
  referenceMaxChars: number
  attachmentTextMaxChars: number
  /** Human-readable flags: `truncated:body:12000/34000`, `injection-warning:body:<id>`, … */
  redactions: string[]
  /** One-line summary surfaced verbatim in ContextChips + the system block privacy note. */
  userVisibleSummary: string
}

// ── Builder inputs ─────────────────────────────────────────────────────────────────────────────

/** The active-email facts the builder needs (already loaded by the hook). Kept structural (not the
 *  EmailDetail type) so the pure builder + tests don't depend on the API surface. */
export interface BuildActiveEmailInput {
  internalId: number
  subject: string | null
  senderName: string | null
  senderAddr: string | null
  recipients?: string[]
  dateIso: string | null
  mailbox: string | null
  threadId: string | null
  threadCount?: number
  notionPageId: string | null
  ai?: {
    priority?: string | null
    action?: string | null
    category?: string | null
    processingStatus?: string | null
    reviewStatus?: string | null
  }
  /** full body markdown (untruncated); the builder clips it to the budget. null → body unavailable. */
  bodyMarkdown: string | null
  /** 'sqlite-body' (full body fetched) | 'snippet' (list snippet only) | 'missing'. */
  bodySource: 'sqlite-body' | 'snippet' | 'missing'
}

export interface BuildAgentContextInput {
  scope: ContextScope
  activeEmail?: BuildActiveEmailInput | null
  selection?: SelectionContext | null
  references?: Array<
    Omit<ReferenceContext, 'charsIncluded' | 'truncated'> & { excerpt: string | null }
  >
  attachments?: AttachmentContext[]
  uiState: UIStateContext
  capabilities: CapabilityContext
  /** ISO timestamp (the hook passes new Date().toISOString(); tests pass a fixed value). */
  createdAt: string
  /** Override the §6 budget (tests / future tuning). Defaults to DEFAULT_CONTEXT_BUDGET. */
  budget?: Partial<ContextTokenBudget>
}

/**
 * Assemble the typed AgentContextSnapshot from already-loaded data. Pure: applies the §6 token
 * budget (clip body / each reference excerpt to its cap), tags untrusted content, runs the §7
 * injection detector over the body + excerpts, and records every truncation / warning in
 * privacy.redactions + a one-line userVisibleSummary. No I/O.
 */
export function buildAgentContextSnapshot(input: BuildAgentContextInput): AgentContextSnapshot {
  const budget: ContextTokenBudget = { ...DEFAULT_CONTEXT_BUDGET, ...input.budget }
  const redactions: string[] = []

  // ── active email ──────────────────────────────────────────────────────────
  let activeEmail: ActiveEmailContext | null = null
  let bodyIncluded = false
  if (input.activeEmail) {
    const a = input.activeEmail
    const clip = truncateToBudget(a.bodyMarkdown, budget.bodyMaxChars)
    bodyIncluded = clip.text != null && clip.charsIncluded > 0
    if (clip.truncated) {
      redactions.push(
        `truncated:body:${clip.charsIncluded}/${clip.charsTotal ?? clip.charsIncluded}`
      )
    }
    for (const id of detectInjectionPatterns(clip.text))
      redactions.push(`injection-warning:body:${id}`)
    activeEmail = {
      internalId: a.internalId,
      subject: a.subject,
      senderName: a.senderName,
      senderAddr: a.senderAddr,
      ...(a.recipients ? { recipients: a.recipients } : {}),
      dateIso: a.dateIso,
      mailbox: a.mailbox,
      threadId: a.threadId,
      ...(a.threadCount != null ? { threadCount: a.threadCount } : {}),
      notionPageId: a.notionPageId,
      ai: {
        priority: a.ai?.priority ?? null,
        action: a.ai?.action ?? null,
        ...(a.ai?.category !== undefined ? { category: a.ai.category } : {}),
        processingStatus: a.ai?.processingStatus ?? null,
        ...(a.ai?.reviewStatus !== undefined ? { reviewStatus: a.ai.reviewStatus } : {})
      },
      body: {
        markdown: clip.text,
        charsIncluded: clip.charsIncluded,
        charsTotal: clip.charsTotal,
        truncated: clip.truncated,
        // a missing body keeps source 'missing'; a present-but-empty body keeps the declared source.
        source: bodyIncluded
          ? a.bodySource
          : a.bodySource === 'sqlite-body'
            ? 'missing'
            : a.bodySource
      },
      trust: 'trusted-metadata-untrusted-body'
    }
  }

  // ── references (clip each excerpt to its cap; respect the aggregate cap) ─────
  const references: ReferenceContext[] = []
  let refTotal = 0
  for (const r of input.references ?? []) {
    const remaining = Math.max(0, budget.referencesTotalMaxChars - refTotal)
    const cap = Math.min(budget.referenceMaxChars, remaining)
    const clip = truncateToBudget(r.excerpt, cap)
    refTotal += clip.charsIncluded
    if (clip.truncated) redactions.push(`truncated:reference:${r.id}`)
    for (const id of detectInjectionPatterns(clip.text)) {
      redactions.push(`injection-warning:reference:${r.id}:${id}`)
    }
    references.push({
      type: r.type,
      id: r.id,
      title: r.title,
      source: r.source,
      excerpt: clip.text,
      charsIncluded: clip.charsIncluded,
      truncated: clip.truncated,
      trust: r.trust
    })
  }

  // ── attachments (clip each text excerpt; scan untrusted excerpts) ───────────
  const attachments: AttachmentContext[] = []
  let attTotal = 0
  for (const at of input.attachments ?? []) {
    const remaining = Math.max(0, budget.attachmentsTotalMaxChars - attTotal)
    const cap = Math.min(budget.attachmentTextMaxChars, remaining)
    const clip = truncateToBudget(at.textExcerpt ?? null, cap)
    attTotal += clip.charsIncluded
    if (clip.truncated) redactions.push(`truncated:attachment:${at.id}`)
    for (const id of detectInjectionPatterns(clip.text)) {
      redactions.push(`injection-warning:attachment:${at.id}:${id}`)
    }
    attachments.push({
      ...at,
      textExcerpt: clip.text
    })
  }

  const privacy: PrivacyContext = {
    bodyIncluded,
    bodyMaxChars: budget.bodyMaxChars,
    referenceMaxChars: budget.referenceMaxChars,
    attachmentTextMaxChars: budget.attachmentTextMaxChars,
    redactions,
    userVisibleSummary: summarizePrivacy({ activeEmail, references, attachments, redactions })
  }

  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    scope: input.scope,
    activeEmail,
    selection: input.selection ?? null,
    references,
    attachments,
    uiState: input.uiState,
    capabilities: input.capabilities,
    privacy,
    createdAt: input.createdAt
  }
}

/** One-line, user-facing summary of what the snapshot carries (drives ContextChips' detail + the
 *  system block's privacy note). Deterministic so a test can assert it. */
function summarizePrivacy(args: {
  activeEmail: ActiveEmailContext | null
  references: ReferenceContext[]
  attachments: AttachmentContext[]
  redactions: string[]
}): string {
  const parts: string[] = []
  const body = args.activeEmail?.body
  if (body && body.markdown != null && body.charsIncluded > 0) {
    parts.push(
      body.truncated
        ? `body ${body.charsIncluded}/${body.charsTotal ?? body.charsIncluded} chars (truncated)`
        : `body ${body.charsIncluded} chars`
    )
  } else if (args.activeEmail) {
    parts.push('body unavailable')
  }
  if (args.references.length > 0) parts.push(`${args.references.length} reference(s)`)
  if (args.attachments.length > 0) parts.push(`${args.attachments.length} attachment(s)`)
  const warnings = args.redactions.filter((r) => r.startsWith('injection-warning:')).length
  if (warnings > 0) parts.push(`${warnings} injection warning(s)`)
  return parts.length > 0 ? parts.join('; ') : 'no email context'
}

// ── Validation (used by the gateway to reject a malformed snapshot) ──────────────────────────────

/** True when `value` is a structurally-valid AgentContextSnapshot. The gateway returns 400 on a
 *  present-but-invalid snapshot so a malformed client can't smuggle an off-spec blob into the prompt.
 *  Absent snapshot is handled by the caller (valid → context-light), not here.
 *
 *  🔴 Validates the PROMPT-CONSUMED string fields strictly (codex review HIGH): `capabilities`
 *  (enabledSkills: string[], unavailableTools: {name,reason}[]) and `privacy.userVisibleSummary` are
 *  rendered as TRUSTED prose by the serializer, so a type-confused snapshot (e.g. enabledSkills
 *  carrying objects, or userVisibleSummary a non-string) must be rejected here rather than reaching
 *  prompt assembly. The untrusted excerpt fields (references/attachments) are render-sanitized
 *  (UNTRUSTED_* fences), so they only need structural array checks. */
export function isValidContextSnapshot(value: unknown): value is AgentContextSnapshot {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (v.version !== CONTEXT_SNAPSHOT_VERSION) return false
  if (v.scope == null || typeof v.scope !== 'object') return false
  const scope = v.scope as Record<string, unknown>
  if (typeof scope.surface !== 'string' || typeof scope.anchorType !== 'string') return false
  if (!Array.isArray(v.references) || !Array.isArray(v.attachments)) return false
  if (v.uiState == null || typeof v.uiState !== 'object') return false
  if (v.privacy == null || typeof v.privacy !== 'object') return false
  // privacy.userVisibleSummary is rendered as prose → must be a string.
  if (typeof (v.privacy as Record<string, unknown>).userVisibleSummary !== 'string') return false
  // capabilities: enabledSkills must be string[]; unavailableTools (if present) must be {name,reason}[].
  if (v.capabilities == null || typeof v.capabilities !== 'object') return false
  const cap = v.capabilities as Record<string, unknown>
  if (!Array.isArray(cap.enabledSkills) || cap.enabledSkills.some((s) => typeof s !== 'string')) {
    return false
  }
  if (cap.unavailableTools !== undefined) {
    if (!Array.isArray(cap.unavailableTools)) return false
    for (const u of cap.unavailableTools) {
      if (u == null || typeof u !== 'object') return false
      const uu = u as Record<string, unknown>
      if (typeof uu.name !== 'string' || typeof uu.reason !== 'string') return false
    }
  }
  return true
}
