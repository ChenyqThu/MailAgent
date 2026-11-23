// Batch email translation route (`POST /api/ai/translate/batch`) inside the AI Gateway.
//
// Owns block extraction, batching (<=10 segments / <=3000 chars, concurrency 2), LLM calls
// (via providerModelResolver or legacy Anthropic fetch fallback), tolerant JSON rescue, and
// usage telemetry. Reads email bodies & persists segments via serve-api (`cfg.translate` hooks),
// keeping Electron main completely free of writes to sync_store.db.
//
// 🔴 Lazy-load gate (tests/ai-gateway/provider_lazy_import.test.ts): NEVER import `../providers`
//    or any `@ai-sdk/<provider>` package here.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { generateText } from 'ai'

import type { TargetLang, TranslateBatchResult, TranslationSegment } from '@shared/api/types'
import { MAX_OUTPUT_TOKENS } from '@shared/lib/llm_limits'
import type { AiGatewayConfig } from '../config'
import { readJsonBody, writeJson } from '../httpUtil'
import { extractBlocks, type ExtractedBlock } from '../lib/htmlExtractor'
import {
  isPrivacyMaskError,
  isProviderCredentialsError,
  type ProviderProtocol
} from '../providerRef'
import { sanitizedUpstreamErrorMessage } from '../upstreamError'

export const TRANSLATE_BATCH_SIZE = 10
export const TRANSLATE_BATCH_CHAR_BUDGET = 3000
const CONCURRENCY = 2
const FETCH_TIMEOUT_MS = 240_000
const CRS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'

export class TranslateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'TranslateError'
  }
}

export interface TranslateBatchOpts {
  internalId: number
  targetLang?: TargetLang
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>
  model?: string
  stop_reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

interface BatchOutcome {
  segments: TranslationSegment[]
  modelReturned: string
  ok: boolean
}

const _inflight = new Map<number, Set<AbortController>>()

function registerAbort(internalId: number, ac: AbortController): void {
  let set = _inflight.get(internalId)
  if (!set) {
    set = new Set()
    _inflight.set(internalId, set)
  }
  set.add(ac)
}

function unregisterAbort(internalId: number, ac: AbortController): void {
  const set = _inflight.get(internalId)
  if (!set) return
  set.delete(ac)
  if (set.size === 0) _inflight.delete(internalId)
}

function abortInternalId(internalId: number): void {
  const set = _inflight.get(internalId)
  if (!set) return
  for (const ac of set) ac.abort()
  _inflight.delete(internalId)
}

/** Abort all in-flight batch translations (gateway teardown / unit tests). */
export function abortAllTranslations(): void {
  for (const set of _inflight.values()) {
    for (const ac of set) ac.abort()
  }
  _inflight.clear()
}

export function batchSystemPromptFor(target: TargetLang): string {
  const lang =
    target === 'zh'
      ? 'fluent natural Simplified Chinese (mainland usage)'
      : 'fluent natural English'
  return [
    `You translate email paragraphs into ${lang}.`,
    'Input is a JSON array of {"id": "...", "text": "..."} — one entry per paragraph.',
    'Output STRICTLY a JSON array of {"id": "...", "tgt": "..."} — one entry per input,',
    'matching by id; same length and same order as the input. Rules:',
    '- Preserve URLs, email addresses, code identifiers, product names, and people names verbatim.',
    '- Translate the FULL meaning of each text into the target language, not literal word-for-word.',
    '- If a paragraph is already in the target language, output it verbatim as tgt.',
    '- **CRITICAL JSON SAFETY**: tgt strings MUST NOT contain raw ASCII double quotes (").',
    '  If you need to quote a phrase, use Chinese 「」 quotes for Chinese tgt, or escape as \\".',
    '  Unescaped " inside tgt breaks JSON parsing and the whole batch is lost.',
    '- Output ONLY the JSON array. No preamble, no commentary, no ```json fence, no trailing prose.'
  ].join('\n')
}

function shapeCheckArray(candidate: unknown): Array<{ id: string; tgt: string }> | null {
  if (!Array.isArray(candidate)) return null
  const out: Array<{ id: string; tgt: string }> = []
  for (const item of candidate) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    const tgt = (item as { tgt?: unknown }).tgt
    if (typeof id !== 'string' || typeof tgt !== 'string') continue
    if (tgt.trim().length === 0) continue
    out.push({ id, tgt: tgt.trim() })
  }
  return out.length > 0 ? out : null
}

