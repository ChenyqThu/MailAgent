// Sprint 19 §B eval harness — runs 25 scenarios from docs/eval/email_scenarios.md
// against the real chat agent harness + real CRS LLM gateway, collects
// pass/fail metrics + cost, writes raw JSON + markdown report.
//
// Bypasses the IPC dispatcher (`dispatcher.ts`) which depends on Electron,
// calling `runHarness` directly with a recording sink that auto-approves
// any pending_confirmation events. Tools register through the normal
// `registerBuiltinTools` path; electron-coupled handlers are reachable
// because scripts/dev/eval_electron_stub.cjs stubs `electron` + `keytar`.
//
// Run from project root:
//   node --import tsx --import ./scripts/dev/eval_electron_stub.cjs \
//        scripts/dev/eval_chat_scenarios.ts
//
// Or via the wrapper script for the right env setup:
//   bash scripts/dev/run_eval.sh

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'

const ROOT = resolve(__dirname, '..', '..')
const FRONTEND_ROOT = join(ROOT, 'frontend')

// Load .env into process.env BEFORE we import anything that reads it.
const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    const k = m[1]
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}

// Force harness ON for eval regardless of .env (the gating only matters
// at the dispatcher level; runHarness itself runs unconditionally).
process.env.MAILAGENT_AGENT_HARNESS = '1'
// Isolated chat_db (`:memory:`) keeps eval from polluting the user's
// real ~/.mailagent/frontend/ai_chat.db.
process.env.AI_CHAT_DB_PATH = ':memory:'
// Cap each turn to a reasonable budget — scenarios don't need 8 iters or
// $0.5; this also keeps runaway loops cheap.
process.env.AGENT_MAX_ITER = process.env.AGENT_MAX_ITER ?? '5'
process.env.AGENT_MAX_COST_USD = process.env.AGENT_MAX_COST_USD ?? '0.2'
// We don't want sender digest prefetch making real network calls during
// eval unless explicitly testing it — KOS consumer flag controls that.

// Imports go after env-shim. Order matters: chat_db / handlers load
// modules that read env immediately.
import { runHarness } from '../../frontend/src/electron/main/chat/harness'
import {
  appendMessage,
  getOrCreateSession,
  closeChatDb,
  type ChatMessage
} from '../../frontend/src/electron/main/chat_db'
import {
  createToolRegistry,
  defaultToolRegistry
} from '../../frontend/src/electron/main/chat/tools/registry'
import {
  resolveConfirmation,
  __resetConfirmations
} from '../../frontend/src/electron/main/chat/tools/confirmation'
import { registerBuiltinTools } from '../../frontend/src/electron/main/chat/tools/builtin'
import { CustomApiBackend } from '../../frontend/src/electron/main/chat/backends/custom_api'
import type {
  ChatStreamEnvelope,
  ChatStreamEvent,
  EmailContext
} from '../../frontend/src/electron/main/chat/types'

// ── Scenario extraction ───────────────────────────────────────────────────

interface Scenario {
  id: string
  category: string
  phase: string
  prompt: string
  emailCtx: string | null
  expectedTools: string[]
  forbiddenTools: string[]
  expectedSubstring: string[]
  notes: string | null
}

function parseScenarios(md: string): Scenario[] {
  const out: Scenario[] = []
  const blockRe = /```yaml\s*\n([\s\S]*?)\n```/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(md)) !== null) {
    const block = m[1]
    const s = parseYamlBlock(block)
    if (s) out.push(s)
  }
  return out
}

/** Cheap YAML-ish parser tuned for the scenario block shape. Avoids
 *  pulling in a full YAML lib; the blocks are structurally identical
 *  (id, category, phase, prompt, email_ctx, expected_tools, forbidden_tools,
 *  expected_substring, notes), and the keys we actually use are flat. */
