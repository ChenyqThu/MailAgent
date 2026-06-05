// Sprint 19 PR-1d.1 — Multi-turn agent harness.
//
// This is the outer loop that turns a single user message into a sequence
// of (backend.stream → dispatchTools → tool_result inject) iterations,
// stopping when the LLM emits stop_reason='end_turn' or a guard trips
// (MAX_ITER / MAX_COST_USD / abort).
//
// dispatcher.runStream still owns:
//   - session-level AbortController
//   - DB persistence of the streaming assistant message row
//   - IPC fanout (sink.send)
//
// What lives HERE:
//   - iteration loop
//   - tool_use accumulation per iter + chat_tool_call audit writes
//   - confirmation callback wiring (forwards PendingConfirmationEvent,
//     awaits chat:confirmTool IPC reply)
//   - history rebuild between iterations (assistant tool_use blocks +
//     user tool_result blocks in Anthropic multi-block content shape)
//   - end-of-turn finalization (status='complete' on the assistant row)
//
// The whole harness only runs when (a) MAILAGENT_AGENT_HARNESS=1 AND
// (b) the backend supports the Anthropic tool_use protocol. dispatcher.ts
// double-gates at the entry point — when either condition fails the
// legacy single-pass runStream path takes over verbatim.

import {
  appendToolCall,
  getToolCallByUseId,
  updateMessage,
  updateToolCall,
  abortStreamingMessages,
  type ChatMessage,
  type ConfirmationTier
} from '../chat_db'
import { getMaxCostUsd, getMaxIter, isKosL1HotBlockEnabled } from './config'
import { prefetchSenderDigest } from '../kos/sender_digest_cache'
import { defaultToolRegistry, type ToolRegistry } from '@shared/chat/tools/registry'
import {
  dispatchTools,
  type DispatchContext,
  type ToolDispatchResult,
  type ToolUseRequest
} from '@shared/chat/tools/dispatch'
import { awaitConfirmation } from '@shared/chat/tools/confirmation'
import type {
  AnthropicContentBlock,
  AnthropicHistoryMessage,
  ChatBackend,
  ChatStreamEnvelope,
  ChatStreamEvent,
  EmailContext
} from '@shared/chat/types'

export interface HarnessSink {
  send(envelope: ChatStreamEnvelope): void
}

export interface RunHarnessArgs {
  sessionId: number
  assistantMessageId: number
  backend: ChatBackend
  initialHistory: ChatMessage[]
  model: string | null
  agentPageId: string | null
  emailContext: EmailContext | null
  ac: AbortController
  sink: HarnessSink
  /** Test injection point. Production callers omit and the harness uses
   *  the module-level `defaultToolRegistry`. */
  registry?: ToolRegistry
}

/** Translate the chat_db ChatMessage[] history into Anthropic's shape for
 *  the iter-0 request. Plain text only — multi-block content (tool_use /
 *  tool_result) lives in `priorTurns` and is appended on subsequent iters,
 *  not pulled back out of the DB. */
function chatHistoryToAnthropic(history: ChatMessage[]): AnthropicHistoryMessage[] {
  const out: AnthropicHistoryMessage[] = []
  for (const m of history) {
    if (m.role === 'user') {
      if (m.content.length > 0) out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      // Skip aborted/error rows — they were never fully formed; leaving
      // them in confuses the model with partial assistant text.
      if (m.status === 'aborted' || m.status === 'error') continue
      if (m.content.length > 0) out.push({ role: 'assistant', content: m.content })
    }
    // system/tool rows from the legacy path are intentionally dropped here;
    // the harness only writes role=assistant with chat_tool_call sidecar
    // rows, never role=tool messages.
  }
  if (out.length === 0) {
    // Anthropic rejects empty messages[]. Shouldn't happen — dispatcher
    // always appends the user message before invoking the harness.
    out.push({ role: 'user', content: '(empty)' })
  }
  return out
}

/** Build the assistant turn entry the harness appends to priorTurns after
 *  one iteration completes. Anthropic requires the SAME tool_use blocks
 *  (id + name + input) the LLM emitted to appear in the next request's
 *  history so it can match its own prior tool calls. */
function buildAssistantTurnFromIter(
  iterText: string,
  collected: ToolUseRequest[]
): AnthropicHistoryMessage {
  const blocks: AnthropicContentBlock[] = []
  if (iterText.length > 0) blocks.push({ type: 'text', text: iterText })
  for (const tu of collected) {
    blocks.push({ type: 'tool_use', id: tu.toolUseId, name: tu.name, input: tu.input })
  }
  return { role: 'assistant', content: blocks }
}

