// S6 W1 — renderer client for the in-record approval seam (record-view approval).
//
// Two gateway-channel calls, mirroring searchAgentClient's thin-client pattern (resolveAiGatewayBaseUrl
// → fetch): the record view live-queries the pending TRUTH, then drives the decision through the SAME
// server-side POST /api/ai/approval/decide the island uses (PRD P3 — a headless run has no active
// useChat stream to resume, so assistant-ui's respondToApproval is unusable; /decide is the only
// channel). W2 consumes these; this wave is API-layer only (no UI).
//
// Transport (resolveAiGatewayBaseUrl, `=== null`-checked — '' is a valid same-origin base):
//   - Desktop: loopback gateway (direct).
//   - Web: '' (same-origin) → serve-api ai_gateway_proxy forwards both /api/ai/approval/{pending,
//     decide} to the loopback gateway (routes added S6 W1 → remote-web parity).
//   - null (gateway not injected / non-renderer) → treated as unavailable.

import { resolveAiGatewayBaseUrl } from './runtime/flags'
import { errorMessage } from '@shared/lib/ipcErrors'

/** GET /api/ai/approval/pending hit body (miss → null). 🔴 NEVER carries the resumeToken — that
 *  capability leaves the gateway only through the serve-api announce leg. */
export interface PendingApprovalInfo {
  approvalId: string
  toolName: string
  /** A compact one-line preview of the model-proposed tool input (for the decide card). */
  inputPreview: string
  /** The custom-agent id when this is a headless agent run; null for a manual-chat approval. */
  agentId: string | null
  /** The async_jobs row id when this is a headless agent run; null otherwise. */
  jobId: number | null
  /** Age since the approval was stashed (ms) — the card can show "N 分钟前". */
  ageMs: number
  /** Stage 2 PR-4 — the connector tool's frozen destructive_hint (server-side registry, never the
   *  model). The server has always returned it; the type omitted it, so the desktop card silently
   *  rendered no warning while the Feishu card did (r1 §Caveats 末条). */
  destructive: boolean
  /** L4 批次2 — the EFFECTIVE tool input (a previous /resolve edit overlaid, else the model's
   *  proposal). `null` when the stashed message carried no readable approval part. */
  input: unknown
  /** L4 批次2 — fields the tool factory registered as editable. Empty ⇒ approve/reject only (the
   *  same boundary ApprovalGuard.applyEdit enforces); the card offers no editor. */
  editableFields: string[]
  /** L4 批次2 — the context mode FROZEN at pause time. `'manual_chat'` is the only mode in which
   *  `tool_approval_pref` is consulted, so it gates the「记住这类操作」affordance; `null` = unknown
   *  (older/hand-built stash entry) → fail closed, offer nothing. */
  contextMode: string | null
}

/** POST /api/ai/approval/decide terminal result (mirrors the gateway ResumeResult wire shape). */
export interface ApprovalDecideResult {
  ok: boolean
  /** 'completed'/'rejected' = terminal; 'repaused' = a fresh approval now awaits (not terminal);
   *  'not_found' = no live stash (restarted / already claimed / wrong token); 'error' = resume threw. */
  status: 'completed' | 'rejected' | 'repaused' | 'not_found' | 'error'
  sessionId?: number | null
  summary?: string
  error?: string
}

/** Live-query the pending TRUTH for a session. Hit → PendingApprovalInfo; miss (404) / gateway
 *  unavailable / malformed body / any error → null (the record view then shows the honest
 *  "审批已失效（超时或应用重启）" state). Never throws. */
export async function fetchPendingApproval(sessionId: number): Promise<PendingApprovalInfo | null> {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (baseUrl == null) return null
  try {
    const res = await fetch(`${baseUrl}/api/ai/approval/pending?sessionId=${sessionId}`)
    if (!res.ok) return null // 404 miss = fail-closed truth (stash 纯内存, 重启即 miss)
    const body = (await res.json()) as Record<string, unknown>
    if (
      body.pending !== true ||
      typeof body.approvalId !== 'string' ||
      typeof body.toolName !== 'string'
    ) {
      return null
    }
    return {
      approvalId: body.approvalId,
      toolName: body.toolName,
      inputPreview: typeof body.inputPreview === 'string' ? body.inputPreview : body.toolName,
      agentId: typeof body.agentId === 'string' ? body.agentId : null,
      jobId: typeof body.jobId === 'number' ? body.jobId : null,
      ageMs: typeof body.ageMs === 'number' ? body.ageMs : 0,
      destructive: body.destructive === true,
      input: body.input ?? null,
      // Absent / malformed (a gateway older than this build) → no editor, no remember affordance:
      // both degrade to the pre-L4 approve/reject card rather than guess.
      editableFields: Array.isArray(body.editableFields)
        ? body.editableFields.filter((f): f is string => typeof f === 'string')
        : [],
      contextMode: typeof body.contextMode === 'string' ? body.contextMode : null
    }
  } catch {
    return null
  }
}

