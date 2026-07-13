// Sprint Immersive-Translate — batch translate IPC + SQLite cache (DB v12).
//
// 三个 IPC:
//   - translate:batch        on-demand 翻译 (Path B): extract → 分批 LLM → 写
//                            email_translation 表 → return {segments, ...}
//   - translation:get        读缓存 (Path A 由 LLMRunner 写, Path B 由本文件写)
//   - translation:delete     "重新翻译" 触发, 删缓存
//
// 删除项 (handoff 已说明):
//   - 旧 email:translate 整篇 markdown 路径
//   - LLM_TRANSLATE_BILINGUAL + ⟦S⟧⟦T⟧⟦E⟧ sentinel 解析
//   - parseBilingualSegments / bilingualSystemPromptFor
//   - TranslateOpts.bilingual / TranslateResult.segments(markdown 形式) /
//     TranslateResult.translated
//
// 同名 IPC `email:translate` + `email:translateAbort` 保留以保持 preload 表
// 不变, 但内部转向 batch path; ElectronApi.ts 在 Task #7 改造 renderer 调用。
//
// 架构修正 (handoff 重读时确认):
//   - iframe sandbox 是 allow-same-origin (无 allow-scripts), 注入译文由 parent
//     直接操作 iframe.contentDocument 完成, 不用 postMessage; 本文件不参与渲染,
//     只负责 LLM 调度 + SQLite I/O。
//   - 译文配对用 textContent.includes(src) fuzzy match, 不依赖 data-i18n-id;
//     所以 extractBlocks 返回的 id 只是 batch 内 dedupe key, 不写 SSoT。

import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateText } from 'ai'

import { isProviderCredentialsError } from '../../../ai-gateway/providerRef'
import { getDb, resolveDbPath } from '../db'
import { extractBlocks, type ExtractedBlock } from '../lib/html-extractor'
import {
  getLlmProviderModelResolver,
  isLlmProviderRegistryEnabled
} from '../llm_provider_resolver'
import { plaintextToHtml } from '@shared/lib/plaintext_html'
import {
  getLlmTranslateApiKey,
  getLlmTranslateBaseUrl,
  getLlmTranslateModel
} from '../llm_settings'

export type TargetLang = 'zh' | 'en'

export interface TranslateBatchOpts {
  internalId: number
  targetLang?: TargetLang
}

export interface TranslationSegment {
  src: string
  tgt: string
}

export interface TranslationCache {
  internalId: number
  targetLang: TargetLang
  segments: TranslationSegment[]
  /** 'llm_agent' (Path A) | 'on_demand' (Path B); null on a freshly-rejected
   *  cache miss. */
  source: string | null
  model: string | null
  fetchedAt: number | null
}

export interface TranslateBatchResult extends TranslationCache {
  latencyMs: number
  /** 0 if every batch succeeded; equals total batch count if all failed.
   *  Renderer surfaces a partial-failure indicator when this is non-zero. */
  failedBatches: number
  totalBatches: number
  /** true when a shorter fresh result was returned but an existing richer cache
   *  row was kept to avoid downgrading the immersive translation coverage. */
  cacheKept?: boolean
}

export class TranslateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'TranslateError'
  }
}

// ============================================================================
// Logging
// ============================================================================

let _logPathCache: string | null = null
function logPath(): string | null {
  if (_logPathCache !== null) return _logPathCache
  try {
    const dir = app.getPath('logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    _logPathCache = join(dir, 'translate.log')
    return _logPathCache
  } catch {
    return null
  }
}
function logLine(rec: Record<string, unknown>): void {
  const p = logPath()
  if (p === null) return
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'
    appendFileSync(p, line, 'utf8')
  } catch {
    /* logging never throws */
  }
}

// ============================================================================
// SQLite (readwrite singleton for email_translation table only)
// ============================================================================

