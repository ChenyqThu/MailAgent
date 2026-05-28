// Notion Agent chat backend.
//
// Shells out to `notion-agent chat --stream` (https://github.com/chenyqthu/
// notion-agent-cli, 0.1.9). The bound Custom Agent (Jarvis etc.) is read by
// the CLI from its own account file (~/.notionagents/notion_account.json,
// written once via `notion-agent init --agent-page-id`) — we do NOT pass an
// agent id per call. (An earlier build passed `--json --agent-page-id <id>`,
// but `--agent-page-id` is an `init` flag, not a `chat` flag; argparse
// rejected it with exit 2 on every call, so the backend never worked.)
//
// Streaming: `--stream` prints the assistant text delta-by-delta to stdout
// (CLI flushes each chunk), so we read child.stdout incrementally and yield
// one `chunk` event per delta — same UX as the custom-api backend. A
// StringDecoder bridges multi-byte UTF-8 sequences that straddle chunk
// boundaries (otherwise streamed CJK text corrupts). The prompt rides in on
// stdin rather than argv so a long email body can't blow ARG_MAX / need
// shell escaping.
//
// thread_id: `--stream` doesn't print structured fields (only `--json`
// does), but the CLI still persists thread state to
// ~/.notionagents/threads/<thread_id>.json. We snapshot that dir before the
// call and diff after to recover the freshly-written thread_id, then stash
// it in the assistant message's `metadata` so the next turn round-trips it
// via `--thread-id` (server-side continuity + token savings). Follow-up
// turns already know the thread_id, so they skip the probe.
//
// `notion-agent` exit codes map to E_* event codes so the renderer can
// branch on E_NOTION_AGENT_AUTH (token_v2 expired) vs E_NOTION_AGENT_NETWORK
// (Cloudflare blocked) vs the generic E_NOTION_AGENT_FAIL.

import { execa } from 'execa'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'node:string_decoder'

import { whichSync } from '../../bin_resolver'
import type { ChatBackend, ChatStreamEvent, ChatStreamRequest, EmailContext } from '../types'

const REQUEST_DEADLINE_MS = 90_000 // generous: Notion AI itself can be slow

/** Where the CLI persists per-thread state files (one `<thread_id>.json`
 *  per chat thread). Mirrors the CLI default account dir; we don't pass
 *  `--account`, so the default applies. */
const THREADS_DIR = join(homedir(), '.notionagents', 'threads')

let _binCache: string | null = null

/** Resolve the `notion-agent` binary once and cache.
 *  Search order:
 *    1. $NOTION_AGENT_BIN (full path; ops escape hatch)
 *    2. `which notion-agent` (PATH lookup; pipx default if user ran
 *       `pipx ensurepath`)
 *    3. ~/.local/bin/notion-agent (pipx install location without
 *       PATH integration) */
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

/** Snapshot the set of `<thread_id>.json` filenames before a first-turn
 *  call so we can diff afterwards. Missing dir → empty set (first chat
 *  ever, or a custom account dir we don't track). */
function snapshotThreadFiles(): Set<string> {
  try {
    return new Set(readdirSync(THREADS_DIR).filter((f) => f.endsWith('.json')))
  } catch {
    return new Set()
  }
}

/** After a first-turn call, find the thread state file the CLI just wrote
 *  (present in `after` but not `before`). When several appear (concurrent
 *  first-turn calls across sessions — rare), the most recently modified
 *  wins. Returns the bare thread_id (filename minus `.json`) or null when
 *  nothing new landed. */
function detectNewThreadId(before: Set<string>): string | null {
  let fresh: { name: string; mtime: number }[]
  try {
    fresh = readdirSync(THREADS_DIR)
      .filter((f) => f.endsWith('.json') && !before.has(f))
      .map((f) => {
        try {
          return { name: f, mtime: statSync(join(THREADS_DIR, f)).mtimeMs }
        } catch {
          return { name: f, mtime: 0 }
        }
      })
  } catch {
    return null
  }
  if (fresh.length === 0) return null
  fresh.sort((a, b) => b.mtime - a.mtime)
  return fresh[0].name.replace(/\.json$/, '')
}

