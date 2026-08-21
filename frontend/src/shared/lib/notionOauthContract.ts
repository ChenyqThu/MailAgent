// task 08-20 Notion OAuth — main ↔ renderer 的 IPC 契约单源（Lane 3）。
//
// 为什么单独一个文件：契约的两侧分别是 electron main（notion_oauth.ts，import
// electron/http/crypto）与 renderer（设置页 / onboarding）。renderer tsconfig
// 里没有 main 的 path alias，直接手抄一份 phase / errorCode / channel 名就是
// 典型的「跨边界手抄常量」——改一处漏一处，两侧类型还都是绿的。
// 故把纯类型 + channel 名下沉成**零依赖叶子**：main 从这里 re-export，renderer
// 从这里 import，谁也不用抄。
//
// 🔴 这里只放**非敏感**形状：token / code / state 从不出现在任何 IPC 载荷里
//（access_token 只存 main 内存直到 env 原子写；见 notion_oauth.ts 头注释）。

import type { NotionDbRole } from './notionDbSchema'

/** 授权尝试的阶段（main 经 status 通道推送）。 */
export type NotionOauthPhase =
  | 'waiting_callback'
  | 'exchanging'
  | 'discovering'
  | 'need_selection'
  | 'writing'
  | 'done'
  | 'error'

/** 稳定错误码。UI 每个码都有具体文案（不做「未知错误」兜底以外的合并）。 */
export type NotionOauthErrorCode =
  | 'client_id_missing'
  | 'port_unavailable'
  | 'browser_open_failed'
  | 'denied'
  | 'timeout'
  | 'cancelled'
  | 'invalid_grant'
  | 'upstream_error'
  | 'not_configured'
  | 'rate_limited'
  | 'invalid_redirect_uri'
  | 'network_error'
  | 'invalid_response'
  | 'discovery_failed'
  | 'no_databases_found'
  | 'selection_invalid'
  | 'env_write_failed'

/** 推送给 renderer 的状态事件。🔴 只带非敏感展示字段。 */
export interface NotionOauthStatusEvent {
  attemptId: string
  phase: NotionOauthPhase
  errorCode?: NotionOauthErrorCode
  workspaceName?: string
  emailDbTitle?: string
  calendarDbTitle?: string
}

/** listDatabases 返回的候选（非敏感投影；id = data source id）。 */
export interface NotionDbCandidate {
  id: string
  title: string
  role: NotionDbRole | 'unknown'
  valid: boolean
  /** required 档缺失清单（缺失即不可选，UI 置灰并展示）。 */
  missing: string[]
  /** recommended 档缺失清单（仅提示，可选用 —— LLM 等可选功能的字段）。 */
  warnings: string[]
}

export type NotionOauthStartResult =
  | { ok: true; attemptId: string }
  | { ok: false; errorCode: NotionOauthErrorCode }

export type NotionOauthSelectResult = { ok: true } | { ok: false; errorCode: NotionOauthErrorCode }

export type NotionOauthRemoveResult = { ok: true } | { ok: false; errorCode: 'env_write_failed' }

/** IPC channel 名（main 注册 / renderer 调用的唯一来源）。 */
export const NOTION_OAUTH_STATUS_CHANNEL = 'notionOauth:status'
export const NOTION_OAUTH_START_CHANNEL = 'notionOauth:start'
export const NOTION_OAUTH_CANCEL_CHANNEL = 'notionOauth:cancel'
export const NOTION_OAUTH_LIST_DATABASES_CHANNEL = 'notionOauth:listDatabases'
export const NOTION_OAUTH_SELECT_DATABASES_CHANNEL = 'notionOauth:selectDatabases'
export const NOTION_OAUTH_REMOVE_CONNECTION_CHANNEL = 'notionOauth:removeConnection'

/** 授权成功 / 移除连接时 main 原子写的 env key 全集。renderer 据此刷新 env 快照并
 *  标记「需重启后端」——漏一个键 = 重启横幅少列一项，用户以为不用重启。
 *  🔴 与 notion_oauth.ts 的 patch 键集由 tests/main/notion_oauth_env_contract.test.ts
 *  锁死（removeConnection 的 patch 键集必须恰好等于本数组）。
 *  🔴 有意不含 NOTION_REFRESH_TOKEN（prd 拍板：refresh token 不落盘）。 */
export const NOTION_OAUTH_ENV_KEYS: readonly string[] = [
  'NOTION_TOKEN',
  'EMAIL_DATABASE_ID',
  'CALENDAR_DATABASE_ID',
  // 选中的两个 data source id（2025-09-03 起 database 是容器、schema 在 data source）。
  'EMAIL_DATA_SOURCE_ID',
  'CALENDAR_DATA_SOURCE_ID',
  'NOTION_WORKSPACE_ID',
  'NOTION_WORKSPACE_NAME'
]

/** 「已连接（OAuth）」判据 —— design.md v2「UI 状态」：token 已设（secret key 在
 *  env:get 里恒为掩码 `***`，故只判非空）**且** workspace id 非空 **且** 邮件库 ID
 *  非空。只看 workspace name 会把陈旧 / 半配置状态显示成已连接。 */
export function isNotionOauthConnected(values: Record<string, string | undefined>): boolean {
  const nonEmpty = (k: string): boolean => (values[k] ?? '').trim() !== ''
  return (
    nonEmpty('NOTION_TOKEN') && nonEmpty('NOTION_WORKSPACE_ID') && nonEmpty('EMAIL_DATABASE_ID')
  )
}