// Main `db.ts` is readonly (REVIEW-LOG C-05 — schema is mail-sync territory).
// Translation cache is the one exception: renderer-initiated writes against
// a single table that doesn't conflict with mail-sync's responsibilities.
// We keep a separate writable handle so the main readonly conn stays clean.
let _writeDb: Database.Database | null = null
function writeDb(): Database.Database {
  if (_writeDb) return _writeDb
  const path = resolveDbPath()
  _writeDb = new Database(path, { fileMustExist: true })
  _writeDb.pragma('journal_mode = WAL')
  _writeDb.pragma('foreign_keys = ON')
  _writeDb.pragma('busy_timeout = 2000') // writer holds longer than 500ms reader
  return _writeDb
}

export function closeTranslateDb(): void {
  if (_writeDb) {
    _writeDb.close()
    _writeDb = null
  }
}

function readBodyHtml(internalId: number): string | null {
  const row = getDb()
    .prepare('SELECT body_html, body_markdown FROM email_body WHERE internal_id = ?')
    .get(internalId) as { body_html: string | null; body_markdown: string | null } | undefined
  if (!row) return null
  if (typeof row.body_html === 'string' && row.body_html.length > 0) return row.body_html
  if (typeof row.body_markdown !== 'string' || row.body_markdown.length === 0) return null

  // text-only fallback 必须和 EmailBodyFrame 共用 plaintextToHtml 产物；
  // extractBlocks 与 iframe DOM 同源，译文注入的文本匹配才稳定。
  const html = plaintextToHtml(row.body_markdown)
  return html.length > 0 ? html : null
}

function readCache(internalId: number, targetLang: TargetLang): TranslationCache | null {
  // Read via the same writable conn so the reader sees its own writes
  // immediately (WAL otherwise has small visibility window).
  const row = writeDb()
    .prepare(
      `SELECT segments_json, model, source, updated_at
         FROM email_translation
        WHERE internal_id = ? AND target_lang = ?`
    )
    .get(internalId, targetLang) as
    | { segments_json: string; model: string | null; source: string; updated_at: number }
    | undefined
  if (!row) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.segments_json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const segments: TranslationSegment[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const src = (item as { src?: unknown }).src
    const tgt = (item as { tgt?: unknown }).tgt
    if (typeof src !== 'string' || typeof tgt !== 'string') continue
    if (!src.trim() || !tgt.trim()) continue
    segments.push({ src: src.trim(), tgt: tgt.trim() })
  }
  return {
    internalId,
    targetLang,
    segments,
    source: row.source,
    model: row.model,
    fetchedAt: row.updated_at
  }
}

function writeCache(
  internalId: number,
  targetLang: TargetLang,
  segments: TranslationSegment[],
  model: string,
  source: 'on_demand' | 'llm_agent'
): void {
  const now = Date.now() / 1000
  const payload = JSON.stringify(
    segments.map((s) => ({ src: s.src, tgt: s.tgt })),
    null,
    0
  )
  try {
    writeDb()
      .prepare(
        `INSERT INTO email_translation
           (internal_id, target_lang, segments_json, model, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(internal_id) DO UPDATE SET
           target_lang   = excluded.target_lang,
           segments_json = excluded.segments_json,
           model         = excluded.model,
           source        = excluded.source,
           updated_at    = excluded.updated_at`
      )
      .run(internalId, targetLang, payload, model, source, now, now)
  } catch (err) {
    // FK violation (orphan internal_id) is non-fatal — frontend still gets
    // the segments in the IPC reply, just no cache next time.
    const msg = err instanceof Error ? err.message : String(err)
    logLine({ event: 'translate.cache_write_failed', internalId, err: msg })
  }
}

