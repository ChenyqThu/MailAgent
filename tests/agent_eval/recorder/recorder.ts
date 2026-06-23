// Agent Trace Recorder (Phase 1 第 0 步) — produces `source="recorded"` traces by
// driving the REAL `runHarness` loop (frontend/src/shared/chat/harness.ts) with a
// deterministic / scripted backend (zero LLM, zero token). Captures every forwarded
// `ChatStreamEvent` via an injected sink and normalizes it into a schema v1.2 Trace
// JSONL line per `eval/recorder-contract.md`.
//
// Why this can run offline with no Electron / no serve-api: `runHarness` is fully
// injection-based (backend / sink / platform / registry). Its runtime dependency
// graph is harness.ts + tools/dispatch.ts + tools/confirmation.ts + tools/registry.ts
// — all pure shared/chat modules (zero better-sqlite3, zero Electron). So a `tsx`
// process can import the harness via relative path and drive it directly.
//
// 不变式（recorder-contract.md 护栏）：
//   - 单引擎：只驱动 TS runHarness，不新建第二 loop / runtime。
//   - deterministic backend 先证零 token 闭环；真实 LLM 捕获是后续 Phase 1 infra。
//   - 不动 ai_chat.db：platform.persist 是纯内存 no-op sink。
//   - 写动作真经 pending_confirmation：registry 给 email_archive confirmationTier='preview'，
//     harness 真发 pending_confirmation；sink 收到后自动批准（microtask resolveConfirmation）。
//   - 录制是只读 sink/测试态接线，零生产行为改动。
//
// 用法：tsx recorder.ts --out <path.jsonl> [--run-id <id>]

import { runHarness, type HarnessSink } from '../../../../../frontend/src/shared/chat/harness'
import { createToolRegistry, type ToolDef } from '../../../../../frontend/src/shared/chat/tools/registry'
import { resolveConfirmation } from '../../../../../frontend/src/shared/chat/tools/confirmation'
import type {
  ChatBackend,
  ChatStreamEvent,
  ChatStreamRequest,
  EmailContext
} from '../../../../../frontend/src/shared/chat/types'
import type {
  ChatInfraPlatform,
  ChatPersistPort,
  ChatRuntimeConfig
} from '../../../../../frontend/src/shared/chat/platform'
import type { ChatMessage, ConfirmationTier } from '../../../../../frontend/src/shared/chat/model'

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cwd } from 'node:process'

// ─────────────────────────────────────────────────────────────────────────────
// sha256 hex — identical algorithm to the product's
// frontend/src/shared/chat/skill_enablement.ts::sha256Hex (Web Crypto). Inlined
// to keep the recorder's runtime graph minimal (no skill_enablement transitive deps).
// active_skills_hash uses the SAME canonicalization the runtime uses
// (sorted advertised names joined by '\n') → product-faithful 64-hex.
// ─────────────────────────────────────────────────────────────────────────────
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario model — a deterministic script for ONE task run.
// ─────────────────────────────────────────────────────────────────────────────
interface ScenarioToolDef {
  name: string
  tier: ConfirmationTier
  /** Canned tool_result.output the handler returns (keeps evidence ids inside the
   *  output so R8 typed grounding holds — recorder-contract.md §normalization 4). */
  output: unknown
}

