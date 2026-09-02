// L4 群聊（CHAT_DB v30 / g1 v31）— group-chat SPEAKER-run pure helpers.
//
// A group session (ai_chat_sessions origin='group' + members_json) holds ONE shared transcript;
// each member's speaking turn is a separate LLM run driven by POST /api/ai/group-chat
// (server.ts handleGroupChat) or, with labs on, by the server-side groupOrchestrator. This module
// owns the pure pieces of that run:
//
//   • parseGroupMemberIds — the members_json → string[] read (tolerant: anything that isn't a
//     non-empty string array collapses to []; a group with zero readable members admits no speaker).
//   • parseGroupMentions — `@显示名` 点名解析（g1 从 shared/components/agents/groups/mentions.ts
//     下沉到这里：调度器的候选集是服务端事实，renderer 经 mentions.ts 的 re-export 共用同一份）。
//   • assembleGroupHistory — the 多人历史装配约定 (task spec §2): the speaking agent's own
//     persisted assistant rows become `assistant`-role history; every OTHER participant's row
//     becomes `user`-role text prefixed with its speaker label (`[标题] …` for other agents,
//     `[用户] …` for the owner, `[主助理] …` for a main-agent delivery — metadata.via). Consecutive
//     user-role texts are merged into ONE user message — the model sees a strictly alternating
//     transcript regardless of how many members spoke between the agent's own turns.
//   • buildGroupWindow / isChainRootRow — g1 近期消息窗口（seen 游标 + 尾部 + 行/字符上限）与
//     链归属（链根 = 人类消息 / 主 agent 投递；成员回复继承触发消息的 chain_id）。
//
// 🔴 Pure: no node:http / electron / ai imports. Unit-tested in plain Node
// (tests/ai-gateway/group_chat.test.ts).

import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { GroupHistoryRow } from './config'
import { renderAttachmentBlock } from './groupAttachments'
import { WINDOW_MAX_CHARS, WINDOW_MAX_ROWS, WINDOW_TAIL } from './groupFloors'

/** The owner's speaker label in assembled history. One fixed label (not the account name) so the
 *  convention is stable across accounts and the prompt block can explain it verbatim. */
export const GROUP_USER_LABEL = '用户'
/** 主 agent 投递到群里的行（role user + metadata.via='main_agent'）在装配里的前缀。 */
export const GROUP_MAIN_AGENT_LABEL = '主助理'

/** GroupHistoryRow + the v31 columns the orchestrator reads (row id / chain_id / metadata.via /
 *  created_at). The lifecycle's listGroupHistory projection fills them; hand-built v30 fixtures
 *  without them still satisfy assembleGroupHistory (via is read optionally there).
 *  g2 widens `via` with 'judge_post' — a judge's cross-group delivery row (role assistant,
 *  chainId NULL = chain root, trigger_kind 'judge_post'); assembleGroupHistory labels only
 *  role='user' rows, so a judge row keeps its speaker's own label. */
export interface GroupTranscriptRow extends GroupHistoryRow {
  id: number
  chainId: number | null
  via: 'main_agent' | 'judge_post' | null
  createdAt: number
}

/** Parse ai_chat_sessions.members_json into the member agent-id array. Tolerant by contract:
 *  malformed JSON / non-array / non-string entries → dropped (a zero-member group admits no
 *  speaker — handleGroupChat then 403s every speakAsAgentId). */
export function parseGroupMemberIds(membersJson: string | null | undefined): string[] {
  if (typeof membersJson !== 'string' || membersJson.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(membersJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
  } catch {
    return []
  }
}

export interface GroupMentionMember {
  agentId: string
  title: string
}

/** 名字后的边界判定：串尾 / 空白 / 标点（中文名后常直接跟中文标点或正文，此处只排除
 *  字母/数字/下划线续接 —— `@agent1x` 不算提及 `agent1`）。 */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true
  return !/[A-Za-z0-9_]/.test(ch)
}

/** `@全员` 保留字（composer 弹层置顶项与 parseGroupMentions 共用）。命中 = 唤醒全部成员一次，
 *  仍受全部地板约束；保留字优先于成员名（成员恰好叫「所有人」/「all」时被遮蔽，有意）。 */
export const GROUP_MENTION_ALL_TOKENS = ['@所有人', '@all'] as const

