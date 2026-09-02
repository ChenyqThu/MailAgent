// L4 群聊 g1 — 群设置 / 群指标 / labs 实验开关的 serve-api 客户端（HTTP，桌面 loopback 与
// 远程 web 同一份）。
//
// 形态照 `hooks/useLlmProviders.ts`：`request(resolveApiBaseUrl(), ...)` 统一 envelope
// unwrap，失败 throw `Error & {code}`，调用方 toast / 渲染错误面。
//
// 🔴 为什么不挂在 `ChatApi`（chat_api.ts / api/types/chat.ts）上：`GroupConfig` /
// `GroupMetrics` 的**单一定义**在 `shared/chat_model.ts`（那边的注释明写「群设置对话框直接
// import 它」），而 `api/types/chat.ts` 至今**一个 import 都没有** —— 这条 import-free 不变式
// 正是 tests/config/test_chat_type_mirror_parity.py 保留两份行类型手抄的理由（"将来真出现一列
// 不该出网时，re-export 会把「让它别出网」变成不可能"）。把这三个类型抄进那份边界文件 = 又一处
// 无闸镜像；往那份文件里加 import = 把那条不变式和它撑着的闸的理由一起打破。故本模块独立成面，
// 与 `api/matters.ts` / `api/contacts.ts` / `api/notifications.ts` 同构。

import type { GroupConfig, GroupMetrics } from '@shared/chat_model'
import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'

import { request } from './http_client'

import type {
  GroupResponseMode,
  GroupTriggerKind,
  GroupTurnOutcome
} from '../../ai-gateway/groupFloors'

/** `GET/PUT/PATCH` 三个群端点共用的应答。`modes` 只含**有行**的成员 ——
 *  缺行 = 'mention'（PRD Q1），读侧一律 `modes[id] ?? 'mention'`，不在这里补齐。 */
export interface GroupConfigPayload {
  modes: Record<string, GroupResponseMode>
  config: GroupConfig
  /** `members_json` 的成员序（= 无 @ 时的回复序）。群详情面一次拿全，不再打一次 /sessions/{id}。 */
  members: string[]
  /** 有法官位且 `judgeScopeHash` 与当前名单失配 = 名单在确认法官位之后变过（提示重新确认）。 */
  judgeScopeStale: boolean
}

/** `PUT /chat/sessions/{id}/group-config` 的 body：全部可选，只写传了的键。
 *  值域校验的权威在服务端（chat.py），这里不复制一份判据。
 *  🔴 显式 `null` = **删键**（恢复出厂默认），与「不传」语义不同：不传是不动。 */
export interface GroupConfigPatch {
  modes?: Record<string, GroupResponseMode>
  judgeAgentId?: string | null
  chainCap?: number | null
  hourlyTurns?: number | null
  hourlyTokens?: number | null
  hourlyUsd?: number | null
  sessionTurnCap?: number | null
  /** 群用途：注入每位成员的身份块。长度上限只在服务端校验（超限读 400 的 hint）。 */
  topic?: string | null
  /** 全群统一模型（`providerId:modelId`）；null = 各成员用自己 agent 行的 model。 */
  modelOverride?: string | null
  /** 群不在前台时按链合并成一条通知；null = 恢复默认（发）。 */
  notify?: boolean | null
}

/** `PATCH /chat/sessions/{id}/group-members` 的 body：至少一项非空。
 *  加人 / 踢人的六条校验全在服务端，失败一律 `E_INVALID_ARG` + `hint`（UI 显示 hint）。 */
export interface GroupMembersPatch {
  add?: string[]
  remove?: string[]
}

/** `ai_chat_group_turn` 一行的出网投影（camelCase）。每次唤醒一行，**无论说没说话** ——
 *  沉默 / 重复折叠 / 跳过 / 失败 / 停止的 turn 没有落库消息，只有这张表证明它们发生过。 */
export interface GroupTurnWire {
  id: number
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
  /** `skipped` 的原因词 / `failed` 的错误文本 / `stopped` 的地板原因（值域见 groupFloors.ts）。 */
  error: string | null
  startedAt: number
  finishedAt: number | null
}

/** `GET /chat/sessions/{id}/group-turns` 的应答（新→旧）。 */
export interface GroupTurnsPayload {
  turns: GroupTurnWire[]
  hasMore: boolean
}

export interface GroupTurnsQuery {
  limit?: number
  /** 上一页最旧一行的 turn id（取更旧的一页）。 */
  before?: number
  /** 只要 `startedAt >= since` 的行；恒传「最早一条落库消息的时间」，使清空历史后旧 meta 行
   *  不再回到对话里（台账本身保留，用量不变）。 */
  since?: number
}

export type LabsFlagValue = 'on' | 'off'

export interface LabsFlags {
  groupAgents: LabsFlagValue
}

export async function getGroupConfig(sessionId: number): Promise<GroupConfigPayload> {
  return request(resolveApiBaseUrl(), 'GET', `/chat/sessions/${sessionId}/group-config`)
}

export async function setGroupConfig(
  sessionId: number,
  patch: GroupConfigPatch
): Promise<GroupConfigPayload> {
  return request(resolveApiBaseUrl(), 'PUT', `/chat/sessions/${sessionId}/group-config`, {
    body: patch
  })
}

/** 加人 / 踢人。应答与 group-config 同形（含新名单），调用方直接拿它刷 query 缓存。 */
export async function patchGroupMembers(
  sessionId: number,
  patch: GroupMembersPatch
): Promise<GroupConfigPayload> {
  return request(resolveApiBaseUrl(), 'PATCH', `/chat/sessions/${sessionId}/group-members`, {
    body: patch
  })
}

export async function getGroupTurns(
  sessionId: number,
  query: GroupTurnsQuery = {}
): Promise<GroupTurnsPayload> {
  return request(resolveApiBaseUrl(), 'GET', `/chat/sessions/${sessionId}/group-turns`, {
    query: { limit: query.limit, before: query.before, since: query.since }
  })
}

export async function getGroupMetrics(sessionId: number): Promise<GroupMetrics> {
  return request(resolveApiBaseUrl(), 'GET', `/chat/sessions/${sessionId}/group-metrics`)
}

/** `GET /api/agent/labs`。🔴 传输失败一律 throw（调用方 fail-closed 到 off）—— 不在这里
 *  折成 off，否则「够不着后端」与「owner 关着」在读侧不可区分。 */
export async function getLabs(): Promise<LabsFlags> {
  return request(resolveApiBaseUrl(), 'GET', '/agent/labs')
}

export async function setLabs(flags: Partial<LabsFlags>): Promise<LabsFlags> {
  return request(resolveApiBaseUrl(), 'PUT', '/agent/labs', { body: flags })
}