function writeCacheGuarded(
  internalId: number,
  targetLang: TargetLang,
  segments: TranslationSegment[],
  model: string,
  source: 'on_demand' | 'llm_agent'
): boolean {
  let existing: TranslationCache | null = null
  try {
    existing = readCache(internalId, targetLang)
  } catch (err) {
    logLine({
      event: 'translate.cache_guard_read_failed',
      internalId,
      targetLang,
      error: err instanceof Error ? err.message : String(err)
    })
  }
  if (existing && segments.length < existing.segments.length) {
    logLine({
      event: 'translate.cache_kept',
      internalId,
      targetLang,
      oldSegments: existing.segments.length,
      newSegments: segments.length
    })
    return true
  }
  writeCache(internalId, targetLang, segments, model, source)
  return false
}

function deleteCache(internalId: number, targetLang: TargetLang): boolean {
  const info = writeDb()
    .prepare('DELETE FROM email_translation WHERE internal_id = ? AND target_lang = ?')
    .run(internalId, targetLang)
  return info.changes > 0
}

// ============================================================================
// LLM batch call
// ============================================================================

const BATCH_SIZE = 10
const BATCH_TEXT_CHAR_BUDGET = 3000
const CONCURRENCY = 2
const FETCH_TIMEOUT_MS = 240_000
const MAX_OUTPUT_TOKENS = 64_000
const CRS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'
// Abort controller registry — one per internalId; renderer fires
// `email:translateAbort` on email switch to drop all in-flight batches for
// the now-stale email.
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

export function abortAllTranslations(): void {
  for (const set of _inflight.values()) {
    for (const ac of set) ac.abort()
  }
  _inflight.clear()
}

function batchSystemPromptFor(target: TargetLang): string {
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

/** Tolerant JSON-array parser for LLM output.
 *
 * Three-stage:
 *   1. Strict JSON.parse.
 *   2. Regex-extract the first `[...]` block, JSON.parse that.
 *   3. **Lenient item-by-item** scanner — anchors on `"id":"..."` markers
 *      and grabs the associated `"tgt":"..."` value tolerating unescaped
 *      double quotes inside (a real-world failure mode: LLMs frequently
 *      emit `"tgt":""Cisco PCI Compliance""` when quoting proper nouns,
 *      which crashes strict JSON.parse and dumps the whole batch).
 *
 * Validates shape: each item must have string id + non-empty string tgt.
 */
function parseBatchJson(raw: string): Array<{ id: string; tgt: string }> | null {
  // Stage 1: strict JSON
  try {
    const candidate = JSON.parse(raw)
    const out = shapeCheckArray(candidate)
    if (out !== null) return out
  } catch {
    /* fall through */
  }
  // Stage 2: regex slice [...]
  const m = raw.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const candidate = JSON.parse(m[0])
      const out = shapeCheckArray(candidate)
      if (out !== null) return out
    } catch {
      /* fall through */
    }
  }
  // Stage 3: lenient item-by-item rescue
  return parseLeniently(raw)
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

/** Last-resort scanner: locate every `"id":"<8 hex>"` then capture the tgt
 *  value up to the next item boundary (next `"id":` or end-of-string). The
 *  tgt slice is then trimmed of its enclosing quote-and-brace artifacts.
 *  Tolerates unescaped `"` inside tgt values that crash strict JSON. */
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
    // -7 to back off the next anchor's `"id":"…` prefix; we want to land in
    // the inter-item gap, not inside the next id literal.
    const segment = raw.slice(cur.afterId, end)
    // Find `"tgt":"…"` and take everything between the opening quote and the
    // LAST closing `"` followed by item-end (`}` then , or ]).
    const tgtStart = segment.search(/"tgt"\s*:\s*"/)
    if (tgtStart < 0) continue
    const valStartMatch = segment.slice(tgtStart).match(/"tgt"\s*:\s*"/)
    if (!valStartMatch) continue
    const valStart = tgtStart + valStartMatch[0].length
    // Trim from the end backwards: find the last "} (object close), drop
    // anything trailing it; the closing `"` immediately before `}` is the
    // string terminator. If `}` not found, take to end-of-segment.
    let valEnd = segment.lastIndexOf('}')
    if (valEnd < 0) valEnd = segment.length
    // The last `"` before `}` is the closing quote.
    let closingQuote = segment.lastIndexOf('"', valEnd - 1)
    if (closingQuote <= valStart) closingQuote = segment.length
    let tgt = segment.slice(valStart, closingQuote)
    // Unescape common JSON escapes we expect LLM to emit correctly.
    tgt = tgt.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
    tgt = tgt.trim()
    if (tgt.length > 0) {
      out.push({ id: cur.id, tgt })
    }
  }
  return out.length > 0 ? out : null
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>
  model?: string
  stop_reason?: string
}

