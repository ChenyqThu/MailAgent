// L4 群聊 g1 — 服务端群 run 调度器（每群一条队列、全 gateway 单 worker 串行）。
//
// 任何一条落进群 transcript 的消息（owner / 主 agent 投递 / 成员回复）都经唯一入口
// `onGroupMessage` 进来：候选集只由服务端事实决定（@ 优先 → realtime 成员；self 不唤醒 self；
// 零 realtime 且无 @ → 无人），同 (session, agent) 在队即折叠；worker 每个 turn 依次过
// 成员资格复核（取出时重读事实，被踢 → skipped）→ 确定性地板（groupFloors 单源，本文件零裸数字）
// → 反独白 → 令牌桶 + 最小间隔 → 重读快照 → 近期消息窗口（无他人新消息 → skipped）→ 租约
// （与 /api/ai/chat 同锁，/run/active 可见）→ speak → 六种 outcome 各写一行 ai_chat_group_turn 台账：
//   spoke     落消息行（带 token / cost / chain_id）+ 推进游标 + best-effort 镜像 run_log + 级联
//   silent    不落消息行，推进游标（沉默只省发言不省 token）
//   held_dup  逐字重复，不落行，推进游标
//   skipped   反独白 / 无他人新消息 / 成员已被移出，推进游标（error 列 = GROUP_SKIP_REASONS）
//   failed    不落行，游标不动；同一 run 连续 CONSECUTIVE_FAILED_STOP 次 → stop('error')
//   stopped   地板命中 / owner 停止，游标不动；按 family 清队列 + 各群写 system 行
//
// 每个节点经 `deps.emitEvent`（groupTurnEvent.ts 单一定义）投影给 renderer：事件是服务端事实的
// 投影，best-effort（emit 抛错只 warn，台账照常）。
//
// 🔴 deps 全部经 GroupOrchestratorDeps 注入（history / append / cursor / turn / usage / labs /
//    speak / lease / now / sleep / emit），本文件不 import config.ts、不 import lifecycle —— 单测用
//    假 deps 即可跑完整条链；生产接线见 server.ts / ai_gateway_lifecycle.ts。
// 🔴 级联（spoke 后 onGroupMessage(newRow)）由构造参数 `cascade` 控制，默认 true；这是 G5 的
//    本质代价，递归有界只靠地板 —— 地板变异用例见 tests/ai-gateway/group_orchestrator.test.ts。
// 🔴 g2 跨群投递（主 agent / 法官经 cfg.deliverGroupMessage 进来）：目标群的 scope 由工具工厂
//    闭包强制（tools/groups.ts），本处对 sessionId **不做第二次校验**；父群 stopFamily 连带清掉
//    子群的链与队列是拍板 E 的既定语义（子群 run 的 familySessionIds 含父群）—— g3 夜晚流程须知情。
// 🔴 g3 game_over 不是停止：不写 group_stop、不进 GROUP_STOP_REASONS；靠 gameOver 集合按 sessionId
//    拦（family 全体），主群一条 {kind:'game_over'} 系统行是唯一落盘痕迹（maybeGameOver）。

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
  GAME_OVER_PREFIX,
  HOURLY_TOKENS_DEFAULT,
  HOURLY_TURNS_DEFAULT,
  HOURLY_USD_DEFAULT,
  HOURLY_WINDOW_MS,
  JUDGE_RUN_SHARE_DIVISOR,
  LAPPING_FACTOR,
  MAIN_AGENT_MEMBER_ID,
  MIN_TURN_GAP_MS,
  PER_AGENT_RUN_CAP,
  RATE_PER_MINUTE,
  RUN_WALL_MS,
  SESSION_TURN_CAP_DEFAULT,
  WEREWOLF_CHAIN_CAP,
  WEREWOLF_HOURLY_TOKENS,
  WEREWOLF_HOURLY_TURNS,
  WEREWOLF_HOURLY_USD,
  WEREWOLF_SESSION_TURN_CAP,
  isSilence,
  normalizeForDup,
  type GroupResponseMode,
  type GroupStopReason,
  type GroupTriggerKind,
  type GroupTurnOutcome
} from './groupFloors'
import type { WerewolfGame } from './groupGame'
import type { GroupSkipReason, GroupTurnEvent, GroupTurnUsage } from './groupTurnEvent'
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
  /** GroupConfig 的宽形状：地板键之外（topic / modelOverride / notify）由 speak 适配器读；
   *  preset / game（g3）由 resolveGroupRunConfig 的缺省与 game_over 判据读。 */
  config: Partial<GroupRunConfig> & {
    topic?: string | null
    modelOverride?: string | null
    preset?: 'werewolf' | null
    game?: WerewolfGame
  }
  /** 本群 + 父群 + 子群（含自身）；小时预算、session_cap、停止范围都按它算。 */
  familySessionIds: number[]
  /** g3 — 父群 id（子群才非空）。game_over 系统行只写 family 的根：有父 → 父群，无父 → 本群。 */
  parentSessionId?: number | null
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
  /** 流式累计正文回调（server.ts 节流后调用）；省略 → 只在 spoke 事件里带全文。 */
  onDelta?: (accumulated: string) => void
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
  /** Best-effort turn lifecycle projection (renderer 在场态)。抛错只 warn，台账照常。 */
  emitEvent?: (event: GroupTurnEvent) => void
  /** g3 — best-effort 把一个 session 的 sessionTurnCap 钉到当前值（重启后一局不复活）。失败只 warn。 */
  setSessionTurnCap?: (sessionId: number, cap: number) => Promise<void> | void
  now: () => number
  sleep: (ms: number) => Promise<void>
  warn?: (message: string, data: Record<string, unknown>) => void
}

