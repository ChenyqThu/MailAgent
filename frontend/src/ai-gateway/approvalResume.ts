// chat-panel Part B (harness 上岛) — server-side approval resume for full-offline island approval.
//
// POST /api/ai/approval/decide lands here (via server.ts). The renderer normally resumes a paused
// approval by replaying the full history + a tool-approval-response on a second /api/ai/chat; when the
// user is fully off the app (renderer unmounted) the island decision must resume the run WITHOUT the
// renderer. This reconstructs that same resume from the stash (the original body + the paused assistant
// message) and re-runs the SAME streamText + tools + ApprovalGuard as /api/ai/chat — no alternate
// write path (the tool's execute + guard.verify/consume still gate every write, architecture §13.10.3).
//
// 🔴 Reuses the AG-UI mirror's pure approval-response transition (applyApprovalResponseToMessages):
//    it flips the tool part `approval-requested` → `approval-responded` WITHOUT touching the input, so
//    the guard.verify hash still matches and the tool executes exactly as an in-app approve would.
//
// 🔴 Single-resolver: the stash.claim (in server.ts) is one-shot for the ISLAND side (two island
//    clicks → the second finds nothing). The RENDERER side (a concurrent in-app approve/reject) is
//    caught three ways: (1) cfg.isApprovalResolved short-circuits here BEFORE re-running when the
//    renderer already resolved it (approved+executed OR rejected — no double execute, no double
//    persist, and a renderer reject blocks a later island approve); (2) the write tool's one-shot
//    guard.consume (enabled with island agent) makes whichever execute lands second throw
//    E_APPROVAL_USED → never a double write; (3) an island reject tombstones the guard so a later
//    renderer approve fails closed too. Whichever surface acts FIRST wins ("先到先赢").

import {
  makeIdGenerator,
  makePersistOnFinish,
  prepareChatRun,
  responseMessageAwaitsApproval
} from './chatRun'
import type { AiGatewayConfig } from './config'
import {
  applyApprovalResponseToMessages,
  type ToolApprovalResponsePayload
} from './agui/interruptMapper'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { UIMessage } from 'ai'

export interface ResumeDecideInput {
  toolCallId: string
  decision: 'approve' | 'reject'
  resumeToken: string
}

export interface ResumeResult {
  ok: boolean
  /** 'completed' = approved + tool executed OK (or the OTHER surface already executed it — the action
   *  DID happen); 'rejected' = user rejected (model responded to the denial); 'repaused' = the resume
   *  ran the first tool but the model then requested ANOTHER approval — makePersistOnFinish already
   *  stashed + announced a fresh island card, so this is NOT terminal (serve-api must NOT clear/complete
   *  the card); 'not_found' = no live stash (gateway restarted / already claimed / wrong token); 'error'
   *  = the resume ran but the tool errored (e.g. guard mismatch) or streamText threw. */
  status: 'completed' | 'rejected' | 'repaused' | 'not_found' | 'error'
  /** A one-line human summary for the island completed/error card (the model's final text, clipped). */
  summary?: string
  error?: string
}

/** Clip the accumulated assistant text to a one-line island-card summary. */
function clipSummary(text: string, max = 180): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/**
 * Resume a stashed approval run server-side. Claims the stash one-shot (single-use), folds the
 * decision into the message history, re-runs streamText, drains the stream (driving the tool's
 * execute + guard + persistTurn), and reports a terminal status for the island card.
 */
