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
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type UIMessageStreamOnFinishCallback
} from 'ai'

import { anthropicBaseUrl, type AiGatewayConfig, type PersistTurnInput } from './config'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { GatewayToolAuditEntry } from './tools/types'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
// chat-panel P4 composer-parity C1-① — per-turn extended-thinking → @ai-sdk/anthropic providerOptions.
import { thinkingProviderOptions } from './thinking'
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

/** composer-parity C2 — prepend the renderer's mention/attachment injected context to the LAST user
 *  message of the MODEL-message array (NOT rawMessages, so persistence keeps the original user text).
 *  String content → string prefix; array content → an extra leading text part. The prefix already
 *  carries untrusted-content framing (buildMentionContext / buildAttachmentBlock from the renderer),
 *  so a mentioned email body can't masquerade as a system directive. Empty prefix → unchanged. */
export function prependInjectedContext(messages: ModelMessage[], prefix: string): ModelMessage[] {
  if (prefix.length === 0) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string') {
      const next = { ...m, content: `${prefix}${content}` } as ModelMessage
      return messages.map((mm, idx) => (idx === i ? next : mm))
    }
    if (Array.isArray(content)) {
      const next = { ...m, content: [{ type: 'text', text: prefix }, ...content] } as ModelMessage
      return messages.map((mm, idx) => (idx === i ? next : mm))
    }
    break
  }
  return messages
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
  result: StreamTextResult<ToolSet, never, never>
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
  // chat-panel P4 composer-parity C1-① — per-turn extended-thinking toggle. body.thinking===true →
  // inject providerOptions by the model-family matrix (./thinking); absent/false → undefined →
  // providerOptions omitted below, byte-identical to the pre-toggle no-thinking streamText call.
  const thinkingProviderOpts = thinkingProviderOptions(modelId, body.thinking === true)

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
  // composer-parity C2 — prepend the renderer's mention/attachment context to the model's last user
  // message (rawMessages stay original → persistence is clean). The prefix carries untrusted framing.
  const injectedContext = typeof body.injectedContext === 'string' ? body.injectedContext : ''
  if (injectedContext.length > 0) {
    modelMessages = prependInjectedContext(modelMessages, injectedContext)
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
    ...(thinkingProviderOpts ? { providerOptions: thinkingProviderOpts } : {}),
    ...(hasTools
      ? {
          tools,
          stopWhen: stepCountIs(cfg.maxSteps ?? DEFAULT_MAX_STEPS),
          ...(cfg.toolApprovalSecret
            ? { experimental_toolApprovalSecret: cfg.toolApprovalSecret }
            : {})
        }
      : {})
  }) as StreamTextResult<ToolSet, never, never>

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

// ── Phase 10b — configurable LLM auto-title ────────────────────────────────────────────────────────

/** Clamp a model-generated title: strip wrapping quotes / a leading "Title:" label, collapse internal
 *  whitespace to single spaces, drop a trailing period, and cap the length. Empty after cleaning →
 *  null (the caller then leaves the session untitled so the first-message preview keeps showing). */
export function sanitizeSessionTitle(raw: string): string | null {
  let t = raw.trim()
  // strip surrounding quotes (ASCII + CJK) the model sometimes wraps the title in
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '')
  // a model may prefix "Title:" / "标题：" — drop a short leading label
  t = t.replace(/^\s*(title|标题)\s*[:：]\s*/i, '')
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/[.。]+$/, '').trim()
  if (t.length === 0) return null
  return t.length > 60 ? t.slice(0, 60).trim() : t
}

/** The auto-title prompt: a SHORT topic title in the user's own language, no quotes, no end label. The
 *  first user message is clipped (a title needs only the gist, not a 12k-char body). */
export function buildTitlePrompt(firstUserText: string): string {
  const clipped = firstUserText.length > 1000 ? firstUserText.slice(0, 1000) : firstUserText
  return [
    'Generate a SHORT title (at most 6 words) summarizing the topic of the user message below.',
    'Reply with ONLY the title text — no surrounding quotes, no trailing punctuation, no prefix label.',
    'Write the title in the SAME language as the user message.',
    '',
    'User message:',
    '<<<',
    clipped,
    '>>>'
  ].join('\n')
}