function parseLeniently(raw: string): Array<{ id: string; tgt: string }> | null {
  const idRe = /"id"\s*:\s*"([a-f0-9]{4,32})"/g
  const anchors: Array<{ id: string; afterId: number }> = []
  let m: RegExpExecArray | null
  while ((m = idRe.exec(raw)) !== null) {
    anchors.push({ id: m[1]!, afterId: m.index + m[0].length })
  }
  if (anchors.length === 0) return null

  const out: Array<{ id: string; tgt: string }> = []
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i]!
    const end = i + 1 < anchors.length ? anchors[i + 1]!.afterId - 7 : raw.length
    const segment = raw.slice(cur.afterId, end)
    const tgtStart = segment.search(/"tgt"\s*:\s*"/)
    if (tgtStart < 0) continue
    const valStartMatch = segment.slice(tgtStart).match(/"tgt"\s*:\s*"/)
    if (!valStartMatch) continue
    const valStart = tgtStart + valStartMatch[0].length
    let valEnd = segment.lastIndexOf('}')
    if (valEnd < 0) valEnd = segment.length
    let closingQuote = segment.lastIndexOf('"', valEnd - 1)
    if (closingQuote <= valStart) closingQuote = segment.length
    let tgt = segment.slice(valStart, closingQuote)
    tgt = tgt.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').trim()
    if (tgt.length > 0) out.push({ id: cur.id, tgt })
  }
  return out.length > 0 ? out : null
}

/** Three-stage tolerant JSON-array parser for LLM translation output. */
export function parseBatchJson(raw: string): Array<{ id: string; tgt: string }> | null {
  try {
    const out = shapeCheckArray(JSON.parse(raw))
    if (out !== null) return out
  } catch {
    /* fall through */
  }
  const m = raw.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const out = shapeCheckArray(JSON.parse(m[0]))
      if (out !== null) return out
    } catch {
      /* fall through */
    }
  }
  return parseLeniently(raw)
}

function pairSegments(
  batch: ExtractedBlock[],
  parsed: Array<{ id: string; tgt: string }>
): TranslationSegment[] {
  const tgtMap = new Map<string, string>()
  for (const p of parsed) tgtMap.set(p.id, p.tgt)
  const segments: TranslationSegment[] = []
  for (const b of batch) {
    const tgt = tgtMap.get(b.id)
    if (tgt && tgt.length > 0) segments.push({ src: b.text, tgt })
  }
  return segments
}

function recordBatchUsage(
  cfg: AiGatewayConfig,
  input: {
    model: string
    protocol: ProviderProtocol | null
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    noCacheTokens: number | null
    latencyMs: number
  }
): void {
  try {
    cfg.recordUsageEvent?.({
      surface: 'translate',
      model: input.model,
      protocol: input.protocol,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      noCacheTokens: input.noCacheTokens,
      latencyMs: input.latencyMs,
      status: 'ok'
    })
  } catch {
    /* best-effort telemetry */
  }
}

