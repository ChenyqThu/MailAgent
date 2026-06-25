// chat-panel P4 Phase 05 — AI SDK UIMessageChunk → AG-UI event mapper (the mirror core).
//
// The gateway's /api/ai/chat pipes `result.toUIMessageStream()` straight to the response (the AI
// SDK UIMessage stream). The AG-UI mirror consumes that SAME stream and re-encodes each
// UIMessageChunk into AG-UI events (protocol-contracts §8 / phase-05 §5). This module is the pure,
// STATEFUL translator at the heart of the mirror — and the golden-snapshot test target.
//
// Why stateful: AG-UI's `tool-approval-request` ai@6 chunk carries ONLY { approvalId, toolCallId,
// signature } — not the toolName / input the interrupt needs. So the mapper accumulates each tool
// call's { toolName, input } from the preceding `tool-input-*` chunks and joins them when the
// approval request arrives. Text / reasoning / tool blocks are likewise tracked so START/CONTENT/
// END come out balanced.
//
// 🔴 Pure TS (the only `ai` import is the type-only UIMessageChunk) — harness-testable; no clock in
//    the emitted bytes (deterministic golden snapshots). RUN_STARTED + STATE_SNAPSHOT are emitted by
//    the route (they need request/config state); this mapper owns everything derived from the stream.

import type { UIMessageChunk } from 'ai'

import {
  AgUiEventType,
  type AgUiEvent,
  type AgUiInterruptValue,
  type AgUiRunStartedEvent
} from './events'
import { interruptToAgUiEvents } from './interruptMapper'

/** What the route needs to enrich a `tool-approval-request` into a full interrupt: the accumulated
 *  tool call + the ai@6 approval id/signature. The route's resolver looks the toolCallId up in the
 *  domain ApprovalGuard (risk / reason / expiry) + optional A2UI to return the interrupt value. */
export interface ApprovalChunkInfo {
  approvalId: string
  toolCallId: string
  toolName: string | null
  input: unknown
  signature?: string
}

export interface AgUiMapperContext {
  threadId: string
  runId: string
  /** Default assistant message id (a `start` chunk's messageId overrides it). */
  assistantMessageId?: string
  /** Enrich an approval request into the AG-UI interrupt value (route wires it to the
   *  ApprovalGuard). Returns null / omitted → the mapper builds a minimal fail-closed interrupt. */
  resolveApprovalInterrupt?: (info: ApprovalChunkInfo) => AgUiInterruptValue | null
}

interface ToolCallState {
  toolName: string | null
  started: boolean
  argsStreamed: boolean
  input: unknown
  /** Set once a TOOL_CALL_RESULT is emitted for this call — a strict AG-UI client expects exactly
   *  one result per tool call, so a later output chunk for the same id must not emit a second. */
  resulted: boolean
}

/** A per-run mapper. Construct one per request, call `runStarted()` once, then `map(chunk)` for
 *  each UIMessageChunk; concatenate the returned event arrays in order. */
export interface AgUiEventMapper {
  runStarted: () => AgUiRunStartedEvent
  map: (chunk: UIMessageChunk) => AgUiEvent[]
}

