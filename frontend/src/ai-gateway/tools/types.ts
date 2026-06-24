// chat-panel P4 Phase 03a — AI SDK Gateway read-tool shared types + audit helper.
//
// The gateway read tools (email/kos/report) are AI SDK `tool()` definitions whose
// `execute` runs against the injected MailAgentDomainClient. This module owns the
// pieces every tool shares:
//   - the per-request audit collector captured by CLOSURE (each tool is built bound
//     to one `collector` array and pushes one entry per call). The gateway drains it
//     in onFinish and writes chat_tool_call keyed to the persisted assistant message
//     (matching the legacy harness's appendToolCall/updateToolCall audit, fields ≥
//     legacy). 🔴 We deliberately do NOT thread the collector through streamText
//     `experimental_context`: the AI SDK docs warn to treat that object as immutable
//     (it may be cloned/frozen per-call), which would silently drop audit entries.
//     A closure-captured array is robust regardless of SDK context semantics AND is
//     directly unit-testable (build tools with a collector → execute → assert it),
//     without driving a full streamText tool loop.
//   - the error normalizer (DomainError → typed {code,message}) + a thrown
//     ToolExecutionError the AI SDK renders as a tool-error part the model reads.
//
// 🔴 read tools NEVER set `needsApproval` (silent tier). Approval lands with write
//    tools in phase-03b/04b.

import { tool, type Tool } from 'ai'
import type { z } from 'zod'

import { DomainError } from '../python/domainClient'

/** One finished tool call, ready to persist into chat_tool_call. The gateway
 *  collects these per request and the Electron wrapper writes them (appendToolCall
 *  + updateToolCall) keyed to the assistant message id. `confirmation_tier` is
 *  always 'silent' for read tools (set by the writer, not carried here). */
export interface GatewayToolAuditEntry {
  toolUseId: string
  toolName: string
  inputJson: string
  outputJson: string
  status: 'ok' | 'error'
  durationMs: number
}

/** A per-request audit collector — a plain array the gateway creates per /api/ai/chat
 *  request and binds into the tools (closure). Drained in onFinish. */
export type GatewayToolAuditCollector = GatewayToolAuditEntry[]

/** True for an abort/cancel error — let it propagate untouched so the AI SDK
 *  treats the run as aborted (not as a tool error). */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))
}

/** Normalize a thrown tool error into a stable {code,message}. DomainError carries
 *  the serve-api envelope code; a duck-typed `.code` (e.g. KOS E_KOS_*) is honored;
 *  anything else is E_INTERNAL so the model can read it and self-correct. */
export function normalizeToolError(e: unknown): { code: string; message: string } {
  if (e instanceof DomainError) return { code: e.code, message: e.message }
  const code = (e as { code?: unknown }).code
  if (e instanceof Error && typeof code === 'string') return { code, message: e.message }
  return { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) }
}

/** A thrown tool error the AI SDK turns into a tool-error part. Carries the
 *  structured `code` so audit + parity tests can read it. */
export class ToolExecutionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'ToolExecutionError'
    this.code = code
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
}

/**
 * Build a silent-tier AI SDK read tool with built-in audit, bound to one `collector`
 * (closure). `run` does the domain call + parity massage and returns the model-facing
 * output. The wrapper:
 *   - times the call, pushes an `ok` audit entry (input+output) into `collector`;
 *   - on failure pushes an `error` entry (code+message) and throws a
 *     ToolExecutionError → tool-error part (model self-corrects);
 *   - lets abort propagate untouched (the aborted turn isn't persisted anyway).
 * read tools never request approval — there is no `needsApproval` here by design.
 */
export function auditedReadTool<I>(
  opts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    run: (input: I, signal: AbortSignal | undefined) => Promise<unknown>
  },
  collector: GatewayToolAuditCollector
): Tool {
  return tool({
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: async (input: I, { toolCallId, abortSignal }) => {
      const start = Date.now()
      try {
        const output = await opts.run(input, abortSignal)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson(output),
          status: 'ok',
          durationMs: Date.now() - start
        })
        return output
      } catch (e) {
        if (isAbortError(e)) throw e
        const { code, message } = normalizeToolError(e)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start
        })
        throw new ToolExecutionError(code, message)
      }
    }
  })
}
