// chat-panel P4 Phase 03b — domain-side approval guard (HITL write tools).
//
// AI SDK v6 gives us the *transport* of human-in-the-loop approval: a write tool declared
// `needsApproval` ends the first streamText run with a `tool-approval-request` part, and the
// second run only executes after the client replays a `tool-approval-response`. ai@6 can
// additionally HMAC-sign that approval (streamText `experimental_toolApprovalSecret`), but we
// deliberately do NOT enable that on the native assistant-ui path — the replay drops the request
// signature, so it would fail the resume call rather than add protection (see chatRun.ts).
//
// This ApprovalGuard is therefore the AUTHORITATIVE write gate — toolCallId + input hash + expiry,
// surviving across the two HTTP calls of one approval round-trip (architecture §5.3, §13.4;
// phase-04 §5/§6):
//   - register(toolCallId, …) runs in the write tool's `needsApproval` callback on the
//     FIRST call (when ai@6 decides the tool needs approval). It stamps a record keyed
//     by the stable toolCallId with the input hash + an expiry. KEEP-FIRST ABSOLUTE:
//     a re-evaluation on the second call never refreshes the record (so the expiry
//     window is anchored to when the approval was first requested, and an input swap
//     cannot rewrite the bound hash).
//   - verify(toolCallId, input) runs inside `execute` on the SECOND call (i.e. only
//     after the user approved). It enforces: record exists, not expired, and the executed
//     input matches the approved input — a directly-changed exec input is rejected for ALL
//     tiers (E_APPROVAL_HASH_MISMATCH — "no silent input swap"). The ONLY way to change a
//     write's input is a UI edit via applyEdit (the resolve side-channel), which PINS identity
//     fields + overlays only editableFields; verify() then runs that override (record.editedInput)
//     and reports userEdited so audit records it.
//
// 🔴 Pure Node (node:crypto only) — no electron / chat_db / ai imports, so the gateway
//    core stays harness-testable and this guard is directly unit-testable. The store is
//    a module-instance Map shared across the two HTTP calls of one approval round-trip
//    (the Electron wrapper builds ONE guard per gateway start and binds it into every
//    request's tool factory). A gateway restart between the two calls drops the record →
//    verify fails closed (E_APPROVAL_NOT_FOUND). Fail-closed is the safe direction for a
//    write gate.
//
// Phase 04a — edit-tier UI edits via a domain side-channel (closes architecture §13.10.2(1)).
//   ai@6's signed approval binds the signature to the tool INPUT IN THE MESSAGE HISTORY and
//   `signToolApproval` is NOT exported, so we cannot re-sign an edited input in ai@6's format.
//   Instead the user's edit NEVER touches the ai@6 history input: the rich card POSTs the
//   edited fields to POST /api/ai/approval/resolve, which calls `applyEdit` to stamp an
//   `editedInput` override onto the record (edit-tier only; identity fields pinned to the
//   original). On the second streamText call ai@6 re-verifies its signature against the
//   UNCHANGED history input (still valid → secret stays ON, no security regression), runs
//   `execute`, and the write tool runs `verify(...).effectiveInput` — which returns the
//   override. So the edit takes effect domain-side ("域内 re-approve") with the ai@6 signature
//   intact. preview-tier never registers editable fields, so applyEdit rejects it.

import { createHash, randomUUID } from 'node:crypto'

/** Risk tier of a write tool, mirroring the legacy confirmationTier (write.ts) +
 *  tool_catalog.json. 'preview' = reversible, approve/reject only (no input edit).
 *  'edit' = user-editable input (e.g. a draft body) before the write.
 *  'blocking' (Phase 04b) = high-risk irreversible OUTBOUND (email_prepare_send): like 'edit'
 *  for the editable/re-approve path (all send fields are editable on the SendApprovalCard), but
 *  additionally carries a one-shot idempotency key (consume()) and a content-hash binding the
 *  gateway + Python both verify (the "double guard"). 🔴 At the eval/persistence layer this maps
 *  DOWN to confirmationTier='edit' (tool_catalog + chat_tool_call CHECK only allow
 *  silent/preview/edit); 'blocking' is the gateway/A2UI-risk vocabulary only. */
