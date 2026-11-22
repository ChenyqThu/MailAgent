// Approval resolve/decide/pending and policy-remember handlers.
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type AiGatewayConfig } from '../config'
import { extractApprovalStashInput, resolveApprovalPreview } from '../chatRun'
import { readJsonBody, writeJson } from '../httpUtil'
import { APPROVAL_REASON_MAX_CHARS, resumeApprovalRun } from '../approvalResume'

/** Map an ApprovalError-shaped `.code` to an HTTP status for the resolve endpoint. */
function approvalErrorStatus(code: string): number {
  switch (code) {
    case 'E_APPROVAL_NOT_FOUND':
      return 404
    case 'E_APPROVAL_EXPIRED':
      return 410
    case 'E_APPROVAL_NOT_EDITABLE':
      return 400
    default:
      return 400
  }
}

/**
 * `POST /api/ai/approval/resolve` — Phase 04a edit-tier side-channel. The rich DraftReplyCard
 * POSTs the user's edited fields here BEFORE replaying the ai@6 approval. The gateway overlays
 * the editable fields onto the pending approval's original input (via cfg.resolveEditedApproval
 * → ApprovalGuard.applyEdit) so the next streamText call's execute runs the edited input — all
 * WITHOUT changing the ai@6 history input, so the signed approval stays valid (architecture
 * §13.10.2(1)). Identity fields are pinned domain-side. Errors are typed: 404 not-found / 410
 * expired / 400 not-editable / 501 when no resolver is wired (read-only / 03b config).
 *
 * L4 批次2 — a second body shape `{ approvalId, editedInput }` for the in-panel decide card, the
 * SAME id-resolution /decide already does (S6 W2 P9): that surface only ever learns the approvalId
 * from GET /pending, never the internal toolCallId. The gateway peeks the stash by approvalId
 * (read-only — the claim still happens later, inside /decide) and drives the identical applyEdit.
 * A miss → 404, so a stale card cannot edit anything. 🔴 Order matters for the caller: /resolve
 * FIRST, /decide second — /decide claims the stash, after which the approvalId no longer resolves.
 */
export async function handleApprovalResolve(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.resolveEditedApproval) {
    writeJson(res, 501, {
      error: 'E_NOT_IMPLEMENTED',
      hint: 'edit-tier approval cards not enabled'
    })
    return
  }
  const body = await readJsonBody(req)
  const bodyToolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  const editedInput =
    body.editedInput && typeof body.editedInput === 'object' && !Array.isArray(body.editedInput)
      ? (body.editedInput as Record<string, unknown>)
      : null
  // L4 批次2 — resolve the { approvalId } shape to the internal toolCallId through the stash
  // (peek = read-only; the entry stays claimable for the /decide that follows). No stash wired or
  // no live entry → 404 not_found, the same fail-closed shape /decide answers for a stale id.
  let toolCallId = bodyToolCallId
  if (!toolCallId && approvalId) {
    const entry = cfg.approvalStash?.peekByApprovalId(approvalId) ?? null
    if (!entry) {
      writeJson(res, 404, { error: 'E_APPROVAL_NOT_FOUND', hint: 'no live pending approval' })
      return
    }
    toolCallId = entry.toolCallId
  }
  if (!toolCallId || !editedInput) {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'toolCallId (or approvalId) + editedInput{} required'
    })
    return
  }
  try {
    const out = cfg.resolveEditedApproval(toolCallId, editedInput)
    writeJson(res, 200, { status: 'ok', ...out })
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const message = e instanceof Error ? e.message : String(e)
    if (typeof code === 'string') {
      if (code === 'E_APPROVAL_EXPIRED') cfg.markApprovalExpired?.(toolCallId)
      writeJson(res, approvalErrorStatus(code), { error: code, hint: message })
    } else {
      // Unexpected non-ApprovalError on a security-adjacent endpoint — log for forensics
      // (never executes a write; the resolver only records an override).
      console.error('[ai-gateway] /api/ai/approval/resolve failed unexpectedly', e)
      writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
    }
  }
}

/**
 * `POST /api/ai/policy/remember` — S2 W1 exec whitelist "always allow" side-channel. The exec
 * approval card POSTs { toolCallId } when the user ticks "always allow" and approves. The gateway
 * peeks the pending exec approval (guard.peek — the SAME approved argv/cwd/path), derives a
 * full-PIN structured PolicyRule, and persists it via the owner policy API (cfg.rememberExecApproval).
 * This is the ONLY rule-creation path besides Settings; no gateway TOOL can reach it. Typed errors:
 * 404 not-found / 400 bad-arg (non-exec / derivation) / 501 when exec tools aren't wired.
 */
