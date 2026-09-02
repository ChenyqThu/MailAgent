// L4 群聊 UX 批 — 消息流 / 群列表的纯展示辅助（零 react / 零 api import；组件与测试直引）。
//
// @ 切段的边界判定**不手抄**：mentionSegments 把候选片段交给 parseGroupMentions 判，命中与否
// 与调度器的候选集口径完全一致（`@agent1x` 不算提及 `agent1`，`@allx` 不算 @全员）。

import {
  GROUP_MENTION_ALL_TOKENS,
  parseGroupMentions,
  type GroupMentionMember
} from '../../../../ai-gateway/groupChat'
// 🔴 type-only（擦除）— 阶段词表与 stall 档位与 AI Chat 同一份，别在群侧另立一套；
// useTurnStage.ts 顶层拉 react + @assistant-ui/react，本文件只取类型故运行时零拉取。
import type { StallLevel, TurnStage } from '@shared/assistant/runtime/useTurnStage'

/** 成员名字色（按 members_json 序取模）。全 token，不引新色值。 */
export const NAME_COLORS = [
  'rgb(var(--c-ai))',
  'rgb(var(--c-info))',
  'rgb(var(--c-ok))',
  'rgb(var(--c-impt))',
  'rgb(var(--c-accent))'
] as const

export function colorOfMember(memberIds: readonly string[], agentId: string): string {
  return NAME_COLORS[Math.max(0, memberIds.indexOf(agentId)) % NAME_COLORS.length]
}

/** i18n `t` 的最小形状（不 import react-i18next，保持叶子纯净）。 */
export type PresentationT = (key: string, options?: Record<string, unknown>) => string

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 本地自然日零点（日期分隔的判据）。 */
export function dayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 组头相对时间五档：< 1 min「刚刚」；< 60 min「n 分钟前」；今天「HH:MM」；昨天「昨天 HH:MM」；
 *  更早「M/D HH:MM」。 */
