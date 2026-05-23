// Sprint 4 Task #11 — Custom API chat backend.
//
// Talks to the Anthropic Messages streaming endpoint (CRS, native
// Anthropic, or any compatible /v1/messages-shape gateway). REVIEW-LOG
// C-04 hard rule: API key reads happen here in the main process; the
// renderer never sees the key bytes.
//
// Why Anthropic-only for Sprint 4:
//   - The default model alias `claude-sonnet-4-6` matches the Sprint 3
//     translate path, so existing CRS users get chat for free.
//   - The OpenAI / Gemini code path lives behind the same `getLlmModel()`
//     env override but uses a different stream parser; we ship Anthropic
//     first so the headline AI panel works, and the BackendSelector's
//     gpt-5.4 / gemini chips degrade to an error-event toast (renderer
//     stays robust) until the OpenAI parser lands as a follow-up.
//
// Stream protocol:
//   POST /v1/messages with `stream: true` returns text/event-stream.
//   Each event is `data: <json>\n\n` with the JSON shape documented at
//   https://docs.anthropic.com/en/api/messages-streaming. We care about
//   `message_start`, `content_block_delta` (text_delta), `message_delta`
//   (usage), and `message_stop`. Anything else passes through silently.

import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from '../../llm_settings'
import type { ChatBackend, ChatStreamEvent, ChatStreamRequest, EmailContext } from '../types'

// Anthropic `max_tokens` caps the model's RESPONSE length (not input).
// Same 4096 ceiling Sprint 3 translate.ts used; ~12k Chinese chars at
// typical token density.
const MAX_OUTPUT_TOKENS = 4096
const REQUEST_DEADLINE_MS = 60_000

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

// Translate ChatMessage[] history into the Anthropic conversation form.
// `tool` rows are folded into the assistant content as `[tool: name]`
// breadcrumbs so the model has context for a follow-up turn without us
// having to teach Anthropic about MailAgent's tool transcript format.
function buildAnthropicMessages(req: ChatStreamRequest): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  let pendingAssistant: string[] = []
  function flushAssistant(): void {
    if (pendingAssistant.length === 0) return
    out.push({ role: 'assistant', content: pendingAssistant.join('\n').trim() })
    pendingAssistant = []
  }
  for (const m of req.history) {
    if (m.role === 'user') {
      flushAssistant()
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.status === 'aborted' || m.status === 'error') continue
      if (m.content.length > 0) pendingAssistant.push(m.content)
    } else if (m.role === 'tool') {
      // tool_call rows: keep a minimal breadcrumb so context survives.
      try {
        const data = JSON.parse(m.content) as { name?: string; detail?: string }
        pendingAssistant.push(
          `[tool: ${data.name ?? 'unknown'}${data.detail ? ' — ' + data.detail : ''}]`
        )
      } catch {
        // malformed tool row — skip
      }
    }
    // system messages currently aren't surfaced by the panel; ignore.
  }
  flushAssistant()
  // Anthropic rejects an empty messages array. If history was somehow
  // empty (shouldn't happen — dispatcher always inserts the user
  // message first), insert a placeholder so the API returns a sensible
  // error rather than a 400.
  if (out.length === 0) out.push({ role: 'user', content: '(empty)' })
  return out
}

function buildSystemPrompt(ctx: EmailContext | null): string {
  const lines = [
    'You are the AI assistant inside MailAgent, a macOS email client.',
    'The user is asking about the email currently open in the inbox panel.',
    'Be terse, concrete, and cite specific sentences from the email when relevant.',
    'Respond in the same language as the user message unless the user asks for translation.',
    'Use markdown when it improves readability (lists, code blocks, links). Keep prose tight.'
  ]
  // Sprint 4 review (Opus H-1): inline the email content into the system
  // prompt so the model actually sees the email the user is asking about.
  // Without this block, queries like "summarize this email" arrive at
  // the upstream with zero email content and the system prompt's "the
  // email currently open" claim becomes a lie.
  if (ctx) {
    lines.push('', '--- Email currently open ---')
    lines.push(`internal_id: ${ctx.internalId}`)
    if (ctx.subject) lines.push(`Subject: ${ctx.subject}`)
    if (ctx.senderName || ctx.senderAddr) {
      const name = ctx.senderName ?? ''
      const addr = ctx.senderAddr ?? ''
      lines.push(`From: ${name}${name && addr ? ' ' : ''}${addr ? `<${addr}>` : ''}`.trim())
    }
    if (ctx.dateIso) lines.push(`Date: ${ctx.dateIso}`)
    // Notion 镜像 URL — Custom AI 不能直接 mutate Notion, 但可以引用链接给用户.
    if (ctx.notionPageId) {
      const pageNoDash = ctx.notionPageId.replace(/-/g, '')
      lines.push(`Notion URL: https://www.notion.so/${pageNoDash}`)
    }
    lines.push('')
    if (ctx.bodyMarkdown && ctx.bodyMarkdown.length > 0) {
      lines.push('Body (markdown):')
      lines.push(ctx.bodyMarkdown)
    } else {
      lines.push('Body: (not available)')
    }
    lines.push('--- End email ---')
  }
  return lines.join('\n')
}

interface SseParseState {
  buffer: string
}

/** Parse a single chunk of text into zero or more `data: {...}` objects.
 *  Updates `state.buffer` with the unterminated remainder. */
function parseSseChunk(state: SseParseState, chunk: string): unknown[] {
  state.buffer += chunk
  const out: unknown[] = []
  let idx
  while ((idx = state.buffer.indexOf('\n\n')) !== -1) {
    const block = state.buffer.slice(0, idx)
    state.buffer = state.buffer.slice(idx + 2)
    // A block can hold multiple `data:` lines; concatenate.
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) data += line.slice(6)
      else if (line.startsWith('data:')) data += line.slice(5)
    }
    if (data.length === 0) continue
    if (data.trim() === '[DONE]') {
      out.push({ __done: true })
      continue
    }
    try {
      out.push(JSON.parse(data))
    } catch {
      // malformed — skip; the next event will resync.
    }
  }
  return out
}

