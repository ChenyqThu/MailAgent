// chat-panel P4 Phase 03b — domain-side approval guard (HITL write tools).
//
// AI SDK v6 already gives us the *transport* of human-in-the-loop approval: a write
// tool declared `needsApproval` ends the first streamText run with a signed
// `tool-approval-request` part, and the second run only executes after the client
// replays a `tool-approval-response` whose HMAC signature verifies (set via
// streamText `experimental_toolApprovalSecret` → InvalidToolApprovalSignatureError on
// a forged/tampered approval). That signature binds approval↔toolCall — it does NOT
// bind the tool *input*. So a client could legitimately approve tool call X and then
// swap X's input before the replay.
//
// This ApprovalGuard is the MailAgent domain-side layer that closes that gap and adds
// id/expiry, LAYERED on top of ai@6's signature (architecture §5.3, §13.4; phase-04 §5/§6):
//   - register(toolCallId, …) runs in the write tool's `needsApproval` callback on the
//     FIRST call (when ai@6 decides the tool needs approval). It stamps a record keyed
//     by the stable toolCallId with the input hash + an expiry. KEEP-FIRST ABSOLUTE:
//     a re-evaluation on the second call never refreshes the record (so the expiry
//     window is anchored to when the approval was first requested, and an input swap
//     cannot rewrite the bound hash).
//   - verify(toolCallId, input) runs inside `execute` on the SECOND call (i.e. only
//     after ai@6 verified the approval signature). It enforces: record exists, not
//     expired, and the executed input matches the approved input. preview-tier writes
//     reject any input change (E_APPROVAL_HASH_MISMATCH — "no silent input swap").
//     edit-tier writes (email_draft_reply) PERMIT an input change (the user may edit
//     the proposed draft) and report it as userEdited so audit records it.
//
// 🔴 Pure Node (node:crypto only) — no electron / chat_db / ai imports, so the gateway
//    core stays harness-testable and this guard is directly unit-testable. The store is
//    a module-instance Map shared across the two HTTP calls of one approval round-trip
//    (the Electron wrapper builds ONE guard per gateway start and binds it into every
//    request's tool factory). A gateway restart between the two calls drops the record →
//    verify fails closed (E_APPROVAL_NOT_FOUND), which also matches ai@6 losing its
//    per-process signing secret. Fail-closed is the safe direction for a write gate.

import { createHash, randomUUID } from 'node:crypto'

/** Risk tier of a write tool, mirroring the legacy confirmationTier (write.ts) +
 *  tool_catalog.json. 'preview' = reversible, approve/reject only (no input edit).
 *  'edit' = user-editable input (e.g. a draft body) before the write. */
export type ApprovalRisk = 'preview' | 'edit'

/** Approval error codes surfaced to the model as a tool-error (normalizeToolError
 *  reads the duck-typed `.code`). Distinct from ai@6's InvalidToolApprovalSignatureError
 *  (the transport-layer guard) — these are the domain-layer guard. */
export type ApprovalErrorCode =
  | 'E_APPROVAL_NOT_FOUND'
  | 'E_APPROVAL_EXPIRED'
  | 'E_APPROVAL_HASH_MISMATCH'

/** A thrown domain-approval failure. `.code` lets normalizeToolError map it to a stable
 *  tool-error code without a dependency on this module. */
export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode
  constructor(code: ApprovalErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'ApprovalError'
    this.code = code
  }
}

/** One pending/decided approval, keyed by the (stable) AI SDK toolCallId. Mirrors
 *  phase-04 §5 ApprovalRecord (the subset 03b needs — content-hash send token is 04b). */
export interface ApprovalRecord {
  /** Domain-side approval id (audit traceability; independent of ai@6's approvalId). */
  approvalId: string
  toolCallId: string
  toolName: string
  risk: ApprovalRisk
  /** sha256 of the canonical approved input — the anti-swap binding. */
  inputHash: string
  createdAt: number
  expiresAt: number
}

/** verify() outcome: the matched record + whether the executed input differed from the
 *  approved input (only possible for edit-tier; preview-tier throws on mismatch). */
export interface ApprovalVerifyResult {
  record: ApprovalRecord
  userEdited: boolean
}

/** Default approval validity window (5 min) — long enough for a human to review a card,
 *  short enough that a stale approval can't be replayed much later. */
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000

/** Canonical JSON: object keys sorted recursively so hashing is order-independent
 *  (two inputs that differ only in key order hash equal). Arrays keep order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** sha256 hex of the canonical form of an input (the approval binding). */
export function hashApprovalInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input)) ?? 'null')
    .digest('hex')
}

/**
 * Domain-side approval store + guard. One instance per gateway process (the Electron
 * wrapper constructs it once and binds it into every request's write-tool factory, so
 * a record registered on the first call survives to the second). Tests construct one
 * directly with an injected clock / id generator for determinism.
 */
export class ApprovalGuard {
  private readonly store = new Map<string, ApprovalRecord>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly genId: () => string

  constructor(opts?: { ttlMs?: number; now?: () => number; genId?: () => string }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.now = opts?.now ?? (() => Date.now())
    this.genId = opts?.genId ?? (() => `apr-${randomUUID()}`)
  }

  /**
   * Register (or return the existing) approval record for a tool call. Called from the
   * write tool's `needsApproval` callback on the first streamText run. KEEP-FIRST
   * ABSOLUTE: if a record for this toolCallId already exists it is returned unchanged
   * (even if expired) — so a re-evaluation on the second run can never refresh the
   * expiry window nor rewrite the bound input hash.
   */
  register(
    toolCallId: string,
    toolName: string,
    risk: ApprovalRisk,
    input: unknown
  ): ApprovalRecord {
    const existing = this.store.get(toolCallId)
    if (existing) return existing
    const createdAt = this.now()
    const record: ApprovalRecord = {
      approvalId: this.genId(),
      toolCallId,
      toolName,
      risk,
      inputHash: hashApprovalInput(input),
      createdAt,
      expiresAt: createdAt + this.ttlMs
    }
    this.store.set(toolCallId, record)
    return record
  }

  /**
   * Verify a tool call may execute with the given input. Called inside `execute` on the
   * second run (so ai@6 has already verified the approval signature). Throws ApprovalError
   * when no record exists, it has expired, or — for preview-tier — the input was swapped.
   * For edit-tier an input change is allowed and reported via `userEdited`.
   */
  verify(toolCallId: string, input: unknown): ApprovalVerifyResult {
    const record = this.store.get(toolCallId)
    if (!record) {
      throw new ApprovalError(
        'E_APPROVAL_NOT_FOUND',
        `no approval on record for tool call ${toolCallId} (re-propose the action)`
      )
    }
    if (this.now() >= record.expiresAt) {
      throw new ApprovalError(
        'E_APPROVAL_EXPIRED',
        `approval ${record.approvalId} expired — re-propose the action`
      )
    }
    const inputHash = hashApprovalInput(input)
    if (inputHash !== record.inputHash) {
      if (record.risk === 'edit') {
        // edit-tier: the user is allowed to change the proposed input (e.g. a draft body)
        // before approving. Record the edit; the executed input is the authoritative one.
        return { record, userEdited: true }
      }
      throw new ApprovalError(
        'E_APPROVAL_HASH_MISMATCH',
        `approved input was modified for ${record.toolName} (preview-tier writes cannot be edited)`
      )
    }
    return { record, userEdited: false }
  }

  /** Diagnostic — number of records currently held (tests / observability). */
  size(): number {
    return this.store.size
  }
}