interface BatchOutcome {
  segments: TranslationSegment[]
  modelReturned: string
  ok: boolean
}

function hasExplicitTranslateProfile(): boolean {
  return Boolean(process.env['LLM_TRANSLATE_BASE_URL'] || process.env['LLM_TRANSLATE_API_KEY'])
}

async function runOneBatchWithProvider(
  batch: ExtractedBlock[],
  targetLang: TargetLang,
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
  try {
    const resolver = await getLlmProviderModelResolver()
    const resolved = await resolver.resolve(model)
    const result = await generateText({
      model: resolved.model,
      maxOutputTokens: resolved.maxOutputTokens,
      system: batchSystemPromptFor(targetLang),
      prompt: JSON.stringify(idText),
      abortSignal: ac.signal
    })
    if (result.finishReason === 'length') {
      logLine({
        event: 'translate.batch_truncated',
        internalId,
        batchBlocks: batch.length,
        batchChars: batchTextChars
      })
    }
    const text = result.text
    if (text.trim().length === 0) {
      logLine({ event: 'translate.batch_empty', internalId })
      return { segments: [], modelReturned: resolved.modelId, ok: false }
    }
    const parsed = parseBatchJson(text.trim())
    if (parsed === null) {
      logLine({ event: 'translate.batch_parse_failed', internalId, raw: text.slice(0, 200) })
      return { segments: [], modelReturned: resolved.modelId, ok: false }
    }
    const tgtMap = new Map<string, string>()
    for (const p of parsed) tgtMap.set(p.id, p.tgt)
    const segments: TranslationSegment[] = []
    for (const b of batch) {
      const tgt = tgtMap.get(b.id)
      if (tgt && tgt.length > 0) segments.push({ src: b.text, tgt })
    }
    return { segments, modelReturned: resolved.modelId, ok: true }
  } catch (err) {
    if (isProviderCredentialsError(err)) {
      throw new TranslateError('E_NO_LLM_KEY', err.message)
    }
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      logLine({ event: 'translate.batch_aborted', internalId })
      return { segments: [], modelReturned: model, ok: false }
    }
    const msg = err instanceof Error ? err.message : String(err)
    logLine({ event: 'translate.batch_fetch_failed', internalId, error: msg })
    return { segments: [], modelReturned: model, ok: false }
  } finally {
    clearTimeout(timer)
    parentAc.signal.removeEventListener('abort', onParentAbort)
    unregisterAbort(internalId, ac)
  }
}

