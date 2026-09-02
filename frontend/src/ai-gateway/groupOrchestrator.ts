// L4 群聊 g1 — 服务端群 run 调度器（每群一条队列、全 gateway 单 worker 串行）。
//
// 任何一条落进群 transcript 的消息（owner / 主 agent 投递 / 成员回复）都经唯一入口
// `onGroupMessage` 进来：候选集只由服务端事实决定（@ 优先 → realtime 成员；self 不唤醒 self；
// 零 realtime 且无 @ → 无人），同 (session, agent) 在队即折叠；worker 每个 turn 依次过
// 确定性地板（groupFloors 单源，本文件零裸数字）→ 反独白 → 令牌桶 + 最小间隔 → 重读快照 →
// 近期消息窗口（无他人新消息 → skipped）→ 租约（与 /api/ai/chat 同锁，/run/active 可见）→
// speak → 六种 outcome 各写一行 ai_chat_group_turn 台账：
//   spoke     落消息行（带 token / cost / chain_id）+ 推进游标 + best-effort 镜像 run_log + 级联
//   silent    不落消息行，推进游标（沉默只省发言不省 token）
//   held_dup  逐字重复，不落行，推进游标
//   skipped   反独白 / 无他人新消息，推进游标
//   failed    不落行，游标不动；同一 run 连续 CONSECUTIVE_FAILED_STOP 次 → stop('error')
//   stopped   地板命中 / owner 停止，游标不动；按 family 清队列 + 各群写 system 行
//
// 🔴 deps 全部经 GroupOrchestratorDeps 注入（history / append / cursor / turn / usage / labs /
//    speak / lease / now / sleep），本文件不 import config.ts、不 import lifecycle —— 单测用假 deps
//    即可跑完整条链；生产接线见 server.ts / ai_gateway_lifecycle.ts。
// 🔴 级联（spoke 后 onGroupMessage(newRow)）由构造参数 `cascade` 控制，默认 true；这是 G5 的
//    本质代价，递归有界只靠地板 —— 地板变异用例见 tests/ai-gateway/group_orchestrator.test.ts。

import { randomUUID } from 'node:crypto'

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { GroupSessionMember } from './config'
import {
  assembleGroupHistory,
  buildGroupWindow,
  isChainRootRow,
  parseGroupMentions,
  type GroupTranscriptRow
} from './groupChat'
import {
  CHAIN_CAP_DEFAULT,
  CONSECUTIVE_FAILED_STOP,
  DUP_LOOKBACK,
  HOURLY_TOKENS_DEFAULT,
  HOURLY_TURNS_DEFAULT,
  HOURLY_USD_DEFAULT,
  HOURLY_WINDOW_MS,
  JUDGE_RUN_SHARE_DIVISOR,
  LAPPING_FACTOR,
  MIN_TURN_GAP_MS,
  PER_AGENT_RUN_CAP,
  RATE_PER_MINUTE,
  RUN_WALL_MS,
  SESSION_TURN_CAP_DEFAULT,
  isSilence,
  normalizeForDup,
  type GroupResponseMode,
  type GroupStopReason,
  type GroupTriggerKind,
  type GroupTurnOutcome
} from './groupFloors'
import { costUsdFor, type TokenUsage } from './modelCost'

// ── 契约类型 ─────────────────────────────────────────────────────────────────────

/** 群设置（group_config_json）解析后的运行时形状；缺项取 groupFloors 默认。 */
export interface GroupRunConfig {
  judgeAgentId: string | null
  chainCap: number
  hourlyTurns: number
  hourlyTokens: number
  hourlyUsd: number
  sessionTurnCap: number | null
}

/** 一次 onGroupMessage 重读到的服务端事实（lifecycle 的 resolveGroupSession 扩展形状）。 */
export interface GroupRunFacts {
  members: GroupSessionMember[]
  /** 每成员响应模式；缺行 = 'mention'。 */
  modes: Record<string, GroupResponseMode>
  config: Partial<GroupRunConfig>
  /** 本群 + 父群 + 子群（含自身）；小时预算、session_cap、停止范围都按它算。 */
  familySessionIds: number[]
}

