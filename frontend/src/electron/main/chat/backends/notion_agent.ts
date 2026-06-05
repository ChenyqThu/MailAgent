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
// (Cloudflare blocked) vs E_NOTION_AGENT_RATE_LIMIT (Notion's anti-automation
// "trust-rule" guard tripped) vs the generic E_NOTION_AGENT_FAIL.
//
// trust-rule (CLI ≥0.1.11 exit 75): Notion has no public ✦ AI API; the CLI
// drives the internal `runInferenceTranscript` endpoint, which a server-side
// trust rule protects. A burst of automated calls pushes the session into
// strict mode and subsequent calls are denied (HTTP 200 with an embedded
// `{"subType":"trust-rule-denied","isRetryable":false}`). The CLI surfaces
// this as exit 75. It is NOT auth/network — an immediate retry only deepens
// the ban; the renderer treats E_NOTION_AGENT_RATE_LIMIT like E_QUOTA (force
// a ~5-min backoff cooldown, no Retry button). The exit code is authoritative
// regardless of --stream vs --json, so we read it directly without parsing
// stdout (handoff §2). That is the *reactive* side; the *preventive* side is
// the global serial gate (notion_agent_gate.ts) every spawn passes through —
// it stops concurrent calls (cross-session / popout windows) from tripping
// strict mode in the first place.

import { execa } from 'execa'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'node:string_decoder'

import { whichSync } from '../../bin_resolver'
import type {
  ChatBackend,
  ChatStreamEvent,
  ChatStreamRequest,
  EmailContext
} from '@shared/chat/types'
import { notionAgentGate, type GateRelease } from './notion_agent_gate'

/** Idle (no-output) timeout for a `notion-agent chat` stream. This is NOT a
 *  total wall-clock cap — the watchdog in runNotionAgent re-arms it on every
 *  stdout chunk, so a healthy long stream never trips it; only a stalled/hung
 *  process (no output for the whole window) does. The old code used execa's
 *  `timeout` (a TOTAL cap) at 90s, which killed long-but-healthy answers
 *  mid-stream. Default 600s; override via NOTION_AGENT_IDLE_TIMEOUT_MS (ms). */