export interface GroupOrchestratorOptions {
  deps: GroupOrchestratorDeps
  /** spoke 后是否把新行送回 onGroupMessage（G5 级联）。默认 true。 */
  cascade?: boolean
}

/** 群此刻的在场三元组（/run/active 在 registry 无租约时据此仍答 200）。 */
export interface GroupLiveState {
  inFlight: string | null
  preparing: string | null
  queued: string[]
}

export type GroupRequeueError = 'E_NOT_GROUP' | 'E_NOT_GROUP_MEMBER' | 'E_RUN_STOPPED'

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
  /** 最近一次读到的群设置（事件 chainProgress.cap 的口径；每 turn 随事实刷新）。 */
  config: GroupRunFacts['config']
}

/** 已被地板 / owner 停掉的链（runKey）—— requeue 不许复活它们。stopRuns 立刻 runs.delete，
 *  所以不能靠 run.stopped 判；有界 FIFO 防无界增长。 */
const STOPPED_CHAINS_CAP = 512

/** emit() 的调用方只填事件本体；v / ts / queued / chainProgress 由 emit 统一补。 */
interface GroupEmitPartial {
  phase: GroupTurnEvent['phase']
  chainId: number
  runId?: string | null
  seq?: number | null
  agentId?: string | null
  text?: string
  messageId?: number
  reason?: string
  error?: string
  usage?: GroupTurnUsage
}

function runKey(sessionId: number, chainId: number): string {
  return `${sessionId}:${chainId}`
}

export function resolveGroupRunConfig(input: GroupRunFacts['config'] | undefined): GroupRunConfig {
  const preset = input?.preset === 'werewolf'
  return {
    judgeAgentId: input?.judgeAgentId ?? null,
    chainCap: input?.chainCap ?? (preset ? WEREWOLF_CHAIN_CAP : CHAIN_CAP_DEFAULT),
    hourlyTurns: input?.hourlyTurns ?? (preset ? WEREWOLF_HOURLY_TURNS : HOURLY_TURNS_DEFAULT),
    hourlyTokens: input?.hourlyTokens ?? (preset ? WEREWOLF_HOURLY_TOKENS : HOURLY_TOKENS_DEFAULT),
    hourlyUsd: input?.hourlyUsd ?? (preset ? WEREWOLF_HOURLY_USD : HOURLY_USD_DEFAULT),
    sessionTurnCap:
      input?.sessionTurnCap === undefined
        ? preset
          ? WEREWOLF_SESSION_TURN_CAP
          : SESSION_TURN_CAP_DEFAULT
        : input.sessionTurnCap
  }
}

