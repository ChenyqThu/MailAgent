// Sprint 3 §2.2 — email translation IPC handler.
//
// REVIEW-LOG C-04 hard rule: the LLM API key MUST NOT cross into the
// renderer bundle. This file runs in the main process, reads the key from
// `llm_settings.getLlmApiKey()` (keychain or env-var), and `fetch()`s the
// Anthropic-compatible Messages endpoint directly. Renderer only sees the
// translated text via the IPC reply.
//
// Cancellation: each in-flight request registers its AbortController in
// `_inflight` keyed by internal_id. A second translate for the same id
// auto-aborts the previous (rapid-click guard), and the renderer can fire
// `email:translateAbort` to drop a stale request when the user switches
// emails (handoff §2.2 explicit AbortController contract).
//
// We deliberately read the body via `getDb()` rather than the full
// `email:body` IPC because:
//   (a) it stays main-process-internal (no IPC round-trip),
//   (b) we want the markdown form specifically (Anthropic prefers prose,
//       not HTML, and markdown round-trips list/code/emphasis cleanly).

import { ipcMain } from 'electron'

import { getDb } from '../db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from '../llm_settings'

export type TargetLang = 'zh' | 'en'

export interface TranslateOpts {
  internalId: number
  targetLang?: TargetLang
}

export interface TranslateResult {
  internalId: number
  targetLang: TargetLang
  translated: string
  model: string
  latencyMs: number
}

export class TranslateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'TranslateError'
  }
}

const _inflight = new Map<number, AbortController>()

// Reasonable upper bound on the input we hand the model. Mirrors
// `LLM_BODY_MAX_CHARS` default in backend `src/llm_agent/processor.py`;
// keeping the two limits aligned means a body that the LLM agent already
// processed will fit here too.
const MAX_BODY_CHARS = 12_000

// Cap on the request body the model returns. 4k tokens ≈ ~12k chars in
// Chinese — comfortably more than the input we hand in, so a verbose
// translation (Chinese tends to be denser than English by token count
// but longer by character count) doesn't truncate.
const MAX_OUTPUT_TOKENS = 4096

// Hard request deadline so a hanging upstream can't keep a slot wedged
// indefinitely. Sprint 3 review (opus H-2): when the user neither
// switches emails nor quits, a stuck CRS slot stays occupied; this
// timer fires the AbortController to cut it loose.
const FETCH_TIMEOUT_MS = 60_000

function readBodyMarkdown(internalId: number): string | null {
  const db = getDb()
  const row = db
    .prepare('SELECT body_markdown FROM email_body WHERE internal_id = ?')
    .get(internalId) as { body_markdown: string | null } | undefined
  if (!row) return null
  const body = row.body_markdown
  if (typeof body !== 'string' || body.trim().length === 0) return null
  return body
}

function systemPromptFor(target: TargetLang): string {
  if (target === 'zh') {
    return [
      'You translate an email into fluent natural Chinese (Simplified, mainland usage).',
      'Rules:',
      '- Preserve markdown formatting (links, lists, code blocks, emphasis).',
      '- Keep URLs, email addresses, code identifiers, and product names verbatim.',
      '- Keep proper nouns in their original form unless a well-established Chinese rendering exists.',
      '- Return ONLY the translated text. No preamble, no commentary, no markdown wrapper like ```.',
      '- If the source is already Chinese, return it unchanged.'
    ].join('\n')
  }
  return [
    'You translate an email into fluent natural English.',
    'Rules:',
    '- Preserve markdown formatting (links, lists, code blocks, emphasis).',
    '- Keep URLs, email addresses, code identifiers, and product names verbatim.',
    '- Return ONLY the translated text. No preamble, no commentary, no markdown wrapper.',
    '- If the source is already English, return it unchanged.'
  ].join('\n')
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>
  model?: string
}