function formatEmailContextHeader(ctx: EmailContext | null): string {
  if (!ctx) return ''
  // 邮件已全量从 SSoT 同步到 Notion, 所以首轮只递交 Notion 页 URL 作引用 ——
  // Notion Agent 能自己 loadPage 去索引正文/附件/线程并检索关联信息, 不必把
  // 元数据 + 正文塞进 prompt (省 token, 也让 agent 走它擅长的工作区检索路径).
  // notion-agent CLI 只收纯文本 prompt, 没有结构化 page-mention 协议, 所以用
  // 明文 URL —— 实测 agent 会自动对工作区内 URL 调 connections.notion.loadPage.
  if (ctx.notionPageId) {
    const pageNoDash = ctx.notionPageId.replace(/-/g, '')
    return [
      '[参考邮件] 我正在看下面这封邮件(已同步到 Notion)。回答前请读取该页面，',
      '获取它的主题 / 正文 / 附件 / 线程等完整内容，并据此检索关联信息：',
      `https://www.notion.so/${pageNoDash}`,
      '',
      ''
    ].join('\n')
  }
  // 兜底: 未同步到 Notion 的邮件(罕见) —— 给最小元数据(不含正文), 让 agent
  // 至少知道在问哪封.
  const lines: string[] = ['[参考邮件] 当前邮件未同步到 Notion, 仅提供元数据:']
  lines.push(`internal_id: ${ctx.internalId}`)
  if (ctx.subject) lines.push(`主题: ${ctx.subject}`)
  if (ctx.senderName || ctx.senderAddr) {
    const name = ctx.senderName ?? ''
    const addr = ctx.senderAddr ?? ''
    lines.push(`发件人: ${name}${name && addr ? ' ' : ''}${addr ? `<${addr}>` : ''}`.trim())
  }
  if (ctx.dateIso) lines.push(`日期: ${ctx.dateIso}`)
  lines.push('', '')
  return lines.join('\n')
}

/** Extract the user message + any prior thread_id to feed back to
 *  notion-agent. The CLI continues a thread via `--thread-id`, so once we
 *  have one (stashed in a prior assistant row's metadata) we keep using it. */
