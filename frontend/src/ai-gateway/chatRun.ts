// chat-panel P4 Phase 05 — shared chat-run preparation (single source for "build the model call").
//
// Extracted from the Phase 02–04b handleChat so the canonical /api/ai/chat handler AND the AG-UI
// mirror (/api/ai/agui/chat) construct the SAME streamText with the SAME tools + the SAME approval
// guard + secret. The mirror is then provably "复用同一 streamText + tools + 04b 双 guard approval,
// 只换 output 编码器" — there is no second tool implementation and no send path that skips the guard.
//
// 🔴 Pure-ish: depends only on `ai` + config + tools/types + uiMessage. No node:http (it takes an
//    already-parsed body + an AbortSignal), no electron / chat_db.

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type StreamTextResult,
  type ToolSet,
  type UIMessageStreamOnFinishCallback
} from 'ai'

import { anthropicBaseUrl, type AiGatewayConfig, type PersistTurnInput } from './config'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { GatewayToolAuditEntry } from './tools/types'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
// Phase 06 (context injection) — system prompt assembly + snapshot schema guard.
import { buildGatewaySystemPrompt } from './systemPrompt'
import {
  isValidContextSnapshot,
  type AgentContextSnapshot
} from '@shared/assistant/context/contextSnapshot'

/** Default tool-loop ceiling (matches the legacy harness AGENT_MAX_ITER default). */
export const DEFAULT_MAX_STEPS = 8

/** Resolve the LanguageModel factory: injected (tests / mock) else the default @ai-sdk/anthropic
 *  provider wired to the normalized baseURL + key. */
export function resolveModelFactory(cfg: AiGatewayConfig): (modelId: string) => LanguageModel {
  if (cfg.createModel) return cfg.createModel
  const anthropic = createAnthropic({
    apiKey: cfg.apiKey ?? '',
    baseURL: anthropicBaseUrl(cfg.baseUrl)
  })
  return (modelId: string) => anthropic(modelId)
}

/** Pick the last user UIMessage of an incoming turn (the fresh message we persist alongside the
 *  assistant reply). */
export function lastUserMessage(messages: MailAgentUIMessage[]): MailAgentUIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
}

/** Monotonic-ish id generator for response message ids (transient — reload re-stamps the persisted
 *  row id). Not security-sensitive. */
export function makeIdGenerator(): () => string {
  let seq = 0
  const boot = Date.now().toString(36)
  return () => `asst-${boot}-${(seq++).toString(36)}`
}

/** A prepared streamText run + the metadata both endpoints need to encode + persist it. */
export interface PreparedChatRun {
  result: StreamTextResult<ToolSet, never>
  rawMessages: MailAgentUIMessage[]
  sessionId: number | null
  modelId: string
  /** The per-request audit collector the tools push into (drained in onFinish → chat_tool_call). */
  auditEntries: GatewayToolAuditEntry[]
  /** Tool names exposed this run (for the AG-UI STATE_SNAPSHOT capabilities). */
  toolNames: string[]
}

export type PrepareChatOutcome =
  | { ok: true; run: PreparedChatRun }
  | { ok: false; status: number; body: { error: string; hint: string } }

/**
 * Validate an incoming chat request body and build the streamText run (key check, messages check,
 * model/system/sessionId parse, convertToModelMessages, tool registry + approval wiring). Returns a
 * typed error outcome (the caller writes it as JSON) or the prepared run. Mirrors the Phase 02–04b
 * handleChat preamble exactly, so /api/ai/chat behaviour is unchanged.
 */
