// Sprint 4 Task #12 — Notion Agent chat backend.
//
// Shells out to `notion-agent chat <prompt> --json --agent-page-id <id>`
// (https://github.com/chenyqthu/notion-agent-cli). Token-by-token streaming
// would use `--ndjson` instead, but the ndjson event schema isn't yet
// frozen by the CLI — Sprint 4 ships the synchronous JSON form (one full
// reply at end) and surfaces it as a single chunk event so the UI still
// gets to render the panel + DraftPreviewCard. Sprint 5 polish will
// switch to `--ndjson` once the CLI lands its 0.2 release.
//
// Subprocess plumbing follows the same pattern as Sprint 3's
// cli_runner.ts: resolve the binary once (avoiding `which` on every
// call), wire the orchestrator's AbortSignal into execa so user-cancel
// kills the child, time-bound the whole call so a wedged Notion API
// doesn't hold the slot forever.
//
// `notion-agent` exit codes are mapped to E_* event codes so the
// renderer can branch on `E_NOTION_AGENT_AUTH` (token_v2 expired) vs
// `E_NOTION_AGENT_NETWORK` (Cloudflare blocked the call) vs the generic
// `E_NOTION_AGENT_FAIL`.

import { execa } from 'execa'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { whichSync } from '../../bin_resolver'
import type { ChatBackend, ChatStreamEvent, ChatStreamRequest, EmailContext } from '../types'

const REQUEST_DEADLINE_MS = 90_000 // generous: Notion AI itself can be slow

let _binCache: string | null = null

/** Resolve the `notion-agent` binary once and cache.
 *  Search order:
 *    1. $NOTION_AGENT_BIN (full path; ops escape hatch)
 *    2. `which notion-agent` (PATH lookup; pipx default if user ran
 *       `pipx ensurepath`)
 *    3. ~/.local/bin/notion-agent (pipx install location without
 *       PATH integration — verified in Sprint 4 Task #2 pre-flight) */
export function resolveNotionAgentBin(): string {
  if (_binCache) return _binCache
  const fromEnv = process.env['NOTION_AGENT_BIN']
  if (fromEnv && existsSync(fromEnv)) {
    _binCache = fromEnv
    return fromEnv
  }
  try {
    const resolved = whichSync('notion-agent')
    if (resolved) {
      _binCache = resolved
      return resolved
    }
  } catch {
    /* fall through to pipx default */
  }
  const fallback = join(homedir(), '.local', 'bin', 'notion-agent')
  _binCache = fallback
  return fallback
}

/** Test-only — reset the binary path cache so tests can swap env vars. */
export function __resetNotionAgentBinCache(): void {
  _binCache = null
}