export type ApprovalRisk = 'preview' | 'edit' | 'blocking'

/** Approval error codes surfaced to the model as a tool-error (normalizeToolError
 *  reads the duck-typed `.code`). Distinct from ai@6's InvalidToolApprovalSignatureError
 *  (the transport-layer guard) — these are the domain-layer guard. */
export type ApprovalErrorCode =
  | 'E_APPROVAL_NOT_FOUND'
  | 'E_APPROVAL_EXPIRED'
  | 'E_APPROVAL_HASH_MISMATCH'
  // Phase 04a — applyEdit on a non-editable (preview) record, or a record that registered
  // no editable fields. preview writes are approve/reject only — they cannot be edited.
  | 'E_APPROVAL_NOT_EDITABLE'
  // Phase 04b — consume() on a blocking-tier approval that was already executed once. The
  // gateway-scope idempotency guard for outbound send (a replayed approval-response must NOT
  // send twice). Fail-closed: a used approval is dead; a retry needs a fresh approval.
  | 'E_APPROVAL_USED'

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
  /** Phase 04a — the original model-proposed input (kept so applyEdit can pin identity
   *  fields and only overlay the editable ones). */
  input: unknown
  /** Phase 04a — which top-level input fields the user may edit (edit-tier only, e.g.
   *  ['body_markdown'] for email_draft_reply). Empty/undefined → applyEdit rejects. */
  editableFields?: readonly string[]
  /** Phase 04a — the effective input after a UI edit (set by applyEdit). undefined until the
   *  user edits; once set, verify() returns it as effectiveInput + userEdited. */
  editedInput?: unknown
  /** Phase 04b — blocking-tier (outbound send) only: a one-shot idempotency key generated at
   *  register time. Carried to the Python send-approved endpoint (its send ledger keys on it);
   *  undefined for preview/edit writes. */
  idempotencyKey?: string
  /** Phase 04b — set by consume() the first time a blocking approval is executed. A second
   *  consume() (replayed approval-response) throws E_APPROVAL_USED → the send never runs twice. */
  usedAt?: number
  /** Part B (harness 上岛) — set by reject() when a REJECT decision lands on ANY surface (island
   *  /decide reject, or the renderer's rejected approval-response). A rejected approval is terminal:
   *  verify() throws E_APPROVAL_USED so the OTHER surface can never approve+execute it afterwards
   *  ("先到先赢" across renderer + island). Only ever set when island agent is on (the only caller). */
  rejectedAt?: number
  createdAt: number
  expiresAt: number
}

/** verify() outcome: the matched record, whether the executed input was edited (ONLY via an
 *  applyEdit override — a directly-changed exec input is rejected for all tiers), and the
 *  `effectiveInput` the tool MUST run with (the applyEdit override when present, else the verified
 *  input). A hash mismatch with no applyEdit override throws E_APPROVAL_HASH_MISMATCH. */
export interface ApprovalVerifyResult {
  record: ApprovalRecord
  userEdited: boolean
  /** The input the write tool should execute with: the applyEdit override (UI edit), or the
   *  verified input itself (no edit). */
  effectiveInput: unknown
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
  private readonly genIdempotency: () => string