export function createAgUiEventMapper(ctx: AgUiMapperContext): AgUiEventMapper {
  const ids = { threadId: ctx.threadId, runId: ctx.runId }
  let assistantMessageId = ctx.assistantMessageId ?? 'asst'
  const tools = new Map<string, ToolCallState>()
  const stepStack: string[] = []
  let stepIndex = 0
  let interruptEmitted = false
  let runEnded = false

  function ensureTool(toolCallId: string): ToolCallState {
    let s = tools.get(toolCallId)
    if (!s) {
      s = { toolName: null, started: false, argsStreamed: false, input: undefined, resulted: false }
      tools.set(toolCallId, s)
    }
    return s
  }

  /** Emit a TOOL_CALL_RESULT at most once per tool call (a later output chunk for the same id is
   *  dropped — see ToolCallState.resulted). */
  function emitResult(toolCallId: string, content: string): AgUiEvent[] {
    const s = ensureTool(toolCallId)
    if (s.resulted) return []
    s.resulted = true
    return [
      {
        type: AgUiEventType.ToolCallResult,
        messageId: `tr-${toolCallId}`,
        toolCallId,
        content,
        role: 'tool'
      }
    ]
  }

  /** Emit TOOL_CALL_START once per tool call (lazily — some models skip `tool-input-start`). */
  function startTool(toolCallId: string, toolName: string | null): AgUiEvent[] {
    const s = ensureTool(toolCallId)
    if (toolName) s.toolName = toolName
    if (s.started) return []
    s.started = true
    return [
      {
        type: AgUiEventType.ToolCallStart,
        toolCallId,
        toolCallName: s.toolName ?? 'unknown',
        parentMessageId: assistantMessageId
      }
    ]
  }

  function approvalInterrupt(info: ApprovalChunkInfo): AgUiInterruptValue {
    const resolved = ctx.resolveApprovalInterrupt?.(info)
    if (resolved) return resolved
    // Fail-closed fallback (no guard wired — tests / dev): a maximally-cautious interrupt. risk is
    // 'blocking' and expiresAt is empty (the client must treat an unresolved interrupt as needing
    // explicit action); the real risk/expiry come from the guard in production.
    return {
      id: info.approvalId,
      name: info.toolName ?? 'unknown',
      payload: {
        toolCallId: info.toolCallId,
        input: info.input,
        risk: 'blocking',
        reason: 'approval required',
        expiresAt: ''
      }
    }
  }

  function map(chunk: UIMessageChunk): AgUiEvent[] {
    switch (chunk.type) {
      case 'start': {
        if (typeof chunk.messageId === 'string' && chunk.messageId.length > 0) {
          assistantMessageId = chunk.messageId
        }
        return []
      }
      case 'start-step': {
        const stepName = `step-${++stepIndex}`
        stepStack.push(stepName)
        return [{ type: AgUiEventType.StepStarted, stepName }]
      }
      case 'finish-step': {
        const stepName = stepStack.pop() ?? `step-${stepIndex}`
        return [{ type: AgUiEventType.StepFinished, stepName }]
      }
      case 'text-start':
        return [{ type: AgUiEventType.TextMessageStart, messageId: chunk.id, role: 'assistant' }]
      case 'text-delta':
        return [{ type: AgUiEventType.TextMessageContent, messageId: chunk.id, delta: chunk.delta }]
      case 'text-end':
        return [{ type: AgUiEventType.TextMessageEnd, messageId: chunk.id }]
      case 'reasoning-start':
        return [
          { type: AgUiEventType.ThinkingStart },
          { type: AgUiEventType.ThinkingTextMessageStart, messageId: chunk.id }
        ]
      case 'reasoning-delta':
        return [
          {
            type: AgUiEventType.ThinkingTextMessageContent,
            messageId: chunk.id,
            delta: chunk.delta
          }
        ]
      case 'reasoning-end':
        return [
          { type: AgUiEventType.ThinkingTextMessageEnd, messageId: chunk.id },
          { type: AgUiEventType.ThinkingEnd }
        ]
      case 'tool-input-start':
        return startTool(chunk.toolCallId, chunk.toolName)
      case 'tool-input-delta': {
        const out = startTool(chunk.toolCallId, null)
        const s = ensureTool(chunk.toolCallId)
        s.argsStreamed = true
        out.push({
          type: AgUiEventType.ToolCallArgs,
          toolCallId: chunk.toolCallId,
          delta: chunk.inputTextDelta
        })
        return out
      }
      case 'tool-input-available': {
        const out = startTool(chunk.toolCallId, chunk.toolName)
        const s = ensureTool(chunk.toolCallId)
        s.input = chunk.input
        if (!s.argsStreamed) {
          // undefined input → `{}` (not the literal "null"): an AG-UI client concatenating args
          // deltas should parse an object, not null, for a tool that was called with no fields.
          out.push({
            type: AgUiEventType.ToolCallArgs,
            toolCallId: chunk.toolCallId,
            delta: chunk.input === undefined ? '{}' : safeJson(chunk.input)
          })
        }
        out.push({ type: AgUiEventType.ToolCallEnd, toolCallId: chunk.toolCallId })
        return out
      }
      case 'tool-input-error': {
        const out = startTool(chunk.toolCallId, chunk.toolName)
        out.push({ type: AgUiEventType.ToolCallEnd, toolCallId: chunk.toolCallId })
        out.push(...emitResult(chunk.toolCallId, safeJson({ error: chunk.errorText })))
        return out
      }
      case 'tool-approval-request': {
        const s = tools.get(chunk.toolCallId)
        const interrupt = approvalInterrupt({
          approvalId: chunk.approvalId,
          toolCallId: chunk.toolCallId,
          toolName: s?.toolName ?? null,
          input: s?.input,
          ...(chunk.signature !== undefined ? { signature: chunk.signature } : {})
        })
        interruptEmitted = true
        runEnded = true
        return interruptToAgUiEvents(interrupt, ids)
      }
      case 'tool-output-available':
        return emitResult(chunk.toolCallId, safeJson(chunk.output))
      case 'tool-output-error':
        return emitResult(chunk.toolCallId, safeJson({ error: chunk.errorText }))
      case 'tool-output-denied':
        return emitResult(chunk.toolCallId, safeJson({ status: 'denied' }))
      case 'error':
        runEnded = true
        return [{ type: AgUiEventType.RunError, message: chunk.errorText, code: 'E_RUN_ERROR' }]
      case 'abort':
        runEnded = true
        return [
          {
            type: AgUiEventType.RunError,
            message: typeof chunk.reason === 'string' ? chunk.reason : 'run aborted',
            code: 'E_ABORTED'
          }
        ]
      case 'finish': {
        // The interrupt path already closed the run with a requires_action RUN_FINISHED; a normal
        // `finish` after it must NOT emit a second RUN_FINISHED.
        if (interruptEmitted || runEnded) return []
        runEnded = true
        return [
          {
            type: AgUiEventType.RunFinished,
            threadId: ids.threadId,
            runId: ids.runId,
            result: {
              status: 'success',
              ...(typeof chunk.finishReason === 'string'
                ? { finishReason: chunk.finishReason }
                : {})
            }
          }
        ]
      }
      // message-metadata / file / source-* / data-* → not mirrored (no AG-UI core analogue needed
      // for the mirror's scope; ignored rather than emitted as RAW to keep the stream clean).
      default:
        return []
    }
  }

  return {
    runStarted: () => ({
      type: AgUiEventType.RunStarted,
      threadId: ids.threadId,
      runId: ids.runId
    }),
    map
  }
}

/** JSON stringify that never throws (tool args / outputs may carry odd values). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
}