/** Build the synthetic user-role tool_result turn that follows an
 *  assistant turn ending in tool_use. Order MUST mirror the assistant
 *  turn's tool_use blocks; Anthropic matches by tool_use_id but the
 *  pairing is clearer for debugging when the order is preserved. */
function buildToolResultTurn(
  collected: ToolUseRequest[],
  results: ToolDispatchResult[]
): AnthropicHistoryMessage {
  const byId = new Map<string, ToolDispatchResult>()
  for (const r of results) byId.set(r.toolUseId, r)
  const blocks: AnthropicContentBlock[] = []
  for (const use of collected) {
    const r = byId.get(use.toolUseId)
    if (!r) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: use.toolUseId,
        content: 'E_MISSING: dispatchTools returned no result for this tool_use',
        is_error: true
      })
      continue
    }
    let content: string
    if (r.status === 'ok') {
      content = serializeToolOutput(r.output)
    } else if (r.status === 'canceled') {
      content =
        `E_USER_CANCELED: ${r.errorMessage ?? 'user declined the proposed action'}` +
        (r.userEdited ? ' (with edits)' : '')
    } else {
      content = r.errorMessage ?? 'tool error'
    }
    blocks.push({
      type: 'tool_result',
      tool_use_id: use.toolUseId,
      content,
      is_error: r.status !== 'ok'
    })
  }
  return { role: 'user', content: blocks }
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/** Map dispatch result.status to chat_tool_call.status. */
function chatToolStatus(status: ToolDispatchResult['status']): 'ok' | 'error' | 'canceled' {
  return status
}

