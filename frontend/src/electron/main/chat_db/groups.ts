// L4 群聊 g1（CHAT_DB v31）— 群编排的三张读写面：成员设置 / seen 游标 / turn 台账。
//
// 🔴 **两写者列级纪律**（父设计 §3.1）：`ai_chat_group_member` 一张表两个写者 ——
//   • `response_mode` 只由 serve-api 写（`PUT /chat/sessions/{id}/group-config`，列级 UPSERT）；
//   • `seen_through_id` 只由 gateway 写（本文件的 advanceSeenCursor，`INSERT OR IGNORE` +
//     `UPDATE ... SET seen_through_id`）。
//   本文件**绝不**写 response_mode 列，Python 侧**绝不**写 seen_through_id 列。任何一侧的整行
//   UPSERT 都会静默冲掉对方的列（owner 刚改的响应模式被一次游标推进冲回 mention）。
//
// `ai_chat_group_turn` 是两个成本指标与全部地板计数的**权威源**：每次唤醒一行，无论说没说话
// （spoke / silent / held_dup / skipped / failed / stopped 六值）。agent_run_log 只镜像 spoke，
// 跨库无事务，写失败只 warn —— 对不上账时以本表为准。

import { getChatDb } from './connection'

import type {
  GroupResponseMode,
  GroupTriggerKind,
  GroupTurnOutcome
} from '../../../ai-gateway/groupFloors'

/** `ai_chat_group_member` 的一行（缺行 = mention + 游标空，读侧自行兜底）。 */
export interface GroupMemberConfigRow {
  agentId: string
  responseMode: GroupResponseMode
  seenThroughId: number | null
  updatedAt: number
}

/** 一次 turn 台账写入（列名与 v31 表 1:1；可缺字段落 NULL = 未知，不是 0）。 */
export interface GroupTurnInsertRow {
  sessionId: number
  runId: string
  chainId: number
  seq: number
  agentId: string
  triggerKind: GroupTriggerKind
  outcome: GroupTurnOutcome
  messageId?: number | null
  model?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  costUsd?: number | null
  windowFromId?: number | null
  windowToId?: number | null
  startedAt: number
  finishedAt?: number | null
  error?: string | null
}

/** 滚动窗口用量（小时预算三条地板的输入）。costUsd 在整窗全 NULL 时为 null（未知 ≠ 0）。 */
export interface GroupUsageTotals {
  turns: number
  tokens: number
  costUsd: number | null
}

/** 本群每个**有行**成员的设置。缺行的成员不在结果里 —— 读侧一律 `?? 'mention'`（PRD Q1）。 */
export function getGroupMemberConfigs(sessionId: number): GroupMemberConfigRow[] {
  const rows = getChatDb()
    .prepare(
      `SELECT agent_id, response_mode, seen_through_id, updated_at
         FROM ai_chat_group_member WHERE session_id = ? ORDER BY agent_id ASC`
    )
    .all(sessionId) as Array<{
    agent_id: string
    response_mode: GroupResponseMode
    seen_through_id: number | null
    updated_at: number
  }>
  return rows.map((r) => ({
    agentId: r.agent_id,
    responseMode: r.response_mode,
    seenThroughId: r.seen_through_id ?? null,
    updatedAt: r.updated_at
  }))
}

/** 某成员在本群的 seen 游标；缺行 → null = 首轮（窗口取最后 WINDOW_MAX_ROWS 行）。 */
export function getSeenCursor(sessionId: number, agentId: string): number | null {
  const row = getChatDb()
    .prepare(
      'SELECT seen_through_id FROM ai_chat_group_member WHERE session_id = ? AND agent_id = ?'
    )
    .get(sessionId, agentId) as { seen_through_id: number | null } | undefined
  return row?.seen_through_id ?? null
}

/** 推进 seen 游标（🔴 列级：先补行再单列 UPDATE，绝不整行 UPSERT —— 见文件头注）。
 *  只前进不后退：`throughId` 小于现值时是 no-op（乱序 turn 不应把游标拉回去）。 */
export function advanceSeenCursor(sessionId: number, agentId: string, throughId: number): void {
  const db = getChatDb()
  const now = Date.now()
  // 补行时 response_mode 走表的 DEFAULT 'mention' —— 本文件不显式写那一列（写者纪律）。
  db.prepare(
    `INSERT OR IGNORE INTO ai_chat_group_member (session_id, agent_id, seen_through_id, updated_at)
     VALUES (?, ?, NULL, ?)`
  ).run(sessionId, agentId, now)
  db.prepare(
    `UPDATE ai_chat_group_member
        SET seen_through_id = ?, updated_at = ?
      WHERE session_id = ? AND agent_id = ?
        AND (seen_through_id IS NULL OR seen_through_id < ?)`
  ).run(throughId, now, sessionId, agentId, throughId)
}