/** Generate a session title from its first user message via the configured model factory. Non-streaming
 *  generateText; returns the cleaned title or null (empty / clean-to-empty). Output is a handful of
 *  tokens (a title), so maxOutputTokens is small — deliberately NOT the chat ceiling. Throws on an
 *  upstream error (the caller maps it to 502); the title is best-effort UX, never blocks the chat. */
export async function generateSessionTitle(
  cfg: AiGatewayConfig,
  firstUserText: string,
  modelId: string,
  abortSignal?: AbortSignal
): Promise<string | null> {
  const factory = resolveModelFactory(cfg)
  const { text } = await generateText({
    model: factory(modelId),
    prompt: buildTitlePrompt(firstUserText),
    maxOutputTokens: 64,
    abortSignal
  })
  return sanitizeSessionTitle(text)
}

/** dogfood-3 (follow-ups) — parse model output into at most 3 short suggestion strings. Accepts a JSON
 *  array, or a newline / numbered list (the model sometimes ignores "JSON only"). Each is trimmed,
 *  de-bulleted, quote-stripped, capped at 80 chars; empties + dups dropped; capped to 3. */
export function parseFollowups(raw: string): string[] {
  const out: string[] = []
  const push = (s: string): void => {
    let t = s
      .trim()
      .replace(/^[-*\d.)\s]+/, '')
      .replace(/^["'「『]+/, '')
      .replace(/["'」』]+$/, '')
      .trim()
    if (t.length > 80) t = t.slice(0, 80).trim()
    if (t.length > 0 && !out.includes(t)) out.push(t)
  }
  // dogfood — strip a markdown code fence the model sometimes wraps the JSON in (```json … ``` or
  // bare ``` … ```). Without this `trimmed` starts with "```json" (not "[") → the JSON branch is
  // skipped → the fence lines become bogus "```json" / "```" chips + the whole array becomes one
  // truncated chip (user-reported). Match the fenced body; fall back to the raw trim if no fence.
  let trimmed = raw.trim()
  const fence = trimmed.match(/^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/)
  if (fence) trimmed = fence[1].trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr: unknown = JSON.parse(trimmed)
      if (Array.isArray(arr)) {
        for (const x of arr) if (typeof x === 'string') push(x)
        return out.slice(0, 3)
      }
    } catch {
      /* not JSON — fall through to line parsing */
    }
  }
  // Line fallback: skip any stray fence line defensively so a partial / unmatched fence never leaks
  // a "```" chip.
  for (const line of trimmed.split('\n')) {
    if (/^\s*```/.test(line)) continue
    push(line)
  }
  return out.slice(0, 3)
}

/** The follow-ups prompt: 2-3 SHORT next questions the user is likely to ask after this reply, phrased
 *  as the USER (first person) in the user's own language. Both texts are clipped (a hint suffices). */
export function buildFollowupsPrompt(userText: string, assistantText: string): string {
  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)
  return [
    'Based on the conversation turn below, suggest 2-3 SHORT follow-up questions the user is likely to',
    'ask NEXT. Phrase each as the USER would ask it (first person), in the SAME language as the user.',
    'Each at most 10 words. Reply with ONLY a JSON array of strings — nothing else.',
    '',
    'User asked:',
    '<<<',
    clip(userText, 800),
    '>>>',
    '',
    'Assistant replied:',
    '<<<',
    clip(assistantText, 1500),
    '>>>'
  ].join('\n')
}

/** Generate follow-up suggestions for the last turn via the configured model factory. Non-streaming
 *  generateText; small output. Returns [] on empty / parse-empty. Throws on an upstream error (caller
 *  maps to 502); follow-ups are best-effort UX, never block the chat. */
export async function generateFollowups(
  cfg: AiGatewayConfig,
  userText: string,
  assistantText: string,
  modelId: string,
  abortSignal?: AbortSignal
): Promise<string[]> {
  const factory = resolveModelFactory(cfg)
  const { text } = await generateText({
    model: factory(modelId),
    prompt: buildFollowupsPrompt(userText, assistantText),
    maxOutputTokens: 200,
    abortSignal
  })
  return parseFollowups(text)
}