/** 文本里是否出现保留字（边界判定与成员名相同：`@allx` 不算）。 */
function mentionsAll(text: string): boolean {
  for (const token of GROUP_MENTION_ALL_TOKENS) {
    let from = 0
    for (;;) {
      const idx = text.indexOf(token, from)
      if (idx === -1) break
      if (isBoundary(text[idx + token.length])) return true
      from = idx + 1
    }
  }
  return false
}

/** 解析文本中被 @ 点名的成员 id。无点名 → []（调用方按「全员各回一轮」/ realtime 候选处理）。
 *  按**显示名**匹配，返回值恒按 members 传入序（= members_json 成员序 = 回复顺序），去重；
 *  先按名字长度降序检出、再回到成员序输出，长名优先吃掉重叠。
 *  保留字 `@所有人` / `@all` 命中 → 全体成员 id（成员序），先于逐名匹配。 */
export function parseGroupMentions(text: string, members: readonly GroupMentionMember[]): string[] {
  if (!text.includes('@') || members.length === 0) return []
  if (mentionsAll(text)) return members.map((m) => m.agentId)
  const hit = new Set<string>()
  // 长名优先：避免短名作为长名前缀时双命中（去重靠 Set，但边界判定在长名场景下更稳）。
  const byLength = [...members]
    .filter((m) => m.title.length > 0)
    .sort((a, b) => b.title.length - a.title.length)
  for (const member of byLength) {
    let from = 0
    for (;;) {
      const idx = text.indexOf(`@${member.title}`, from)
      if (idx === -1) break
      const after = text[idx + 1 + member.title.length]
      if (isBoundary(after)) {
        hit.add(member.agentId)
        break
      }
      from = idx + 1
    }
  }
  // 恒按成员序输出 = 回复顺序稳定可预期。
  return members.filter((m) => hit.has(m.agentId)).map((m) => m.agentId)
}

/**
 * Assemble the model-facing history for ONE speaker's turn.
 *
 * Rows admitted: role 'user'|'assistant' with non-empty content, status 'complete' (or absent —
 * hand-built fixtures); error/aborted/streaming rows never reach the model. Returns UIMessages
 * (text parts only — a group speaking turn is text-in/text-out by design).
 *
 * T2 群附件：user 行带 `attachments` 时，`renderAttachmentBlock` 的不可信内容围栏块前置进该行
 * 正文 —— 附件对**所有**候选成员可见（父设计 D10），不是只给第一个回复的人。
 */
export function assembleGroupHistory(
  rows: readonly (GroupHistoryRow & { via?: GroupTranscriptRow['via'] })[],
  speakAsAgentId: string,
  titleByAgentId: ReadonlyMap<string, string>
): MailAgentUIMessage[] {
  const messages: MailAgentUIMessage[] = []
  let seq = 0
  const push = (role: 'user' | 'assistant', text: string): void => {
    const last = messages[messages.length - 1]
    // Merge consecutive user-role texts (see header). Assistant rows are the speaker's OWN turns
    // and stay one-message-per-row.
    if (role === 'user' && last?.role === 'user') {
      const part = last.parts[0] as { type: 'text'; text: string }
      part.text = `${part.text}\n\n${text}`
      return
    }
    messages.push({
      id: `group-${role}-${seq++}`,
      role,
      parts: [{ type: 'text', text }]
    } as MailAgentUIMessage)
  }
  for (const row of rows) {
    if (typeof row.content !== 'string' || row.content.length === 0) continue
    if (row.status != null && row.status !== 'complete') continue
    if (row.role === 'user') {
      const label = row.via === 'main_agent' ? GROUP_MAIN_AGENT_LABEL : GROUP_USER_LABEL
      // T2 群附件：围栏块前置进这条 user 行（在标签之后 —— 块属于这一位说话人的这条消息，
      // 连续 user 合并后也不会跟别人的话混在一起）。无附件 → 空串，与改动前逐字节相同。
      push('user', `[${label}] ${renderAttachmentBlock(row.attachments)}${row.content}`)
    } else if (row.role === 'assistant') {
      const speaker = row.speakerAgentId
      if (speaker != null && speaker === speakAsAgentId) {
        push('assistant', row.content)
      } else {
        // Another member's reply (or a legacy NULL-speaker assistant row) reads as third-party
        // speech: user role, labelled. NULL speaker in a group session can only come from
        // pre-group rows and is labelled with its raw id fallback.
        const label = speaker == null ? GROUP_USER_LABEL : (titleByAgentId.get(speaker) ?? speaker)
        push('user', `[${label}] ${row.content}`)
      }
    }
    // system/tool rows (none are written by the group writer) are skipped.
  }
  return messages
}