export interface GroupTurnRow {
  sessionId: number
  runId: string
  chainId: number
  seq: number
  agentId: string
  triggerKind: GroupTriggerKind
  outcome: GroupTurnOutcome
  messageId: number | null
  model: string | null
  tokensInput: number | null
  tokensOutput: number | null
  costUsd: number | null
  windowFromId: number | null
  windowToId: number | null
  startedAt: number
  finishedAt: number | null
  error: string | null
}

export interface GroupAppendInput {
  role: 'assistant' | 'system'
  content: string
  speakerAgentId: string | null
  model?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  costUsd?: number | null
  chainId?: number | null
  /** JSON string — system rows carry {kind:'group_stop', reason, runId}. */
  metadata?: string
}

export interface GroupSpeakInput {
  sessionId: number
  agentId: string
  member: GroupSessionMember
  facts: GroupRunFacts
  messages: MailAgentUIMessage[]
  chainId: number
  runId: string
  signal: AbortSignal
}

export interface GroupSpeakResult {
  text: string
  modelId: string | null
  usage: TokenUsage | null
  protocol?: LlmProviderProtocol | null
}

/** spoke / failed turn 的 agent_run_log 镜像输入 —— 与 config.ts 的 GroupRunLogMirror 同形
 *  （lifecycle 负责组 trigger_detail / steps 的 wire 形状；status 值域无 'stopped'）。 */
export interface GroupRunLogMirror {
  agentId: string
  sessionId: number
  chainId: number
  runId: string
  status: 'completed' | 'failed'
  summary: string
  model?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  startedAtMs: number
  finishedAtMs: number
  windowFromId?: number | null
  windowToId?: number | null
  messageId?: number | null
  error?: string | null
}

export interface GroupUsage {
  turns: number
  tokens: number
  costUsd: number | null
}

export interface GroupOrchestratorDeps {
  resolveFacts: (sessionId: number) => Promise<GroupRunFacts | null> | GroupRunFacts | null
  listHistory: (sessionId: number) => GroupTranscriptRow[]
  appendMessage: (sessionId: number, input: GroupAppendInput) => number
  getSeenCursor: (sessionId: number, agentId: string) => number | null
  advanceSeenCursor: (sessionId: number, agentId: string, throughId: number) => void
  insertTurn: (row: GroupTurnRow) => number
  /** Rolling-window usage over the family (rows with started_at >= sinceMs; 0 = all). */
  groupUsage: (sessionIds: readonly number[], sinceMs: number) => GroupUsage
  /** Fail-closed: any failure resolves {groupAgents:false}. */
  resolveLabs: () => Promise<{ groupAgents: boolean }>
  /** One member turn: prepare + drain the LLM run, honouring `signal`. Throws on failure. */
  speak: (input: GroupSpeakInput) => Promise<GroupSpeakResult>
  /** ActiveRunRegistry.register / release — the per-session lease /run/active + /run/stop see. */
  registerRun: (sessionId: number, controller: AbortController) => { runId: string } | null
  releaseRun: (sessionId: number, runId: string) => void
  /** Best-effort agent_run_log mirror (spoke → completed, failed → failed). Never awaited on the
   *  hot path beyond a try/catch — a loopback failure only warns. */
  mirrorRunLog?: (input: GroupRunLogMirror) => Promise<void>
  now: () => number
  sleep: (ms: number) => Promise<void>
  warn?: (message: string, data: Record<string, unknown>) => void
}

export interface GroupOrchestratorOptions {
  deps: GroupOrchestratorDeps
  /** spoke 后是否把新行送回 onGroupMessage（G5 级联）。默认 true。 */
  cascade?: boolean
}

// ── 内部状态 ─────────────────────────────────────────────────────────────────────

interface QueueItem {
  agentId: string
  chainId: number
  triggerKind: GroupTriggerKind
  triggerMsgId: number
  facts: GroupRunFacts
}