  constructor(opts?: {
    ttlMs?: number
    now?: () => number
    genId?: () => string
    /** Phase 04b — injectable idempotency-key generator (deterministic in tests). */
    genIdempotency?: () => string
  }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.now = opts?.now ?? (() => Date.now())
    this.genId = opts?.genId ?? (() => `apr-${randomUUID()}`)
    this.genIdempotency = opts?.genIdempotency ?? (() => `idem-${randomUUID()}`)
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
    input: unknown,
    editableFields?: readonly string[]
  ): ApprovalRecord {
    const existing = this.store.get(toolCallId)
    if (existing) return existing
    const createdAt = this.now()
    const editable =
      (risk === 'edit' || risk === 'blocking') && editableFields && editableFields.length > 0
    const record: ApprovalRecord = {
      approvalId: this.genId(),
      toolCallId,
      toolName,
      risk,
      inputHash: hashApprovalInput(input),
      input,
      // editable fields matter for edit + blocking tiers; for preview they stay undefined so
      // applyEdit fails E_APPROVAL_NOT_EDITABLE.
      ...(editable ? { editableFields } : {}),
      // blocking (outbound send) carries a one-shot idempotency key Python's send ledger keys on.
      ...(risk === 'blocking' ? { idempotencyKey: this.genIdempotency() } : {}),
      createdAt,
      expiresAt: createdAt + this.ttlMs
    }
    this.store.set(toolCallId, record)
    return record
  }

  /**
   * Phase 04a — apply a UI edit to a pending edit-tier approval (the POST /api/ai/approval/
   * resolve side-channel). The user changed some editable fields on the rich card before
   * approving; record the effective input so the second-call execute runs it. Identity
   * fields are PINNED to the original input (only `editableFields` are overlaid from the
   * edit), so the side channel can never swap, say, internal_id. Throws ApprovalError when:
   *   - no record (E_APPROVAL_NOT_FOUND) / expired (E_APPROVAL_EXPIRED);
   *   - the record is not edit-tier or registered no editable fields (E_APPROVAL_NOT_EDITABLE
   *     — preview writes are approve/reject only).
   * The ai@6 history input is UNCHANGED, so the signed approval stays valid on replay.
   */
  applyEdit(toolCallId: string, editedFields: Record<string, unknown>): ApprovalRecord {
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
    const editableTier = record.risk === 'edit' || record.risk === 'blocking'
    if (!editableTier || !record.editableFields || record.editableFields.length === 0) {
      throw new ApprovalError(
        'E_APPROVAL_NOT_EDITABLE',
        `${record.toolName} is not editable (preview-tier writes are approve/reject only)`
      )
    }
    // Overlay ONLY the editable fields from the edit onto the original input (identity pin).
    // Expected single-shot per approval round-trip (one card POSTs once before approving); a
    // second resolve is last-write-wins, which the single-renderer Electron flow never races.
    const base = (record.input ?? {}) as Record<string, unknown>
    const effective: Record<string, unknown> = { ...base }
    for (const field of record.editableFields) {
      if (Object.prototype.hasOwnProperty.call(editedFields, field)) {
        effective[field] = editedFields[field]
      }
    }
    record.editedInput = effective
    return record
  }