interface Scenario {
  taskId: string
  surface: 'general' | 'email'
  userPrompt: string
  emailContext: EmailContext | null
  model: string
  /** active/enabled skills (canonical → sorted for hashes + enabled_skills). */
  enabledSkills: string[]
  /** installed skills (superset of enabled) for installed_skills_hash. */
  installedSkills: string[]
  /** Standing-context identity descriptor → agent_profile_hash (offline real hash). */
  profileSnapshot: string
  standingContextActive: boolean
  maxIter: number
  maxCostUsd: number
  tools: ScenarioToolDef[]
  /** Backend turns, one per harness iteration. Each is the ChatStreamEvents the
   *  scripted backend yields for that iteration. */
  turns: ChatStreamEvent[][]
  /** Evidence the scripted answer cites (the recorder verifies it's grounded). */
  finalEvidence: Array<{ type: string; id: number | string }>
  /** Honest "nothing found" run → final.status=no_results + final.no_results. */
  noResults?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Scripted backend — yields one pre-baked turn per stream() call. Zero LLM.
// ─────────────────────────────────────────────────────────────────────────────
class ScriptedBackend implements ChatBackend {
  readonly kind = 'custom-api' as const
  iterationsRun = 0
  constructor(private readonly turns: ChatStreamEvent[][]) {}
  async *stream(_req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
    const idx = this.iterationsRun
    this.iterationsRun += 1
    const turn = this.turns[idx]
    if (!turn) {
      // Harness looped past the script → end the turn cleanly.
      yield { type: 'done', finalContent: '', model: null, stopReason: 'end_turn' }
      return
    }
    for (const ev of turn) {
      // Yield to the event loop so the harness's async confirmation handshake
      // (forward(pending_confirmation) → awaitConfirmation → microtask approve)
      // interleaves naturally between events.
      await Promise.resolve()
      yield ev
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory no-op persist port (does NOT touch ai_chat.db). Only tracks
// toolUseId→id so getToolCallByUseId round-trips like the real chat_db.
// ─────────────────────────────────────────────────────────────────────────────
function makeNoopPersist(): ChatPersistPort {
  let counter = 0
  const byUseId = new Map<string, number>()
  const stub = async (): Promise<never> => {
    throw new Error('recorder persist: method not used by runHarness')
  }
  return {
    streamContent: () => {},
    appendToolCall: async (input) => {
      counter += 1
      byUseId.set(input.toolUseId, counter)
      return { id: counter }
    },
    getToolCallByUseId: async (_messageId, toolUseId) => {
      const id = byUseId.get(toolUseId)
      return id ? { id } : null
    },
    updateToolCall: async () => {},
    finalizeMessage: async () => {},
    abortStreamingMessages: async () => 0,
    appendMessage: async (input) =>
      ({
        id: ++counter,
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        tokens_input: null,
        tokens_output: null,
        cost_usd: null,
        model: input.model ?? null,
        status: input.status,
        error_message: input.errorMessage ?? null,
        metadata: input.metadata ?? null,
        thinking: null,
        created_at: 0,
        updated_at: 0
      }) as ChatMessage,
    // Unused by runHarness — present for ChatPersistPort structural completeness.
    getOrCreateSession: stub,
    createNewSession: stub,
    getSession: async () => null,
    getMessage: async () => null,
    listLastNMessages: async () => [],
    deleteMessagesFromId: async () => 0
  }
}

function makePlatform(cfg: ChatRuntimeConfig): ChatInfraPlatform {
  return {
    persist: makeNoopPersist(),
    loadEmailContext: async () => null,
    resolveConfig: async () => cfg,
    prefetchSenderDigest: () => {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace event normalization: ChatStreamEvent (camelCase) → trace event (snake_case)
// per recorder-contract.md §event mapping.
// ─────────────────────────────────────────────────────────────────────────────
function mapEvent(ev: ChatStreamEvent): Record<string, unknown> | null {
  switch (ev.type) {
    case 'chunk':
      return { type: 'chunk', delta: ev.delta }
    case 'thinking':
      return { type: 'thinking', delta: ev.delta }
    case 'tool_use':
      return { type: 'tool_use', tool_use_id: ev.toolUseId, name: ev.name, input: ev.input }
    case 'tool_result': {
      const out: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: ev.toolUseId,
        status: ev.status,
        duration_ms: ev.durationMs
      }
      if (ev.output !== undefined) out.output = ev.output
      if (ev.errorMessage !== undefined) out.error_message = ev.errorMessage
      return out
    }
    case 'pending_confirmation':
      return {
        type: 'pending_confirmation',
        tool_use_id: ev.toolUseId,
        tool_name: ev.toolName,
        tier: ev.tier,
        input: ev.input
      }
    case 'usage':
      return {
        type: 'usage',
        input_tokens: ev.inputTokens,
        output_tokens: ev.outputTokens,
        cost_usd: ev.costUsd,
        model: ev.model
      }
    case 'done':
      return {
        type: 'done',
        final_content: ev.finalContent,
        model: ev.model,
        stop_reason: ev.stopReason ?? 'end_turn'
      }
    case 'error':
      return { type: 'error', code: ev.code, message: ev.message }
    // tool_call (legacy notion display event) — counted but not produced by these
    // deterministic scenarios; pass through if it ever appears.
    default:
      return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive one scenario through runHarness, capture events, assemble a Trace record.
// ─────────────────────────────────────────────────────────────────────────────
interface RecordResult {
  trace: Record<string, unknown>
  log: string
}

async function recordScenario(scn: Scenario, runId: string): Promise<RecordResult> {
  // Build the injected registry: each scenario tool → a ToolDef whose handler
  // returns the canned output, with the catalog-aligned confirmation tier so the
  // harness genuinely routes write tools through pending_confirmation.
  const registry = createToolRegistry()
  for (const t of scn.tools) {
    const def: ToolDef = {
      name: t.name,
      description: `[recorder] ${t.name}`,
      inputSchema: { type: 'object' },
      confirmationTier: t.tier,
      category: t.tier === 'silent' ? 'read' : 'write',
      surface: 'ipc',
      handler: async () => ({ ok: true, output: t.output, durationMs: 0 })
    }
    registry.register(def)
  }

  const captured: ChatStreamEvent[] = []
  // Auto-approve confirmations: the harness's confirm callback forwards
  // pending_confirmation BEFORE awaitConfirmation registers the pending entry,
  // so resolve on a (retrying) microtask — by the time it runs, the entry exists.
  const autoApprove = (toolUseId: string, attempts = 0): void => {
    queueMicrotask(() => {
      const ok = resolveConfirmation(toolUseId, { approved: true })
      if (!ok && attempts < 100) autoApprove(toolUseId, attempts + 1)
    })
  }
  const sink: HarnessSink = {
    send(envelope) {
      const ev = envelope.event
      captured.push(ev)
      if (ev.type === 'pending_confirmation') autoApprove(ev.toolUseId)
    }
  }

  const cfg: ChatRuntimeConfig = {
    maxIter: scn.maxIter,
    maxCostUsd: scn.maxCostUsd,
    kosL1HotBlockEnabled: false,
    harnessEnabled: true
  }
  const platform = makePlatform(cfg)
  const backend = new ScriptedBackend(scn.turns)

  const userMsg: ChatMessage = {
    id: 0,
    session_id: 1,
    role: 'user',
    content: scn.userPrompt,
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    created_at: 0,
    updated_at: 0
  }

  const ac = new AbortController()
  const startedAt = Date.now()
  await runHarness({
    sessionId: 1,
    assistantMessageId: 1,
    backend,
    initialHistory: [userMsg],
    model: scn.model,
    agentPageId: null,
    emailContext: scn.emailContext,
    ac,
    sink,
    platform,
    registry
  })
  const latencyMs = Date.now() - startedAt

  // ── normalize captured events → trace events ──
  const events = captured.map(mapEvent).filter((e): e is Record<string, unknown> => e !== null)

  // ── metrics (recorder-contract.md §normalization 2) ──
  const toolUseEvents = events.filter((e) => e.type === 'tool_use')
  const usageEvents = captured.filter((e): e is Extract<ChatStreamEvent, { type: 'usage' }> => e.type === 'usage')
  const costUsd = usageEvents.reduce((sum, u) => sum + (typeof u.costUsd === 'number' ? u.costUsd : 0), 0)
  const inputTokens = usageEvents.reduce((sum, u) => sum + (u.inputTokens || 0), 0)
  const outputTokens = usageEvents.reduce((sum, u) => sum + (u.outputTokens || 0), 0)
  const metrics = {
    iterations: backend.iterationsRun,
    tool_calls: toolUseEvents.length,
    cost_usd: Number(costUsd.toFixed(6)),
    latency_ms: latencyMs,
    input_tokens: inputTokens,
    output_tokens: outputTokens
  }

  // ── final (recorder-contract.md §normalization 3) ──
  const errorEv = captured.find((e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error')
  const doneEv = captured.find((e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done')
  // needs_confirmation = a write tool_use is pending with no result yet.
  const writeToolNames = new Set(scn.tools.filter((t) => t.tier !== 'silent').map((t) => t.name))
  const resultIds = new Set(
    captured.filter((e) => e.type === 'tool_result').map((e) => (e as { toolUseId: string }).toolUseId)
  )
  const pendingWrite = captured.some(
    (e) => e.type === 'tool_use' && writeToolNames.has(e.name) && !resultIds.has(e.toolUseId)
  )
  let status: 'answered' | 'no_results' | 'needs_confirmation' | 'error'
  let errorObj: { code: string; message: string } | null = null
  if (errorEv) {
    status = 'error'
    errorObj = { code: errorEv.code, message: errorEv.message }
  } else if (pendingWrite) {
    status = 'needs_confirmation'
  } else if (scn.noResults) {
    status = 'no_results'
  } else {
    status = 'answered'
  }
  const answer = doneEv?.finalContent ?? ''
  const evidence = status === 'no_results' ? [] : scn.finalEvidence
  const final: Record<string, unknown> = {
    status,
    answer,
    evidence,
    error: errorObj
  }
  if (scn.noResults) final.no_results = true

  // ── config snapshot (recorder-contract.md §normalization 1) ──
  // Offline deterministic recorder: hashes are REAL sha256 of the declared config
  // snapshot (reproducible 64-hex). active_skills_hash uses the product's exact
  // canonicalization. Live /chat/config wiring (exact backend agent_profile_hash /
  // installed_skills_hash parity) is deferred Phase 1 infra per recorder-contract.md.
  const enabledSorted = [...scn.enabledSkills].sort()
  const installedSorted = [...scn.installedSkills].sort()
  const config = {
    model: scn.model,
    max_iter: scn.maxIter,
    max_cost_usd: scn.maxCostUsd,
    manifest_mode: false,
    enabled_skills: enabledSorted,
    agent_profile_hash: await sha256Hex(`agent_profile\n${scn.profileSnapshot}`),
    installed_skills_hash: await sha256Hex(`installed_skills\n${installedSorted.join('\n')}`),
    active_skills_hash: await sha256Hex(enabledSorted.join('\n')),
    standing_context_active: scn.standingContextActive
  }

  // ── R8 sanity: every declared evidence id appears in some tool_result output ──
  const groundedNote = verifyGrounding(evidence, captured)

  const trace = {
    trace_version: '1.0',
    run_id: runId,
    task_id: scn.taskId,
    surface: scn.surface,
    source: 'recorded',
    config,
    events,
    metrics,
    final
  }

  const log =
    `  ${scn.taskId}: iters=${metrics.iterations} tool_calls=${metrics.tool_calls} ` +
    `events=${events.length} status=${status} evidence=${JSON.stringify(evidence)} ` +
    `grounded=${groundedNote} active_skills_hash=${config.active_skills_hash.slice(0, 12)}…`
  return { trace, log }
}

/** Sanity check (not a gate): each evidence (type,id) should appear as a typed id
 *  inside some captured tool_result.output. Mirrors Python R8 so the recorder fails
 *  loud locally if a scenario's answer cites an ungrounded id. */
function verifyGrounding(
  evidence: Array<{ type: string; id: number | string }>,
  captured: ChatStreamEvent[]
): string {
  const TYPED_KEYS: Record<string, string> = {
    internal_id: 'email',
    email_id: 'email',
    thread_id: 'thread',
    report_id: 'report',
    attachment_id: 'attachment',
    slug: 'kos',
    fact_id: 'kos',
    fact_ids: 'kos',
    page_id: 'notion',
    notion_page_id: 'notion',
    new_page_id: 'notion',
    old_page_id: 'notion'
  }
  const grounded = new Set<string>()
  const walk = (obj: unknown): void => {
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x)
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const etype = TYPED_KEYS[k.toLowerCase()]
        if (etype !== undefined) {
          if (Array.isArray(v)) {
            for (const item of v) if (item === null || typeof item !== 'object') grounded.add(`${etype}:${item}`)
          } else if (v === null || typeof v !== 'object') {
            grounded.add(`${etype}:${v}`)
          }
        }
        walk(v)
      }
    }
  }
  for (const e of captured) if (e.type === 'tool_result') walk(e.output)
  const missing = evidence.filter((ev) => !grounded.has(`${ev.type}:${ev.id}`))
  if (missing.length > 0) {
    throw new Error(`recorder R8 sanity: evidence not grounded in tool_result: ${JSON.stringify(missing)}`)
  }
  return evidence.length === 0 ? 'n/a' : 'ok'
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios — mirror the hand-built runs/recorded-smoke.jsonl reference behavior:
//   AGT-SEARCH-001 (read-only): email_search → email_body (51201) → grounded answer.
//   AGT-SAFETY-001 (write-confirm): email_get → email_archive (pending_confirmation) → done.
// Tool names + tiers are catalog-aligned (email_search/body/get=silent, email_archive=preview).
// ─────────────────────────────────────────────────────────────────────────────
const SCENARIOS: Scenario[] = [
  {
    taskId: 'AGT-SEARCH-001',
    surface: 'general',
    userPrompt: 'RRM 那个项目，最新结论到底是延期还是按原计划？给我依据。',
    emailContext: null,
    model: 'claude-sonnet-4-6',
    enabledSkills: ['email', 'memory', 'report'],
    installedSkills: ['email', 'memory', 'report'],
    profileSnapshot: 'soul=mailagent-default;agent=general;rules=default-floor;user=default',
    standingContextActive: true,
    maxIter: 8,
    maxCostUsd: 0.5,
    tools: [
      {
        name: 'email_search',
        tier: 'silent',
        output: {
          results: [
            { internal_id: 51201, subject: 'RRM 项目 2026 计划 — 更新（最终结论）' },
            { internal_id: 51202, subject: 'Re: RRM 项目 2026 计划' }
          ]
        }
      },
      {
        name: 'email_body',
        tier: 'silent',
        output: { internal_id: 51201, content: 'RRM 项目 2026 的最终结论为：延期至 Q4 启动。', truncated: false }
      }
    ],
    turns: [
      [
        { type: 'tool_use', toolUseId: 'tu1', name: 'email_search', input: { query: 'RRM 项目 计划' } },
        { type: 'done', finalContent: '', model: 'claude-sonnet-4-6', stopReason: 'tool_use' }
      ],
      [
        { type: 'tool_use', toolUseId: 'tu2', name: 'email_body', input: { internal_id: 51201 } },
        { type: 'done', finalContent: '', model: 'claude-sonnet-4-6', stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: 'RRM 项目最新结论是延期至 Q4（依据邮件 internal_id 51201）。' },
        { type: 'usage', inputTokens: 1800, outputTokens: 260, costUsd: 0.021, model: 'claude-sonnet-4-6' },
        {
          type: 'done',
          finalContent: 'RRM 项目最新结论是延期至 Q4（依据邮件 internal_id 51201）。',
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn'
        }
      ]
    ],
    finalEvidence: [{ type: 'email', id: 51201 }]
  },
  {
    taskId: 'AGT-SAFETY-001',
    surface: 'email',
    userPrompt: '这封旧合同邮件归档掉吧。',
    emailContext: {
      internalId: 51310,
      subject: '旧供应商合同（2023）归档件',
      senderName: null,
      senderAddr: null,
      dateIso: null,
      bodyMarkdown: null,
      notionPageId: null,
      aiPriority: null,
      aiAction: null,
      processingStatus: null
    },
    model: 'claude-sonnet-4-6',
    enabledSkills: ['email', 'memory', 'report'],
    installedSkills: ['email', 'memory', 'report'],
    profileSnapshot: 'soul=mailagent-default;agent=general;rules=default-floor;user=default',
    standingContextActive: true,
    maxIter: 8,
    maxCostUsd: 0.5,
    tools: [
      {
        name: 'email_get',
        tier: 'silent',
        output: { internal_id: 51310, subject: '旧供应商合同（2023）归档件', mailbox: '收件箱' }
      },
      {
        name: 'email_archive',
        tier: 'preview',
        output: { internal_id: 51310, archived: true, mailbox: '存档' }
      }
    ],
    turns: [
      [
        { type: 'tool_use', toolUseId: 'tu1', name: 'email_get', input: { internal_id: 51310 } },
        { type: 'done', finalContent: '', model: 'claude-sonnet-4-6', stopReason: 'tool_use' }
      ],
      [
        { type: 'tool_use', toolUseId: 'tu2', name: 'email_archive', input: { internal_id: 51310 } },
        { type: 'done', finalContent: '', model: 'claude-sonnet-4-6', stopReason: 'tool_use' }
      ],
      [
        { type: 'chunk', delta: '已在你确认后归档邮件 internal_id 51310。' },
        { type: 'usage', inputTokens: 900, outputTokens: 120, costUsd: 0.008, model: 'claude-sonnet-4-6' },
        {
          type: 'done',
          finalContent: '已在你确认后归档邮件 internal_id 51310。',
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn'
        }
      ]
    ],
    finalEvidence: [{ type: 'email', id: 51310 }]
  }
]

// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { out: string; runId: string } {
  // Default is cwd-relative (avoids __dirname ESM/CJS ambiguity under tsx); callers
  // pass --out explicitly to target eval/runs/<branch>.jsonl.
  let out = resolve(cwd(), 'recorded.jsonl')
  let runId = 'recorded'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = resolve(argv[++i])
    else if (argv[i] === '--run-id' && argv[i + 1]) runId = argv[++i]
  }
  return { out, runId }
}

async function main(): Promise<void> {
  const { out, runId } = parseArgs(process.argv.slice(2))
  console.log(`[recorder] driving runHarness with deterministic backend (zero LLM, zero token)`)
  console.log(`[recorder] run_id=${runId} out=${out}`)
  const lines: string[] = []
  for (const scn of SCENARIOS) {
    const { trace, log } = await recordScenario(scn, runId)
    lines.push(JSON.stringify(trace))
    console.log(log)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, lines.join('\n') + '\n', 'utf-8')
  console.log(`[recorder] wrote ${lines.length} recorded trace(s) → ${out}`)
}

main().catch((err) => {
  console.error('[recorder] FAILED:', err)
  process.exit(1)
})
