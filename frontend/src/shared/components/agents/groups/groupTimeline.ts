// L4 群聊 UX 批 — 群消息流的时间线合并（纯函数，design §3 七条规则）。
//
// 三个来源按时间合并：① 落库消息（user / assistant / `group_stop` 系统行）；② 非 spoke 的 turn
// 台账行（沉默 / 重复折叠 / 跳过 / 失败 / 停止 → 淡色 meta 行，不占气泡）；③ 事件 overlay
// （只做实时叠加：落库行到达后同 messageId / 同 turnKey 的 overlay 项让位）。
//
// 🔴 红线 1：没有事件且没有 turn 行时不显示任何在场态。唯一白名单 = 规则 6 的 no_candidates
//    台账推导，判据全部来自落库行（链根 user 行零 turn 行、且已被后续消息闭合），不是猜。
// 🔴 规则 7：turn 行只在 turnsQ 覆盖到的区间内参与合并（since = 最早消息、hasMore 时以最旧一条已
//    加载 turn 为界），界外只渲染消息、不做推导。

import type { ChatMessage } from '@shared/api/types'
import type { GroupTurnWire } from '@shared/api/groupSettings'
import type { GroupThreadSummary } from '@shared/chat_model'

import {
  GROUP_SKIP_REASONS,
  type GroupTurnPhase,
  type GroupTurnUsage
} from '../../../../ai-gateway/groupTurnEvent'
import { dayStart } from './groupPresentation'

/** 同人连发折叠窗（Slack 惯例；design Q2 默认 3 min）。 */
export const GROUP_FOLD_WINDOW_MS = 3 * 60_000

/** overlay 里一条 turn 级事件的留痕（reducer 写、时间线读）。 */
export interface GroupLiveTurn {
  turnKey: string
  phase: GroupTurnPhase
  agentId: string | null
  runId: string | null
  chainId: number
  seq: number | null
  ts: number
  text?: string
  messageId?: number
  reason?: string
  error?: string
  usage?: GroupTurnUsage
}

export interface GroupLiveInFlight {
  agentId: string
  text: string
  runId: string | null
  seq: number | null
  chainId: number | null
  startedAt: number
}

/** reducer 状态里时间线要读的那部分。 */
export interface GroupLiveSnapshot {
  inFlight: GroupLiveInFlight | null
  preparing: string | null
  queued: string[]
  overlay: ReadonlyMap<string, GroupLiveTurn>
  stoppedByRun: ReadonlySet<string>
}

/** renderer 本地气泡（labs off 的 v1 循环 + 两条路径共用的「发送中的用户消息」）。 */
export interface GroupLocalBubble {
  key: string
  kind: 'user' | 'speaker'
  agentId?: string
  text: string
  status: 'streaming' | 'done' | 'failed'
  error?: string
  ts: number
}

export interface GroupTimelineInput {
  messages: readonly ChatMessage[]
  /** null = 台账未加载（labs off / 请求中）→ 不出 meta 行、不做推导。 */
  turns: readonly GroupTurnWire[] | null
  turnsHasMore: boolean
  live: GroupLiveSnapshot | null
  local: readonly GroupLocalBubble[]
  /** T3 — 本群的话题清单（顶层群的主时间线传；话题面自己的时间线与子群不传）。命中根消息
   *  → 紧随那条消息之后插一张 `threadCard`。话题内的回复**不在**这里：它们落在另一条会话。 */
  threads?: readonly GroupThreadSummary[]
}

export type GroupSpeaker = { type: 'user' } | { type: 'member'; agentId: string }

export interface GroupTimelineMessage {
  key: string
  id: number | null
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  streaming: boolean
  failed: boolean
  error?: string
  usage: GroupTurnUsage | null
}

export type GroupMetaVariant =
  | 'silent'
  | 'held_dup'
  | 'skipped_monologue'
  | 'skipped_no_new_messages'
  | 'skipped_removed'
  | 'skipped'
  | 'failed'

export type GroupTimelineItem =
  | { kind: 'date'; key: string; dayStart: number }
  | {
      kind: 'group'
      key: string
      speaker: GroupSpeaker
      startedAt: number
      messages: GroupTimelineMessage[]
    }
  | {
      kind: 'meta'
      key: string
      ts: number
      agentId: string
      variant: GroupMetaVariant
      error: string | null
      runId: string | null
      chainId: number
      seq: number | null
      usage: GroupTurnUsage | null
      /** failed 专用：该链已被地板 / owner 停掉 → 重试钮禁用（retryStopped）。 */
      retryDisabled: boolean
    }
  | { kind: 'noCandidates'; key: string; ts: number; reason: string | null }
  | { kind: 'stopped'; key: string; ts: number; reason: string; runId: string | null }
  | { kind: 'turnsBoundary'; key: string; ts: number }
  /** T3 — 挂在根消息正下方的话题卡（回复数 / 最新一条 / 未读）。它打断折叠组：同人在根消息之后
   *  再发的消息另起一组，卡才能「紧随根消息」而不是沉到整组末尾。 */
  | {
      kind: 'threadCard'
      key: string
      ts: number
      thread: GroupThreadSummary
      /** 根消息的说话人：卡跟着根消息的对齐方向（user 根右对齐、成员根缩进到气泡列）。 */
      speaker: GroupSpeaker
    }