async function runOneBatchWithProvider(
  cfg: AiGatewayConfig,
  batch: ExtractedBlock[],
  targetLang: TargetLang,
  model: string,
  internalId: number,
  parentAc: AbortController
): Promise<BatchOutcome> {
  if (!cfg.providerModelResolver) {
    throw new TranslateError('E_NO_LLM_KEY', 'Provider model resolver is not configured')
  }
  const idText = batch.map((b) => ({ id: b.id, text: b.text }))
  const batchTextChars = batch.reduce((sum, b) => sum + b.text.length, 0)
  const ac = new AbortController()
  const onParentAbort = (): void => ac.abort()
  parentAc.signal.addEventListener('abort', onParentAbort, { once: true })
  registerAbort(internalId, ac)
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const resolved = await cfg.providerModelResolver.resolve(model)
    const result = await generateText({
      model: resolved.model,
      maxOutputTokens: resolved.maxOutputTokens,
      system: batchSystemPromptFor(targetLang),
      prompt: JSON.stringify(idText),
      abortSignal: ac.signal
    })
    recordBatchUsage(cfg, {
      model,
      protocol: resolved.protocol,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cacheReadTokens: result.usage?.inputTokenDetails?.cacheReadTokens ?? null,
      cacheWriteTokens: result.usage?.inputTokenDetails?.cacheWriteTokens ?? null,
      noCacheTokens: result.usage?.inputTokenDetails?.noCacheTokens ?? null,
      latencyMs: Date.now() - t0
    })
    if (result.finishReason === 'length') {
      cfg.logEvent?.({
        event: 'translate.batch_truncated',
        internalId,
        batchBlocks: batch.length,
        batchChars: batchTextChars
      })
    }
    const text = result.text
    if (text.trim().length === 0) {
      cfg.logEvent?.({ event: 'translate.batch_empty', internalId })
      return { segments: [], modelReturned: resolved.modelId, ok: false }
    }
    const parsed = parseBatchJson(text.trim())
    if (parsed === null) {
      cfg.logEvent?.({
        event: 'translate.batch_parse_failed',
        internalId,
        raw: text.slice(0, 200)
      })
      return { segments: [], modelReturned: resolved.modelId, ok: false }
    }
    return {
      segments: pairSegments(batch, parsed),
      modelReturned: resolved.modelId,
      ok: true
    }
  } catch (err) {
    if (isProviderCredentialsError(err)) {
      throw new TranslateError('E_NO_LLM_KEY', err.message)
    }
    if (isPrivacyMaskError(err)) {
      throw new TranslateError('E_PRIVACY_MASK_FAILED', err.message)
    }
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      cfg.logEvent?.({ event: 'translate.batch_aborted', internalId })
      return { segments: [], modelReturned: model, ok: false }
    }
    cfg.logEvent?.({
      event: 'translate.batch_fetch_failed',
      internalId,
      error: sanitizedUpstreamErrorMessage(err)
    })
    return { segments: [], modelReturned: model, ok: false }
  } finally {
    clearTimeout(timer)
    parentAc.signal.removeEventListener('abort', onParentAbort)
    unregisterAbort(internalId, ac)
  }
}

async function runOneBatchLegacy(
  cfg: AiGatewayConfig,
  batch: ExtractedBlock[],
  targetLang: TargetLang,
  baseUrl: string,
  apiKey: string,
  model: string,
  internalId: number,
  parentAc: AbortController
): Promise<BatchOutcome> {
  const idText = batch.map((b) => ({ id: b.id, text: b.text }))
  const batchTextChars = batch.reduce((sum, b) => sum + b.text.length, 0)
  const ac = new AbortController()
  const onParentAbort = (): void => ac.abort()
  parentAc.signal.addEventListener('abort', onParentAbort, { once: true })
  registerAbort(internalId, ac)
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  const url = `${baseUrl}/v1/messages`
  const t0 = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'user-agent': CRS_USER_AGENT
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: batchSystemPromptFor(targetLang),
        messages: [{ role: 'user', content: JSON.stringify(idText) }]
      }),
      signal: ac.signal
    })
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 500)
      } catch {
        /* body consumed */
      }
      cfg.logEvent?.({
        event: 'translate.batch_http_error',
        internalId,
        status: response.status,
        detail
      })
      return { segments: [], modelReturned: model, ok: false }
    }
    const payload = (await response.json()) as MessagesResponse
    if (payload.usage) {
      const uncached = payload.usage.input_tokens ?? null
      const cacheRead = payload.usage.cache_read_input_tokens ?? null
      const cacheWrite = payload.usage.cache_creation_input_tokens ?? null
      const totalInput =
        uncached != null ? uncached + (cacheRead ?? 0) + (cacheWrite ?? 0) : null
      recordBatchUsage(cfg, {
        model: payload.model ?? model,
        protocol: 'anthropic',
        inputTokens: totalInput,
        outputTokens: payload.usage.output_tokens ?? null,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        noCacheTokens: uncached,
        latencyMs: Date.now() - t0
      })
    }
    if (payload.stop_reason === 'max_tokens') {
      cfg.logEvent?.({
        event: 'translate.batch_truncated',
        internalId,
        batchBlocks: batch.length,
        batchChars: batchTextChars
      })
    }
    const text = payload.content?.find((b) => b.type === 'text')?.text ?? payload.content?.[0]?.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      cfg.logEvent?.({ event: 'translate.batch_empty', internalId })
      return { segments: [], modelReturned: payload.model ?? model, ok: false }
    }
    const parsed = parseBatchJson(text.trim())
    if (parsed === null) {
      cfg.logEvent?.({
        event: 'translate.batch_parse_failed',
        internalId,
        raw: text.slice(0, 200)
      })
      return { segments: [], modelReturned: payload.model ?? model, ok: false }
    }
    return {
      segments: pairSegments(batch, parsed),
      modelReturned: payload.model ?? model,
      ok: true
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      cfg.logEvent?.({ event: 'translate.batch_aborted', internalId })
      return { segments: [], modelReturned: model, ok: false }
    }
    cfg.logEvent?.({
      event: 'translate.batch_fetch_failed',
      internalId,
      error: err instanceof Error ? err.message : String(err)
    })
    return { segments: [], modelReturned: model, ok: false }
  } finally {
    clearTimeout(timer)
    parentAc.signal.removeEventListener('abort', onParentAbort)
    unregisterAbort(internalId, ac)
  }
}