export async function resumeApprovalRun(
  cfg: AiGatewayConfig,
  input: ResumeDecideInput,
  abortSignal: AbortSignal
): Promise<ResumeResult> {
  const stash = cfg.approvalStash
  if (!stash) return { ok: false, status: 'not_found', error: 'approval stash not wired' }

  const entry = stash.claim(input.toolCallId, input.resumeToken)
  if (!entry) return { ok: false, status: 'not_found', error: 'no live pending approval' }

  // Renderer-won-the-race short-circuit: if a TERMINAL decision already landed in-app (approved +
  // executed → usedAt, OR rejected → rejectedAt; ApprovalGuard.isResolved), do NOT re-run/re-persist.
  // Report 'completed' so the island clears its (now stale) card either way — the decision was made
  // in-app; the island click must not re-execute (finding 1) nor re-persist (finding 2).
  if (cfg.isApprovalResolved?.(entry.toolCallId)) {
    return { ok: true, status: 'completed', summary: '已在 app 内处理' }
  }

  const approved = input.decision === 'approve'
  // finding 1 — an island REJECT is terminal: tombstone the guard BEFORE the replay so a later (or
  // concurrent) renderer approve fails closed (verify → E_APPROVAL_USED). Idempotent / never throws;
  // inert when rejectApproval is unwired (but island agent off never reaches this path). The approve
  // path never tombstones — the write tool's one-shot guard.consume is the approve-side resolver.
  if (!approved) cfg.rejectApproval?.(entry.toolCallId)
  const approvalResp: ToolApprovalResponsePayload = {
    toolCallId: entry.toolCallId,
    approvalId: entry.approvalId,
    decision: approved ? 'approved' : 'rejected'
  }

  // Resume history = the original turn's messages + the paused assistant message, with the tool part
  // transitioned to approval-responded. (Same shape the renderer would replay on its second call.)
  //
  // 🔴 HIGH-1 (rebase 复审) — dedup by id at reconstruction: on a REPAUSE chain the re-stash's body
  // is run.originalBody of the PREVIOUS resume, whose messages already END with the hop's merged
  // assistant — the SAME UIMessage id as the re-stashed responseMessage. Appending blindly puts TWO
  // copies of that assistant into the history; ai@7's convertToModelMessages does not dedup by id, so
  // the earlier hop's tool-call is emitted twice → duplicate tool_use ids reach the upstream API →
  // 400, and the second hop never executes. Mirror the renderer's useChat semantics (replace the
  // trailing assistant in place by id) here — one spot covers every already-stashed entry, and the
  // stash itself keeps its "original body, verbatim" contract.
  const bodyMessages = Array.isArray(entry.body.messages)
    ? (entry.body.messages as MailAgentUIMessage[])
    : []
  const last = bodyMessages[bodyMessages.length - 1]
  const history =
    last && (last as { id?: string }).id === (entry.responseMessage as { id?: string }).id
      ? [...bodyMessages.slice(0, -1), entry.responseMessage]
      : [...bodyMessages, entry.responseMessage]
  const { messages: resumedMessages, applied } = applyApprovalResponseToMessages(
    history as unknown as readonly UIMessage[],
    approvalResp
  )
  if (!applied) {
    return { ok: false, status: 'error', error: 'approval part not found in stashed run' }
  }

  // Reconstruct the request body verbatim (same model/thinking/context/system/approvalMode), swapping
  // in the resumed messages. injectedContext is stripped: the mention/attachment chips were consumed
  // on the FIRST send (renderer clears them), so the renderer's own resume doesn't re-inject either —
  // re-applying here would double-inject the prefix into the last user message.
  const resumeBody: Record<string, unknown> = {
    ...entry.body,
    messages: resumedMessages,
    injectedContext: undefined
  }

  // S2 W0 (ADR-001 D1) — resume under the mode FROZEN at pause time (stashed by
  // maybeStashAndAnnounceApproval, never from the body): an island resume of a manual-session
  // approval stays manual; a future untrusted/headless pause resumes fail-closed at its own mode.
  const prepared = await prepareChatRun(resumeBody, cfg, abortSignal, entry.contextMode)
  if (!prepared.ok) {
    return { ok: false, status: 'error', error: prepared.body.error }
  }
  const run = prepared.run

  // Drain the stream server-side (no client to pipe to). This drives the tool loop (execute →
  // guard.verify/consume → write). Wrap the shared persist so we can observe whether the resumed run
  // itself PAUSED AGAIN at a second approval gate (finding 3). basePersist (makePersistOnFinish) still
  // owns persistence: it persists a completed turn, OR (re-paused) re-stashes + re-announces the next
  // island card and skips persist, OR (the OTHER surface already executed → E_APPROVAL_USED audit)
  // skips the duplicate persist (finding 2, gated by islandAgentEnabled inside makePersistOnFinish).
  const basePersist = makePersistOnFinish(cfg, run)
  let rePaused = false
  let assistantText = ''
  try {
    const stream = run.result.toUIMessageStream({
      originalMessages: run.rawMessages,
      generateMessageId: makeIdGenerator(),
      sendReasoning: false,
      onFinish: async (args) => {
        if (!args.isAborted) {
          rePaused = responseMessageAwaitsApproval(args.responseMessage as MailAgentUIMessage)
        }
        await basePersist(args)
      }
    })
    for await (const chunk of stream) {
      const c = chunk as { type?: string; delta?: unknown; text?: unknown }
      if (c.type === 'text-delta') {
        const piece =
          typeof c.delta === 'string' ? c.delta : typeof c.text === 'string' ? c.text : ''
        assistantText += piece
      }
    }
  } catch (err) {
    return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) }
  }

  // finding 3 — the resume ran the approved tool but then PAUSED AGAIN at a NEXT approval gate.
  // makePersistOnFinish already stashed + announced that fresh approval as a new island card; this
  // result is NOT terminal, so tell serve-api to leave the (new) card alone (don't send completed).
  if (rePaused) {
    return { ok: true, status: 'repaused', summary: clipSummary(assistantText) }
  }

  // Inspect the audit for THIS tool call to distinguish executed-OK from a guard/write error.
  const audit = run.auditEntries.find((e) => e.toolUseId === entry.toolCallId)
  if (approved) {
    if (audit && audit.status === 'error') {
      // finding 2 — E_APPROVAL_USED means the OTHER surface (renderer) won the approve race and already
      // executed + persisted the authoritative turn. The action DID happen; report 'completed' (NOT
      // 'error', so no misleading AgentError card). basePersist already skipped this duplicate turn.
      if (auditIsApprovalUsed(audit.outputJson)) {
        return { ok: true, status: 'completed', summary: '已在 app 内处理' }
      }
      // A real guard/write error (hash mismatch, expiry, domain failure) → surface it.
      const errMsg = parseAuditError(audit.outputJson)
      return { ok: false, status: 'error', error: errMsg, summary: errMsg }
    }
    return {
      ok: true,
      status: 'completed',
      summary: clipSummary(assistantText) || `${entry.toolName} 已执行`
    }
  }
  // rejected — the model saw the denied tool output and responded; surface its text.
  return { ok: true, status: 'rejected', summary: clipSummary(assistantText) }
}

/** Pull a short error message out of an audit entry's outputJson ({error, message}) for the card. */
function parseAuditError(outputJson: string): string {
  try {
    const o = JSON.parse(outputJson) as { error?: unknown; message?: unknown }
    const code = typeof o.error === 'string' ? o.error : ''
    const msg = typeof o.message === 'string' ? o.message : ''
    return [code, msg].filter(Boolean).join(': ') || 'tool execution failed'
  } catch {
    return 'tool execution failed'
  }
}

/** True when an audit entry's outputJson records an E_APPROVAL_USED tool-error — the one-shot
 *  guard.consume rejected this execute because the approval was already consumed on the OTHER surface
 *  (the renderer won the approve race). Distinguishes the benign "already handled in app" outcome from
 *  a real guard/write failure. Never throws. */
function auditIsApprovalUsed(outputJson: string): boolean {
  try {
    const o = JSON.parse(outputJson) as { error?: unknown }
    return o.error === 'E_APPROVAL_USED'
  } catch {
    return false
  }
}