export interface GroupTimelineTail {
  /** 在写者；`text` 为空时由在场行显示「正在输入…」，非空时已作为流式气泡进 items。 */
  inFlight: { agentId: string; text: string; startedAt: number } | null
  preparing: string | null
  queued: string[]
}

/** 群停止系统行的原因词（`metadata={kind:'group_stop', reason, runId}`）。
 *  🔴 只放行 `kind==='group_stop'`：其他 system 行不属于群 transcript，宁可不渲染也不猜它是什么。 */
export function groupStopMeta(
  message: ChatMessage
): { reason: string; runId: string | null } | null {
  if (message.role !== 'system' || message.metadata == null) return null
  try {
    const parsed = JSON.parse(message.metadata) as {
      kind?: unknown
      reason?: unknown
      runId?: unknown
    }
    if (parsed.kind !== 'group_stop') return null
    return {
      reason:
        typeof parsed.reason === 'string' && parsed.reason.length > 0 ? parsed.reason : 'error',
      runId: typeof parsed.runId === 'string' ? parsed.runId : null
    }
  } catch {
    return null
  }
}

/** turn 行 / 事件 → meta 文案变体：`outcome` + `error`（skipped 的三个原因词 = GROUP_SKIP_REASONS，
 *  NULL / 未知词 → 泛化 `skipped`）。spoke / stopped 不成 meta 项 → null。 */
export function metaVariantOf(
  outcome: string,
  error: string | null | undefined
): GroupMetaVariant | null {
  switch (outcome) {
    case 'silent':
      return 'silent'
    case 'held_dup':
      return 'held_dup'
    case 'failed':
      return 'failed'
    case 'skipped':
      return error != null && (GROUP_SKIP_REASONS as readonly string[]).includes(error)
        ? (`skipped_${error}` as GroupMetaVariant)
        : 'skipped'
    default:
      return null
  }
}

export function turnKeyOf(runId: string | null, seq: number | null): string {
  return `${runId ?? '-'}:${seq ?? '-'}`
}

function isChainRoot(m: ChatMessage): boolean {
  return m.role === 'user' && (m.chain_id == null || m.chain_id === m.id)
}

type Entry =
  | { ts: number; rank: number; msg: GroupTimelineMessage; speaker: GroupSpeaker }
  | {
      ts: number
      rank: number
      item: GroupTimelineItem
    }

function speakerKey(s: GroupSpeaker): string {
  return s.type === 'user' ? 'user' : `m:${s.agentId}`
}

function usageOfMessage(m: ChatMessage): GroupTurnUsage | null {
  if (m.model == null && m.tokens_input == null && m.tokens_output == null && m.cost_usd == null) {
    return null
  }
  return {
    model: m.model,
    tokensInput: m.tokens_input,
    tokensOutput: m.tokens_output,
    costUsd: m.cost_usd
  }
}