async function runOneBatch(
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
  // Bind to parent abort: abortInternalId fires parentAc which we relay here.
  const onParentAbort = (): void => ac.abort()
  parentAc.signal.addEventListener('abort', onParentAbort, { once: true })
  registerAbort(internalId, ac)
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  const url = `${baseUrl}/v1/messages`
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
      logLine({
        event: 'translate.batch_http_error',
        internalId,
        status: response.status,
        detail
      })
      return { segments: [], modelReturned: model, ok: false }
    }
    const payload = (await response.json()) as MessagesResponse
    if (payload.stop_reason === 'max_tokens') {
      logLine({
        event: 'translate.batch_truncated',
        internalId,
        batchBlocks: batch.length,
        batchChars: batchTextChars
      })
    }
    const text = payload.content?.find((b) => b.type === 'text')?.text ?? payload.content?.[0]?.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      logLine({ event: 'translate.batch_empty', internalId })
      return { segments: [], modelReturned: payload.model ?? model, ok: false }
    }
    const parsed = parseBatchJson(text.trim())
    if (parsed === null) {
      logLine({ event: 'translate.batch_parse_failed', internalId, raw: text.slice(0, 200) })
      return { segments: [], modelReturned: payload.model ?? model, ok: false }
    }
    // Pair LLM output back with the original src text by id; if LLM emitted
    // ids out-of-order or skipped some, we still pair by id, dropping any
    // unrecognized id and silently skipping un-translated inputs (the
    // renderer will display only the segments it gets, which is the desired
    // graceful-degradation behaviour).
    const tgtMap = new Map<string, string>()
    for (const p of parsed) tgtMap.set(p.id, p.tgt)
    const segments: TranslationSegment[] = []
    for (const b of batch) {
      const tgt = tgtMap.get(b.id)
      if (tgt && tgt.length > 0) {
        segments.push({ src: b.text, tgt })
      }
    }
    return { segments, modelReturned: payload.model ?? model, ok: true }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      logLine({ event: 'translate.batch_aborted', internalId })
      return { segments: [], modelReturned: model, ok: false }
    }
    const msg = err instanceof Error ? err.message : String(err)
    logLine({ event: 'translate.batch_fetch_failed', internalId, error: msg })
    return { segments: [], modelReturned: model, ok: false }
  } finally {
    clearTimeout(timer)
    parentAc.signal.removeEventListener('abort', onParentAbort)
    unregisterAbort(internalId, ac)
  }
}

