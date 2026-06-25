// chat-panel P4 Phase 05 — AG-UI mirror endpoint POST /api/ai/agui/chat.
//
// The mirror runs the SAME streamText + tools + 04b double-guard approval as /api/ai/chat
// (via the shared prepareChatRun), then re-encodes `result.toUIMessageStream()` into an AG-UI event
// stream (eventMapper) instead of piping the raw UIMessage stream. It prepends RUN_STARTED + a
// redacted STATE_SNAPSHOT and persists the finished turn through the SAME onFinish (the mirror is a
// true mirror, including audit). It is flag-gated: server.ts only routes here when
// cfg.aguiMirrorEnabled — flag-off it is unreachable (404), default behaviour byte-identical.
//
// 🔴 No alternate write/send path: this handler NEVER calls a tool or domain.sendApproved itself.
//    Every write/send still happens inside a tool's execute, gated by the SAME ApprovalGuard
//    (verify/consume + content hash + idempotency). The reverse approval path only flips a tool
//    part's ai@6 state (approval-responded) without touching the signed input — so the guard runs.
//
// 🔴 No electron / chat_db import — pure gateway core (cfg injects persistence + approval lookup),
//    harness-testable end-to-end with a mock model (tests/ai-gateway/agui/route.test.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AiGatewayConfig } from '../config'
import { makePersistOnFinish, makeIdGenerator, prepareChatRun } from '../chatRun'
import { readJsonBody, writeJson, writeSse, SSE_HEADERS } from '../httpUtil'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import { AgUiEventType, type AgUiEvent } from './events'
import { createAgUiEventMapper } from './eventMapper'
import {
  aguiInterruptResponseToApproval,
  applyApprovalResponseToMessages,
  approvalToAgUiInterrupt,
  type AgUiInterruptResponse
} from './interruptMapper'
import { buildMailAgentAgUiState, stateSnapshotEvent } from './stateSnapshot'

/** Pull the anchor facet from the request (protocol-contracts §5 `anchor: { type, id }`). */
function readAnchor(body: Record<string, unknown>): {
  anchorType: 'email' | 'general'
  anchorId: number | null
} {
  const anchor = body.anchor
  if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
    const a = anchor as { type?: unknown; id?: unknown }
    return {
      anchorType: a.type === 'email' ? 'email' : 'general',
      anchorId: typeof a.id === 'number' && Number.isInteger(a.id) ? a.id : null
    }
  }
  return { anchorType: 'general', anchorId: null }
}

function readEnabledSkills(body: Record<string, unknown>): string[] {
  const options = body.options
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const sk = (options as { enabledSkills?: unknown }).enabledSkills
    if (Array.isArray(sk)) return sk.filter((s): s is string => typeof s === 'string')
  }
  return []
}

/** Read the context blob only when it is a plain object (a string / array contextSnapshot would
 *  violate the MailAgentAgUiState.mailagentContext contract at runtime). redactForState handles it
 *  either way, but keeping the shape correct avoids surprising the AG-UI client. */
function readContext(body: Record<string, unknown>): Record<string, unknown> | null {
  const ctx = body.contextSnapshot
  return ctx && typeof ctx === 'object' && !Array.isArray(ctx)
    ? (ctx as Record<string, unknown>)
    : null
}

/**
 * If the request carries an AG-UI interrupt RESPONSE, fold it into the message history so the
 * resume runs through the same approval-gated tools. Returns the body with possibly-transformed
 * messages. A native ai@6 client (assistant-ui useChatRuntime) instead replays the history with the
 * tool part already in `approval-responded` state — that path needs no transform and is left as-is.
 */
function applyInterruptResponse(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.interruptResponse
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return body
  const messages = Array.isArray(body.messages) ? (body.messages as MailAgentUIMessage[]) : []
  if (messages.length === 0) return body
  let approval
  try {
    approval = aguiInterruptResponseToApproval(raw as AgUiInterruptResponse)
  } catch {
    // a malformed interrupt response is ignored here; prepareChatRun will run the history as-is and
    // the guard fails closed (no approval-responded part → no execute). Never an open send path.
    return body
  }
  const { messages: next } = applyApprovalResponseToMessages(messages, approval)
  return { ...body, messages: next }
}

/** A small run-id (display / correlation only — not security-sensitive). */
function makeRunId(): string {
  return `run-${makeIdGenerator()()}`
}

/**
 * Handle POST /api/ai/agui/chat. Pre-stream errors (no key / bad messages) are typed JSON (the
 * client hasn't started SSE). Otherwise it streams AG-UI events: RUN_STARTED → STATE_SNAPSHOT →
 * mapped run events → RUN_FINISHED / RUN_ERROR.
 */
export async function handleAguiChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  const rawBody = await readJsonBody(req)
  const body = applyInterruptResponse(rawBody)

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  const prepared = await prepareChatRun(body, cfg, controller.signal)
  if (!prepared.ok) {
    writeJson(res, prepared.status, prepared.body)
    return
  }
  const run = prepared.run

  const threadId =
    typeof body.threadId === 'string' && body.threadId.length > 0
      ? body.threadId
      : run.sessionId != null
        ? `session-${run.sessionId}`
        : 'thread-anon'
  const runId = makeRunId()

  res.writeHead(200, SSE_HEADERS)

  // Track whether a terminal event (RUN_FINISHED / RUN_ERROR) was emitted so we never double-close
  // and always close exactly once.
  let terminal = false
  const emit = (event: AgUiEvent): void => {
    if (res.writableEnded) return
    if (event.type === AgUiEventType.RunFinished || event.type === AgUiEventType.RunError) {
      terminal = true
    }
    writeSse(res, event)
  }

  const mapper = createAgUiEventMapper({
    threadId,
    runId,
    resolveApprovalInterrupt: cfg.resolveApprovalRequest
      ? (info) => {
          const reqPayload = cfg.resolveApprovalRequest!(info)
          return reqPayload ? approvalToAgUiInterrupt(reqPayload) : null
        }
      : undefined
  })

  // RUN_STARTED, then the redacted STATE_SNAPSHOT (no body / token — stateSnapshot.ts redacts).
  emit(mapper.runStarted())
  const { anchorType, anchorId } = readAnchor(body)
  emit(
    stateSnapshotEvent(
      buildMailAgentAgUiState({
        context: readContext(body),
        sessionId: run.sessionId,
        anchorType,
        anchorId,
        enabledTools: run.toolNames,
        enabledSkills: readEnabledSkills(body)
      })
    )
  )

  try {
    const stream = run.result.toUIMessageStream({
      originalMessages: run.rawMessages,
      generateMessageId: makeIdGenerator(),
      sendReasoning: true,
      onFinish: makePersistOnFinish(cfg, run)
    })
    for await (const chunk of stream) {
      for (const event of mapper.map(chunk)) emit(event)
    }
    // Safety net: a stream that ended without a `finish` chunk (and wasn't an interrupt/abort) still
    // gets a clean RUN_FINISHED so the client isn't left hanging.
    if (!terminal && !controller.signal.aborted) {
      emit({ type: AgUiEventType.RunFinished, threadId, runId, result: { status: 'success' } })
    }
  } catch (err) {
    if (!terminal && !res.writableEnded) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: AgUiEventType.RunError, message, code: 'E_RUN_ERROR' })
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
}