export function buildGroupTimeline(input: GroupTimelineInput): {
  items: GroupTimelineItem[]
  tail: GroupTimelineTail
} {
  const { messages, turns, turnsHasMore, live, local, threads } = input
  const threadByRoot = new Map<number, GroupThreadSummary>()
  for (const th of threads ?? []) threadByRoot.set(th.rootMessageId, th)
  const rows = messages.filter((m) => m.status === 'complete')
  const chatRows = rows.filter((m) => m.role === 'user' || m.role === 'assistant')
  const earliest = chatRows.reduce<number | null>(
    (acc, m) => (acc == null || m.created_at < acc ? m.created_at : acc),
    null
  )
  const messageIds = new Set(chatRows.map((m) => m.id))
  const stopRunIds = new Set<string>()
  const entries: Entry[] = []

  // ① 落库消息 + group_stop 系统行。
  for (const m of rows) {
    if (m.role === 'user' || m.role === 'assistant') {
      const speaker: GroupSpeaker =
        m.role === 'user'
          ? { type: 'user' }
          : { type: 'member', agentId: m.speaker_agent_id ?? 'assistant' }
      entries.push({
        ts: m.created_at,
        rank: 0,
        speaker,
        msg: {
          key: `m:${m.id}`,
          id: m.id,
          role: m.role,
          text: m.content,
          createdAt: m.created_at,
          streaming: false,
          failed: false,
          usage: m.role === 'assistant' ? usageOfMessage(m) : null
        }
      })
      continue
    }
    const stop = groupStopMeta(m)
    if (stop == null) continue
    if (stop.runId != null) stopRunIds.add(stop.runId)
    entries.push({
      ts: m.created_at,
      rank: 1,
      item: {
        kind: 'stopped',
        key: `s:${m.id}`,
        ts: m.created_at,
        reason: stop.reason,
        runId: stop.runId
      }
    })
  }

  // 规则 7：覆盖边界。
  const oldestTurnStartedAt =
    turns != null && turns.length > 0 ? Math.min(...turns.map((t) => t.startedAt)) : null
  const coverageFrom =
    turns == null || earliest == null
      ? null
      : Math.max(earliest, turnsHasMore && oldestTurnStartedAt != null ? oldestTurnStartedAt : 0)
  if (turns != null && turnsHasMore && oldestTurnStartedAt != null && coverageFrom != null) {
    entries.push({
      ts: coverageFrom,
      rank: -1,
      item: { kind: 'turnsBoundary', key: 'turns-boundary', ts: coverageFrom }
    })
  }

  const stoppedChains = new Set<number>()
  const turnKeys = new Set<string>()
  const coveredTurns: GroupTurnWire[] = []
  if (turns != null && coverageFrom != null) {
    for (const t of turns) {
      if (t.startedAt < coverageFrom) continue
      coveredTurns.push(t)
      turnKeys.add(turnKeyOf(t.runId, t.seq))
      if (t.outcome === 'stopped') stoppedChains.add(t.chainId)
    }
  }
  const chainStopped = (chainId: number | null, runId: string | null): boolean =>
    (chainId != null && stoppedChains.has(chainId)) ||
    (runId != null && (stopRunIds.has(runId) || (live?.stoppedByRun.has(runId) ?? false)))

  // ② turn 行（spoke 不成项；stopped 以系统行为准，只在缺系统行时兜底）。
  for (const t of coveredTurns) {
    if (t.outcome === 'spoke') continue
    if (t.outcome === 'stopped') {
      if (stopRunIds.has(t.runId)) continue
      stopRunIds.add(t.runId)
      entries.push({
        ts: t.startedAt,
        rank: 1,
        item: {
          kind: 'stopped',
          key: `st:${t.id}`,
          ts: t.startedAt,
          reason: t.error ?? 'error',
          runId: t.runId
        }
      })
      continue
    }
    const variant = metaVariantOf(t.outcome, t.error)
    if (variant == null) continue
    entries.push({
      ts: t.startedAt,
      rank: 1,
      item: {
        kind: 'meta',
        key: `t:${t.id}`,
        ts: t.startedAt,
        agentId: t.agentId,
        variant,
        error: t.error,
        runId: t.runId,
        chainId: t.chainId,
        seq: t.seq,
        usage: {
          model: t.model,
          tokensInput: t.tokensInput,
          tokensOutput: t.tokensOutput,
          costUsd: t.costUsd
        },
        retryDisabled: variant === 'failed' && chainStopped(t.chainId, t.runId)
      }
    })
  }

  // ③ 事件 overlay：落库优先。
  const noCandidateChains = new Set<number>()
  if (live != null) {
    for (const o of live.overlay.values()) {
      if (o.phase === 'spoke') {
        if (o.messageId != null && messageIds.has(o.messageId)) continue
        if (o.agentId == null) continue
        entries.push({
          ts: o.ts,
          rank: 0,
          speaker: { type: 'member', agentId: o.agentId },
          msg: {
            key: `o:${o.turnKey}`,
            id: o.messageId ?? null,
            role: 'assistant',
            text: o.text ?? '',
            createdAt: o.ts,
            streaming: false,
            failed: false,
            usage: o.usage ?? null
          }
        })
        continue
      }
      if (o.phase === 'no_candidates') {
        noCandidateChains.add(o.chainId)
        entries.push({
          ts: o.ts,
          rank: 1,
          item: { kind: 'noCandidates', key: `nc:${o.chainId}`, ts: o.ts, reason: o.reason ?? null }
        })
        continue
      }
      if (o.phase === 'stopped') {
        if (o.runId != null && stopRunIds.has(o.runId)) continue
        entries.push({
          ts: o.ts,
          rank: 1,
          item: {
            kind: 'stopped',
            key: `os:${o.turnKey}`,
            ts: o.ts,
            reason: o.reason ?? 'error',
            runId: o.runId
          }
        })
        continue
      }
      if (turnKeys.has(o.turnKey) || o.agentId == null) continue
      const variant = metaVariantOf(o.phase, o.reason ?? o.error)
      if (variant == null) continue
      entries.push({
        ts: o.ts,
        rank: 1,
        item: {
          kind: 'meta',
          key: `o:${o.turnKey}`,
          ts: o.ts,
          agentId: o.agentId,
          variant,
          error: o.error ?? null,
          runId: o.runId,
          chainId: o.chainId,
          seq: o.seq,
          usage: o.usage ?? null,
          retryDisabled: variant === 'failed' && chainStopped(o.chainId, o.runId)
        }
      })
    }
  }

  // 规则 6：no_candidates 的台账推导（只用落库事实；最后一条不推——它可能还在排队）。
  if (turns != null && coverageFrom != null && chatRows.length > 0) {
    const last = chatRows.reduce((acc, m) =>
      m.created_at > acc.created_at || (m.created_at === acc.created_at && m.id > acc.id) ? m : acc
    )
    for (const m of chatRows) {
      if (!isChainRoot(m) || m.id === last.id || m.created_at < coverageFrom) continue
      if (noCandidateChains.has(m.id)) continue
      if (coveredTurns.some((t) => t.chainId === m.id)) continue
      entries.push({
        ts: m.created_at,
        rank: 1,
        item: { kind: 'noCandidates', key: `nc:${m.id}`, ts: m.created_at, reason: null }
      })
    }
  }

  // 本地气泡（发送中的用户消息 / v1 循环的成员气泡）恒在落库行之后。
  for (const b of local) {
    entries.push({
      ts: b.ts,
      rank: 2,
      speaker:
        b.kind === 'user'
          ? { type: 'user' }
          : { type: 'member', agentId: b.agentId ?? 'assistant' },
      msg: {
        key: b.key,
        id: null,
        role: b.kind === 'user' ? 'user' : 'assistant',
        text: b.text,
        createdAt: b.ts,
        streaming: b.status === 'streaming',
        failed: b.status === 'failed',
        error: b.error,
        usage: null
      }
    })
  }

  entries.sort((a, b) => a.ts - b.ts || a.rank - b.rank)

  // 规则 5：有正文的在写者作为流式气泡挂在最后。
  if (live?.inFlight != null && live.inFlight.text.length > 0) {
    const lastTs = entries.length > 0 ? entries[entries.length - 1].ts : live.inFlight.startedAt
    entries.push({
      ts: Math.max(lastTs, live.inFlight.startedAt),
      rank: 3,
      speaker: { type: 'member', agentId: live.inFlight.agentId },
      msg: {
        key: `live:${live.inFlight.agentId}`,
        id: null,
        role: 'assistant',
        text: live.inFlight.text,
        createdAt: live.inFlight.startedAt,
        streaming: true,
        failed: false,
        usage: null
      }
    })
  }

  // 规则 3 / 4：折叠 + 日期分隔。
  const items: GroupTimelineItem[] = []
  let currentGroup: Extract<GroupTimelineItem, { kind: 'group' }> | null = null
  let lastMsgTs = 0
  let lastDay: number | null = null
  for (const e of entries) {
    const day = dayStart(e.ts)
    if (lastDay == null || day !== lastDay) {
      currentGroup = null
      items.push({ kind: 'date', key: `d:${day}`, dayStart: day })
      lastDay = day
    }
    if ('item' in e) {
      currentGroup = null
      items.push(e.item)
      continue
    }
    if (
      currentGroup != null &&
      speakerKey(currentGroup.speaker) === speakerKey(e.speaker) &&
      e.ts - lastMsgTs <= GROUP_FOLD_WINDOW_MS
    ) {
      currentGroup.messages.push(e.msg)
    } else {
      currentGroup = {
        kind: 'group',
        key: `g:${e.msg.key}`,
        speaker: e.speaker,
        startedAt: e.ts,
        messages: [e.msg]
      }
      items.push(currentGroup)
    }
    lastMsgTs = e.ts
    // T3：这条落库消息是某个话题的根 → 卡紧随其后，并关掉当前折叠组（下一条同人消息另起一组）。
    // 本地气泡 / 未落库的 overlay 项 id 为 null，查不到，天然不挂卡。
    const thread = e.msg.id != null ? threadByRoot.get(e.msg.id) : undefined
    if (thread != null) {
      items.push({
        kind: 'threadCard',
        key: `tc:${thread.sessionId}`,
        ts: e.ts,
        thread,
        speaker: e.speaker
      })
      currentGroup = null
    }
  }

  return {
    items,
    tail: {
      inFlight:
        live?.inFlight != null
          ? {
              agentId: live.inFlight.agentId,
              text: live.inFlight.text,
              startedAt: live.inFlight.startedAt
            }
          : null,
      preparing: live?.preparing ?? null,
      queued: live?.queued ?? []
    }
  }
}