/** 链上已计数的唤醒数（与 checkFloors 的 chain_cap 口径一致）。 */
function countedTurns(run: RunState): number {
  return run.turns.filter(
    (t) => t.outcome === 'spoke' || t.outcome === 'silent' || t.outcome === 'held_dup'
  ).length
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
  private readonly stoppedChains = new Set<string>()
  /** g3 — 已终局的 session（family 全体）：onGroupMessage 对它们零候选、零 turn。 */
  private readonly gameOver = new Set<number>()
  private readonly bucket: RateBucket
  private inFlight: {
    sessionId: number
    agentId: string
    run: RunState
    controller: AbortController
  } | null = null
  /** 已出队、租约未拿（复核 / 地板 / 令牌桶 / 最小间隔）的那一段：探针靠它不 404。 */
  private preparing: { sessionId: number; agentId: string } | null = null
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
    if (this.gameOver.has(sessionId)) return { queued: [] }
    const chainId = isChainRootRow(row) ? row.id : (row.chainId as number)
    // g2 — 法官跨群投递行（role assistant + metadata.via='judge_post'，chainId NULL = 链根）
    // 是第四种触发；不带 via 的 assistant 行仍是成员级联（'agent'）。
    const triggerKind: GroupTriggerKind =
      row.role === 'user'
        ? row.via === 'main_agent'
          ? 'main_agent'
          : 'human'
        : row.via === 'judge_post'
          ? 'judge_post'
          : 'agent'
    // no_candidates 只对人类 / 主 agent / 法官投递触发发：成员级联末尾候选为空是链正常结束，
    // 而法官投出去却没人醒是要能看见的事。
    const announceEmpty =
      triggerKind === 'human' || triggerKind === 'main_agent' || triggerKind === 'judge_post'
    const key = runKey(sessionId, chainId)
    // g3 — 法官从子群 group_post 回投的终局行不经 processItem，判据在这里跑一次。run 此时可能
    // 尚不存在：临时 newRun 只为拿 runId / family，不放进 this.runs。
    if (
      triggerKind === 'judge_post' &&
      this.maybeGameOver(
        sessionId,
        row.speakerAgentId,
        row.content,
        facts,
        this.runs.get(key) ?? this.newRun(sessionId, chainId, facts)
      )
    ) {
      return { queued: [] }
    }
    const mentioned = parseGroupMentions(row.content, facts.members)
    const realtime = facts.members
      .filter((m) => (facts.modes[m.agentId] ?? 'mention') === 'realtime')
      .map((m) => m.agentId)
    // T4 (design M5) — 主 agent 从单聊投递的行 speakerAgentId 是 null（via='main_agent'），上面的
    // 自排除对它失效：主 agent 若也是本群成员，会被自己的投递唤醒（自问自答 + 计入链根配额）。
    // 工具侧已拒（E_GROUP_SELF_MEMBER）；这里是对历史行与旁路投递的结构兜底。
    const candidates = (mentioned.length ? mentioned : realtime).filter(
      (id) =>
        id !== row.speakerAgentId && !(triggerKind === 'main_agent' && id === MAIN_AGENT_MEMBER_ID)
    )
    let run = this.runs.get(key)
    if (candidates.length === 0) {
      if (announceEmpty) {
        this.emit(sessionId, run ?? null, facts.config, {
          phase: 'no_candidates',
          chainId,
          reason:
            mentioned.length === 0 && realtime.length === 0 ? 'no_realtime_members' : 'self_only'
        })
      }
      return { queued: [] }
    }
    if (run?.stopped) {
      if (announceEmpty) {
        this.emit(sessionId, run, facts.config, {
          phase: 'no_candidates',
          chainId,
          reason: 'run_stopped'
        })
      }
      return { queued: [] }
    }
    if (!run) {
      run = this.newRun(sessionId, chainId, facts)
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
    // 先发再 kick：kick 同步跑到 worker 的第一个 await，takeNext 已把首项出队。
    this.emit(sessionId, run, facts.config, { phase: 'queued', chainId })
    this.kick()
    return { queued }
  }

  /** Owner retry of a failed turn (POST /api/ai/group-chat {retry}). Re-enqueues `agentId` on the
   *  chain; a chain stopped by a floor / the owner is never revived (E_RUN_STOPPED — reviving it
   *  would hand the same chain another chainCap budget per click). A chain whose run was reaped
   *  after finishing normally gets a fresh run under the same chainId (counters from zero: the
   *  owner's manual action is a human-attention reset, like a new human message opening a chain). */
  async requeue(
    sessionId: number,
    agentId: string,
    chainId: number
  ): Promise<{ queued: boolean; error?: GroupRequeueError }> {
    const facts = (await this.deps.resolveFacts(sessionId)) ?? null
    if (!facts) return { queued: false, error: 'E_NOT_GROUP' }
    if (!facts.members.some((m) => m.agentId === agentId)) {
      return { queued: false, error: 'E_NOT_GROUP_MEMBER' }
    }
    const key = runKey(sessionId, chainId)
    if (this.stoppedChains.has(key)) return { queued: false, error: 'E_RUN_STOPPED' }
    let run = this.runs.get(key)
    if (!run) {
      run = this.newRun(sessionId, chainId, facts)
      this.runs.set(key, run)
    }
    const queued = this.enqueueCoalesced(sessionId, {
      agentId,
      chainId,
      triggerKind: 'human',
      triggerMsgId: chainId,
      facts
    })
    this.emit(sessionId, run, facts.config, { phase: 'queued', chainId })
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

  /** 在场三元组：在写者 / 准备中（已出队未拿租约）/ 队列。三者都空 = 群里没在跑。 */
  liveState(sessionId: number): GroupLiveState {
    return {
      inFlight: this.inFlight?.sessionId === sessionId ? this.inFlight.agentId : null,
      preparing: this.preparing?.sessionId === sessionId ? this.preparing.agentId : null,
      queued: this.pendingFor(sessionId)
    }
  }

  // ── 队列 ─────────────────────────────────────────────────────────────────────

  private newRun(sessionId: number, chainId: number, facts: GroupRunFacts): RunState {
    return {
      runId: randomUUID(),
      sessionId,
      chainId,
      familySessionIds: [...new Set([sessionId, ...facts.familySessionIds])],
      startedAt: this.deps.now(),
      seq: 0,
      turns: [],
      consecutiveFailed: 0,
      stopped: false,
      stopReason: null,
      config: facts.config
    }
  }

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
        this.preparing = { sessionId: next.sessionId, agentId: next.item.agentId }
        try {
          await this.processItem(next.sessionId, next.item)
          this.reapFinishedRuns()
        } catch (err) {
          this.warn('[group-run] worker item crashed', {
            sessionId: next.sessionId,
            agentId: next.item.agentId,
            error: err instanceof Error ? err.message : String(err)
          })
        } finally {
          this.preparing = null
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
    const emitTurn = (partial: Omit<GroupEmitPartial, 'chainId' | 'seq' | 'agentId'>): void => {
      this.emit(sessionId, run, item.facts.config, {
        ...partial,
        chainId: item.chainId,
        seq,
        agentId: item.agentId
      })
    }
    // 三处 skipped 都把同一个词写进 error 列：事件 reason 与行 error 同源，刷新后靠它还原文案。
    const skip = (
      reason: GroupSkipReason,
      extra: Partial<Omit<GroupTurnRow, keyof typeof base | 'outcome'>> = {}
    ): void => {
      record('skipped', { error: reason, ...extra })
      emitTurn({ phase: 'skipped', reason })
    }
    const fail = (
      error: string,
      extra: Partial<Omit<GroupTurnRow, keyof typeof base | 'outcome'>> = {}
    ): void => {
      record('failed', { error, ...extra })
      emitTurn({ phase: 'failed', error })
    }
    // 游标只为仍在名单里的成员写（写前再读一次事实）：缩小「speak 期间被踢 → INSERT OR IGNORE
    // 重建行」的窗口（归零靠 serve-api add 时 DELETE）。
    const advance = async (throughId: number | null): Promise<void> => {
      if (throughId == null) return
      const latest = (await deps.resolveFacts(sessionId)) ?? null
      if (!latest || !latest.members.some((m) => m.agentId === item.agentId)) return
      deps.advanceSeenCursor(sessionId, item.agentId, throughId)
    }

    // 成员资格复核：取出时重读事实（owner 在排队期间可能踢人 / 改模式 / 改模型），刷新给本 turn。
    const fresh = (await deps.resolveFacts(sessionId)) ?? null
    if (!fresh || !fresh.members.some((m) => m.agentId === item.agentId)) {
      skip('removed')
      return
    }
    item.facts = fresh
    run.config = fresh.config

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
      skip('monologue')
      await advance(buildGroupWindow(before, item.agentId, null).maxId)
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
      skip('no_new_messages', windowIds)
      await advance(window.maxId)
      return
    }

    const member = item.facts.members.find((m) => m.agentId === item.agentId)
    if (!member) {
      fail('E_NOT_GROUP_MEMBER', windowIds)
      this.maybeStopOnFailures(run)
      return
    }
    const controller = new AbortController()
    const lease = deps.registerRun(sessionId, controller)
    if (!lease) {
      fail('E_RUN_ACTIVE', windowIds)
      this.maybeStopOnFailures(run)
      return
    }
    this.inFlight = { sessionId, agentId: item.agentId, run, controller }
    const titleById = new Map(item.facts.members.map((m) => [m.agentId, m.title]))
    let result: GroupSpeakResult | null = null
    let failure: string | null = null
    emitTurn({ phase: 'start' })
    try {
      result = await deps.speak({
        sessionId,
        agentId: item.agentId,
        member,
        facts: item.facts,
        messages: assembleGroupHistory(window.rows, item.agentId, titleById),
        chainId: item.chainId,
        runId: run.runId,
        signal: controller.signal,
        onDelta: (accumulated) => emitTurn({ phase: 'delta', text: accumulated })
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
      fail(failure ?? 'E_SPEAK_EMPTY', windowIds)
      await this.mirror(item, run, 'failed', '', null, window, startedAt, failure)
      this.maybeStopOnFailures(run)
      return
    }
    const costUsd = costUsdFor(result.modelId, result.usage, result.protocol)
    const usage: GroupTurnUsage = { ...usageOf(result), costUsd }
    if (isSilence(result.text)) {
      record('silent', { ...usageOf(result), costUsd, ...windowIds })
      emitTurn({ phase: 'silent', usage })
      await advance(window.maxId)
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
      emitTurn({ phase: 'held_dup', usage })
      await advance(window.maxId)
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
    emitTurn({ phase: 'spoke', messageId, text: result.text, usage })
    await advance(window.maxId)
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
    if (this.maybeGameOver(sessionId, item.agentId, result.text, item.facts, run)) return
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
    if (countedTurns(run) >= cfg.chainCap) return 'chain_cap'
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

  private markChainStopped(run: RunState): void {
    if (this.stoppedChains.size >= STOPPED_CHAINS_CAP) {
      const oldest = this.stoppedChains.values().next().value
      if (oldest !== undefined) this.stoppedChains.delete(oldest)
    }
    this.stoppedChains.add(runKey(run.sessionId, run.chainId))
  }

  /** g3 — 法官在 werewolf 预设群里以 GAME_OVER_PREFIX 开头发言 = 一局终局。不是停止：不写
   *  group_stop、不进 GROUP_STOP_REASONS；只写一条 game_over 系统行到主群（family 的根），
   *  family 每个 session 进 gameOver 集合 + 清队列，之后的唤醒在 onGroupMessage 顶部静默。
   *  `setSessionTurnCap` 回写是重启兜底（进程内集合不落盘），best-effort 只 warn。
   *  返回 true = 命中，调用方跳过级联。 */
  private maybeGameOver(
    sessionId: number,
    speakerAgentId: string | null,
    content: string,
    facts: GroupRunFacts,
    run: RunState
  ): boolean {
    if (facts.config.preset !== 'werewolf') return false
    if (speakerAgentId == null || speakerAgentId !== facts.config.judgeAgentId) return false
    if (!content.trimStart().startsWith(GAME_OVER_PREFIX)) return false
    const mainSessionId = facts.parentSessionId ?? sessionId
    this.deps.appendMessage(mainSessionId, {
      role: 'system',
      content: '',
      speakerAgentId: null,
      metadata: JSON.stringify({ kind: 'game_over', runId: run.runId, chainId: run.chainId })
    })
    for (const sid of run.familySessionIds) {
      this.gameOver.add(sid)
      this.queues.get(sid)?.splice(0)
    }
    this.markChainStopped(run)
    const cap = this.deps.groupUsage(run.familySessionIds, 0).turns
    const pin = async (sid: number): Promise<void> => {
      await this.deps.setSessionTurnCap?.(sid, cap)
    }
    for (const sid of run.familySessionIds) {
      void pin(sid).catch((err: unknown) => {
        this.warn('[group-run] setSessionTurnCap failed (game_over landed)', {
          sessionId: sid,
          cap,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }
    return true
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
      this.markChainStopped(run)
    }
    for (const sid of family) this.queues.get(sid)?.splice(0)
    if (this.inFlight && family.has(this.inFlight.sessionId)) {
      this.inFlight.run.stopped = true
      this.inFlight.run.stopReason = reason
      this.markChainStopped(this.inFlight.run)
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
    const primary =
      live.find((r) => r.runId === runId) ??
      (this.inFlight && family.has(this.inFlight.sessionId) ? this.inFlight.run : null) ??
      live[0]!
    for (const sid of family) {
      this.deps.appendMessage(sid, {
        role: 'system',
        content: reason,
        speakerAgentId: null,
        metadata: JSON.stringify({ kind: 'group_stop', reason, runId })
      })
      // 与 system 行一一对应：processItem 内的三处 record('stopped') 都紧接本函数，不单独发。
      this.emit(sid, primary, primary.config, {
        phase: 'stopped',
        chainId: primary.chainId,
        runId,
        reason
      })
    }
  }

  // ── 事件 / 镜像 / 日志 ──────────────────────────────────────────────────────

  /** 统一补 v / ts / queued / chainProgress。best-effort：emitEvent 抛错只 warn。 */
  private emit(
    sessionId: number,
    run: RunState | null,
    config: GroupRunFacts['config'] | undefined,
    partial: GroupEmitPartial
  ): void {
    const emitEvent = this.deps.emitEvent
    if (!emitEvent) return
    const event: GroupTurnEvent = {
      v: 1,
      sessionId,
      runId: partial.runId !== undefined ? partial.runId : (run?.runId ?? null),
      chainId: partial.chainId,
      seq: partial.seq ?? null,
      agentId: partial.agentId ?? null,
      phase: partial.phase,
      ts: this.deps.now(),
      queued: this.pendingFor(sessionId),
      chainProgress: {
        counted: run ? countedTurns(run) : 0,
        cap: resolveGroupRunConfig(config).chainCap
      },
      ...(partial.text !== undefined ? { text: partial.text } : {}),
      ...(partial.messageId !== undefined ? { messageId: partial.messageId } : {}),
      ...(partial.reason !== undefined ? { reason: partial.reason } : {}),
      ...(partial.error !== undefined ? { error: partial.error } : {}),
      ...(partial.usage !== undefined ? { usage: partial.usage } : {})
    }
    try {
      emitEvent(event)
    } catch (err) {
      this.warn('[group-run] emitEvent failed (turn ledger unaffected)', {
        sessionId,
        phase: partial.phase,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

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