  /**
   * Verify a tool call may execute with the given input. Called inside `execute` on the second
   * run. Throws ApprovalError when no record exists, it has expired, or the executed input does not
   * match the approved input (E_APPROVAL_HASH_MISMATCH — for ALL tiers). The only sanctioned input
   * change is an applyEdit override (record.editedInput) — returned as effectiveInput with
   * userEdited=true, identity fields pinned.
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
    // Part B — a rejected approval is terminal: once ANY surface rejected it, no surface may
    // execute it (the island + renderer race — "先到先赢"). reject() only fires when island agent
    // is on, so this is inert (rejectedAt never set) in the pre-Part-B renderer-only flow.
    if (record.rejectedAt !== undefined) {
      throw new ApprovalError(
        'E_APPROVAL_USED',
        `approval ${record.approvalId} was already rejected — re-propose the action`
      )
    }
    // Phase 04a — a UI edit (applyEdit side-channel) is authoritative. The ai@6 history input
    // is unchanged (so the signature verified before we got here) and hashes to inputHash;
    // the user's edited fields live in record.editedInput. Execute that, report userEdited.
    if (record.editedInput !== undefined) {
      return { record, userEdited: true, effectiveInput: record.editedInput }
    }
    const inputHash = hashApprovalInput(input)
    if (inputHash !== record.inputHash) {
      // A directly-changed exec input is NEVER accepted — for ANY tier (M4b review HIGH-1). The ONLY
      // legitimate way to change a write's input is a UI edit via applyEdit (handled above through
      // record.editedInput, which PINS identity fields and overlays only editableFields). Accepting a
      // raw changed exec input here would let a mutated / replayed history input retarget a pinned
      // identity field (e.g. update_system_md's doc_name, or email_prepare_send's recipients) on an
      // edit/blocking-tier write. The gateway does not use ai@6 signed approval (chatRun.ts), so this
      // domain guard is THE authoritative gate and must reject every hash mismatch.
      throw new ApprovalError(
        'E_APPROVAL_HASH_MISMATCH',
        `approved input was modified for ${record.toolName} — re-propose the action (edits apply through the approval card, not by changing the executed input)`
      )
    }
    return { record, userEdited: false, effectiveInput: input }
  }

  /**
   * Phase 04b — atomically reserve a blocking-tier (outbound send) approval for its ONE allowed
   * execution. The send tool calls this right before dispatching to Python: the first call sets
   * `usedAt` and returns the record; a second call (a replayed approval-response, or a renderer
   * that fires execute twice) throws E_APPROVAL_USED so the email is never sent twice — the
   * gateway-scope half of the idempotency guard (Python's send ledger is the cross-process half).
   * Also re-checks not-found / expiry so a stale approval can't be consumed. Fail-closed: a
   * consumed approval is dead even if the subsequent send fails — a retry needs a fresh approval.
   */
  consume(toolCallId: string): ApprovalRecord {
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
    if (record.usedAt !== undefined) {
      throw new ApprovalError(
        'E_APPROVAL_USED',
        `approval ${record.approvalId} was already executed (a send is never replayed)`
      )
    }
    record.usedAt = this.now()
    return record
  }

  /**
   * Part B (harness 上岛) — TOMBSTONE an approval as REJECTED. Idempotent + never throws: it marks
   * the record so a later verify() (from the OTHER surface) fails closed. Called when a reject lands
   * on either surface — the island /decide reject path, or the renderer's rejected approval-response
   * (detected in makePersistOnFinish). No-op if the record is gone (already GC'd) or already used
   * (the approve won the race first — leave usedAt authoritative). This is the reject half of the
   * cross-surface "先到先赢" single-resolver (the approve half is consume()/usedAt).
   */
  reject(toolCallId: string): void {
    const record = this.store.get(toolCallId)
    if (!record) return
    if (record.usedAt !== undefined) return // approve already executed → don't overwrite the outcome
    if (record.rejectedAt === undefined) record.rejectedAt = this.now()
  }

  /** Part B — true once a terminal decision landed on ANY surface (approved+executed OR rejected).
   *  The island /decide short-circuits on this so it never re-runs an approval the renderer already
   *  resolved. Read-only. */
  isResolved(toolCallId: string): boolean {
    const record = this.store.get(toolCallId)
    if (!record) return false
    return record.usedAt !== undefined || record.rejectedAt !== undefined
  }

  /**
   * Phase 05 — READ-ONLY peek at a pending approval record (the AG-UI mirror's interrupt enricher
   * uses it to surface risk / reason / expiry without mutating the guard). Returns null when no
   * record exists. Unlike verify()/consume() it NEVER mutates and NEVER throws on expiry — it is a
   * pure getter, so it can never be a side-door that advances or consumes an approval.
   */
  peek(toolCallId: string): ApprovalRecord | null {
    return this.store.get(toolCallId) ?? null
  }

  /** Diagnostic — number of records currently held (tests / observability). */
  size(): number {
    return this.store.size
  }
}