export async function handlePolicyRemember(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  const body = await readJsonBody(req)
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  // S6 W3-3 — the { approvalId } shape is the in-record web_fetch "always allow this domain" PIN:
  // derive a per-agent web origin rule from the STASHED headless approval (agent-run-only; a manual
  // web_fetch never stashes). Distinct hook from the exec { toolCallId } path (manual approvalGuard,
  // context_mode pinned to manual_chat) — a web remember keys the agent + server-derived context.
  if (approvalId) {
    if (!cfg.rememberWebApproval) {
      writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'web tools not enabled' })
      return
    }
    try {
      const rule = await cfg.rememberWebApproval(approvalId)
      writeJson(res, 200, { status: 'ok', rule })
    } catch (e) {
      const code = (e as { code?: unknown }).code
      const message = e instanceof Error ? e.message : String(e)
      if (typeof code === 'string') {
        writeJson(res, approvalErrorStatus(code), { error: code, hint: message })
      } else {
        console.error('[ai-gateway] /api/ai/policy/remember (web) failed unexpectedly', e)
        writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
      }
    }
    return
  }
  // Exec { toolCallId } path — byte-identical to S2 W1.
  if (!cfg.rememberExecApproval) {
    writeJson(res, 501, { error: 'E_NOT_IMPLEMENTED', hint: 'exec tools not enabled' })
    return
  }
  if (!toolCallId) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'toolCallId or approvalId required' })
    return
  }
  try {
    const rule = await cfg.rememberExecApproval(toolCallId)
    writeJson(res, 200, { status: 'ok', rule })
  } catch (e) {
    const code = (e as { code?: unknown }).code
    const message = e instanceof Error ? e.message : String(e)
    if (typeof code === 'string') {
      writeJson(res, approvalErrorStatus(code), { error: code, hint: message })
    } else {
      console.error('[ai-gateway] /api/ai/policy/remember failed unexpectedly', e)
      writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
    }
  }
}

/**
 * `POST /api/ai/approval/decide` — server-side approval resume. Two callers, two body shapes:
 *   - ISLAND (Part B): `{ toolCallId, decision, resumeToken }`. serve-api echoes back the gateway-minted
 *     capability token; approvalStash.claim rejects a wrong one. Used when the user is fully off the app.
 *   - IN-RECORD (S6 W2, PRD P9): `{ approvalId, decision }` — NO resumeToken. The record view has no
 *     capability token (it must never leave the gateway); the gateway resolves the internal toolCallId +
 *     resumeToken from the stash by approvalId (peekByApprovalId) and drives the SAME resume. A
 *     wrong/stale approvalId → 404 not_found (fail-closed). Loopback-trusted like the other gateway
 *     endpoints (serve-api's ai_gateway_proxy fronts the remote-web parity, CF-Access-gated upstream).
 *
 * Registered unconditionally; cfg.approvalStash gates it (404 when server-side resume is off →
 * byte-identical to pre-S6; the stash presence, not the island flag, is the gate since S6 W2 P8).
 */
