// L4 群聊 UX 批 — 消息流 / 群列表的纯展示辅助（零 react / 零 api import；组件与测试直引）。
//
// @ 切段的边界判定**不手抄**：mentionSegments 把候选片段交给 parseGroupMentions 判，命中与否
// 与调度器的候选集口径完全一致（`@agent1x` 不算提及 `agent1`，`@allx` 不算 @全员）。

import {
  GROUP_MENTION_ALL_TOKENS,
  parseGroupMentions,
  type GroupMentionMember
} from '../../../../ai-gateway/groupChat'

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