interface NotionAgentResponse {
  text?: string
  thread_id?: string
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

function formatEmailContextHeader(ctx: EmailContext | null): string {
  if (!ctx) return ''
  const lines: string[] = ['[Email currently open]']
  lines.push(`internal_id: ${ctx.internalId}`)
  if (ctx.subject) lines.push(`Subject: ${ctx.subject}`)
  if (ctx.senderName || ctx.senderAddr) {
    const name = ctx.senderName ?? ''
    const addr = ctx.senderAddr ?? ''
    lines.push(`From: ${name}${name && addr ? ' ' : ''}${addr ? `<${addr}>` : ''}`.trim())
  }
  if (ctx.dateIso) lines.push(`Date: ${ctx.dateIso}`)
  // Notion 镜像页 ID / URL: 让 Notion Agent 直接定位本邮件页, 方便更新内容
  // 或 create relation 挂别的文档. 没同步过 Notion 时无该字段, 跳过.
  if (ctx.notionPageId) {
    const pageNoDash = ctx.notionPageId.replace(/-/g, '')
    lines.push(`Notion page_id: ${ctx.notionPageId}`)
    lines.push(`Notion URL: https://www.notion.so/${pageNoDash}`)
  }
  lines.push('')
  if (ctx.bodyMarkdown && ctx.bodyMarkdown.length > 0) {
    lines.push('Body:')
    lines.push(ctx.bodyMarkdown)
  } else {
    lines.push('Body: (not available)')
  }
  lines.push('')
  return lines.join('\n')
}

/** Extract the user message + any prior assistant turns to feed back to
 *  notion-agent. The CLI supports `--thread-id` for multi-turn follow-up,
 *  so once we have one we keep using it. */
function extractTurn(req: ChatStreamRequest): {
  prompt: string
  threadId: string | null
} {
  // The user message we just inserted lives at the tail. Everything
  // before it is prior history (which notion-agent already knows from
  // `--thread-id`). If there's no user message, we have nothing to
  // ask — return empty so the caller surfaces an error.
  const lastUser = [...req.history].reverse().find((m) => m.role === 'user')
  const prompt = lastUser?.content ?? ''

  // Find a thread_id from a prior assistant row. Sprint 4 review (opus L)
  // moved thread_id out of the `model` column hack into the structured
  // `metadata` JSON column (ai_chat.db schema v2). For backward read of
  // v1-written rows, fall back to the `notion-agent:<id>` model prefix.
  let threadId: string | null = null
  for (let i = req.history.length - 1; i >= 0; i--) {
    const m = req.history[i]
    if (m.role !== 'assistant') continue
    // v2+: parsed metadata JSON.
    if (m.metadata) {
      try {
        const meta = JSON.parse(m.metadata) as Record<string, unknown>
        const v = meta['thread_id']
        if (typeof v === 'string' && v.length > 0) {
          threadId = v
          break
        }
      } catch {
        // malformed metadata — ignore and try older formats below.
      }
    }
    // v1 backcompat: `model = 'notion-agent:<thread_id>'`.
    if (m.model && m.model.startsWith('notion-agent:')) {
      threadId = m.model.slice('notion-agent:'.length)
      break
    }
  }
  return { prompt, threadId }
}

async function* runNotionAgent(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
  const { prompt, threadId } = extractTurn(req)
  if (prompt.length === 0) {
    yield {
      type: 'error',
      code: 'E_INVALID_ARG',
      message: 'notion-agent backend: history has no user message to answer'
    }
    return
  }
  if (req.agentPageId === null) {
    yield {
      type: 'error',
      code: 'E_INVALID_ARG',
      message: 'notion-agent backend requires backendAgentPageId — bind a Custom Agent in Settings'
    }
    return
  }

  // Sprint 4 review (Opus H-1): prepend the email context so notion-agent's
  // upstream chat sees the actual email body, not just the user's question.
  // Multi-turn follow-ups skip the header (thread_id carries it forward
  // server-side; redundant inclusion eats tokens for no gain).
  const ctxHeader = threadId ? '' : formatEmailContextHeader(req.emailContext)
  const enrichedPrompt = ctxHeader.length > 0 ? `${ctxHeader}[User question]\n${prompt}` : prompt

  const bin = resolveNotionAgentBin()
  const args = ['chat', enrichedPrompt, '--json', '--agent-page-id', req.agentPageId]
  if (threadId) args.push('--thread-id', threadId)
  if (req.model) args.push('--model', req.model)

  // Surface a tool_call breadcrumb so the panel can render the
  // "calling notion-agent" log line while the subprocess runs. The
  // event status flips to 'ok' or 'error' below.
  const toolEvent = {
    type: 'tool_call' as const,
    name: 'notion-agent chat',
    args: { agentPageId: req.agentPageId, threadId, model: req.model },
    status: 'running' as const
  }
  yield toolEvent

  const startTime = Date.now()
  try {
    const child = execa(bin, args, {
      signal: req.signal,
      timeout: REQUEST_DEADLINE_MS,
      buffer: true,
      reject: false
    })
    const result = await child
    const { stdout, stderr, exitCode, timedOut } = result
    // execa@9 surfaces signal-based termination as `isCanceled`; older
    // builds used `killed`. Accept both shapes so the type-check stays
    // happy across the lockfile range.
    const killed =
      (result as unknown as { killed?: boolean; isCanceled?: boolean }).killed === true ||
      (result as unknown as { killed?: boolean; isCanceled?: boolean }).isCanceled === true

    if (req.signal.aborted) return

    if (timedOut) {
      yield {
        type: 'tool_call',
        name: 'notion-agent chat',
        args: toolEvent.args,
        status: 'error',
        durationMs: Date.now() - startTime,
        detail: 'subprocess exceeded 90s'
      }
      yield { type: 'error', code: 'E_NOTION_AGENT_TIMEOUT', message: 'notion-agent timed out' }
      return
    }
    if (killed) {
      // killed by AbortSignal — orchestrator handles the 'aborted' DB flip.
      return
    }
    if (exitCode !== 0) {
      // Sprint 4 review (codex Critical): notion-agent occasionally prints
      // the token_v2 cookie value into stderr on auth failures
      // (`token_v2=v03%3A...` shows up in pipx-installed builds with verbose
      // logging). Classifying the exit on the main side first, then
      // returning a fixed safe message, prevents the cookie bytes from
      // crossing the IPC boundary into the renderer envelope. The full
      // stderr is still available via `pnpm dev` console for triage.
      const code = classifyExit(exitCode, stderr)
      const safeMessage = safeErrorMessage(code, exitCode)
      yield {
        type: 'tool_call',
        name: 'notion-agent chat',
        args: toolEvent.args,
        status: 'error',
        durationMs: Date.now() - startTime,
        detail: safeMessage
      }
      yield {
        type: 'error',
        code,
        message: safeMessage
      }
      return
    }

    let parsed: NotionAgentResponse
    try {
      parsed = JSON.parse(stdout) as NotionAgentResponse
    } catch (err) {
      yield {
        type: 'tool_call',
        name: 'notion-agent chat',
        args: toolEvent.args,
        status: 'error',
        durationMs: Date.now() - startTime,
        detail: 'stdout not valid JSON'
      }
      yield {
        type: 'error',
        code: 'E_NOTION_AGENT_PARSE',
        message: `notion-agent stdout not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      }
      return
    }

    const text = parsed.text ?? ''
    // Sprint 4 review (opus L carry-forward): emit the upstream model
    // verbatim and put the thread_id in `metadata` (orchestrator persists
    // it into ai_chat_messages.metadata for the next turn's
    // `--thread-id`). v1-written rows that still carry
    // `model = 'notion-agent:<id>'` keep working via the backcompat read
    // in extractTurn().
    const modelSeen = parsed.model ?? null
    const metadata: Record<string, unknown> | null = parsed.thread_id
      ? { thread_id: parsed.thread_id }
      : null

    yield {
      type: 'tool_call',
      name: 'notion-agent chat',
      args: toolEvent.args,
      status: 'ok',
      durationMs: Date.now() - startTime,
      detail: parsed.thread_id ? `thread=${parsed.thread_id.slice(0, 8)}` : undefined
    }
    if (text.length > 0) {
      yield { type: 'chunk', delta: text }
    }
    yield {
      type: 'usage',
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      costUsd: null,
      model: modelSeen,
      metadata
    }
    yield {
      type: 'done',
      finalContent: text,
      model: modelSeen,
      metadata
    }
  } catch (err) {
    if (req.signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    yield {
      type: 'tool_call',
      name: 'notion-agent chat',
      args: toolEvent.args,
      status: 'error',
      durationMs: Date.now() - startTime,
      detail: message
    }
    yield { type: 'error', code: 'E_NOTION_AGENT_FAIL', message }
  }
}

function classifyExit(exitCode: number | null | undefined, stderr: string): string {
  const haystack = stderr.toLowerCase()
  if (haystack.includes('token_v2') || haystack.includes('unauthorized')) {
    return 'E_NOTION_AGENT_AUTH'
  }
  if (haystack.includes('cloudflare') || haystack.includes('network')) {
    return 'E_NOTION_AGENT_NETWORK'
  }
  if (exitCode === 127) return 'E_NOTION_AGENT_NOT_INSTALLED'
  return 'E_NOTION_AGENT_FAIL'
}

/** Map a classified error code to a renderer-safe message. The raw
 *  stderr stays in the main-process log; the renderer only sees the
 *  generic phrasing so a token_v2 cookie that printed to stderr never
 *  crosses the IPC boundary. */
function safeErrorMessage(code: string, exitCode: number | null | undefined): string {
  switch (code) {
    case 'E_NOTION_AGENT_AUTH':
      return 'notion-agent authentication failed — re-run `notion-agent init`'
    case 'E_NOTION_AGENT_NETWORK':
      return 'notion-agent network error — check connection / Cloudflare'
    case 'E_NOTION_AGENT_NOT_INSTALLED':
      return 'notion-agent CLI not found on PATH'
    default:
      return `notion-agent exited with code ${exitCode ?? '?'}`
  }
}

export class NotionAgentBackend implements ChatBackend {
  readonly kind = 'notion-agent' as const

  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
    return runNotionAgent(req)
  }
}

export const __testing = {
  classifyExit,
  extractTurn,
  formatEmailContextHeader,
  safeErrorMessage
}