export async function handleApprovalDecide(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  const stash = cfg.approvalStash
  if (!stash) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'approval resume not enabled' })
    return
  }
  const body = await readJsonBody(req)
  // P1-1 (codex r1) — the decision is a fail-closed security floor: ONLY the exact strings
  // 'approve' / 'reject' are accepted. Everything else — a missing field, 'rejected', case variants
  // ('Approve'), or a proxy-mangled value — answers 400 WITHOUT touching the stash (still claimable
  // by a corrected retry). The previous `=== 'reject' ? 'reject' : 'approve'` defaulted every
  // unknown shape to APPROVE, which with the always-on /pending + serverResumeEnabled would execute
  // a real write tool off a malformed request.
  const decision: 'approve' | 'reject' | null =
    body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null
  if (decision == null) {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: "decision must be exactly 'approve' or 'reject'"
    })
    return
  }
  // L4 批次2 — the optional REJECTION REASON (the「不批但给文字指导」response dimension). Validated
  // whenever present, whatever the decision, and BEFORE the stash is touched: a malformed field is a
  // malformed request, and a 400 here leaves the approval claimable by a corrected retry. It only
  // has an EFFECT on reject — ai@7's convertToModelMessages emits a tool-result only for
  // `approved === false` (`{type:'execution-denied', reason}`), so an approve-side reason would be
  // collected and never seen; approvalResume drops it rather than pretend otherwise.
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string') {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'reason must be a string' })
      return
    }
    if (body.reason.length > APPROVAL_REASON_MAX_CHARS) {
      writeJson(res, 400, {
        error: 'E_INVALID_ARG',
        hint: `reason must be at most ${APPROVAL_REASON_MAX_CHARS} characters`
      })
      return
    }
  }
  const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : undefined
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : ''
  const resumeToken = typeof body.resumeToken === 'string' ? body.resumeToken : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  // Resolve to the island shape { toolCallId, resumeToken } either from the body (island) or from the
  // stash by approvalId (in-record — the token is read from the entry, never sent by the caller).
  // Strict discriminated shapes: island requires BOTH toolCallId and resumeToken; in-record requires
  // approvalId; anything else (partial island shape without approvalId) → 400.
  let resolved: { toolCallId: string; resumeToken: string } | null = null
  // P1-2 — the entry PEEKED (never claimed) so the session lease below can key off its sessionId; a
  // lease rejection must leave the stash claimable for a later retry.
  let peeked: ReturnType<typeof stash.peek> = null
  if (toolCallId && resumeToken) {
    resolved = { toolCallId, resumeToken }
    peeked = stash.peek(toolCallId)
  } else if (approvalId) {
    const entry = stash.peekByApprovalId(approvalId)
    // miss / wrong approvalId → fail-closed (no live claimable approval): 404 not_found, same shape the
    // resume returns for a miss, so the record-view client treats it identically.
    if (!entry) {
      writeJson(res, 404, { ok: false, status: 'not_found', error: 'no live pending approval' })
      return
    }
    resolved = { toolCallId: entry.toolCallId, resumeToken: entry.resumeToken }
    peeked = entry
  } else {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'either { toolCallId, resumeToken } or { approvalId } required'
    })
    return
  }
  // The resume drives a real write tool; the fork's ack POST is fire-and-forget (5s, doesn't read the
  // body), and serve-api awaits us in a background task, so a long resume is fine. Abort if serve-api
  // disconnects.
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  // P1-2 (codex r1) — the resume drives the SAME streamText + persistTurn pipeline as a normal
  // /api/ai/chat turn, so it must hold the SAME per-session lease (ActiveRunRegistry). Take the slot
  // BEFORE resumeApprovalRun claims the stash: a lease miss (a chat run is streaming for this
  // session) answers 409 with the stash INTACT — the decision is retryable once the run settles —
  // and while the resume runs, /run/active truthfully reports it (409-fencing new same-session
  // POSTs via handleChat's gate + driving the panel's background placeholder). The finally releases
  // by runId (runId-matched → a stale release can never evict a newer run). Registry unwired
  // (detached runs off) or an unsaved/unknown session → no lease domain, pre-P1-2 flow unchanged.
  const resumeSessionId = peeked?.sessionId ?? null
  let leaseToken: { runId: string } | null = null
  if (cfg.activeRuns && resumeSessionId != null) {
    leaseToken = cfg.activeRuns.register(resumeSessionId, controller)
    if (leaseToken == null) {
      writeJson(res, 409, {
        ok: false,
        status: 'error',
        error: 'E_RUN_ACTIVE: a chat run is already streaming for this session'
      })
      return
    }
  }
  try {
    const result = await resumeApprovalRun(
      cfg,
      {
        toolCallId: resolved.toolCallId,
        decision,
        resumeToken: resolved.resumeToken,
        ...(reason !== undefined ? { reason } : {}),
        // codex r2 [C] — the resume's persists broadcast under the lease's runId (per-run dedup).
        runId: leaseToken?.runId
      },
      controller.signal
    )
    // Part B (dogfood live-refresh) — a TERMINAL settle (completed / rejected / error) on a persisted
    // session notifies the lifecycle so an open chat panel reloads instead of showing the stale
    // approval card. 'repaused' is NOT terminal (a fresh island card owns the next hop; the panel's
    // card is still live) and 'not_found' ran nothing. Best-effort: a hook throw must not break the
    // HTTP response to serve-api.
    if (
      result.sessionId != null &&
      (result.status === 'completed' || result.status === 'rejected' || result.status === 'error')
    ) {
      try {
        cfg.onServerResumeSettled?.(result.sessionId, result.status)
      } catch (err) {
        console.error('[ai-gateway] onServerResumeSettled hook failed (resume settled OK)', err)
      }
    }
    const status = result.status === 'not_found' ? 404 : 200
    writeJson(res, status, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai-gateway] /api/ai/approval/decide failed', err)
    writeJson(res, 500, { ok: false, status: 'error', error: message })
  } finally {
    if (leaseToken && resumeSessionId != null) {
      cfg.activeRuns!.release(resumeSessionId, leaseToken.runId)
    }
  }
}