interface RunState {
  runId: string
  sessionId: number
  chainId: number
  familySessionIds: number[]
  startedAt: number
  seq: number
  turns: Array<{ agentId: string; outcome: GroupTurnOutcome }>
  consecutiveFailed: number
  stopped: boolean
  stopReason: GroupStopReason | null
}

function runKey(sessionId: number, chainId: number): string {
  return `${sessionId}:${chainId}`
}

export function resolveGroupRunConfig(input: Partial<GroupRunConfig> | undefined): GroupRunConfig {
  return {
    judgeAgentId: input?.judgeAgentId ?? null,
    chainCap: input?.chainCap ?? CHAIN_CAP_DEFAULT,
    hourlyTurns: input?.hourlyTurns ?? HOURLY_TURNS_DEFAULT,
    hourlyTokens: input?.hourlyTokens ?? HOURLY_TOKENS_DEFAULT,
    hourlyUsd: input?.hourlyUsd ?? HOURLY_USD_DEFAULT,
    sessionTurnCap:
      input?.sessionTurnCap === undefined ? SESSION_TURN_CAP_DEFAULT : input.sessionTurnCap
  }
}

/** Author of the last user/assistant row (owner rows → null). */
function lastSpeaker(rows: readonly GroupTranscriptRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.role === 'assistant') return row.speakerAgentId
    if (row.role === 'user') return null
  }
  return null
}

/** Token bucket: RATE_PER_MINUTE member turns per minute, gateway-wide. Human appends never
 *  pass through here. After waiting it assumes the token arrived (deterministic under a fake
 *  clock that does not advance). */
class RateBucket {
  private tokens = RATE_PER_MINUTE
  private lastRefill: number
  constructor(private readonly deps: Pick<GroupOrchestratorDeps, 'now' | 'sleep'>) {
    this.lastRefill = deps.now()
  }
  async take(): Promise<void> {
    const now = this.deps.now()
    const refill = ((now - this.lastRefill) * RATE_PER_MINUTE) / 60_000
    this.tokens = Math.min(RATE_PER_MINUTE, this.tokens + Math.max(0, refill))
    this.lastRefill = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const waitMs = Math.ceil(((1 - this.tokens) * 60_000) / RATE_PER_MINUTE)
    await this.deps.sleep(waitMs)
    this.tokens = 0
    this.lastRefill = this.deps.now()
  }
}

// ── 调度器 ───────────────────────────────────────────────────────────────────────

export class GroupOrchestrator {
  private readonly deps: GroupOrchestratorDeps
  private readonly cascade: boolean
  private readonly queues = new Map<number, QueueItem[]>()
  private readonly rotation: number[] = []
  private readonly runs = new Map<string, RunState>()
  private readonly bucket: RateBucket
  private inFlight: { sessionId: number; run: RunState; controller: AbortController } | null = null
  private workerActive = false
  private idleWaiters: Array<() => void> = []

  constructor(options: GroupOrchestratorOptions) {
    this.deps = options.deps
    this.cascade = options.cascade ?? true
    this.bucket = new RateBucket(options.deps)
  }

