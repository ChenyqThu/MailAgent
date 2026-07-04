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
      ageMs: typeof body.ageMs === 'number' ? body.ageMs : 0
    }
  } catch {
    return null
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
    return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}
