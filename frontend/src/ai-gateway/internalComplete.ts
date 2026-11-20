// Phase 4 WP-4C — Internal loopback LLM completion endpoint for Python background workers.
//
// POST /api/ai/internal/complete lets trusted same-machine Python callers (classification,
// report summarization, memory capture, task extraction, contact profiles) reuse the TypeScript
// AI SDK provider registry (6 protocols, multi-key rotation, <tool_call> fix middleware, and
// Gemini/OpenRouter/DeepSeek/OpenAI-compatible routing).
//
// 🔴 Lazy-load gate (tests/ai-gateway/provider_lazy_import.test.ts): NEVER import `./providers`
//    or any `@ai-sdk/*` provider package here. Always use `resolveModelFactory(cfg)` from
//    `./chatRun`, which stays lazy behind `cfg.providerModelResolver`.

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  APICallError,
  generateText,
  jsonSchema,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type SystemModelMessage,
  type ToolChoice,
  type ToolSet
} from 'ai'

import type { AiGatewayConfig, GatewayUsageSurface } from './config'
import { extractSdkUsage, llmCredentialsMissing, resolveModelFactory } from './chatRun'
import { costUsdFor } from './modelCost'
import { isPrivacyMaskError, isProviderCredentialsError } from './providerRef'
import { sanitizedUpstreamErrorMessage, unwrapUpstreamError } from './upstreamError'
import { opencodeSessionId } from './opencodeSessionId'
import { OPENCODE_SESSION_HEADER } from '@shared/lib/opencodeSession'
import { isBodyTooLarge, readJsonBody, writeJson } from './httpUtil'

const DEFAULT_INTERNAL_MAX_TOKENS = 4096

const VALID_SURFACES: ReadonlySet<GatewayUsageSurface> = new Set([
  'auto_title',
  'compact',
  'search_agent',
  'paused_turn',
  'translate',
  'nl_search',
  'memory_capture',
  'user_md_compile',
  'contact_profile',
  'task_extract',
  'py_loopback'
])

interface RawSystemBlock {
  text?: unknown
  cacheControl?: unknown
}

interface RawToolCall {
  toolCallId?: unknown
  toolName?: unknown
  input?: unknown
}

interface RawToolResult {
  toolCallId?: unknown
  toolName?: unknown
  output?: unknown
  content?: unknown
}

interface RawMessage {
  role?: unknown
  content?: unknown
  toolCalls?: unknown
  results?: unknown
  toolCallId?: unknown
  toolName?: unknown
  output?: unknown
}

interface RawToolDef {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
}

function headerToken(req: IncomingMessage): string {
  const raw = req.headers['x-mailagent-local-token']
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim()
  return ''
}

function verifyLocalToken(req: IncomingMessage, cfg: AiGatewayConfig): boolean {
  const expected = typeof cfg.localApiToken === 'string' ? cfg.localApiToken : ''
  const presented = headerToken(req)
  if (!expected || !presented) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeSurface(raw: unknown): GatewayUsageSurface {
  if (typeof raw === 'string' && VALID_SURFACES.has(raw as GatewayUsageSurface)) {
    return raw as GatewayUsageSurface
  }
  return 'py_loopback'
}

function parseSystemMessages(rawBlocks: unknown, anthropicCaching: boolean): SystemModelMessage[] {
  if (!Array.isArray(rawBlocks)) return []
  const out: SystemModelMessage[] = []
  for (const item of rawBlocks) {
    if (!item || typeof item !== 'object') continue
    const b = item as RawSystemBlock
    if (typeof b.text !== 'string' || b.text.length === 0) continue
    if (anthropicCaching && b.cacheControl === true) {
      out.push({
        role: 'system',
        content: b.text,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
      })
    } else {
      out.push({ role: 'system', content: b.text })
    }
  }
  return out
}

function normalizeToolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

function parseModelMessages(rawMessages: unknown): ModelMessage[] | null {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null
  const out: ModelMessage[] = []
  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') return null
    const m = item as RawMessage
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '' })
      continue
    }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : ''
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : []
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: text })
        continue
      }
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      if (text.length > 0) parts.push({ type: 'text', text })
      for (const tcRaw of calls) {
        if (!tcRaw || typeof tcRaw !== 'object') return null
        const tc = tcRaw as RawToolCall
        if (typeof tc.toolCallId !== 'string' || typeof tc.toolName !== 'string') return null
        parts.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input ?? {}
        })
      }
      out.push({ role: 'assistant', content: parts })
      continue
    }
    if (m.role === 'tool') {
      const resultsRaw = Array.isArray(m.results)
        ? m.results
        : typeof m.toolCallId === 'string' && typeof m.toolName === 'string'
          ? [{ toolCallId: m.toolCallId, toolName: m.toolName, output: m.output ?? m.content }]
          : []
      if (resultsRaw.length === 0) return null
      const toolParts: Array<{
        type: 'tool-result'
        toolCallId: string
        toolName: string
        output: { type: 'text'; value: string }
      }> = []
      for (const resRaw of resultsRaw) {
        if (!resRaw || typeof resRaw !== 'object') return null
        const r = resRaw as RawToolResult
        if (typeof r.toolCallId !== 'string' || typeof r.toolName !== 'string') return null
        toolParts.push({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: {
            type: 'text' as const,
            value: normalizeToolResultText(r.output !== undefined ? r.output : r.content)
          }
        })
      }
      out.push({ role: 'tool', content: toolParts })
      continue
    }
    return null
  }
  return out
}

