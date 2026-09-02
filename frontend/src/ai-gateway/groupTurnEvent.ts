// L4 群聊 UX 批 — `chat:group-turn` 事件的单一定义（零依赖叶子）。
//
// gateway（groupOrchestrator 发射）→ electron main（broadcastChatEvent 透传）→ renderer
// （ElectronApi.onGroupTurn 窄化）三处都 import 这一份。renderer 显示的「谁在发言 / 谁沉默 /
// 为什么停」只能来自这里的事件与落库行，不许前端推断（PRD 红线 1）。
//
// 🔴 零依赖：照 groupFloors.ts / groupChat.ts 的叶子纪律，不 import 任何运行时模块（renderer
//    的 reducer 与 gateway 两侧直引）。
// 🔴 `queued` / `chainProgress` 每条事件都带 = 全量覆盖语义，丢一帧不错位；`delta` / `spoke` 的
//    `text` 是**累计**正文不是增量，renderer 直接覆盖 live 文本（幂等）。

export const GROUP_TURN_PHASES = [
  'queued',
  'no_candidates',
  'start',
  'delta',
  'spoke',
  'silent',
  'held_dup',
  'skipped',
  'failed',
  'stopped'
] as const
export type GroupTurnPhase = (typeof GROUP_TURN_PHASES)[number]

/** skipped 的原因词表：事件 `reason` 与 turn 行 `error` 列**同一份**（刷新后靠 error 列还原文案）。 */
export const GROUP_SKIP_REASONS = ['monologue', 'no_new_messages', 'removed'] as const
export type GroupSkipReason = (typeof GROUP_SKIP_REASONS)[number]

export interface GroupTurnUsage {
  model: string | null
  tokensInput: number | null
  tokensOutput: number | null
  costUsd: number | null
}

export interface GroupTurnEvent {
  v: 1
  sessionId: number
  /** 调度器 run id；no_candidates 无 run → null。 */
  runId: string | null
  chainId: number
  /** 本 turn 在 run 内的序号；queued / no_candidates / stopped（按 family 发的那条）→ null。 */
  seq: number | null
  /** 事件主体成员；queued / no_candidates / family 级 stopped → null。 */
  agentId: string | null
  phase: GroupTurnPhase
  /** gateway 时钟（ms）。 */
  ts: number
  /** 事件发出后本群队列的完整 FIFO（agentId 序）。 */
  queued: string[]
  /** 本链已计数唤醒 / 链上限（spoke + silent + held_dup 计入，与 checkFloors 同口径）。 */
  chainProgress: { counted: number; cap: number }
  /** delta / spoke：累计正文。 */
  text?: string
  /** spoke：落库消息 id。 */
  messageId?: number
  /** stopped：GROUP_STOP_REASONS；skipped：GroupSkipReason；
   *  no_candidates：'no_realtime_members' | 'self_only' | 'run_stopped'。 */
  reason?: string
  /** failed：错误文本（同 turn 行 error 列）。 */
  error?: string
  /** spoke / silent / held_dup / failed：与 turn 行同源的成本字段。 */
  usage?: GroupTurnUsage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 运行时窄化（renderer 与 main 共用）：必填字段形状不符 → 返回 null（丢整条）；可选字段类型
 *  不符 → 丢该字段不丢事件（`text` 非字符串 → undefined）。 */
export function narrowGroupTurnEvent(raw: unknown): GroupTurnEvent | null {
  if (!isRecord(raw)) return null
  if (raw.v !== 1) return null
  if (!isInteger(raw.sessionId)) return null
  if (!isInteger(raw.chainId)) return null
  if (typeof raw.phase !== 'string') return null
  if (!(GROUP_TURN_PHASES as readonly string[]).includes(raw.phase)) return null
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null
  if (!Array.isArray(raw.queued) || !raw.queued.every((id) => typeof id === 'string')) return null
  const progress = raw.chainProgress
  if (
    !isRecord(progress) ||
    typeof progress.counted !== 'number' ||
    typeof progress.cap !== 'number'
  ) {
    return null
  }
  const event: GroupTurnEvent = {
    v: 1,
    sessionId: raw.sessionId,
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    chainId: raw.chainId,
    seq: isInteger(raw.seq) ? raw.seq : null,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : null,
    phase: raw.phase as GroupTurnPhase,
    ts: raw.ts,
    queued: raw.queued as string[],
    chainProgress: { counted: progress.counted, cap: progress.cap }
  }
  if (typeof raw.text === 'string') event.text = raw.text
  if (isInteger(raw.messageId)) event.messageId = raw.messageId
  if (typeof raw.reason === 'string') event.reason = raw.reason
  if (typeof raw.error === 'string') event.error = raw.error
  if (isRecord(raw.usage)) {
    event.usage = {
      model: typeof raw.usage.model === 'string' ? raw.usage.model : null,
      tokensInput: nullableNumber(raw.usage.tokensInput),
      tokensOutput: nullableNumber(raw.usage.tokensOutput),
      costUsd: nullableNumber(raw.usage.costUsd)
    }
  }
  return event
}