const DEFAULT_IDLE_TIMEOUT_MS = 600_000
function idleTimeoutMs(): number {
  const raw = process.env['NOTION_AGENT_IDLE_TIMEOUT_MS']
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS
}

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

  const toolArgs = { threadId, model: req.model }
  const startTime = Date.now()
  yield {
    type: 'tool_call',
    name: 'notion-agent chat',
    args: toolArgs,
    status: 'running'
  }

  // Global serial gate (prevention layer): block until no other notion-agent
  // subprocess is running AND the min-interval since the last start elapsed —
  // a burst of concurrent calls is what trips Notion's trust-rule strict mode
  // (exit 75). acquire() rejects if this request is aborted while queued; bail
  // quietly then (the orchestrator flips the assistant row to 'aborted'). The
  // `finally` below releases on every exit path (done / error / timeout /
  // abort / consumer break). See notion_agent_gate.ts.
  // No-op default so the `finally` release() is always callable even on the
  // (impossible) path where we somehow reach it without having acquired.
  let release: GateRelease = () => {}
  try {
    release = await notionAgentGate.acquire(req.signal)
  } catch {
    return
  }

  // First turn only: snapshot threads dir AFTER acquiring (only one
  // notion-agent runs at a time now, so the post-call diff is unambiguous) so
  // we can recover the new thread_id afterwards. Follow-ups already know it
  // (passed via --thread-id).
  const before = threadId ? null : snapshotThreadFiles()

  const decoder = new StringDecoder('utf8')
  let accumulated = ''

  // Idle (no-output) watchdog — see DEFAULT_IDLE_TIMEOUT_MS. We re-arm on every
  // stdout chunk so a streaming answer never trips it; the deadline fires only
  // when the process emits nothing for the whole window (slow first token or a
  // genuinely hung CLI). `idleTimedOut` distinguishes a watchdog kill (→
  // E_NOTION_AGENT_TIMEOUT) from a user abort (→ silent), since both surface as
  // `killed`. disarmIdle() runs in the finally on every exit path.
  const idleMs = idleTimeoutMs()
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let childRef: { kill: (signal?: string) => boolean } | null = null
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      childRef?.kill('SIGTERM')
    }, idleMs)
  }
  const disarmIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  try {
    const child = execa(bin, args, {
      input: enrichedPrompt,
      // execa@9 renamed `signal` → `cancelSignal`; using the old name throws
      // synchronously ("signal option has been renamed").
      cancelSignal: req.signal,
      // No execa `timeout`: that's a TOTAL wall-clock cap that kills healthy
      // long streams mid-flight. The idle watchdog below enforces a no-output
      // deadline instead (reset on every chunk).
      reject: false,
      // stdout unbuffered → we read it as a stream for real-time deltas;
      // stderr buffered → classifyExit reads the whole thing at the end.
      buffer: { stdout: false, stderr: true }
    })
    childRef = child as unknown as { kill: (signal?: string) => boolean }
    armIdle() // cover slow first-token latency before any chunk arrives

    if (child.stdout) {
      for await (const chunk of child.stdout) {
        if (req.signal.aborted) break
        armIdle() // received output → push the idle deadline forward
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
    disarmIdle()
    const { stderr, exitCode } = result
    // execa@9 surfaces signal termination as `isCanceled`; older builds used
    // `killed`. Accept both so the type-check stays happy across the lockfile.
    const killed =
      (result as unknown as { killed?: boolean; isCanceled?: boolean }).killed === true ||
      (result as unknown as { killed?: boolean; isCanceled?: boolean }).isCanceled === true

    if (req.signal.aborted) return

    // Idle watchdog tripped (no output for the whole window) → report timeout.
    // Checked before `killed` because the watchdog kills the child, so `killed`
    // is also true here; idleTimedOut is the disambiguator.
    if (idleTimedOut) {
      const idleSec = Math.round(idleMs / 1000)
      yield {
        type: 'tool_call',
        name: 'notion-agent chat',
        args: toolArgs,
        status: 'error',
        durationMs: Date.now() - startTime,
        detail: `no output for ${idleSec}s`
      }
      yield {
        type: 'error',
        code: 'E_NOTION_AGENT_TIMEOUT',
        message: 'notion-agent idle timeout (no output)'
      }
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
  } finally {
    // Cancel the idle watchdog so a settled call can't fire a stray kill on a
    // reused/exited pid (no-op if already disarmed on the happy path).
    disarmIdle()
    // Release the serial gate on EVERY exit: normal done, error/timeout
    // returns, abort, an exception, or the consumer breaking the for-await
    // (which calls the generator's .return() and runs this finally). Without
    // this a crashed/aborted call would wedge the gate shut for every later
    // notion-agent send. Idempotent, so the belt-and-suspenders paths are safe.
    release()
  }
}

function classifyExit(exitCode: number | null | undefined, stderr: string): string {
  // CLI ≥0.1.11 emits structured exit codes that classify the failure without
  // parsing stdout/stderr (handoff §2). These are authoritative — check first.
  //   75 → trust-rule rate limit (anti-automation guard; retry_after≈300s,
  //        isRetryable:false → must back off, never retry immediately)
  //   77 → auth/credential invalid (re-run `notion-agent init`)
  //  127 → binary not found on PATH
  if (exitCode === 75) return 'E_NOTION_AGENT_RATE_LIMIT'
  if (exitCode === 77) return 'E_NOTION_AGENT_AUTH'
  if (exitCode === 127) return 'E_NOTION_AGENT_NOT_INSTALLED'

  // <0.1.11 fallback + defence-in-depth: the only signal was the human-readable
  // stderr line. trust-rule denial leaks a `trust-rule-denied` subtype string.
  const haystack = stderr.toLowerCase()
  if (haystack.includes('trust-rule-denied') || haystack.includes('trust_rule')) {
    return 'E_NOTION_AGENT_RATE_LIMIT'
  }
  if (haystack.includes('token_v2') || haystack.includes('unauthorized')) {
    return 'E_NOTION_AGENT_AUTH'
  }
  if (haystack.includes('cloudflare') || haystack.includes('network')) {
    return 'E_NOTION_AGENT_NETWORK'
  }
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
    case 'E_NOTION_AGENT_RATE_LIMIT':
      return 'notion-agent rate-limited by Notion anti-automation (trust-rule) — backing off ~5min'
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