export async function runHarness(args: RunHarnessArgs): Promise<void> {
  const registry = args.registry ?? defaultToolRegistry
  const tools = registry.toAnthropicSchema()
  const MAX_ITER = getMaxIter()
  const MAX_COST_USD_PER_TURN = getMaxCostUsd()

  // Sprint 19 PR-2f — Fire-and-forget prefetch KOS sender digest. First
  // iteration's buildSystemBlocks sync-reads getCachedSenderDigest to decide
  // whether to inject the L1 hot block. We intentionally do NOT await:
  // prefetch should not delay backend.stream start, and typically completes
  // before the first content_block arrives.
  if (isKosL1HotBlockEnabled() && args.emailContext?.senderAddr) {
    void prefetchSenderDigest(args.emailContext.senderAddr)
  }

  const baseHistory = chatHistoryToAnthropic(args.initialHistory)
  const priorTurns: AnthropicHistoryMessage[] = []
  let buffer = '' // running accumulation of every iter's text (DB content)
  let lastUsage: { input: number; output: number; cost: number | null } | null = null
  let modelSeen: string | null = args.model
  let costUsd = 0
  let iter = 0

  const forward = (event: ChatStreamEvent): void => {
    args.sink.send({
      sessionId: args.sessionId,
      messageId: args.assistantMessageId,
      event
    })
  }

  while (iter < MAX_ITER) {
    iter++
    if (args.ac.signal.aborted) break

    const collected: ToolUseRequest[] = []
    let iterText = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'

    try {
      for await (const event of args.backend.stream({
        history: args.initialHistory,
        model: args.model,
        agentPageId: args.agentPageId,
        emailContext: args.emailContext,
        signal: args.ac.signal,
        tools: tools.length > 0 ? tools : undefined,
        iterHistory: [...baseHistory, ...priorTurns]
      })) {
        if (args.ac.signal.aborted) break

        switch (event.type) {
          case 'chunk':
            iterText += event.delta
            buffer += event.delta
            updateMessage(args.assistantMessageId, { content: buffer })
            forward(event)
            break
          case 'tool_use': {
            collected.push({
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input
            })
            const def = registry.get(event.name)
            const tier: ConfirmationTier = def?.confirmationTier ?? 'silent'
            // status='pending' for preview/edit until the user confirms;
            // status='running' for silent (we dispatch immediately after
            // the iter's tool_use stream ends).
            const initStatus: 'pending' | 'running' = tier === 'silent' ? 'running' : 'pending'
            appendToolCall({
              messageId: args.assistantMessageId,
              toolUseId: event.toolUseId,
              toolName: event.name,
              inputJson: JSON.stringify(event.input),
              confirmationTier: tier,
              status: initStatus
            })
            forward(event)
            break
          }
          case 'usage':
            lastUsage = {
              input: event.inputTokens,
              output: event.outputTokens,
              cost: event.costUsd
            }
            if (typeof event.costUsd === 'number') costUsd += event.costUsd
            if (event.model) modelSeen = event.model
            forward(event)
            break
          case 'done':
            stopReason = event.stopReason ?? 'end_turn'
            modelSeen = event.model ?? modelSeen
            forward(event)
            break
          case 'error':
            forward(event)
            updateMessage(args.assistantMessageId, {
              status: 'error',
              errorMessage: event.message,
              model: modelSeen
            })
            return
          // Other event types (tool_call legacy, pending_confirmation, tool_result)
          // are not produced by the backend stream; they're harness-internal
          // and forwarded directly elsewhere in this function. Forward
          // anything unexpected as-is for forward compat.
          default:
            forward(event)
            break
        }
      }
    } catch (err) {
      if (args.ac.signal.aborted) {
        abortStreamingMessages(args.sessionId)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      forward({ type: 'error', code: 'E_BACKEND_CRASH', message })
      updateMessage(args.assistantMessageId, {
        status: 'error',
        errorMessage: message,
        model: modelSeen
      })
      return
    }

    if (args.ac.signal.aborted) {
      abortStreamingMessages(args.sessionId)
      return
    }

    // Terminal conditions for the harness loop.
    if (stopReason === 'end_turn' || collected.length === 0) {
      updateMessage(args.assistantMessageId, {
        status: 'complete',
        content: buffer,
        tokensInput: lastUsage?.input ?? null,
        tokensOutput: lastUsage?.output ?? null,
        costUsd: lastUsage?.cost ?? null,
        model: modelSeen
      })
      return
    }
    if (costUsd > MAX_COST_USD_PER_TURN) {
      forward({
        type: 'error',
        code: 'E_COST_BUDGET',
        message: `turn exceeded $${MAX_COST_USD_PER_TURN.toFixed(2)} cap (spent $${costUsd.toFixed(4)})`
      })
      updateMessage(args.assistantMessageId, {
        status: 'error',
        errorMessage: 'cost cap exceeded',
        model: modelSeen
      })
      return
    }

    // Dispatch this iter's tools.
    const dispatchCtx: DispatchContext = {
      sessionId: args.sessionId,
      emailId: args.emailContext?.internalId ?? null,
      signal: args.ac.signal,
      confirm: async (use, def) => {
        forward({
          type: 'pending_confirmation',
          toolUseId: use.toolUseId,
          toolName: def.name,
          input: use.input,
          tier: def.confirmationTier as 'preview' | 'edit'
        })
        return awaitConfirmation(use.toolUseId, args.sessionId, args.ac.signal)
      }
    }
    const results = await dispatchTools(collected, dispatchCtx, registry)

    if (args.ac.signal.aborted) {
      abortStreamingMessages(args.sessionId)
      return
    }

    // Persist tool results to chat_tool_call + forward tool_result events.
    for (const r of results) {
      const row = getToolCallByUseId(args.assistantMessageId, r.toolUseId)
      if (row) {
        const patch: Parameters<typeof updateToolCall>[1] = {
          status: chatToolStatus(r.status),
          durationMs: r.durationMs
        }
        if (r.output !== undefined) patch.outputJson = serializeToolOutput(r.output)
        else if (r.errorMessage) patch.outputJson = r.errorMessage
        if (r.userEdited) patch.confirmedAt = Date.now()
        updateToolCall(row.id, patch)
      }
      forward({
        type: 'tool_result',
        toolUseId: r.toolUseId,
        status: r.status,
        output: r.output,
        errorMessage: r.errorMessage,
        durationMs: r.durationMs
      })
    }

    // Append this iter to priorTurns for the next backend.stream call.
    priorTurns.push(buildAssistantTurnFromIter(iterText, collected))
    priorTurns.push(buildToolResultTurn(collected, results))
  }

  // Reached here = MAX_ITER exhausted without end_turn.
  forward({
    type: 'error',
    code: 'E_MAX_ITER',
    message: `harness exceeded ${MAX_ITER} iterations without end_turn`
  })
  updateMessage(args.assistantMessageId, {
    status: 'error',
    errorMessage: `max iterations (${MAX_ITER}) exceeded`,
    model: modelSeen
  })
}