async function* anthropicStream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
  const apiKey = await getLlmApiKey()
  if (!apiKey) {
    yield {
      type: 'error',
      code: 'E_NO_LLM_KEY',
      message: 'LLM API key not configured — set it in Settings or LLM_API_KEY env'
    }
    return
  }
  const baseUrl = getLlmBaseUrl()
  const model = req.model ?? getLlmModel()
  const messages = buildAnthropicMessages(req)
  const systemPrompt = buildSystemPrompt(req.emailContext)

  const timeoutAc = new AbortController()
  const timer = setTimeout(() => timeoutAc.abort(), REQUEST_DEADLINE_MS)
  // Compose the parent signal (orchestrator-owned, fires on user cancel /
  // email switch) with the deadline signal so either can cut the request.
  const onParentAbort = (): void => timeoutAc.abort()
  if (req.signal.aborted) {
    clearTimeout(timer)
    yield { type: 'error', code: 'E_ABORTED', message: 'request aborted before send' }
    return
  }
  req.signal.addEventListener('abort', onParentAbort, { once: true })

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
        system: systemPrompt,
        messages,
        stream: true
      }),
      signal: timeoutAc.signal
    })
  } catch (err) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    if (req.signal.aborted) return
    yield {
      type: 'error',
      code: 'E_UPSTREAM',
      message: `LLM fetch failed: ${err instanceof Error ? err.message : String(err)}`
    }
    return
  }

  if (!response.ok) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    // Sprint 4 review (codex high): upstream gateways occasionally echo
    // request headers (including an `Authorization: Bearer …`) into 4xx
    // / 5xx HTML error pages. Forwarding the raw body to the renderer
    // would leak those bytes into the IPC envelope. Stick to status
    // codes; the main-process log still has the body for triage.
    yield {
      type: 'error',
      code: response.status === 429 ? 'E_QUOTA' : 'E_UPSTREAM',
      message: `LLM API ${response.status}`
    }
    return
  }

  if (!response.body) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    yield { type: 'error', code: 'E_UPSTREAM', message: 'LLM response had no body' }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const state: SseParseState = { buffer: '' }
  let inputTokens = 0
  let outputTokens = 0
  let modelSeen: string | null = model
  let accumulated = ''
  // Sprint 4 review (codex M-2): once the upstream emits an Anthropic
  // `error` event, the model has stopped producing usable output —
  // suppress the trailing `usage`/`done` so the assistant row doesn't
  // flip back to `complete` over the error.
  let sawError = false

  try {
    while (true) {
      if (req.signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      const events = parseSseChunk(state, text)
      for (const ev of events) {
        const e = ev as Record<string, unknown> & { type?: string; __done?: boolean }
        if (e.__done === true) {
          // Anthropic itself uses message_stop rather than [DONE]; tolerate.
          continue
        }
        switch (e.type) {
          case 'message_start': {
            const msg = (e as { message?: { usage?: { input_tokens?: number }; model?: string } })
              .message
            if (msg) {
              if (typeof msg.usage?.input_tokens === 'number') inputTokens = msg.usage.input_tokens
              if (typeof msg.model === 'string') modelSeen = msg.model
            }
            break
          }
          case 'content_block_delta': {
            const delta = (e as { delta?: { type?: string; text?: string } }).delta
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              accumulated += delta.text
              yield { type: 'chunk', delta: delta.text }
            }
            break
          }
          case 'message_delta': {
            const usage = (e as { usage?: { output_tokens?: number } }).usage
            if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens
            break
          }
          case 'message_stop':
            // The done event is emitted once at the end (see below) so
            // we have a single consumer-facing hand-off point regardless
            // of whether the upstream uses [DONE] or message_stop.
            break
          case 'error': {
            const errObj = (e as { error?: { type?: string; message?: string } }).error
            sawError = true
            yield {
              type: 'error',
              code: errObj?.type ?? 'E_UPSTREAM',
              message: errObj?.message ?? 'LLM error'
            }
            break
          }
        }
      }
    }
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }

  if (req.signal.aborted) return
  // Sprint 4 review (codex M-2): once an Anthropic `error` event landed
  // mid-stream, don't paper over it with a trailing usage/done — the
  // assistant row would flip back to `complete` and lose the error.
  if (sawError) return

  yield {
    type: 'usage',
    inputTokens,
    outputTokens,
    costUsd: null,
    model: modelSeen
  }
  yield {
    type: 'done',
    finalContent: accumulated,
    model: modelSeen
  }
}

export class CustomApiBackend implements ChatBackend {
  readonly kind = 'custom-api' as const

  async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
    // Sprint 4 ships Anthropic-only. The hook routes by alias (the
    // `claude-*` family covers the default plus the explicit alternates
    // in the BackendSelector). Anything else returns a clear error
    // event so the UI can show "model not supported in this build".
    const model = req.model ?? getLlmModel()
    if (!isAnthropicModel(model)) {
      yield {
        type: 'error',
        code: 'E_MODEL_UNSUPPORTED',
        message: `Model "${model}" not supported by Sprint 4 Custom API backend (Anthropic only).`
      }
      return
    }
    yield* anthropicStream(req)
  }
}

function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude-') || model.startsWith('claude:')
}

// Test-only — exposed so unit tests can exercise the SSE parser without
// reaching for a private symbol.
export const __testing = {
  parseSseChunk,
  buildAnthropicMessages,
  isAnthropicModel
}
