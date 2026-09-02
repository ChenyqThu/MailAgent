// L4 群聊 g3 — 群回放导出：一组群（family）的消息行 + turn 台账合并成一张 markdown 表。
//
// 纯函数 + 注入读，零 I/O、零运行时 import。只服务零-LLM 整局 vitest
// （tests/ai-gateway/group_werewolf.test.ts）：gateway cfg 没有 turn 读 hook，`listTurns`
// 由测试假世界注入，**不**为它新开 cfg hook；manual 脚本（scripts/werewolf_lab_run.py）
// 自己从 messages + turns 拼同一列口径的 markdown，调不到本函数。
//
// 列：`时间 | 群 | 发言者 | 内容 | outcome`
//   • 消息行（user / assistant）一行；assistant 行的 outcome 取 messageId 指向它的 turn。
//   • messageId 为空的 turn 各成一行（沉默 / 折叠 / 跳过 / 失败 / 停止都不落消息行）。
//   • 系统行只认 game_over / group_stop（judge_post / judge_denied 是法官自群里的标记，
//     投递本体已作为目标群的 assistant 行出现，不再重复一行）。
// 排序键 = 消息 createdAt / turn startedAt，并列时消息在前。

import type { GroupTranscriptRow } from './groupChat'
import type { GroupTurnRow } from './groupOrchestrator'

/** 转录行 + 系统行的 metadata 原文（game_over / group_stop 的 kind 只能从这里读；
 *  GroupTranscriptRow 本身不带它，两种系统行的 content 又都可能为空）。 */
export type ReplayHistoryRow = GroupTranscriptRow & { metadata?: string | null }

export interface ReplaySource {
  listHistory: (sessionId: number) => ReplayHistoryRow[]
  listTurns: (
    sessionId: number
  ) => Array<Pick<GroupTurnRow, 'messageId' | 'agentId' | 'outcome' | 'error' | 'startedAt'>>
  getTitle: (sessionId: number) => string | null
  titleOf: (agentId: string) => string | null
}

const HEADER = ['| 时间 | 群 | 发言者 | 内容 | outcome |', '| --- | --- | --- | --- | --- |']

/** 装配历史里 owner / 主助理投递行的两个固定标签（groupChat.ts 同字面；零运行时 import）。 */
const USER_LABEL = '用户'
const MAIN_AGENT_LABEL = '主助理'

/** outcome → 中文标注（只在本文件出现一次）。 */
function turnLabel(outcome: GroupTurnRow['outcome'], error: string | null): string {
  switch (outcome) {
    case 'silent':
      return '(沉默)'
    case 'held_dup':
      return '(重复折叠)'
    case 'skipped':
      return `(跳过:${error ?? ''})`
    case 'failed':
      return '(失败)'
    case 'stopped':
      return `(停止:${error ?? ''})`
    default:
      return `(${outcome})`
  }
}

interface ReplayLine {
  ts: number
  /** 并列时消息（0）在 turn（1）之前。 */
  rank: 0 | 1
  cells: [string, string, string, string]
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function systemLabel(row: ReplayHistoryRow): string | null {
  if (typeof row.metadata !== 'string' || row.metadata.length === 0) return null
  let meta: { kind?: unknown; reason?: unknown }
  try {
    meta = JSON.parse(row.metadata) as { kind?: unknown; reason?: unknown }
  } catch {
    return null
  }
  if (meta.kind === 'game_over') return '(游戏结束)'
  if (meta.kind === 'group_stop') {
    return `(停止:${typeof meta.reason === 'string' ? meta.reason : ''})`
  }
  return null
}

export function exportGroupReplay(sessionIds: readonly number[], src: ReplaySource): string {
  const lines: ReplayLine[] = []
  for (const sessionId of sessionIds) {
    const group = src.getTitle(sessionId) ?? `#${sessionId}`
    const turns = src.listTurns(sessionId)
    const outcomeByMessage = new Map<number, string>()
    for (const turn of turns) {
      if (turn.messageId != null) outcomeByMessage.set(turn.messageId, turn.outcome)
    }
    for (const row of src.listHistory(sessionId)) {
      if (row.role === 'user') {
        const speaker = row.via === 'main_agent' ? MAIN_AGENT_LABEL : USER_LABEL
        lines.push({ ts: row.createdAt, rank: 0, cells: [group, speaker, row.content, ''] })
      } else if (row.role === 'assistant') {
        const speaker =
          row.speakerAgentId == null
            ? USER_LABEL
            : (src.titleOf(row.speakerAgentId) ?? row.speakerAgentId)
        lines.push({
          ts: row.createdAt,
          rank: 0,
          cells: [group, speaker, row.content, outcomeByMessage.get(row.id) ?? '']
        })
      } else if (row.role === 'system') {
        const label = systemLabel(row)
        if (label) lines.push({ ts: row.createdAt, rank: 0, cells: [group, '', label, ''] })
      }
    }
    for (const turn of turns) {
      if (turn.messageId != null) continue
      lines.push({
        ts: turn.startedAt,
        rank: 1,
        cells: [
          group,
          src.titleOf(turn.agentId) ?? turn.agentId,
          turnLabel(turn.outcome, turn.error),
          turn.outcome
        ]
      })
    }
  }
  lines.sort((a, b) => a.ts - b.ts || a.rank - b.rank)
  return [
    ...HEADER,
    ...lines.map((l) => `| ${new Date(l.ts).toISOString()} | ${l.cells.map(cell).join(' | ')} |`)
  ].join('\n')
}