function parseYamlBlock(block: string): Scenario | null {
  const lines = block.split('\n')
  const fields: Record<string, string | string[]> = {}
  // Multi-line lists are gathered under their key; bullet items collected.
  let currentKey: string | null = null
  let inList = false
  const listAcc: string[] = []

  const flush = () => {
    if (currentKey && inList) {
      fields[currentKey] = [...listAcc]
      listAcc.length = 0
    }
    inList = false
  }

  for (const line of lines) {
    // skip empty / pure comment lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue

    const top = line.match(/^([a-z_]+):\s*(.*)$/)
    if (top) {
      flush()
      currentKey = top[1]
      const rest = top[2].trim()
      if (rest === '') {
        // list or nested follows
        inList = true
      } else if (rest === 'null') {
        fields[currentKey] = ''
      } else {
        fields[currentKey] = unquote(rest)
      }
      continue
    }

    // list item
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && currentKey) {
      // For expected_tools entries with `name: foo` shape, just keep the name.
      const v = item[1].trim()
      const nameMatch = v.match(/^name:\s*(.*)$/)
      if (nameMatch) {
        listAcc.push(unquote(nameMatch[1].trim()))
      } else if (v.match(/^[a-z_]+:/)) {
        // nested key on a list item we don't care about — skip
      } else if (v.startsWith('可选') || v.startsWith('或')) {
        // Chinese "optional:" prefix isn't a tool name
      } else {
        listAcc.push(unquote(v))
      }
      inList = true
      continue
    }

    // sub-key under expected_tools entries (input_pattern etc) — ignore
    if (currentKey && /^\s{2,}[a-z_]+:/.test(line)) continue
  }
  flush()

  const id = typeof fields.id === 'string' ? fields.id : null
  if (!id) return null

  // forbidden_tools is sometimes inline: `forbidden_tools: [email_flag, ...]`
  const forbidden = parseInlineList(fields.forbidden_tools)
  const expectedTools = Array.isArray(fields.expected_tools)
    ? (fields.expected_tools as string[])
    : parseInlineList(fields.expected_tools)
  const expectedSub = parseInlineList(fields.expected_substring)

  return {
    id,
    category: (fields.category as string) ?? 'unknown',
    phase: (fields.phase as string) ?? 'P1',
    prompt: ((fields.prompt as string) ?? '').trim(),
    emailCtx: typeof fields.email_ctx === 'string' && fields.email_ctx.length > 0
      ? (fields.email_ctx as string)
      : null,
    expectedTools: expectedTools.filter(t => t.length > 0),
    forbiddenTools: forbidden.filter(t => t.length > 0),
    expectedSubstring: expectedSub.filter(s => s.length > 0),
    notes: (fields.notes as string) ?? null
  }
}