function extractTurn(req: ChatStreamRequest): {
  prompt: string
  threadId: string | null
} {
  // The user message we just inserted lives at the tail. Everything before
  // it is prior history (which notion-agent already knows server-side from
  // `--thread-id`). No user message → nothing to ask.
  const lastUser = [...req.history].reverse().find((m) => m.role === 'user')
  const prompt = lastUser?.content ?? ''

  // Find a thread_id from a prior assistant row's structured metadata. v1
  // rows wrote it as a `notion-agent:<id>` model prefix — read both.
  let threadId: string | null = null
  for (let i = req.history.length - 1; i >= 0; i--) {
    const m = req.history[i]
    if (m.role !== 'assistant') continue
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

  // First turn: prepend the email context so the agent sees the actual body,
  // not just the user's question. Follow-ups skip it — thread_id carries the
  // context forward server-side; re-sending eats tokens for no gain.
  const ctxHeader = threadId ? '' : formatEmailContextHeader(req.emailContext)
  const enrichedPrompt = ctxHeader.length > 0 ? `${ctxHeader}我的问题：\n${prompt}` : prompt

  const bin = resolveNotionAgentBin()
  const args = ['chat', '--stream']
  if (threadId) args.push('--thread-id', threadId)
  if (req.model) args.push('--model', req.model)
  // prompt rides in on stdin (no positional arg) — keeps a long email body
  // out of argv (ARG_MAX) and sidesteps shell-escaping entirely.

  // First turn only: snapshot threads dir so we can recover the new
  // thread_id afterwards. Follow-ups already know it (passed via --thread-id).
  const before = threadId ? null : snapshotThreadFiles()

  const toolArgs = { threadId, model: req.model }
  yield {
    type: 'tool_call',
    name: 'notion-agent chat',
    args: toolArgs,
    status: 'running'
  }

  const startTime = Date.now()
  const decoder = new StringDecoder('utf8')
  let accumulated = ''
  try {
    const child = execa(bin, args, {
      input: enrichedPrompt,
      // execa@9 renamed `signal` → `cancelSignal`; using the old name throws
      // synchronously ("signal option has been renamed").
      cancelSignal: req.signal,
      timeout: REQUEST_DEADLINE_MS,
      reject: false,
      // stdout unbuffered → we read it as a stream for real-time deltas;
      // stderr buffered → classifyExit reads the whole thing at the end.
      buffer: { stdout: false, stderr: true }
    })

    if (child.stdout) {
      for await (const chunk of child.stdout) {
        if (req.signal.aborted) break
        // chunk is a Buffer; StringDecoder holds back any trailing partial
        // multi-byte sequence until the next chunk completes it.
        const delta = decoder.write(chunk as Buffer)
        if (delta.length > 0) {
          accumulated += delta
          yield { type: 'chunk', delta }
        }
      }
      const tail = decoder.end()
      if (tail.length > 0 && !req.signal.aborted) {
        accumulated += tail
        yield { type: 'chunk', delta: tail }
      }
    }

    const result = await child
    const { stderr, exitCode, timedOut } = result
    // execa@9 surfaces signal termination as `isCanceled`; older builds used
    // `killed`. Accept both so the type-check stays happy across the lockfile.
    const killed =
      (result as unknown as { killed?: boolean; isCanceled?: boolean }).killed === true ||
      (result as unknown as { killed?: boolean; isCanceled?: boolean }).isCanceled === true

    if (req.signal.aborted) return

    if (timedOut) {
      yield {
        type: 'tool_call',
        name: 'notion-agent chat',
        args: toolArgs,
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
      // notion-agent occasionally prints the token_v2 cookie into stderr on
      // auth failures. Classify on the main side, then return a fixed safe
      // message so the cookie bytes never cross the IPC boundary into the
      // renderer. Full stderr stays in the `pnpm dev` console for triage.
      const stderrText = typeof stderr === 'string' ? stderr : ''
      const code = classifyExit(exitCode, stderrText)
      const safeMessage = safeErrorMessage(code, exitCode)
      yield {
        type: 'tool_call',
        name: 'notion-agent chat',
        args: toolArgs,
        status: 'error',
        durationMs: Date.now() - startTime,
        detail: safeMessage
      }
      yield { type: 'error', code, message: safeMessage }
      return
    }

    // exit 0 — finalize. Trim trailing newline(s): `--stream` ends with a
    // bare `print()` line terminator after the deltas.
    const text = accumulated.replace(/\n+$/, '')
    const newThreadId = threadId ?? detectNewThreadId(before ?? new Set())
    const metadata: Record<string, unknown> | null = newThreadId ? { thread_id: newThreadId } : null
    const modelSeen = req.model ?? null

    yield {
      type: 'tool_call',
      name: 'notion-agent chat',
      args: toolArgs,
      status: 'ok',
      durationMs: Date.now() - startTime,
      detail: newThreadId ? `thread=${newThreadId.slice(0, 8)}` : undefined
    }
    // `--stream` doesn't emit token counts; surface zeros so the cost
    // accounting layer has a uniform shape. metadata carries the thread_id.
    yield {
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
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
      args: toolArgs,
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

/** Map a classified error code to a renderer-safe message. The raw stderr
 *  stays in the main-process log; the renderer only sees the generic
 *  phrasing so a token_v2 cookie that printed to stderr never crosses the
 *  IPC boundary. */
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
  safeErrorMessage,
  detectNewThreadId,
  snapshotThreadFiles
}