/** 链归属：链根 = 人类消息 / 主 agent 投递（role user），或没有 chain_id 可继承的行（v31 前的
 *  遗留行 / 自指行）。成员回复（assistant + chain_id）不是链根 —— 法官在本群发言同样不是
 *  （父设计 §3.1 否决「法官消息开新链」）。 */
export function isChainRootRow(row: Pick<GroupTranscriptRow, 'id' | 'role' | 'chainId'>): boolean {
  return row.role === 'user' || row.chainId == null || row.chainId === row.id
}

/** A row admitted into the window: user / assistant, non-empty, status complete (or absent). */
function isWindowRow(row: GroupTranscriptRow): boolean {
  if (row.role !== 'user' && row.role !== 'assistant') return false
  if (typeof row.content !== 'string' || row.content.length === 0) return false
  return row.status == null || row.status === 'complete'
}

export interface GroupWindowLimits {
  tail: number
  maxRows: number
  maxChars: number
}

export interface GroupWindow {
  /** The rows the model sees, oldest-first; first row is never the speaker's own assistant row. */
  rows: GroupTranscriptRow[]
  /** Rows newer than the seen cursor that were NOT authored by the speaker (the candidate test:
   *  zero → the turn is skipped, nothing to react to). */
  othersNew: GroupTranscriptRow[]
  /** Highest admitted row id in the snapshot (the cursor value to advance to after this turn). */
  maxId: number | null
  fromId: number | null
  toId: number | null
}

/**
 * Build the speaker's 近期消息窗口 from a transcript snapshot: everything after the seen cursor
 * ∪ WINDOW_TAIL rows before it, trimmed from the OLD end to maxRows / maxChars (keep new, drop
 * old). First turn (cursor null) = the last maxRows rows. Leading rows authored by the speaker
 * are dropped so the assembled history opens with a user-role message.
 */
export function buildGroupWindow(
  snapshot: readonly GroupTranscriptRow[],
  speakAsAgentId: string,
  seenThroughId: number | null,
  limits: GroupWindowLimits = {
    tail: WINDOW_TAIL,
    maxRows: WINDOW_MAX_ROWS,
    maxChars: WINDOW_MAX_CHARS
  }
): GroupWindow {
  const admitted = snapshot.filter(isWindowRow).sort((a, b) => a.id - b.id)
  const maxId = admitted.length ? admitted[admitted.length - 1]!.id : null
  const isOthers = (row: GroupTranscriptRow): boolean =>
    row.role === 'user' || row.speakerAgentId !== speakAsAgentId
  let rows: GroupTranscriptRow[]
  if (seenThroughId == null) {
    rows = admitted.slice(-limits.maxRows)
  } else {
    const firstNew = admitted.findIndex((r) => r.id > seenThroughId)
    const newCount = firstNew === -1 ? 0 : admitted.length - firstNew
    const tailStart = Math.max(0, admitted.length - newCount - limits.tail)
    rows = admitted.slice(tailStart)
  }
  // Trim from the old end: rows first, then chars.
  if (rows.length > limits.maxRows) rows = rows.slice(rows.length - limits.maxRows)
  // 🔴 字符预算算上附件正文：它一样进模型（assembleGroupHistory 前置围栏块），不算的话一份
  // 20k 字的附件能把 12k 的窗口撑到三倍而地板毫不知情。无附件的行加 0 → 老行为逐字节不变。
  const rowChars = (r: GroupTranscriptRow): number =>
    r.content.length + (r.attachments ?? []).reduce((n, a) => n + (a.text?.length ?? 0), 0)
  let chars = rows.reduce((n, r) => n + rowChars(r), 0)
  while (rows.length > 1 && chars > limits.maxChars) {
    chars -= rowChars(rows[0]!)
    rows = rows.slice(1)
  }
  while (rows.length > 0 && !isOthers(rows[0]!)) rows = rows.slice(1)
  const othersNew = admitted.filter(
    (r) => (seenThroughId == null || r.id > seenThroughId) && isOthers(r)
  )
  return {
    rows,
    othersNew,
    maxId,
    fromId: rows.length ? rows[0]!.id : null,
    toId: rows.length ? rows[rows.length - 1]!.id : null
  }
}