function buildToolSet(rawTools: unknown): ToolSet | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined
  const out: ToolSet = {}
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as RawToolDef
    if (typeof t.name !== 'string' || t.name.trim().length === 0) continue
    const name = t.name.trim()
    const rawSchema =
      t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
        ? (t.inputSchema as JSONSchema7)
        : ({ type: 'object', properties: {}, additionalProperties: true } as JSONSchema7)
    // Intentionally omit `execute` so generateText performs a single model step and returns
    // structured toolCalls back to the Python orchestrator.
    out[name] = tool({
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: jsonSchema<Record<string, unknown>>(rawSchema)
    }) as ToolSet[string]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseToolChoice(raw: unknown, tools: ToolSet | undefined): ToolChoice<ToolSet> | undefined {
  if (!tools) return undefined
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw
  if (raw && typeof raw === 'object') {
    const obj = raw as { type?: unknown; toolName?: unknown }
    if (
      obj.type === 'tool' &&
      typeof obj.toolName === 'string' &&
      Object.prototype.hasOwnProperty.call(tools, obj.toolName)
    ) {
      return { type: 'tool', toolName: obj.toolName }
    }
  }
  return undefined
}

function clampMaxTokens(raw: unknown, ceiling?: number): number {
  const requested =
    typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_INTERNAL_MAX_TOKENS
  if (typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling > 0) {
    return Math.min(requested, ceiling)
  }
  return requested
}