export function buildTranslateBatches(blocks: ExtractedBlock[]): ExtractedBlock[][] {
  const out: ExtractedBlock[][] = []
  let current: ExtractedBlock[] = []
  let currentChars = 0
  for (const block of blocks) {
    const wouldExceedCount = current.length >= TRANSLATE_BATCH_SIZE
    const wouldExceedChars =
      current.length > 0 && currentChars + block.text.length > TRANSLATE_BATCH_CHAR_BUDGET
    if (wouldExceedCount || wouldExceedChars) {
      out.push(current)
      current = []
      currentChars = 0
    }
    current.push(block)
    currentChars += block.text.length
  }
  if (current.length > 0) out.push(current)
  return out
}

async function withConcurrency<T, U>(
  jobs: T[],
  limit: number,
  worker: (job: T, idx: number) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(jobs.length)
  let cursor = 0
  async function pump(): Promise<void> {
    while (cursor < jobs.length) {
      const my = cursor++
      results[my] = await worker(jobs[my]!, my)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, pump))
  return results
}

async function persistGuardedTranslation(
  cfg: AiGatewayConfig,
  input: {
    internalId: number
    targetLang: TargetLang
    segments: TranslationSegment[]
    model: string
  }
): Promise<{ cacheKept: boolean; cacheWriteFailed: boolean; fetchedAt: number | null }> {
  const fallbackTs = Date.now() / 1000
  if (!cfg.translate) return { cacheKept: false, cacheWriteFailed: false, fetchedAt: fallbackTs }
  try {
    const res = await cfg.translate.saveTranslation({
      ...input,
      source: 'on_demand'
    })
    return {
      cacheKept: res.cacheKept === true,
      cacheWriteFailed: false,
      fetchedAt: typeof res.fetchedAt === 'number' ? res.fetchedAt : fallbackTs
    }
  } catch (err) {
    cfg.logEvent?.({
      event: 'translate.cache_write_failed',
      internalId: input.internalId,
      err: err instanceof Error ? err.message : String(err)
    })
    return { cacheKept: false, cacheWriteFailed: true, fetchedAt: null }
  }
}