function buildBatches(blocks: ExtractedBlock[]): ExtractedBlock[][] {
  const out: ExtractedBlock[][] = []
  let current: ExtractedBlock[] = []
  let currentChars = 0
  for (const block of blocks) {
    const wouldExceedCount = current.length >= BATCH_SIZE
    const wouldExceedChars =
      current.length > 0 && currentChars + block.text.length > BATCH_TEXT_CHAR_BUDGET
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

/** Run N async jobs with at most `limit` concurrent. Preserves output order
 *  matching `jobs` input order. */
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

// ============================================================================
// Public entry: translateBatch
// ============================================================================

export async function translateBatch(opts: TranslateBatchOpts): Promise<TranslateBatchResult> {
  const internalId = opts.internalId
  if (!Number.isInteger(internalId) || internalId < 0) {
    throw new TranslateError(
      'E_INVALID_ARG',
      `internalId must be a non-negative integer, got ${String(internalId)}`
    )
  }
  const targetLang: TargetLang = opts.targetLang === 'en' ? 'en' : 'zh'

  const html = readBodyHtml(internalId)
  if (html === null) {
    throw new TranslateError(
      'E_NO_BODY',
      `email_body.body_html/body_markdown for internal_id=${internalId} is empty or missing`
    )
  }

  const blocks = extractBlocks(html)
  if (blocks.length === 0) {
    // Empty/CJK-only/code-only body — write an empty cache row so we don't
    // re-trigger LLM on next open. Renderer treats empty segments as "nothing
    // to translate" CTA disabled. Guard 仍避免覆盖已有非空译文。
    const cacheKept = writeCacheGuarded(internalId, targetLang, [], '', 'on_demand')
    return {
      internalId,
      targetLang,
      segments: [],
      source: 'on_demand',
      model: '',
      fetchedAt: Date.now() / 1000,
      latencyMs: 0,
      failedBatches: 0,
      totalBatches: 0,
      ...(cacheKept ? { cacheKept: true } : {})
    }
  }

  const providerRegistryEnabled = isLlmProviderRegistryEnabled()
  // v1 keeps an explicitly configured translate-only gateway outside the registry. Its dedicated
  // base/key semantics take precedence even when the registry flag is on.
  const useProviderRegistry = providerRegistryEnabled && !hasExplicitTranslateProfile()
  const apiKey = (await getLlmTranslateApiKey()) ?? ''
  if (!useProviderRegistry && !apiKey) {
    throw new TranslateError(
      'E_NO_LLM_KEY',
      'LLM translate API key not configured — set it in Settings or LLM_TRANSLATE_API_KEY env'
    )
  }
  const baseUrl = getLlmTranslateBaseUrl()
  const model = getLlmTranslateModel()

  // Abort any prior in-flight translation for this internalId (rapid-click
  // guard / re-translate flow).
  abortInternalId(internalId)
  // Parent controller for THIS batch run; child controllers in runOneBatch
  // listen on its `abort` event.
  const parentAc = new AbortController()
  registerAbort(internalId, parentAc)

  const batches = buildBatches(blocks)
  const start = Date.now()
  logLine({
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
        ? runOneBatchWithProvider(batch, targetLang, model, internalId, parentAc)
        : runOneBatch(batch, targetLang, baseUrl, apiKey, model, internalId, parentAc)
    )

    // Stitch in batch order so segment order matches DOM order.
    const segments: TranslationSegment[] = []
    let failed = 0
    let modelReturned = model
    for (const oc of outcomes) {
      if (!oc.ok) failed++
      if (oc.modelReturned) modelReturned = oc.modelReturned
      for (const seg of oc.segments) segments.push(seg)
    }

    const latencyMs = Date.now() - start

    // Write cache even on partial failure — what we got is still useful, and
    // the renderer surfaces a partial-failure indicator via failedBatches.
    // Full failure with empty segments still writes when no richer cache exists
    // so a stuck upstream doesn't get hammered on every click.
    const cacheKept = writeCacheGuarded(
      internalId,
      targetLang,
      segments,
      modelReturned,
      'on_demand'
    )

    logLine({
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
      fetchedAt: Date.now() / 1000,
      latencyMs,
      failedBatches: failed,
      totalBatches: batches.length,
      ...(cacheKept ? { cacheKept: true } : {})
    }
  } finally {
    unregisterAbort(internalId, parentAc)
  }
}

// ============================================================================
// IPC registration
// ============================================================================

type TranslateEnvelope =
  | { ok: true; data: TranslateBatchResult }
  | { ok: false; code: string; message: string }

type GetCacheReply = TranslationCache | null

export function registerTranslateHandlers(): void {
  ipcMain.handle(
    'translate:batch',
    async (_evt, opts: TranslateBatchOpts): Promise<TranslateEnvelope> => {
      try {
        const data = await translateBatch(opts ?? { internalId: -1 })
        return { ok: true, data }
      } catch (err) {
        const code = err instanceof TranslateError ? err.code : 'E_UPSTREAM'
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code, message }
      }
    }
  )

  ipcMain.handle(
    'translation:get',
    async (_evt, internalId: number, targetLang?: TargetLang): Promise<GetCacheReply> => {
      if (!Number.isInteger(internalId) || internalId < 0) return null
      const lang: TargetLang = targetLang === 'en' ? 'en' : 'zh'
      try {
        return readCache(internalId, lang)
      } catch (err) {
        logLine({
          event: 'translation.get_failed',
          internalId,
          error: err instanceof Error ? err.message : String(err)
        })
        return null
      }
    }
  )

  ipcMain.handle(
    'translation:delete',
    async (_evt, internalId: number, targetLang?: TargetLang): Promise<boolean> => {
      if (!Number.isInteger(internalId) || internalId < 0) return false
      const lang: TargetLang = targetLang === 'en' ? 'en' : 'zh'
      try {
        return deleteCache(internalId, lang)
      } catch (err) {
        logLine({
          event: 'translation.delete_failed',
          internalId,
          error: err instanceof Error ? err.message : String(err)
        })
        return false
      }
    }
  )

  ipcMain.on('email:translateAbort', (_evt, internalId: number) => {
    if (Number.isInteger(internalId) && internalId >= 0) {
      abortInternalId(internalId)
    }
  })
}