export function relativeTimeLabel(ms: number, now: number, t: PresentationT): string {
  const diff = now - ms
  if (diff < 60_000) return t('groupChat.timeJustNow')
  if (diff < 3_600_000) return t('groupChat.timeMinutesAgo', { count: Math.floor(diff / 60_000) })
  const d = new Date(ms)
  const n = new Date(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (sameLocalDay(d, n)) return hm
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameLocalDay(d, yesterday)) return `${t('groupChat.dateYesterday')} ${hm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 气泡 hover 的绝对时间（`title`）。 */
export function absoluteTimeLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 日期分隔文案：今天 / 昨天 / YYYY-MM-DD。 */
export function dateSeparatorLabel(dayStartMs: number, now: number, t: PresentationT): string {
  const d = new Date(dayStartMs)
  const n = new Date(now)
  if (sameLocalDay(d, n)) return t('groupChat.dateToday')
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameLocalDay(d, yesterday)) return t('groupChat.dateYesterday')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; agentId: string }
  | { kind: 'all'; text: string }

/** 探针成员：永远不会被逐名匹配命中，让 parseGroupMentions 只剩保留字分支说话。 */
const ALL_PROBE: readonly GroupMentionMember[] = [{ agentId: '__all__', title: '\u0000' }]

/** 把正文切成 文本 / @成员 / @所有人 三种段，供 chip 覆盖。命中判定全部经 parseGroupMentions。 */
export function mentionSegments(
  text: string,
  members: readonly GroupMentionMember[]
): MentionSegment[] {
  if (!text.includes('@') || members.length === 0) return [{ kind: 'text', text }]
  const byLength = members
    .filter((m) => m.title.length > 0)
    .sort((a, b) => b.title.length - a.title.length)
  const out: MentionSegment[] = []
  let plain = ''
  const flush = (): void => {
    if (plain.length > 0) out.push({ kind: 'text', text: plain })
    plain = ''
  }
  let i = 0
  scan: while (i < text.length) {
    if (text[i] === '@') {
      for (const token of GROUP_MENTION_ALL_TOKENS) {
        if (!text.startsWith(token, i)) continue
        // 候选片段 = 保留字 + 紧随其后的一个字符（边界判定需要它）。
        if (parseGroupMentions(text.slice(i, i + token.length + 1), ALL_PROBE).length > 0) {
          flush()
          out.push({ kind: 'all', text: token })
          i += token.length
          continue scan
        }
      }
      for (const m of byLength) {
        const label = `@${m.title}`
        if (!text.startsWith(label, i)) continue
        if (parseGroupMentions(text.slice(i, i + label.length + 1), [m]).length > 0) {
          flush()
          out.push({ kind: 'mention', text: label, agentId: m.agentId })
          i += label.length
          continue scan
        }
      }
    }
    plain += text[i]
    i += 1
  }
  flush()
  return out
}

/** 群列表预览：去 markdown 符号与换行，截 max。 */
export function plainPreview(content: string, max = 80): string {
  return content
    .replace(/[`*_#>[\]|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 气泡纯文本快路径判据：不含 markdown 行内符号，且没有列表 / 编号行。误判两个方向都无害
 *  （markdown 当纯文本只是显示原文；纯文本当 markdown 只是多一次解析）。 */
export function isPlainText(text: string): boolean {
  if (/[*_`#>[\]|~]/.test(text)) return false
  return !text.split('\n').some((line) => /^\s*(?:[-+]\s|\d+\.\s)/.test(line))
}

/** `groupTurnStage` 吃的最小事实面（`useGroupTurnEvents` 的 `GroupLiveState` 结构上满足它）。
 *
 *  🔴 **有意**不 import 那个类型：groupTimeline / useGroupTurnEvents 反过来都 import 本文件
 *  （dayStart），写成结构形状才能让这个叶子继续「零 react / 零 api import」。 */
export interface GroupTurnStageView {
  inFlight: { agentId: string; text: string; startedAt: number } | null
  preparing: string | null
  queued: readonly string[]
  /** turn 级留痕（`phase` 的值域是 groupTurnEvent.ts 的 GroupTurnPhase；这里只需要读 failed）。 */
  overlay: ReadonlyMap<string, { phase: string; agentId: string | null; ts: number }>
  /** 最近一次事件（含 delta）的时刻；null = 还没收到过任何事件。 */
  lastEventAt: number | null
}

/** stall 升级的两个门槛。🔴 调用方传 `useTurnStage.ts` 的 `STALL_1_MS` / `STALL_2_MS`（那里是
 *  单源），**不要**在本文件里重写 15s / 30s —— 参数化就是为了不在叶子里手抄那两个数。 */
export interface GroupTurnStallThresholds {
  level1Ms: number
  level2Ms: number
}

export interface GroupTurnStageResult {
  stage: TurnStage
  stallLevel: StallLevel
}

/** overlay 里时刻最新的那条留痕（空 Map → null）。判「这一轮最后发生的是什么」。
 *  导出是因为 error 支的**在场者身份**只能从这条留痕取（此时三元组已空，没有在写者可问）——
 *  两处必须看同一条留痕，抄第二个「找最新」的循环就会出现「阶段说失败、头像是别人」。 */
export function latestOverlayTurn(
  overlay: GroupTurnStageView['overlay']
): { phase: string; agentId: string | null; ts: number } | null {
  let latest: { phase: string; agentId: string | null; ts: number } | null = null
  for (const turn of overlay.values()) {
    if (latest == null || turn.ts > latest.ts) {
      latest = { phase: turn.phase, agentId: turn.agentId, ts: turn.ts }
    }
  }
  return latest
}

/**
 * 群在场态：把群的在场三元组 + overlay 翻译成 AI Chat 那套 `TurnStage`。
 *
 * 分支次序（照 `deriveTurnStage` 的取舍：先看「还在不在跑」，再让静默压过上一帧看到的相位）：
 *   ① 三元组全空 → 收尾：最后一条留痕是 failed 且还新鲜 → error，否则 idle；
 *   ② 距最近一次事件 ≥ level2 / level1 → stalled（2 / 1）；`lastEventAt == null`（只有探针种子、
 *      没收到过事件）不算静默 —— 没有事件源就无从谈「无增量」；
 *   ③ 还没有在写者（只有 preparing / 排队），或在写者尚无正文 → connecting；
 *   ④ 在写者有正文 → writing。
 *
 * 🔴 只产 connecting / writing / stalled / error 四态。`thinking` / `calling-tool` 群里**永远不
 * 出现**：`chat:group-turn` 的 delta 只带文本，renderer 看不到工具相位（labs on 的成员 run 自 g2
 * 起可能有读工具，但那个相位不上事件通道）。这是有意的边界 —— 不伪造一个看着像的态。
 */
export function groupTurnStage(
  view: GroupTurnStageView,
  nowMs: number,
  stall: GroupTurnStallThresholds
): GroupTurnStageResult {
  const running = view.inFlight != null || view.preparing != null || view.queued.length > 0
  if (!running) {
    // 🔴 失败的**长期**载体是时间线里那条带重试钮的 meta 行；在场行只答「此刻正在发生什么」。
    // overlay 的 failed 留痕没有任何清理者（`turnsLoaded` 至今无人 dispatch），不给新鲜期就会在
    // 群底留一条永不消失的红字「响应出错」——「shimmer must stop」治下同一类永动 bug。
    // 新鲜期借 stall 的一级门槛（调用方已经传进来了），不为此再造一个数。
    const latest = latestOverlayTurn(view.overlay)
    const fresh = latest != null && nowMs - latest.ts < stall.level1Ms
    return { stage: fresh && latest.phase === 'failed' ? 'error' : 'idle', stallLevel: 0 }
  }
  if (view.lastEventAt != null) {
    const silentMs = nowMs - view.lastEventAt
    if (silentMs >= stall.level2Ms) return { stage: 'stalled', stallLevel: 2 }
    if (silentMs >= stall.level1Ms) return { stage: 'stalled', stallLevel: 1 }
  }
  if (view.inFlight == null || view.inFlight.text.length === 0) {
    return { stage: 'connecting', stallLevel: 0 }
  }
  return { stage: 'writing', stallLevel: 0 }
}

/** 列表预览前缀三分支：主助理投递 → 「主助理」；其余 user → 「你」；assistant → 成员名。 */
export function previewPrefix(
  lastMessage: { role: 'user' | 'assistant'; speaker_agent_id: string | null; via: string | null },
  titleOf: (agentId: string) => string,
  t: PresentationT
): string {
  if (lastMessage.via === 'main_agent') return t('groupChat.previewMainAgent')
  if (lastMessage.role === 'user') return t('groupChat.previewYou')
  return lastMessage.speaker_agent_id != null ? titleOf(lastMessage.speaker_agent_id) : 'AI'
}