export async function handleInternalComplete(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!verifyLocalToken(req, cfg)) {
    writeJson(res, 401, {
      ok: false,
      error: { code: 'E_UNAUTHORIZED', message: 'missing or invalid local token' }
    })
    return
  }

  const body = await readJsonBody(req)
  if (isBodyTooLarge(body)) {
    writeJson(res, 413, {
      ok: false,
      error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'request body exceeds limit' }
    })
    return
  }

  const modelRef = typeof body.model === 'string' ? body.model.trim() : ''
  if (!modelRef) {
    writeJson(res, 400, {
      ok: false,
      error: { code: 'E_INVALID_ARG', message: 'model is required' }
    })
    return
  }

  const modelMessages = parseModelMessages(body.messages)
  if (!modelMessages) {
    writeJson(res, 400, {
      ok: false,
      error: { code: 'E_INVALID_ARG', message: 'valid non-empty messages[] required' }
    })
    return
  }

  if (llmCredentialsMissing(cfg)) {
    writeJson(res, 503, {
      ok: false,
      error: { code: 'E_NO_LLM_KEY', message: 'LLM credentials missing' }
    })
    return
  }

  const t0 = Date.now()
  const surface = normalizeSurface(body.surface)
  const shouldRecordUsage = body.recordUsage === true

  let resolved: Awaited<ReturnType<ReturnType<typeof resolveModelFactory>>>
  try {
    resolved = await resolveModelFactory(cfg)(modelRef)
  } catch (err) {
    if (isProviderCredentialsError(err)) {
      writeJson(res, 503, {
        ok: false,
        error: { code: 'E_NO_LLM_KEY', message: err.message }
      })
      return
    }
    if (isPrivacyMaskError(err)) {
      writeJson(res, 503, {
        ok: false,
        error: { code: 'E_PRIVACY_MASK_FAILED', message: err.message }
      })
      return
    }
    const sanitized = sanitizedUpstreamErrorMessage(err)
    writeJson(res, 502, {
      ok: false,
      error: { code: 'E_UPSTREAM', message: sanitized }
    })
    return
  }

  const anthropicCaching = resolved.protocol === 'anthropic' && /claude/i.test(resolved.modelId)
  const systemMessages = parseSystemMessages(body.systemBlocks, anthropicCaching)
  const tools = buildToolSet(body.tools)
  const toolChoice = parseToolChoice(body.toolChoice, tools)
  const maxOutputTokens = clampMaxTokens(body.maxTokens, resolved.maxOutputTokens)
  const sessionIdStr =
    typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
      ? body.sessionId.trim()
      : null

  const controller = new AbortController()
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)

  try {
    const result = await generateText({
      model: resolved.model,
      ...(systemMessages.length > 0 ? { system: systemMessages } : {}),
      messages: modelMessages,
      maxOutputTokens,
      abortSignal: controller.signal,
      ...(resolved.opencodeSession
        ? { headers: { [OPENCODE_SESSION_HEADER]: sessionIdStr ?? opencodeSessionId(null) } }
        : {}),
      ...(anthropicCaching
        ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
        : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {})
    })

    const latencyMs = Date.now() - t0
    const sdkUsage = extractSdkUsage(result.usage)
    const costUsd = costUsdFor(resolved.modelId, sdkUsage ?? null, resolved.protocol)
    const toolCalls = result.toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input
    }))

    if (shouldRecordUsage) {
      try {
        cfg.recordUsageEvent?.({
          surface,
          model: resolved.modelId,
          protocol: resolved.protocol,
          inputTokens: sdkUsage?.inputTokens ?? null,
          outputTokens: sdkUsage?.outputTokens ?? null,
          cacheReadTokens: sdkUsage?.cacheReadTokens ?? null,
          cacheWriteTokens: sdkUsage?.cacheWriteTokens ?? null,
          noCacheTokens: sdkUsage?.noCacheTokens ?? null,
          latencyMs,
          status: 'ok'
        })
      } catch {
        /* best-effort auxiliary usage recording */
      }
    }

    writeJson(res, 200, {
      ok: true,
      model: resolved.modelId,
      providerId: resolved.providerId,
      protocol: resolved.protocol,
      text: result.text,
      toolCalls,
      finishReason: result.finishReason,
      usage: {
        inputTokens: sdkUsage?.inputTokens ?? 0,
        outputTokens: sdkUsage?.outputTokens ?? 0,
        cacheReadTokens: sdkUsage?.cacheReadTokens ?? 0,
        cacheWriteTokens: sdkUsage?.cacheWriteTokens ?? 0,
        noCacheTokens: sdkUsage?.noCacheTokens ?? null
      },
      costUsd,
      latencyMs
    })
  } catch (err) {
    const latencyMs = Date.now() - t0
    const cause = unwrapUpstreamError(err)
    const isQuota = APICallError.isInstance(cause) && cause.statusCode === 429
    const code = isPrivacyMaskError(cause)
      ? 'E_PRIVACY_MASK_FAILED'
      : isProviderCredentialsError(cause)
        ? 'E_NO_LLM_KEY'
        : isQuota
          ? 'E_QUOTA'
          : 'E_UPSTREAM'
    const status = isPrivacyMaskError(cause) || isProviderCredentialsError(cause) ? 503 : isQuota ? 429 : 502
    const message =
      isProviderCredentialsError(cause) || isPrivacyMaskError(cause)
        ? cause.message
        : sanitizedUpstreamErrorMessage(cause)

    if (shouldRecordUsage) {
      try {
        cfg.recordUsageEvent?.({
          surface,
          model: resolved.modelId,
          protocol: resolved.protocol,
          latencyMs,
          status: 'error',
          errorCode: code
        })
      } catch {
        /* best-effort auxiliary usage recording */
      }
    }

    writeJson(res, status, { ok: false, error: { code, message } })
  } finally {
    res.off('close', onClose)
  }
}