/** 写一行 turn 台账，返回行 id。 */
export function insertGroupTurn(row: GroupTurnInsertRow): number {
  const result = getChatDb()
    .prepare(
      `INSERT INTO ai_chat_group_turn
        (session_id, run_id, chain_id, seq, agent_id, trigger_kind, outcome, message_id, model,
         tokens_input, tokens_output, cost_usd, window_from_id, window_to_id, started_at,
         finished_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.sessionId,
      row.runId,
      row.chainId,
      row.seq,
      row.agentId,
      row.triggerKind,
      row.outcome,
      row.messageId ?? null,
      row.model ?? null,
      row.tokensInput ?? null,
      row.tokensOutput ?? null,
      row.costUsd ?? null,
      row.windowFromId ?? null,
      row.windowToId ?? null,
      row.startedAt,
      row.finishedAt ?? null,
      row.error ?? null
    )
  return Number(result.lastInsertRowid)
}

/** family（本群 ∪ 父 ∪ 子）在 `started_at >= sinceMs` 窗口内的用量。
 *  空 sessionIds → 零用量（不发 SQL）。tokens 为 input + output 之和；两列各自 NULL 记 0
 *  （SUM 忽略 NULL），而 costUsd 在整窗全 NULL 时返 null —— 金额未知不等于零，金额地板此时
 *  不生效、由 tokens 地板兜底。 */
export function groupUsage(sessionIds: readonly number[], sinceMs: number): GroupUsageTotals {
  if (sessionIds.length === 0) return { turns: 0, tokens: 0, costUsd: null }
  const placeholders = sessionIds.map(() => '?').join(',')
  const row = getChatDb()
    .prepare(
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)), 0) AS tokens,
              SUM(cost_usd) AS cost_usd
         FROM ai_chat_group_turn
        WHERE session_id IN (${placeholders}) AND started_at >= ?`
    )
    .get(...sessionIds, sinceMs) as {
    turns: number
    tokens: number
    cost_usd: number | null
  }
  return {
    turns: Number(row.turns ?? 0),
    tokens: Number(row.tokens ?? 0),
    costUsd: row.cost_usd == null ? null : Number(row.cost_usd)
  }
}

/** 本群的 family：父群 id（子群才非 null）+ 子群 id 列表（按 parent_session_id 反查）。
 *  子群只认 origin='group' 行 —— `parent_session_id` 也被 custom_agent_call 的子会话用（v27），
 *  那些不是群、不该进 family 的预算窗口与 stopFamily。 */
export function familyOf(sessionId: number): {
  parentSessionId: number | null
  childSessionIds: number[]
} {
  const db = getChatDb()
  const self = db
    .prepare('SELECT parent_session_id FROM ai_chat_sessions WHERE id = ?')
    .get(sessionId) as { parent_session_id: number | null } | undefined
  const children = db
    .prepare(
      `SELECT id FROM ai_chat_sessions
        WHERE parent_session_id = ? AND origin = 'group' ORDER BY id ASC`
    )
    .all(sessionId) as Array<{ id: number }>
  return {
    parentSessionId: self?.parent_session_id ?? null,
    childSessionIds: children.map((r) => Number(r.id))
  }
}

/** 本群的 turn 台账（新→旧）。metrics 读面与调度器的 run 内计数共用。 */
export function listGroupTurns(sessionId: number, limit = 200): GroupTurnRow[] {
  return getChatDb()
    .prepare(
      `SELECT * FROM ai_chat_group_turn WHERE session_id = ?
        ORDER BY started_at DESC, id DESC LIMIT ?`
    )
    .all(sessionId, limit) as GroupTurnRow[]
}

/** `ai_chat_group_turn` 的行形状（SELECT * 投影）。 */
export interface GroupTurnRow {
  id: number
  session_id: number
  run_id: string
  chain_id: number
  seq: number
  agent_id: string
  trigger_kind: GroupTriggerKind
  outcome: GroupTurnOutcome
  message_id: number | null
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  cost_usd: number | null
  window_from_id: number | null
  window_to_id: number | null
  started_at: number
  finished_at: number | null
  error: string | null
}