export async function translateEmail(opts: TranslateOpts): Promise<TranslateResult> {
  const internalId = opts.internalId
  if (!Number.isInteger(internalId) || internalId < 0) {
    throw new TranslateError(
      'E_INVALID_ARG',
      `internalId must be a non-negative integer, got ${String(internalId)}`
    )
  }
  const targetLang: TargetLang = opts.targetLang === 'en' ? 'en' : 'zh'

  const body = readBodyMarkdown(internalId)
  if (body === null) {
    throw new TranslateError(
      'E_NO_BODY',
      `email_body for internal_id=${internalId} is empty or missing`
    )
  }

  const apiKey = await getLlmApiKey()
  if (!apiKey) {
    throw new TranslateError(
      'E_NO_LLM_KEY',
      'LLM API key not configured — set it in Settings or LLM_API_KEY env'
    )
  }

  // Abort any previous in-flight translation for the same email (rapid
  // re-click guard). The aborted request rejects with E_ABORTED and the
  // renderer query gets gc'd by TanStack Query.
  _inflight.get(internalId)?.abort()
  const ac = new AbortController()
  _inflight.set(internalId, ac)

  const baseUrl = getLlmBaseUrl()
  const model = getLlmModel()
  const start = Date.now()

  // Wrap the request in a hard timeout. clearTimeout fires whether the
  // request resolves, rejects, or is aborted by user action.
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPromptFor(targetLang),
        messages: [{ role: 'user', content: body.slice(0, MAX_BODY_CHARS) }]
      }),
      signal: ac.signal
    })
  } catch (err) {
    clearTimeout(timer)
    if (_inflight.get(internalId) === ac) _inflight.delete(internalId)
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      throw new TranslateError('E_ABORTED', 'Translation aborted')
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new TranslateError('E_UPSTREAM', `LLM fetch failed: ${msg}`)
  }
  clearTimeout(timer)
  if (_inflight.get(internalId) === ac) _inflight.delete(internalId)

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      /* body may already be consumed; ignore */
    }
    throw new TranslateError('E_UPSTREAM', `LLM API ${response.status}: ${detail}`)
  }

  let payload: MessagesResponse
  try {
    payload = (await response.json()) as MessagesResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new TranslateError('E_UPSTREAM', `LLM response not valid JSON: ${msg}`)
  }

  const text = payload.content?.find((b) => b.type === 'text')?.text ?? payload.content?.[0]?.text
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) {
    throw new TranslateError('E_EMPTY_RESPONSE', 'LLM returned no text content')
  }

  return {
    internalId,
    targetLang,
    translated: trimmed,
    model: payload.model ?? model,
    latencyMs: Date.now() - start
  }
}

export function abortTranslation(internalId: number): void {
  const ac = _inflight.get(internalId)
  if (!ac) return
  ac.abort()
  // Only drop the entry if we still own it. A racing `translateEmail()`
  // that replaced the controller before this caller observed it must
  // keep its slot.
  if (_inflight.get(internalId) === ac) _inflight.delete(internalId)
}

export function abortAllTranslations(): void {
  for (const ac of _inflight.values()) ac.abort()
  _inflight.clear()
}

/**
 * Renderer-facing IPC payload. Always resolves (codex review M-3):
 * Electron does not reliably preserve custom Error properties across the
 * `ipcRenderer.invoke` boundary, so a thrown `e.code = 'E_NO_LLM_KEY'`
 * may arrive as a bare `Error("…")` on the other side, collapsing the
 * UI fallback branches. Returning an envelope sidesteps the issue
 * entirely.
 */
export type TranslateEnvelope =
  | { ok: true; data: TranslateResult }
  | { ok: false; code: string; message: string }

export function registerTranslateHandlers(): void {
  ipcMain.handle(
    'email:translate',
    async (_evt, opts: TranslateOpts): Promise<TranslateEnvelope> => {
      try {
        const data = await translateEmail(opts ?? { internalId: -1 })
        return { ok: true, data }
      } catch (err) {
        const code = err instanceof TranslateError ? err.code : 'E_UPSTREAM'
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code, message }
      }
    }
  )
  ipcMain.on('email:translateAbort', (_evt, internalId: number) => {
    if (Number.isInteger(internalId) && internalId >= 0) {
      abortTranslation(internalId)
    }
  })
}
