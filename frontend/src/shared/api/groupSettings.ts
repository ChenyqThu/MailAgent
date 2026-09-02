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

import type { GroupResponseMode } from '../../ai-gateway/groupFloors'

/** `GET/PUT /chat/sessions/{id}/group-config` 的应答。`modes` 只含**有行**的成员 ——
 *  缺行 = 'mention'（PRD Q1），读侧一律 `modes[id] ?? 'mention'`，不在这里补齐。 */
export interface GroupConfigPayload {
  modes: Record<string, GroupResponseMode>
  config: GroupConfig
}

/** `PUT /chat/sessions/{id}/group-config` 的 body：全部可选，只写传了的键。
 *  值域校验的权威在服务端（chat.py），这里不复制一份判据。 */
export interface GroupConfigPatch {
  modes?: Record<string, GroupResponseMode>
  judgeAgentId?: string | null
  chainCap?: number
  hourlyTurns?: number
  hourlyTokens?: number
  hourlyUsd?: number
  sessionTurnCap?: number | null
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