  /** The single wake-up entry: a row just landed in `sessionId`'s transcript. Resolves once the
   *  candidates are enqueued (the worker runs detached — never await the chain here). */
  async onGroupMessage(sessionId: number, row: GroupTranscriptRow): Promise<{ queued: string[] }> {
    const facts = (await this.deps.resolveFacts(sessionId)) ?? null
    if (!facts) return { queued: [] }
    const chainId = isChainRootRow(row) ? row.id : (row.chainId as number)
    const triggerKind: GroupTriggerKind =
      row.role === 'user' ? (row.via === 'main_agent' ? 'main_agent' : 'human') : 'agent'
    const mentioned = parseGroupMentions(row.content, facts.members)
    const candidates = (
      mentioned.length
        ? mentioned
        : facts.members
            .filter((m) => (facts.modes[m.agentId] ?? 'mention') === 'realtime')
            .map((m) => m.agentId)
    ).filter((id) => id !== row.speakerAgentId)
    if (candidates.length === 0) return { queued: [] }

    const key = runKey(sessionId, chainId)
    let run = this.runs.get(key)
    if (run?.stopped) return { queued: [] }
    if (!run) {
      run = {
        runId: randomUUID(),
        sessionId,
        chainId,
        familySessionIds: [...new Set([sessionId, ...facts.familySessionIds])],
        startedAt: this.deps.now(),
        seq: 0,
        turns: [],
        consecutiveFailed: 0,
        stopped: false,
        stopReason: null
      }
      this.runs.set(key, run)
    }
    const queued: string[] = []
    for (const agentId of candidates) {
      if (
        this.enqueueCoalesced(sessionId, {
          agentId,
          chainId,
          triggerKind,
          triggerMsgId: row.id,
          facts
        })
      ) {
        queued.push(agentId)
      }
    }
    this.kick()
    return { queued }
  }

  /** Owner stop (POST /api/ai/run/stop) or a floor: clear every queue in the family, mark its runs
   *  stopped, abort the in-flight turn, write one system row per family session. Returns false
   *  when nothing involving `sessionId` was queued or running (no rows written). */
  stopFamily(sessionId: number, reason: GroupStopReason = 'owner_stop'): { stopped: boolean } {
    const family = new Set<number>([sessionId])
    const runs: RunState[] = []
    for (const run of this.runs.values()) {
      if (run.stopped || !run.familySessionIds.includes(sessionId)) continue
      runs.push(run)
      for (const sid of run.familySessionIds) family.add(sid)
    }
    for (const [sid, items] of this.queues) {
      if (sid === sessionId || items.some((i) => i.facts.familySessionIds.includes(sessionId))) {
        for (const item of items) for (const fid of item.facts.familySessionIds) family.add(fid)
        family.add(sid)
      }
    }
    const inFlightHere = this.inFlight != null && family.has(this.inFlight.sessionId)
    const hasQueued = [...family].some((sid) => (this.queues.get(sid)?.length ?? 0) > 0)
    if (runs.length === 0 && !inFlightHere && !hasQueued) return { stopped: false }
    const runId = this.inFlight && inFlightHere ? this.inFlight.run.runId : (runs[0]?.runId ?? null)
    this.stopRuns(runs, family, reason, runId)
    return { stopped: true }
  }

