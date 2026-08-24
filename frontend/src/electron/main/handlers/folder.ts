// 多文件夹同步 (P3/P4/P5) — folder handler.
//
// discover/whitelist/manage/cleanup 经 daemonRequest 转发到本机 serve-api
// in-process service (D1 架构, 注本地 token), 与远程 web 的 HttpApi 同 wire。
// serve-api 对非 davmail 后端返回 400 E_INVALID_ARG → daemonRequest 抛 ApiError{code}
// → envelopeFromCli 收成 {ok:false,code} 过 IPC → ElectronApi.unwrap 重抛带 code
// → FolderPicker 据此切门控态。

import { ipcMain } from 'electron'

import { daemonRead, daemonRequest } from '../daemon_api'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'
import type {
  FolderApi,
  FolderCleanupResult,
  FolderDiscoverResult,
  FolderManageResult,
  FolderPref,
  FolderPrefPatch,
  FolderPrefsResult,
  FolderSetWhitelistResult,
  FolderWhitelistResult
} from '@shared/api/types'

// ---- 多文件夹同步 (P3) — discover/whitelist (daemon → serve-api 转发) ---------
//
// 这三个不直读 SQLite (discover 要现连 IMAP LIST, whitelist 读/写 .env), 故经
// daemon 转发到本机 serve-api in-process service (D1 架构, 注本地 token), 与远程 web
// 的 HttpApi 同 wire。serve-api 对非 davmail 后端返回 400 E_INVALID_ARG → 抛
// ApiError{code} → envelopeFromCli 收成 {ok:false,code} 过 IPC → ElectronApi.unwrap
// 重抛带 code → FolderPicker 据此切门控态。
//
// 🔴 两个读走 daemonRead (E_NETWORK 重试一次), 写仍走 daemonRequest: 冷启时 renderer
// 比 serve-api 先起, 而侧边栏文件夹树在开窗那一瞬就发 whitelist —— 首拉打空则整段树
// 不渲染。业务错误 (上面那条 E_INVALID_ARG) 不重试, 门控态不被拖慢。

// counts 默认 false, 对齐 serve-api / imap_client 新默认 (issue #45: 大邮箱逐文件夹
// STATUS 分钟级); 显式 counts:true 仍可 opt-in。
// refresh 默认 false = 吃 serve-api 的 60s TTL 缓存; true 穿透强制真连 IMAP
// (设置页文件夹管理的手动刷新 / CRUD 后 refetch)。
export function runFolderDiscover(counts = false, refresh = false): Promise<FolderDiscoverResult> {
  return daemonRead<FolderDiscoverResult>('/folder/discover', {
    query: { counts, refresh }
  })
}

export function runFolderGetWhitelist(): Promise<FolderWhitelistResult> {
  return daemonRead<FolderWhitelistResult>('/folder/whitelist')
}

export function runFolderSetWhitelist(imapNames: string[]): Promise<FolderSetWhitelistResult> {
  return daemonRequest<FolderSetWhitelistResult>('PUT', '/folder/whitelist', {
    body: { folders: imapNames }
  })
}

// 文件夹管理 (P4) — 新建/重命名/删除。daemon → serve-api `POST|PATCH|DELETE
// /folder/manage` 转发 (davmail-only, 回写真实 Exchange + 本地副本)。非 davmail /
// 失败 → serve-api 抛 ApiError{code} → envelopeFromCli 收成 {ok:false,code} 过 IPC。

export function runFolderCreate(
  parentImapName: string | null,
  name: string
): Promise<FolderManageResult> {
  // serve-api `_FolderCreateBody.parent: str = ""` (空串 = 顶层); null 会被 Pydantic
  // 拒成 422, 故顶层 (null) 归一化为空串。
  return daemonRequest<FolderManageResult>('POST', '/folder/manage', {
    body: { parent: parentImapName ?? '', name }
  })
}

export function runFolderRename(imapName: string, newName: string): Promise<FolderManageResult> {
  return daemonRequest<FolderManageResult>('PATCH', '/folder/manage', {
    body: { imap_name: imapName, new_name: newName }
  })
}

export function runFolderManageDelete(imapName: string): Promise<FolderManageResult> {
  return daemonRequest<FolderManageResult>('DELETE', '/folder/manage', {
    body: { imap_name: imapName }
  })
}

// 本地副本清理 (P5) — POST /folder/cleanup {imap_name}。
// 不碰 Exchange, 仅删本地已同步邮件 + 从白名单移除; 非 davmail 也可。
export function runFolderCleanup(imapName: string): Promise<FolderCleanupResult> {
  return daemonRequest<FolderCleanupResult>('POST', '/folder/cleanup', {
    body: { imap_name: imapName }
  })
}

// ---- IPC wiring -------------------------------------------------------------