function unquote(s: string): string {
  s = s.trim()
  // Strip trailing inline-comment ("foo # bar" → "foo")
  // Only strip when # is preceded by whitespace, so URL fragments don't trip.
  const commentIdx = s.search(/\s+#/)
  if (commentIdx >= 0) s = s.slice(0, commentIdx).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function parseInlineList(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[]
  if (typeof v !== 'string') return []
  let s = v.trim()
  if (s === '' || s === 'null') return []
  // Strip trailing inline comment
  const commentIdx = s.search(/\s+#/)
  if (commentIdx >= 0) s = s.slice(0, commentIdx).trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',')
      .map(x => unquote(x.trim()))
      .filter(x => x.length > 0 && !x.startsWith('可选') && !x.startsWith('或'))
  }
  return [unquote(s)].filter(x => x.length > 0)
}

// ── Fixture selection ─────────────────────────────────────────────────────

const DB_PATH = process.env.SYNC_STORE_DB_PATH ?? join(homedir(), 'Documents', 'MailAgent', 'data', 'sync_store.db')

interface FixtureRow {
  internal_id: number
  subject: string | null
  sender: string | null
  sender_name: string | null
  thread_id: string | null
  is_read: number
  is_flagged: number
  ai_priority: string | null
  ai_action: string | null
  processing_status: string | null
  has_pdf: number
  has_xlsx: number
  thread_size: number
}

function loadFixtureMap(): Record<string, FixtureRow | null> {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  const queryOne = (sql: string, params: any[] = []): FixtureRow | null => {
    return (db.prepare(sql).get(...params) ?? null) as FixtureRow | null
  }
  const base = `
    SELECT m.internal_id, m.subject, m.sender, m.sender_name, m.thread_id,
           m.is_read, m.is_flagged, m.ai_priority, m.ai_action, m.processing_status,
           (SELECT COUNT(*) FROM email_attachment WHERE internal_id = m.internal_id AND is_inline=0 AND filename LIKE '%.pdf') AS has_pdf,
           (SELECT COUNT(*) FROM email_attachment WHERE internal_id = m.internal_id AND is_inline=0 AND filename LIKE '%.xlsx') AS has_xlsx,
           (SELECT COUNT(*) FROM email_metadata WHERE thread_id = m.thread_id) AS thread_size
      FROM email_metadata m
     WHERE m.sync_status='synced'
  `

  // Pick fixtures matching scenario hints.
  const map: Record<string, FixtureRow | null> = {}
  // S01 baseline — recent normal email
  map.S01 = queryOne(`${base} AND m.body_markdown IS NULL ORDER BY m.internal_id DESC LIMIT 1`)
  if (!map.S01) map.S01 = queryOne(`${base} ORDER BY m.internal_id DESC LIMIT 1`)

  // S02: sender = bob@acme.com — we don't have Bob; use a frequent sender as proxy
  map.S02 = queryOne(`${base} AND m.sender LIKE '%lucien.chen%' ORDER BY m.internal_id DESC LIMIT 1`)
  if (!map.S02) map.S02 = map.S01

  // S03 / S07: PDF + xlsx attachments
  map.S03 = queryOne(`${base} AND EXISTS(SELECT 1 FROM email_attachment WHERE internal_id=m.internal_id AND is_inline=0 AND filename LIKE '%.pdf') AND EXISTS(SELECT 1 FROM email_attachment WHERE internal_id=m.internal_id AND is_inline=0 AND filename LIKE '%.xlsx') ORDER BY m.internal_id DESC LIMIT 1`)
  map.S07 = queryOne(`${base} AND EXISTS(SELECT 1 FROM email_attachment WHERE internal_id=m.internal_id AND is_inline=0 AND filename LIKE '%.pdf') ORDER BY m.internal_id DESC LIMIT 1`)

  // S04 — AI fields populated
  map.S04 = queryOne(`${base} AND m.ai_priority IS NOT NULL AND m.ai_priority != '' ORDER BY m.internal_id DESC LIMIT 1`)

  // S05 — thread ≥ 3
  map.S05 = queryOne(`${base} AND (SELECT COUNT(*) FROM email_metadata WHERE thread_id=m.thread_id) >= 3 ORDER BY m.internal_id DESC LIMIT 1`)

  // S06, S08 — no specific ctx (null email)
  map.S06 = null
  map.S08 = null

  // S09 — unread email
  map.S09 = queryOne(`${base} AND m.is_read=0 ORDER BY m.internal_id DESC LIMIT 1`)
  if (!map.S09) map.S09 = map.S01

  // S10 — flagged email
  map.S10 = queryOne(`${base} AND m.is_flagged=1 ORDER BY m.internal_id DESC LIMIT 1`)
  if (!map.S10) map.S10 = map.S01

  // S11 — meeting invite
  map.S11 = queryOne(`${base} AND (m.subject LIKE '%会议%' OR m.subject LIKE '%邀请%' OR m.subject LIKE '%meeting%') ORDER BY m.internal_id DESC LIMIT 1`)
  if (!map.S11) map.S11 = map.S01

  // S12, S13 — write but expected to reject; no specific fixture needed
  map.S12 = null
  map.S13 = map.S01

  // S14 — multi-step search; null ctx
  map.S14 = null
  // S15 — meeting invite (project recurring meeting)
  map.S15 = map.S11

  // S16, S17, S18 — confirm-edge; use unread email
  map.S16 = map.S09
  map.S17 = map.S11
  map.S18 = null

  // S19 — wiki write; null
  map.S19 = null
  // S20 — retrieval
  map.S20 = null

  // S21-S25 KOS scenarios
  map.S21 = map.S02 // sender ctx
  map.S22 = null
  map.S23 = map.S02
  map.S24 = map.S02
  map.S25 = null

  db.close()
  return map
}

// ── Email context loader (mirrors dispatcher.loadEmailContext) ───────────

const MAX_BODY_CHARS = 12_000

function loadEmailContextForEval(emailId: number): EmailContext | null {
  if (!emailId || emailId <= 0) return null
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT m.internal_id, m.subject, m.sender_name, m.sender, m.date_received,
             m.notion_page_id, m.ai_priority, m.ai_action, m.processing_status,
             b.body_markdown
        FROM email_metadata m
        LEFT JOIN email_body b ON b.internal_id = m.internal_id
       WHERE m.internal_id = ?
    `).get(emailId) as any
    if (!row) return null
    const body = typeof row.body_markdown === 'string' ? row.body_markdown.slice(0, MAX_BODY_CHARS) : null
    return {
      internalId: row.internal_id,
      subject: row.subject,
      senderName: row.sender_name,
      senderAddr: row.sender,
      dateIso: row.date_received,
      bodyMarkdown: body && body.length > 0 ? body : null,
      notionPageId: row.notion_page_id,
      aiPriority: row.ai_priority,
      aiAction: row.ai_action,
      processingStatus: row.processing_status
    }
  } finally {
    db.close()
  }
}

// ── Scenario runner ───────────────────────────────────────────────────────

interface ScenarioResult {
  scenarioId: string
  category: string
  phase: string
  fixtureInternalId: number | null
  fixtureNote: string | null
  prompt: string
  finalText: string
  toolUseSeq: Array<{ name: string; input: unknown }>
  pendingConfirmations: number
  autoApprovedConfirmations: number
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
  durationMs: number
  errorEvent: string | null
  expectedTools: string[]
  forbiddenTools: string[]
  expectedSubstring: string[]
  toolPass: boolean
  outputPass: boolean
  forbiddenPass: boolean
  scenarioPass: boolean
  judgeNotes: string
}

const PER_SCENARIO_TIMEOUT_MS = 90_000

function evaluateScenario(s: Scenario, finalText: string, toolUseSeq: Array<{ name: string; input: unknown }>, errorEvent: string | null): {
  toolPass: boolean
  outputPass: boolean
  forbiddenPass: boolean
  scenarioPass: boolean
  judgeNotes: string
} {
  const names = toolUseSeq.map(t => t.name)
  const expectedToolSet = new Set(s.expectedTools)
  const expectedAny = s.expectedTools.length === 0
    ? true                                    // no expected tools → vacuously satisfied
    : s.expectedTools.some(t => names.includes(t))
  // Some scenarios (S01/S04) note "LLM may skip tool" — be permissive: if
  // expectedTools is non-empty BUT the LLM produced cogent text and the
  // category is 'read-only', count it as tool_skip (partial pass).
  let toolPass = expectedAny
  let judge: string[] = []
  if (!expectedAny && s.expectedTools.length > 0) {
    // Allow partial pass when read-only + LLM answered directly with substring hit
    if (s.category === 'read-only' && names.length === 0) {
      toolPass = true
      judge.push('tool_skip_allowed (read-only, no tool called but expected substring hit later)')
    } else {
      judge.push(`expected tools not called: expected=[${s.expectedTools.join(',')}] actual=[${names.join(',')}]`)
    }
  }

  // forbidden tools
  const violated = s.forbiddenTools.filter(t => names.includes(t))
  const forbiddenPass = violated.length === 0
  if (!forbiddenPass) judge.push(`forbidden tools called: [${violated.join(',')}]`)

  // expected substring — case insensitive
  const lower = finalText.toLowerCase()
  const subAny = s.expectedSubstring.length === 0
    ? true
    : s.expectedSubstring.some(sub => lower.includes(sub.toLowerCase()))
  const outputPass = subAny
  if (!subAny && s.expectedSubstring.length > 0) {
    judge.push(`no expected substring in output (expected any of: ${s.expectedSubstring.join(' | ')})`)
  }

  // Errors are not auto-fail — some scenarios (S24 KOS unreachable) expect
  // an error tool_result yet still want a forbidden-pass + substring match.
  if (errorEvent && errorEvent !== 'E_MAX_ITER' && errorEvent !== 'E_COST_BUDGET') {
    judge.push(`harness emitted error: ${errorEvent}`)
  }

  const scenarioPass = toolPass && outputPass && forbiddenPass
  return { toolPass, outputPass, forbiddenPass, scenarioPass, judgeNotes: judge.join('; ') }
}

async function runScenario(s: Scenario, fixture: FixtureRow | null): Promise<ScenarioResult> {
  const start = Date.now()
  const emailId = fixture?.internal_id ?? 0
  const session = getOrCreateSession({
    emailId: emailId,
    backendKind: 'custom-api',
    backendModel: process.env.LLM_MODEL ?? 'claude-sonnet-4-6'
  })
  appendMessage({
    sessionId: session.id,
    role: 'user',
    content: s.prompt,
    status: 'complete'
  })
  const assistantMsg = appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '',
    status: 'streaming',
    model: process.env.LLM_MODEL ?? 'claude-sonnet-4-6'
  })

  const emailCtx = emailId > 0 ? loadEmailContextForEval(emailId) : null

  // Event collection
  const envelopes: ChatStreamEnvelope[] = []
  const events: ChatStreamEvent[] = []
  let finalText = ''
  const toolUseSeq: Array<{ name: string; input: unknown }> = []
  let usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } = {
    inputTokens: null,
    outputTokens: null,
    costUsd: null
  }
  let pendingCount = 0
  let autoApprovedCount = 0
  let errorEvent: string | null = null

  const ac = new AbortController()
  const timeoutHandle = setTimeout(() => {
    errorEvent = errorEvent ?? 'E_EVAL_TIMEOUT'
    ac.abort()
  }, PER_SCENARIO_TIMEOUT_MS)

  const sink = {
    send(env: ChatStreamEnvelope): void {
      envelopes.push(env)
      const e = env.event
      events.push(e)
      switch (e.type) {
        case 'chunk':
          finalText += e.delta
          break
        case 'tool_use':
          toolUseSeq.push({ name: e.name, input: e.input })
          break
        case 'usage':
          usage = {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            costUsd: e.costUsd
          }
          break
        case 'done':
          if (e.finalContent && e.finalContent.length > 0) finalText = e.finalContent
          break
        case 'error':
          errorEvent = e.code
          break
        case 'pending_confirmation': {
          pendingCount++
          // Auto-approve so the harness can proceed. Use a microtask so the
          // resolveConfirmation runs after awaitConfirmation has registered.
          setImmediate(() => {
            const ok = resolveConfirmation(e.toolUseId, { approved: true })
            if (ok) autoApprovedCount++
          })
          break
        }
      }
    }
  }

  const backend = new CustomApiBackend()

  try {
    await runHarness({
      sessionId: session.id,
      assistantMessageId: assistantMsg.id,
      backend,
      initialHistory: [],
      model: process.env.LLM_MODEL ?? 'claude-sonnet-4-6',
      agentPageId: null,
      emailContext: emailCtx,
      ac,
      sink
    })
  } catch (e) {
    errorEvent = errorEvent ?? `E_RUN_EXCEPTION: ${e instanceof Error ? e.message : String(e)}`
  }

  clearTimeout(timeoutHandle)

  // Wait briefly for any auto-approval microtasks
  await new Promise(r => setTimeout(r, 50))

  const durationMs = Date.now() - start
  const judgment = evaluateScenario(s, finalText, toolUseSeq, errorEvent)

  const fixtureNote = fixture
    ? null
    : (emailId > 0 ? `fixture_internal_id=${emailId} but row not loaded` : null)

  return {
    scenarioId: s.id,
    category: s.category,
    phase: s.phase,
    fixtureInternalId: emailId > 0 ? emailId : null,
    fixtureNote,
    prompt: s.prompt,
    finalText,
    toolUseSeq,
    pendingConfirmations: pendingCount,
    autoApprovedConfirmations: autoApprovedCount,
    usage,
    durationMs,
    errorEvent,
    expectedTools: s.expectedTools,
    forbiddenTools: s.forbiddenTools,
    expectedSubstring: s.expectedSubstring,
    ...judgment
  }
}

// ── Report writer ─────────────────────────────────────────────────────────

function writeReport(results: ScenarioResult[], outPath: string): void {
  const total = results.length
  const p1 = results.filter(r => r.phase === 'P1')
  const p2 = results.filter(r => r.phase === 'P2')
  const p1Pass = p1.filter(r => r.scenarioPass).length
  const p2Pass = p2.filter(r => r.scenarioPass).length

  const p1Total = p1.length
  const p2Total = p2.length
  const gateP1Hit = p1Pass >= 14
  const gateKosHit = p2Pass >= 3

  const totalCost = results.reduce((s, r) => s + (r.usage.costUsd ?? 0), 0)
  const totalWallMs = results.reduce((s, r) => s + r.durationMs, 0)
  const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim()

  const lines: string[] = []
  lines.push('# Sprint 19 §B P1 Baseline Eval Report')
  lines.push('')
  lines.push(`> 跑时间: ${new Date().toISOString()}`)
  lines.push(`> Commit: ${headCommit}`)
  lines.push(`> 总 cost: $${totalCost.toFixed(4)}`)
  lines.push(`> Wall clock: ${(totalWallMs / 1000 / 60).toFixed(1)}min`)
  lines.push(`> Model: ${process.env.LLM_MODEL ?? '(default)'}`)
  lines.push(`> Harness flag: MAILAGENT_AGENT_HARNESS=1, KOS consumer=${process.env.MAILAGENT_KOS_CONSUMER_ENABLED ?? '(unset)'}`)
  lines.push('')
  lines.push('## §1 总览')
  lines.push('')
  lines.push(`- S01-S20 (P1 must-pass): **${p1Pass}/${p1Total}** 通过, gate ≥14 → **${gateP1Hit ? 'HIT ✅' : 'MISS ❌'}**`)
  lines.push(`- S21-S25 (KOS-specific): **${p2Pass}/${p2Total}** 通过, gate ≥3 → **${gateKosHit ? 'HIT ✅' : 'MISS ❌'}**`)
  lines.push(`- 总 pass rate: **${p1Pass + p2Pass}/${total}**`)
  lines.push('')
  lines.push('## §2 Per-scenario 结果')
  lines.push('')
  lines.push('| ID | Cat | Phase | Pass | Tools called | Output snippet | Cost |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const r of results) {
    const pass = r.scenarioPass ? '✅' : '❌'
    const tools = r.toolUseSeq.map(t => t.name).join(', ') || '—'
    const snippet = (r.finalText || '(empty)').replace(/\s+/g, ' ').slice(0, 80).replace(/\|/g, '\\|')
    const cost = r.usage.costUsd !== null ? `$${r.usage.costUsd.toFixed(4)}` : '—'
    lines.push(`| ${r.scenarioId} | ${r.category} | ${r.phase} | ${pass} | ${tools} | ${snippet} | ${cost} |`)
  }
  lines.push('')
  lines.push('## §3 Failed scenario 根因')
  lines.push('')
  const failed = results.filter(r => !r.scenarioPass)
  if (failed.length === 0) {
    lines.push('_无失败场景_ 🎉')
  } else {
    for (const r of failed) {
      lines.push(`### ${r.scenarioId} (${r.category}, ${r.phase})`)
      lines.push('')
      lines.push(`- **Judge notes**: ${r.judgeNotes || '(no notes — see raw)'}`)
      lines.push(`- **Tool used**: ${r.toolUseSeq.map(t => t.name).join(', ') || '(none)'}`)
      lines.push(`- **Expected tools**: ${r.expectedTools.join(', ') || '(none)'}`)
      lines.push(`- **Forbidden tools called**: ${r.forbiddenTools.filter(t => r.toolUseSeq.some(u => u.name === t)).join(', ') || '(none)'}`)
      lines.push(`- **Expected substring (any)**: ${r.expectedSubstring.join(' | ') || '(none)'}`)
      lines.push(`- **Final text (≤200 chars)**: ${(r.finalText || '(empty)').slice(0, 200).replace(/\n/g, ' ')}`)
      if (r.errorEvent) lines.push(`- **Error event**: ${r.errorEvent}`)
      lines.push('')
    }
  }
  lines.push('## §4 Next step 建议')
  lines.push('')
  if (gateP1Hit && gateKosHit) {
    lines.push('- 两个 gate 都 hit → **可翻 default `MAILAGENT_AGENT_HARNESS=1` 合 main**')
  } else if (gateP1Hit && !gateKosHit) {
    lines.push('- P1 gate hit, KOS gate miss → 可翻 default harness flag, KOS consumer 维持 opt-in')
  } else if (!gateP1Hit && gateKosHit) {
    lines.push('- KOS gate hit, P1 gate miss → **暂不翻 default flag**, 优先修 P1 失败 scenario 的 prompt / tool 描述')
  } else {
    lines.push('- 两个 gate 都 miss → **暂不翻 default flag**')
    lines.push('- 优先关注 read-only / write-single 类失败 (S01-S13), 这些是 daily-driver 核心场景')
  }
  if (failed.length > 0) {
    lines.push('')
    lines.push('Top failure 信号:')
    const reasonCounts: Record<string, number> = {}
    for (const r of failed) {
      for (const reason of r.judgeNotes.split(';')) {
        const key = reason.trim().split(':')[0]
        if (!key) continue
        reasonCounts[key] = (reasonCounts[key] ?? 0) + 1
      }
    }
    const sorted = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
    for (const [k, n] of sorted.slice(0, 5)) {
      lines.push(`- \`${k}\` × ${n}`)
    }
  }
  lines.push('')

  writeFileSync(outPath, lines.join('\n'), 'utf-8')
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[eval] loading scenarios from docs/eval/email_scenarios.md')
  const md = readFileSync(join(ROOT, 'docs/eval/email_scenarios.md'), 'utf-8')
  const scenarios = parseScenarios(md)
  console.log(`[eval] parsed ${scenarios.length} scenarios`)
  if (scenarios.length === 0) {
    console.error('[eval] no scenarios parsed — abort')
    process.exit(1)
  }

  console.log(`[eval] DB path: ${DB_PATH}`)
  if (!existsSync(DB_PATH)) {
    console.error(`[eval] sync_store.db not found at ${DB_PATH}`)
    process.exit(2)
  }
  console.log('[eval] selecting fixtures…')
  const fixtureMap = loadFixtureMap()

  // Register tools (production code path)
  registerBuiltinTools(defaultToolRegistry)
  console.log(`[eval] registered tools: ${defaultToolRegistry.names().sort().join(', ')}`)

  const results: ScenarioResult[] = []
  let runCost = 0
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i]
    const fx = fixtureMap[s.id] ?? null
    process.stdout.write(`[eval] [${i + 1}/${scenarios.length}] ${s.id} (${s.category}, ${s.phase}) … `)
    try {
      const r = await runScenario(s, fx)
      results.push(r)
      runCost += r.usage.costUsd ?? 0
      const status = r.scenarioPass ? '✅' : '❌'
      const tools = r.toolUseSeq.map(t => t.name).join(',') || '—'
      console.log(`${status} (${r.durationMs}ms, $${(r.usage.costUsd ?? 0).toFixed(4)}, tools=${tools})`)
    } catch (e) {
      console.log(`💥 exception: ${e instanceof Error ? e.message : String(e)}`)
      results.push({
        scenarioId: s.id,
        category: s.category,
        phase: s.phase,
        fixtureInternalId: fx?.internal_id ?? null,
        fixtureNote: 'exception during scenario',
        prompt: s.prompt,
        finalText: '',
        toolUseSeq: [],
        pendingConfirmations: 0,
        autoApprovedConfirmations: 0,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        durationMs: 0,
        errorEvent: `E_HARNESS_EXCEPTION: ${e instanceof Error ? e.message : String(e)}`,
        expectedTools: s.expectedTools,
        forbiddenTools: s.forbiddenTools,
        expectedSubstring: s.expectedSubstring,
        toolPass: false,
        outputPass: false,
        forbiddenPass: false,
        scenarioPass: false,
        judgeNotes: 'exception during scenario run'
      })
    }
    // Reset confirmations between scenarios so a hung approval doesn't leak.
    __resetConfirmations()
  }

  // Write raw JSON + markdown
  const outDir = join(ROOT, 'docs/eval')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'eval-raw.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    model: process.env.LLM_MODEL,
    totalCost: runCost,
    results
  }, null, 2), 'utf-8')

  writeReport(results, join(outDir, 'p1-baseline.md'))

  console.log('')
  console.log('[eval] DONE')
  console.log(`[eval]   total cost: $${runCost.toFixed(4)}`)
  console.log(`[eval]   report: ${join(outDir, 'p1-baseline.md')}`)
  console.log(`[eval]   raw json: ${join(outDir, 'eval-raw.json')}`)

  closeChatDb()
}

main().catch((e) => {
  console.error('[eval] FATAL:', e)
  process.exit(99)
})