  /** Resolves when the worker has drained every queue (tests). */
  idle(): Promise<void> {
    if (!this.workerActive) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Queued agent ids for a session, FIFO (tests / diagnostics). */
  pendingFor(sessionId: number): string[] {
    return (this.queues.get(sessionId) ?? []).map((i) => i.agentId)
  }

  // ── 队列 ─────────────────────────────────────────────────────────────────────

  private enqueueCoalesced(sessionId: number, item: QueueItem): boolean {
    let queue = this.queues.get(sessionId)
    if (!queue) {
      queue = []
      this.queues.set(sessionId, queue)
      this.rotation.push(sessionId)
    }
    if (queue.some((q) => q.agentId === item.agentId)) return false
    queue.push(item)
    return true
  }

  /** FIFO within a session, round-robin across sessions. */
  private takeNext(): { sessionId: number; item: QueueItem } | null {
    for (let i = 0; i < this.rotation.length; i++) {
      const sessionId = this.rotation.shift()!
      this.rotation.push(sessionId)
      const queue = this.queues.get(sessionId)
      const item = queue?.shift()
      if (item) return { sessionId, item }
    }
    return null
  }

  private kick(): void {
    if (this.workerActive) return
    this.workerActive = true
    void this.workerLoop()
  }

  private async workerLoop(): Promise<void> {
    try {
      for (;;) {
        const next = this.takeNext()
        if (!next) break
        try {
          await this.processItem(next.sessionId, next.item)
          this.reapFinishedRuns()
        } catch (err) {
          this.warn('[group-run] worker item crashed', {
            sessionId: next.sessionId,
            agentId: next.item.agentId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    } finally {
      this.workerActive = false
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  // ── 单个 turn ───────────────────────────────────────────────────────────────

  private async processItem(sessionId: number, item: QueueItem): Promise<void> {
    const run = this.runs.get(runKey(sessionId, item.chainId))
    if (!run || run.stopped) return
    const deps = this.deps
    const startedAt = deps.now()
    const seq = ++run.seq
    const base = {
      sessionId,
      runId: run.runId,
      chainId: item.chainId,
      seq,
      agentId: item.agentId,
      triggerKind: item.triggerKind,
      startedAt
    }
    const record = (
      outcome: GroupTurnOutcome,
      extra: Partial<Omit<GroupTurnRow, keyof typeof base | 'outcome'>> = {}
    ): void => {
      deps.insertTurn({
        ...base,
        outcome,
        messageId: null,
        model: null,
        tokensInput: null,
        tokensOutput: null,
        costUsd: null,
        windowFromId: null,
        windowToId: null,
        finishedAt: deps.now(),
        error: null,
        ...extra
      })
      run.turns.push({ agentId: item.agentId, outcome })
      run.consecutiveFailed = outcome === 'failed' ? run.consecutiveFailed + 1 : 0
    }
    const advance = (throughId: number | null): void => {
      if (throughId != null) deps.advanceSeenCursor(sessionId, item.agentId, throughId)
    }

    const floor = await this.checkFloors(item, run)
    if (floor) {
      record('stopped', { error: floor })
      this.stopRuns(
        this.runsInFamily(run.familySessionIds),
        new Set(run.familySessionIds),
        floor,
        run.runId
      )
      return
    }

    // 反独白：上一发言者不再是候选（跳过不是停止）。
    const before = deps.listHistory(sessionId)
    if (lastSpeaker(before) === item.agentId) {
      record('skipped')
      advance(buildGroupWindow(before, item.agentId, null).maxId)
      return
    }

    await this.bucket.take()
    await deps.sleep(MIN_TURN_GAP_MS)
    if (run.stopped) {
      record('stopped', { error: run.stopReason })
      return
    }

    // 每 turn 前重读快照（新鲜度重算）→ 近期消息窗口。
    const snapshot = deps.listHistory(sessionId)
    const cursor = deps.getSeenCursor(sessionId, item.agentId)
    const window = buildGroupWindow(snapshot, item.agentId, cursor)
    const windowIds = { windowFromId: window.fromId, windowToId: window.toId }
    if (window.othersNew.length === 0 || window.rows.length === 0) {
      record('skipped', windowIds)
      advance(window.maxId)
      return
    }

    const member = item.facts.members.find((m) => m.agentId === item.agentId)
    if (!member) {
      record('failed', { error: 'E_NOT_GROUP_MEMBER', ...windowIds })
      this.maybeStopOnFailures(run)
      return
    }
    const controller = new AbortController()
    const lease = deps.registerRun(sessionId, controller)
    if (!lease) {
      record('failed', { error: 'E_RUN_ACTIVE', ...windowIds })
      this.maybeStopOnFailures(run)
      return
    }
    this.inFlight = { sessionId, run, controller }
    const titleById = new Map(item.facts.members.map((m) => [m.agentId, m.title]))
    let result: GroupSpeakResult | null = null
    let failure: string | null = null
    try {
      result = await deps.speak({
        sessionId,
        agentId: item.agentId,
        member,
        facts: item.facts,
        messages: assembleGroupHistory(window.rows, item.agentId, titleById),
        chainId: item.chainId,
        runId: run.runId,
        signal: controller.signal
      })
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    } finally {
      deps.releaseRun(sessionId, lease.runId)
      this.inFlight = null
    }

    if (controller.signal.aborted) {
      record('stopped', { error: 'owner_stop', ...windowIds })
      this.stopRuns(
        this.runsInFamily(run.familySessionIds),
        new Set(run.familySessionIds),
        'owner_stop',
        run.runId
      )
      return
    }
    const usageOf = (
      r: GroupSpeakResult | null
    ): Pick<GroupTurnRow, 'model' | 'tokensInput' | 'tokensOutput'> => ({
      model: r?.modelId ?? null,
      tokensInput: r?.usage?.inputTokens ?? null,
      tokensOutput: r?.usage?.outputTokens ?? null
    })
    if (failure != null || result == null) {
      record('failed', { error: failure ?? 'E_SPEAK_EMPTY', ...windowIds })
      await this.mirror(item, run, 'failed', '', null, window, startedAt, failure)
      this.maybeStopOnFailures(run)
      return
    }
    const costUsd = costUsdFor(result.modelId, result.usage, result.protocol)
    if (isSilence(result.text)) {
      record('silent', { ...usageOf(result), costUsd, ...windowIds })
      advance(window.maxId)
      return
    }
    const normalized = normalizeForDup(result.text)
    const othersTail = snapshot
      .filter(
        (r) => r.role === 'user' || (r.role === 'assistant' && r.speakerAgentId !== item.agentId)
      )
      .slice(-DUP_LOOKBACK)
    if (
      normalized.length > 0 &&
      othersTail.some((r) => normalizeForDup(r.content) === normalized)
    ) {
      record('held_dup', { ...usageOf(result), costUsd, ...windowIds })
      advance(window.maxId)
      return
    }
    const messageId = deps.appendMessage(sessionId, {
      role: 'assistant',
      content: result.text,
      speakerAgentId: item.agentId,
      ...usageOf(result),
      costUsd,
      chainId: item.chainId
    })
    record('spoke', { messageId, ...usageOf(result), costUsd, ...windowIds })
    advance(window.maxId)
    await this.mirror(
      item,
      run,
      'completed',
      result.text,
      messageId,
      window,
      startedAt,
      null,
      result
    )
    if (this.cascade) {
      await this.onGroupMessage(sessionId, {
        id: messageId,
        role: 'assistant',
        content: result.text,
        speakerAgentId: item.agentId,
        status: 'complete',
        chainId: item.chainId,
        via: null,
        createdAt: deps.now()
      })
    }
  }

  // ── 地板 ────────────────────────────────────────────────────────────────────

  private async checkFloors(item: QueueItem, run: RunState): Promise<GroupStopReason | null> {
    const cfg = resolveGroupRunConfig(item.facts.config)
    const counted = run.turns.filter(
      (t) => t.outcome === 'spoke' || t.outcome === 'silent' || t.outcome === 'held_dup'
    ).length
    if (counted >= cfg.chainCap) return 'chain_cap'
    const spokeTurns = run.turns.filter((t) => t.outcome === 'spoke')
    const isJudge = cfg.judgeAgentId != null && cfg.judgeAgentId === item.agentId
    const agentSpoke = spokeTurns.filter((t) => t.agentId === item.agentId).length
    const perAgentCap = isJudge
      ? Math.max(1, Math.floor(cfg.chainCap / JUDGE_RUN_SHARE_DIVISOR))
      : PER_AGENT_RUN_CAP
    if (agentSpoke >= perAgentCap) return 'per_agent_cap'
    if (cfg.judgeAgentId == null) {
      const distinct = new Set(spokeTurns.map((t) => t.agentId)).size
      if (spokeTurns.length > LAPPING_FACTOR * distinct) return 'lapping'
    }
    const now = this.deps.now()
    const hour = this.deps.groupUsage(run.familySessionIds, now - HOURLY_WINDOW_MS)
    if (hour.turns >= cfg.hourlyTurns) return 'hourly_turns'
    if (hour.tokens >= cfg.hourlyTokens) return 'hourly_tokens'
    if (hour.costUsd != null && hour.costUsd >= cfg.hourlyUsd) return 'hourly_budget'
    if (cfg.sessionTurnCap != null) {
      const total = this.deps.groupUsage(run.familySessionIds, 0)
      if (total.turns >= cfg.sessionTurnCap) return 'session_cap'
    }
    if (now - run.startedAt >= RUN_WALL_MS) return 'wall'
    if (!(await this.deps.resolveLabs()).groupAgents) return 'labs_off'
    return null
  }

  private maybeStopOnFailures(run: RunState): void {
    if (run.consecutiveFailed < CONSECUTIVE_FAILED_STOP) return
    this.stopRuns(
      this.runsInFamily(run.familySessionIds),
      new Set(run.familySessionIds),
      'error',
      run.runId
    )
  }

  // ── 停止 ────────────────────────────────────────────────────────────────────

  private runsInFamily(familySessionIds: readonly number[]): RunState[] {
    return [...this.runs.values()].filter(
      (r) => !r.stopped && r.familySessionIds.some((sid) => familySessionIds.includes(sid))
    )
  }

  /** A run whose chain has nothing queued and nothing in flight is over: drop its state so a
   *  later stopFamily has nothing to stop and a stale chain id never resumes its counters. */
  private reapFinishedRuns(): void {
    for (const [key, run] of this.runs) {
      if (this.inFlight?.run === run) continue
      const queued = this.queues.get(run.sessionId)?.some((i) => i.chainId === run.chainId)
      if (!queued) this.runs.delete(key)
    }
  }

  private stopRuns(
    runs: RunState[],
    family: Set<number>,
    reason: GroupStopReason,
    runId: string | null
  ): void {
    const live = runs.filter((r) => !r.stopped)
    const inFlightLive =
      this.inFlight != null && family.has(this.inFlight.sessionId) && !this.inFlight.run.stopped
    // Idempotent: a second stop for an already-stopped family (owner stop → the aborted turn's own
    // stop call) writes nothing.
    if (live.length === 0 && !inFlightLive) return
    for (const run of live) {
      run.stopped = true
      run.stopReason = reason
      this.runs.delete(runKey(run.sessionId, run.chainId))
    }
    for (const sid of family) this.queues.get(sid)?.splice(0)
    if (this.inFlight && family.has(this.inFlight.sessionId)) {
      this.inFlight.run.stopped = true
      this.inFlight.run.stopReason = reason
      try {
        this.inFlight.controller.abort('E_RUN_STOPPED')
      } catch {
        /* already settled */
      }
    }
    const usage = runId
      ? this.deps.groupUsage([...family], this.deps.now() - HOURLY_WINDOW_MS)
      : null
    this.warn('[group-run] floor', {
      sessionIds: [...family],
      runId,
      reason,
      turns: usage?.turns ?? null,
      tokens: usage?.tokens ?? null
    })
    for (const sid of family) {
      this.deps.appendMessage(sid, {
        role: 'system',
        content: reason,
        speakerAgentId: null,
        metadata: JSON.stringify({ kind: 'group_stop', reason, runId })
      })
    }
  }

  // ── 镜像 / 日志 ─────────────────────────────────────────────────────────────

  private async mirror(
    item: QueueItem,
    run: RunState,
    status: 'completed' | 'failed',
    text: string,
    messageId: number | null,
    window: { fromId: number | null; toId: number | null },
    startedAt: number,
    error: string | null,
    result?: GroupSpeakResult
  ): Promise<void> {
    if (!this.deps.mirrorRunLog) return
    try {
      await this.deps.mirrorRunLog({
        agentId: item.agentId,
        sessionId: run.sessionId,
        chainId: item.chainId,
        runId: run.runId,
        status,
        summary: text.slice(0, 80),
        model: result?.modelId ?? null,
        tokensInput: result?.usage?.inputTokens ?? null,
        tokensOutput: result?.usage?.outputTokens ?? null,
        startedAtMs: startedAt,
        finishedAtMs: this.deps.now(),
        windowFromId: window.fromId,
        windowToId: window.toId,
        messageId,
        error
      })
    } catch (err) {
      this.warn('[group-run] run_log mirror failed', {
        sessionId: run.sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private warn(message: string, data: Record<string, unknown>): void {
    if (this.deps.warn) this.deps.warn(message, data)
    else console.warn(message, data)
  }
}