/** Execute batch translation using `cfg.translate` hooks and `cfg.providerModelResolver`. */
export async function translateBatchWithConfig(
  opts: TranslateBatchOpts,
  cfg: AiGatewayConfig,
  externalSignal?: AbortSignal
): Promise<TranslateBatchResult> {
  const internalId = opts.internalId
  if (!Number.isInteger(internalId) || internalId < 0) {
    throw new TranslateError(
      'E_INVALID_ARG',
      `internalId must be a non-negative integer, got ${String(internalId)}`
    )
  }
  const hooks = cfg.translate
  if (!hooks) {
    throw new TranslateError('E_NOT_CONFIGURED', 'Translation hooks are not configured')
  }
  const targetLang: TargetLang = opts.targetLang === 'en' ? 'en' : 'zh'

  const html = await hooks.readBodyHtml(internalId, externalSignal)
  if (html === null || html.length === 0) {
    throw new TranslateError(
      'E_NO_BODY',
      `email_body.body_html/body_markdown for internal_id=${internalId} is empty or missing`
    )
  }

  const blocks = extractBlocks(html)
  if (blocks.length === 0) {
    const persisted = await persistGuardedTranslation(cfg, {
      internalId,
      targetLang,
      segments: [],
      model: ''
    })
    return {
      internalId,
      targetLang,
      segments: [],
      source: 'on_demand',
      model: '',
      fetchedAt: persisted.fetchedAt,
      latencyMs: 0,
      failedBatches: 0,
      totalBatches: 0,
      ...(persisted.cacheKept ? { cacheKept: true } : {}),
      ...(persisted.cacheWriteFailed ? { cacheWriteFailed: true } : {})
    }
  }

  const providerRegistryEnabled = hooks.isProviderRegistryEnabled()
  const useProviderRegistry =
    providerRegistryEnabled && !(await hooks.hasExplicitTranslateProfile())
  const apiKey = (await hooks.getTranslateApiKey()) ?? ''
  if (!useProviderRegistry && !apiKey) {
    throw new TranslateError(
      'E_NO_LLM_KEY',
      'LLM translate API key not configured — set it in Settings or LLM_TRANSLATE_API_KEY env'
    )
  }
  const baseUrl = hooks.getTranslateBaseUrl()
  const model = hooks.getTranslateModel()

  abortInternalId(internalId)
  const parentAc = new AbortController()
  registerAbort(internalId, parentAc)
  const onExternalAbort = (): void => parentAc.abort()
  if (externalSignal) {
    if (externalSignal.aborted) parentAc.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const batches = buildTranslateBatches(blocks)
  const start = Date.now()
  cfg.logEvent?.({
    event: 'translate.batch_start',
    internalId,
    targetLang,
    model,
    baseUrl,
    blocks: blocks.length,
    batches: batches.length
  })

  try {
    const outcomes = await withConcurrency(batches, CONCURRENCY, (batch) =>
      useProviderRegistry
        ? runOneBatchWithProvider(cfg, batch, targetLang, model, internalId, parentAc)
        : runOneBatchLegacy(cfg, batch, targetLang, baseUrl, apiKey, model, internalId, parentAc)
    )

    const segments: TranslationSegment[] = []
    let failed = 0
    let modelReturned = model
    for (const oc of outcomes) {
      if (!oc.ok) failed++
      if (oc.modelReturned) modelReturned = oc.modelReturned
      for (const seg of oc.segments) segments.push(seg)
    }

    const latencyMs = Date.now() - start
    const persisted = parentAc.signal.aborted
      ? { cacheKept: false, cacheWriteFailed: false, fetchedAt: Date.now() / 1000 }
      : await persistGuardedTranslation(cfg, {
          internalId,
          targetLang,
          segments,
          model: modelReturned
        })

    cfg.logEvent?.({
      event: 'translate.batch_done',
      internalId,
      latencyMs,
      segments: segments.length,
      failedBatches: failed,
      totalBatches: batches.length
    })

    return {
      internalId,
      targetLang,
      segments,
      source: 'on_demand',
      model: modelReturned,
      fetchedAt: persisted.fetchedAt,
      latencyMs,
      failedBatches: failed,
      totalBatches: batches.length,
      ...(persisted.cacheKept ? { cacheKept: true } : {}),
      ...(persisted.cacheWriteFailed ? { cacheWriteFailed: true } : {})
    }
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
    unregisterAbort(internalId, parentAc)
  }
}

function httpStatusForErrorCode(code: string): number {
  if (code === 'E_INVALID_ARG') return 400
  if (code === 'E_NO_BODY') return 404
  if (code === 'E_PRIVACY_MASK_FAILED') return 422
  if (code === 'E_NO_LLM_KEY') return 503
  if (code === 'E_NOT_CONFIGURED') return 501
  return 500
}

/** `POST /api/ai/translate/batch` — on-demand HTML email batch translation. */
export async function handleTranslateBatch(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.translate) {
    writeJson(res, 501, {
      error: 'E_NOT_CONFIGURED',
      message: 'Translation hooks not wired on gateway'
    })
    return
  }

  const reqAc = new AbortController()
  const onClose = (): void => {
    if (!res.writableFinished && !res.writableEnded) reqAc.abort()
  }
  res.on('close', onClose)

  try {
    const body = await readJsonBody(req)
    const internalId = body.internalId
    const targetLang: TargetLang = body.targetLang === 'en' ? 'en' : 'zh'
    if (typeof internalId !== 'number' || !Number.isInteger(internalId) || internalId < 0) {
      writeJson(res, 400, {
        error: 'E_INVALID_ARG',
        message: `internalId must be a non-negative integer, got ${String(internalId)}`
      })
      return
    }

    const result = await translateBatchWithConfig({ internalId, targetLang }, cfg, reqAc.signal)
    if (res.destroyed || res.writableEnded) return
    if (reqAc.signal.aborted) {
      writeJson(res, 499, { error: 'E_ABORTED', message: 'Translation aborted' })
      return
    }
    writeJson(res, 200, result)
  } catch (err) {
    if (res.destroyed || res.writableEnded) return
    if (err instanceof TranslateError) {
      writeJson(res, httpStatusForErrorCode(err.code), {
        error: err.code,
        message: err.message
      })
      return
    }
    writeJson(res, 500, {
      error: 'E_INTERNAL',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    res.off('close', onClose)
  }
}