export async function prepareChatRun(
  body: Record<string, unknown>,
  cfg: AiGatewayConfig,
  abortSignal: AbortSignal
): Promise<PrepareChatOutcome> {
  if (!cfg.apiKey || cfg.apiKey.length === 0) {
    return {
      ok: false,
      status: 503,
      body: { error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' }
    }
  }
  const rawMessages = Array.isArray(body.messages) ? (body.messages as MailAgentUIMessage[]) : []
  if (rawMessages.length === 0) {
    return { ok: false, status: 400, body: { error: 'E_INVALID_ARG', hint: 'messages[] required' } }
  }
  const modelId = typeof body.model === 'string' && body.model.length > 0 ? body.model : cfg.model
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null

  // System prompt. With the injection provider set (MAILAGENT_AI_SDK_CONTEXT_INJECTION on) assemble
  // from standing-context + the typed snapshot, reusing the legacy stable prefix
  // (buildGatewaySystemPrompt). Without it (default) pass body.system through unchanged AND ignore the
  // contextSnapshot field entirely — Phase 02/05 behaviour, byte-identical (no validation, no 400).
  let system: string | undefined
  if (cfg.systemPromptProvider) {
    // Resolve the typed context snapshot ONLY on the injection path: a valid v1 snapshot is used; a
    // snapshot that CLAIMS to be typed (carries a `version`) but fails validation → 400 (no off-spec
    // blob into the prompt); an UNtyped passthrough blob (no version — the AG-UI mirror's open
    // context, handled by the AG-UI route's own redacting readContext) is ignored here. Absent → null.
    let contextSnapshot: AgentContextSnapshot | null = null
    if (body.contextSnapshot != null) {
      if (isValidContextSnapshot(body.contextSnapshot)) {
        contextSnapshot = body.contextSnapshot
      } else if (
        typeof body.contextSnapshot === 'object' &&
        !Array.isArray(body.contextSnapshot) &&
        'version' in (body.contextSnapshot as object)
      ) {
        return {
          ok: false,
          status: 400,
          body: { error: 'E_INVALID_ARG', hint: 'contextSnapshot failed schema validation' }
        }
      }
    }
    // The provider is contracted to return null (not throw) on a /chat/config blip → context-light.
    const promptConfig = (await cfg.systemPromptProvider()) ?? null
    system = buildGatewaySystemPrompt({ promptConfig, contextSnapshot })
  } else {
    system = typeof body.system === 'string' && body.system.length > 0 ? body.system : undefined
  }

  // 🔴 ai@6 convertToModelMessages is ASYNC (returns a Promise) — must await, else
  // streamText.standardizePrompt receives a Promise and throws "messages.some is not a function".
  let modelMessages
  try {
    modelMessages = await convertToModelMessages(rawMessages)
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: 'E_INVALID_ARG', hint: 'messages[] not convertible to model messages' }
    }
  }

  // Build the tools bound to a fresh per-request audit collector (closure). No tools → text-only
  // (Phase 02 behaviour). The same buildTools + toolApprovalSecret feed BOTH endpoints, so the
  // mirror's approval path is identical to /api/ai/chat (no bypass).
  const auditEntries: GatewayToolAuditEntry[] = []
  const tools = cfg.buildTools?.(auditEntries)
  const hasTools = tools != null && Object.keys(tools).length > 0

  const result = streamText({
    model: resolveModelFactory(cfg)(modelId),
    system,
    messages: modelMessages,
    abortSignal,
    ...(hasTools
      ? {
          tools,
          stopWhen: stepCountIs(cfg.maxSteps ?? DEFAULT_MAX_STEPS),
          ...(cfg.toolApprovalSecret
            ? { experimental_toolApprovalSecret: cfg.toolApprovalSecret }
            : {})
        }
      : {})
  }) as StreamTextResult<ToolSet, never>

  return {
    ok: true,
    run: {
      result,
      rawMessages,
      sessionId,
      modelId,
      auditEntries,
      toolNames: hasTools ? Object.keys(tools as ToolSet) : []
    }
  }
}

/**
 * Build the onFinish callback that persists a finished turn (ai_chat.db dual-write) — the SAME
 * persistence both endpoints use (the AG-UI mirror is a true mirror, including audit). Best-effort:
 * a write failure logs and never breaks the already-streamed reply. Aborted turns are not persisted.
 */
export function makePersistOnFinish(
  cfg: AiGatewayConfig,
  run: PreparedChatRun
): UIMessageStreamOnFinishCallback<MailAgentUIMessage> {
  return async ({ responseMessage, isAborted }) => {
    if (isAborted || !cfg.persistTurn) return
    const usage = await Promise.resolve(run.result.usage).catch(() => undefined)
    const turn: PersistTurnInput = {
      sessionId: run.sessionId,
      model: run.modelId,
      userMessage: lastUserMessage(run.rawMessages),
      responseMessage: responseMessage as MailAgentUIMessage,
      usage: usage
        ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null }
        : undefined,
      toolCalls: run.auditEntries
    }
    try {
      await cfg.persistTurn(turn)
    } catch (err) {
      // persistence is best-effort — a write failure must not break the streamed reply.
      console.error('[ai-gateway] persistTurn failed (turn streamed OK)', err)
    }
  }
}