/** S6 W3-3 (ADR-004 rev3.1 §4.2 D-fix-3) — the in-record web_fetch "always allow this domain" PIN.
 *  POSTs { approvalId } to /api/ai/policy/remember when the owner ticks the affordance and approves;
 *  the gateway peeks the STASHED headless approval, derives a per-agent web origin rule from the
 *  approved URL (origin normalized server-side), and persists it. 🔴 Best-effort: a rule-creation
 *  failure must NEVER block the approve the owner already decided — the caller catches and proceeds
 *  to /decide. Returns true on success, false on any failure. Never throws. */
export async function postRememberWebPolicy(approvalId: string): Promise<boolean> {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (baseUrl == null) return false
  try {
    const res = await fetch(`${baseUrl}/api/ai/policy/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId })
    })
    return res.ok
  } catch {
    return false
  }
}

/** L4 批次2 — the in-panel EDIT side-channel: POST /api/ai/approval/resolve with the
 *  `{ approvalId, editedInput }` shape (the panel never learns the internal toolCallId; the gateway
 *  resolves it from the stash, read-only). The gateway overlays ONLY the registered editableFields
 *  onto the pending approval's input — identity fields stay pinned and the model's history input is
 *  untouched, so the approval stays valid on replay.
 *
 *  🔴 Call this BEFORE postApprovalDecide: /decide claims the stash, after which the approvalId no
 *  longer resolves. Throws the typed gateway code (E_APPROVAL_NOT_FOUND / _EXPIRED / _NOT_EDITABLE)
 *  on failure so the caller can surface it and NOT proceed to approve — an unsaved edit must never
 *  be approved silently as the model's original proposal. */
export async function postApprovalResolveEdit(
  approvalId: string,
  editedInput: Record<string, unknown>
): Promise<void> {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (baseUrl == null) throw new Error('E_NO_GATEWAY')
  const res = await fetch(`${baseUrl}/api/ai/approval/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId, editedInput })
  })
  if (!res.ok) {
    let code = `E_HTTP_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) code = body.error
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(code)
  }
}

/** Decide a pending approval server-side (approve / reject) — the SAME /decide channel the island
 *  uses, but with the in-record { approvalId, decision } shape (PRD P9): the record view carries NO
 *  capability token; the gateway resolves the internal toolCallId + resumeToken from the stash by
 *  approvalId (peekByApprovalId) so the token never leaves the gateway. `approvalId` comes from the
 *  live pending probe (fetchPendingApproval). A transport failure / unavailable gateway / stale
 *  approvalId → { ok:false, status:'error'|'not_found', ... }. Never throws. */
export async function postApprovalDecide(input: {
  approvalId: string
  decision: 'approve' | 'reject'
  /** L4 批次2 — the owner's free-text rejection reason. Reject-only by contract (the gateway drops
   *  it on approve, where ai@7 emits no tool-result to carry it). Omit for a plain decision — the
   *  body then matches the pre-L4 one byte for byte. */
  reason?: string
}): Promise<ApprovalDecideResult> {
  const baseUrl = resolveAiGatewayBaseUrl()
  if (baseUrl == null) {
    return { ok: false, status: 'error', error: 'ai gateway unavailable' }
  }
  try {
    const res = await fetch(`${baseUrl}/api/ai/approval/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const status = body.status
    return {
      ok: body.ok === true,
      status:
        status === 'completed' ||
        status === 'rejected' ||
        status === 'repaused' ||
        status === 'not_found' ||
        status === 'error'
          ? status
          : res.ok
            ? 'completed'
            : 'error',
      ...(typeof body.sessionId === 'number' || body.sessionId === null
        ? { sessionId: body.sessionId as number | null }
        : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(typeof body.error === 'string' ? { error: body.error } : {})
    }
  } catch (err) {
    return { ok: false, status: 'error', error: errorMessage(err) }
  }
}