export function registerFolderHandlers(): void {
  // 多文件夹同步 (P3) — discover/whitelist。daemon → serve-api 转发, envelope 形态
  // 过 IPC 保住 error.code (davmail 门控)。
  ipcMain.handle(
    'folder:discover',
    async (
      _evt,
      opts?: { counts?: boolean; refresh?: boolean }
    ): Promise<WriteEnvelope<FolderDiscoverResult>> =>
      envelopeFromCli<FolderDiscoverResult>(
        runFolderDiscover(opts?.counts ?? false, opts?.refresh ?? false)
      )
  )
  ipcMain.handle(
    'folder:getWhitelist',
    async (): Promise<WriteEnvelope<FolderWhitelistResult>> =>
      envelopeFromCli<FolderWhitelistResult>(runFolderGetWhitelist())
  )
  ipcMain.handle(
    'folder:setWhitelist',
    async (_evt, imapNames: unknown): Promise<WriteEnvelope<FolderSetWhitelistResult>> => {
      if (!Array.isArray(imapNames) || !imapNames.every((n) => typeof n === 'string')) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:setWhitelist requires string[]'
        }
      }
      return envelopeFromCli<FolderSetWhitelistResult>(runFolderSetWhitelist(imapNames))
    }
  )

  // 文件夹管理 (P4) — 新建/重命名/删除。daemon → serve-api /folder/manage 转发,
  // envelope 形态过 IPC 保住 error.code (非 davmail / Exchange 失败)。
  ipcMain.handle(
    'folder:create',
    async (_evt, parent: unknown, name: unknown): Promise<WriteEnvelope<FolderManageResult>> => {
      if ((parent !== null && typeof parent !== 'string') || typeof name !== 'string') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:create requires (parent: string|null, name: string)'
        }
      }
      if (name.trim() === '') {
        return { ok: false, code: 'E_INVALID_ARG', message: 'folder:create name must be non-empty' }
      }
      return envelopeFromCli<FolderManageResult>(runFolderCreate(parent, name))
    }
  )
  ipcMain.handle(
    'folder:rename',
    async (
      _evt,
      imapName: unknown,
      newName: unknown
    ): Promise<WriteEnvelope<FolderManageResult>> => {
      if (typeof imapName !== 'string' || typeof newName !== 'string') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:rename requires (imapName: string, newName: string)'
        }
      }
      if (newName.trim() === '') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:rename newName must be non-empty'
        }
      }
      return envelopeFromCli<FolderManageResult>(runFolderRename(imapName, newName))
    }
  )
  ipcMain.handle(
    'folder:manageDelete',
    async (_evt, imapName: unknown): Promise<WriteEnvelope<FolderManageResult>> => {
      if (typeof imapName !== 'string' || imapName.trim() === '') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:manageDelete requires a non-empty imapName'
        }
      }
      return envelopeFromCli<FolderManageResult>(runFolderManageDelete(imapName))
    }
  )

  // 本地副本清理 (P5) — daemon → serve-api POST /folder/cleanup 转发。
  // 不碰 Exchange; 非 davmail 也可 (纯本地操作)。
  ipcMain.handle(
    'folder:cleanup',
    async (_evt, imapName: unknown): Promise<WriteEnvelope<FolderCleanupResult>> => {
      if (typeof imapName !== 'string' || imapName.trim() === '') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:cleanup requires a non-empty imapName'
        }
      }
      return envelopeFromCli<FolderCleanupResult>(runFolderCleanup(imapName))
    }
  )

  // per-folder 配置 (v62) — 图标 + 通知开关 + AI 开关。纯本地, 非 davmail 也可。
  ipcMain.handle(
    'folder:getPrefs',
    async (): Promise<WriteEnvelope<FolderPrefsResult>> =>
      envelopeFromCli<FolderPrefsResult>(runFolderGetPrefs())
  )
  ipcMain.handle(
    'folder:setPref',
    async (_evt, imapName: unknown, patch: unknown): Promise<WriteEnvelope<FolderPref>> => {
      if (typeof imapName !== 'string' || imapName.trim() === '') {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:setPref requires a non-empty imapName'
        }
      }
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'folder:setPref requires a patch object'
        }
      }
      return envelopeFromCli<FolderPref>(runFolderSetPref(imapName, patch as FolderPrefPatch))
    }
  )
}

// per-folder 配置 (v62) — GET|PUT /folder/prefs。纯本地 SQLite 读写, 不 davmail-gated
// (同 cleanup 的口径), 但仍走 daemon → serve-api: 配置的唯一写面在后端 service, 主进程
// 不直连 SQLite 写它 (否则与 mail-sync 的热读之间多一个 writer)。

export function runFolderGetPrefs(): Promise<FolderPrefsResult> {
  return daemonRequest<FolderPrefsResult>('GET', '/folder/prefs')
}

export function runFolderSetPref(imapName: string, patch: FolderPrefPatch): Promise<FolderPref> {
  // 🔴 patch 原样透传: 省略的字段后端保持原值, `icon: null` 是**清除图标**。
  // 不要在这里补默认值 —— 补了就把"没改的项"变成"改成默认值"。
  return daemonRequest<FolderPref>('PUT', '/folder/prefs', {
    body: { imap_name: imapName, ...patch }
  })
}

// Test escape hatch (mirrors handlers/calendar.ts __testing).
export const __testing = {
  runFolderDiscover,
  runFolderGetWhitelist,
  runFolderSetWhitelist,
  runFolderCreate,
  runFolderRename,
  runFolderManageDelete,
  runFolderCleanup,
  runFolderGetPrefs,
  runFolderSetPref
}

// Re-export the renderer-facing type so test / other modules can import from
// the handler (parity with calendar.ts re-exports).
export type { FolderApi }