/**
 * `GET /api/ai/approval/pending?sessionId=N` — the pending-approval TRUTH probe. Two consumers:
 *   - Part B island notice (AiChatPanel): a reloaded session shows only the REDACTED paused turn
 *     (approval parts stripped, R2-3), but with island agent on the approval may still be live in
 *     the stash — the notice reads { pending, toolName } to say "act on the island".
 *   - S6 W1 in-record approval (record view): live-queries this to decide whether to render an
 *     actionable decide card (hit) or an honest "已失效（超时或应用重启）" state (miss).
 * Read-only: peekBySession never consumes / extends the stash.
 *
 * miss → 404 { pending:false } (S6 W1): the stash is process-memory (gateway restart drops it), so
 * a miss is the fail-closed truth "no live claimable approval" — an honest boundary the record view
 * needs. The island-notice consumer already treats !res.ok as pending:false, so the 404 is
 * backward-compatible there. Stash unwired (both server-resume flags off, S6 W2 P8) → also a miss
 * (nothing is claimable).
 *
 * 🔴 SECURITY — the hit body enriches with approvalId/inputPreview/agentId/jobId/ageMs for the
 * decide card, but NEVER the resumeToken: that capability must only leave the gateway through the
 * serve-api announce leg. `pending:true` + `toolName` are kept verbatim for the island-notice
 * consumer (superset, zero-touch).
 *
 * L4 批次2 — three more fields, all additive:
 *   - `input` — the EFFECTIVE input (guard `editedInput ?? input`; the stashed model proposal when
 *     no guard is wired). The decide card renders an editor over it for the editable fields.
 *   - `editableFields` — what the tool factory registered as editable (empty ⇒ approve/reject only,
 *     the same boundary ApprovalGuard.applyEdit enforces with E_APPROVAL_NOT_EDITABLE).
 *   - `contextMode` — the mode FROZEN at pause time. The card needs it to decide whether a
 *     「记住这类操作」affordance would be a live config or a dead one: `tool_approval_pref` is
 *     consulted ONLY in manual_chat (tools/types.ts:411 / tool_prefs.py 头注), so offering it on an
 *     im_chat or headless pause would promise something the ladder never reads. `null` = unknown
 *     (hand-built stash entry) → the card must fail closed and offer nothing.
 */
export async function handleApprovalPending(
  res: ServerResponse,
  cfg: AiGatewayConfig,
  url: string
): Promise<void> {
  const raw = new URL(url, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw != null && /^-?\d+$/.test(raw) ? Number(raw) : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  const entry = cfg.approvalStash ? cfg.approvalStash.peekBySession(sessionId) : null
  if (!entry) {
    writeJson(res, 404, { pending: false })
    return
  }
  const info = extractApprovalStashInput(entry.responseMessage)
  // L4 批次1 #6 — same preview source as the island announce leg (server-derived facts first,
  // the model's args second). Async now: this handler awaits serve-api, which is why it is
  // dispatched through the crash belt. Unreadable stash input (no approval part) keeps the bare
  // toolName — there is no input to describe, and inventing one is worse than saying less.
  const inputPreview = info
    ? await resolveApprovalPreview(cfg, entry.toolName, info.input)
    : entry.toolName
  // L4 批次2 — the guard record is the authority on BOTH new fields: it holds any editedInput a
  // previous /resolve overlaid (so a re-opened card edits from where the last edit left off) and the
  // editableFields the tool factory registered. No guard wired → the stashed proposal + no editor.
  const record = cfg.peekApprovalRecord?.(entry.toolCallId) ?? null
  writeJson(res, 200, {
    pending: true,
    approvalId: entry.approvalId,
    toolName: entry.toolName,
    inputPreview,
    input: record ? record.input : (info?.input ?? null),
    editableFields: record?.editableFields ?? [],
    contextMode: entry.contextMode ?? null,
    agentId: entry.agentRunContext?.agentId ?? null,
    jobId: entry.agentRunContext?.jobId ?? null,
    // Stage 2 PR-4 (task 08-01 messenger) — the frozen DESTRUCTIVE bit, so an out-of-app approval
    // surface (Feishu card) renders the same red warning the desktop McpApprovalCard does. Always
    // a boolean (never undefined) so a consumer can't mistake "absent" for "unknown"; pre-PR-4
    // stash rows / non-connector tools → false = no warning, the previous behaviour verbatim.
    destructive: entry.destructive === true,
    ageMs: Date.now() - entry.createdAt
  })
}
