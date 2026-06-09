// Onboarding IPC client — typed wrappers over window.electron.ipcRenderer.invoke
// for every onboarding:* channel (contract owned by Lane 2 / handlers/onboarding.ts).
//
// Defensive by design: getInvoke() returns a REJECTING stub when the preload
// bridge is missing (never throws synchronously) so callers' .catch() paths see
// it. Each wrapper preserves the channel's documented shape; callers add their
// own try/catch + graceful-degradation fallbacks (the wizard must never
// white-screen when a single channel errors or the preload is absent).

import type { FolderDiscoverResult, FolderSetWhitelistResult } from '@shared/api/types'

export type Status = 'pass' | 'fail' | 'warn'

type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

/** Resolve the preload-exposed invoke fn, or — when the preload bridge is
 *  missing — return a stub that *rejects* (never throws synchronously).
 *
 *  Why a rejecting stub instead of throwing: every wrapper is called as
 *  `getInvoke()(channel)` *inside* a `void ipc.X().then().catch()` chain, often
 *  from a useEffect. A synchronous throw here fires BEFORE the returned Promise
 *  exists, so the chained `.catch()` can't see it — the exception bubbles as a
 *  React render-phase error and (with no ErrorBoundary) white-screens the whole
 *  onboarding window. Returning a rejecting invoke routes the missing-preload
 *  case through the SAME `.catch()` graceful-degradation paths the wizard
 *  already has (StepFDA degradeToWarn / StepConfig setAccounts([]) / syncProgress
 *  silent), so a broken preload degrades instead of dead-ending. */
function getInvoke(): IpcInvoke {
  const w = window as unknown as { electron?: { ipcRenderer?: { invoke?: IpcInvoke } } }
  const fn = w.electron?.ipcRenderer?.invoke
  if (typeof fn !== 'function') {
    return () =>
      Promise.reject(
        new Error(
          'onboarding IPC: window.electron.ipcRenderer.invoke missing — preload not loaded?'
        )
      )
  }
  return fn
}

// ─── Channel response shapes (match CONTRACT in handlers/onboarding.ts) ──────

export type UserState = 'new' | 'config-incomplete' | 'configured'

export interface StatusResult {
  state: UserState
}

export interface CheckEnvResult {
  os: Status
  pythonRuntime: Status
  dataWritable: Status
  fda: Status
  automation: Status
}

export type PrivacyPane = 'AllFiles' | 'Automation'

export interface OpenPrivacyPaneResult {
  ok: boolean
}

export interface ListMailAccountsResult {
  accounts: string[]
  mailboxes: string[]
  error?: string
}

/** onboarding:detectDavmail — TCP 探 davmail 桥 (IMAP/SMTP) + best-effort 从老 .env
 *  读预填值。cipher 绝不明文回传, 只回 detected.hasCipher boolean。 */
export interface DetectDavmailResult {
  bridgeUp: boolean
  imapReachable: boolean
  smtpReachable: boolean
  host: string
  imapPort: number
  smtpPort: number
  detected: {
    host?: string
    imapPort?: number
    smtpPort?: number
    pocMode?: boolean
    hasCipher?: boolean
    userEmail?: string
  }
}

export interface SyncProgressResult {
  exists: boolean
  total: number
  byStatus: Record<string, number>
  synced: number
  dbVersion: number | null
  ready: boolean
}

export interface IpcError {
  code: string
  message: string
}

/** Backend selection — mirrors config.py MAILAGENT_BACKEND value domain. */
export type BackendKind = 'applescript' | 'davmail'

/** Plugin keys the wizard collects (core 'notion' is always on, not sent). */
export interface PluginFlags {
  agent?: boolean
  island?: boolean
  llm?: boolean
  digest?: boolean
  calendar?: boolean
  [key: string]: boolean | undefined
}

export interface CompleteConfig {
  NOTION_TOKEN: string
  EMAIL_DATABASE_ID: string
  USER_EMAIL: string
  CALENDAR_DATABASE_ID?: string
  MAIL_ACCOUNT_NAME?: string
  MAILAGENT_BACKEND: BackendKind
  /** comma-joined mailbox list, e.g. "收件箱,已发送" */
  SYNC_MAILBOXES?: string
  plugins?: PluginFlags
  // — DavMail 连接配置 (仅 davmail 后端时携带; handler 在 applescript 模式忽略)。
  DAVMAIL_HOST?: string
  DAVMAIL_IMAP_PORT?: string
  DAVMAIL_SMTP_PORT?: string
  DAVMAIL_POC_MODE?: 'true' | 'false'
  DAVMAIL_POC_CIPHER_KEY?: string
}

export interface CompleteResult {
  ok: boolean
  ready?: boolean
  error?: IpcError
}

/** commitConfig: 写核心 .env (无 plugin flag) + 起后端, 不 reload。 */
export type CommitConfigResult = CompleteResult

/** finalize 入参: 仅插件勾选 (核心配置已由 commitConfig 写过)。 */
export interface FinalizeArg {
  plugins?: PluginFlags
}

export interface FinalizeResult {
  ok: boolean
  error?: IpcError
}

export interface DetectLegacyResult {
  found: boolean
  oldDataPath?: string
  dbVersion?: number | null
  emailCount?: number
  sizeBytes?: number
  hasConfig?: boolean
}

export interface LegacyInheritResult {
  ok: boolean
  backupPath?: string
  error?: IpcError
}

export interface LegacyMigrateResult {
  ok: boolean
  dbVersionBefore?: number | null
  dbVersionAfter?: number | null
  ready?: boolean
  error?: IpcError
}

export interface VerifyCheck {
  key: string
  label: string
  pass: boolean
}

export interface LegacyVerifyResult {
  verified: boolean
  checks: VerifyCheck[]
  emailCount?: number
}

export interface LegacyRollbackResult {
  ok: boolean
  error?: IpcError
}

export interface BootBackendResult {
  ok: boolean
  ready?: boolean
  error?: IpcError
}

// ─── Typed wrappers ──────────────────────────────────────────────────────────

export function status(): Promise<StatusResult> {
  return getInvoke()('onboarding:status') as Promise<StatusResult>
}

export function checkEnv(): Promise<CheckEnvResult> {
  return getInvoke()('onboarding:checkEnv') as Promise<CheckEnvResult>
}

export function openPrivacyPane(pane: PrivacyPane): Promise<OpenPrivacyPaneResult> {
  return getInvoke()('onboarding:openPrivacyPane', { pane }) as Promise<OpenPrivacyPaneResult>
}

export function listMailAccounts(): Promise<ListMailAccountsResult> {
  return getInvoke()('onboarding:listMailAccounts') as Promise<ListMailAccountsResult>
}

/** 探 davmail 桥 (IMAP/SMTP TCP 可达) + 从老 .env best-effort 预填。davmail 分支
 *  StepConfig 进入时调一次。arg 省略 → 默认 127.0.0.1/1143/1025。 */
export function detectDavmail(arg?: {
  host?: string
  imapPort?: number
  smtpPort?: number
}): Promise<DetectDavmailResult> {
  return getInvoke()('onboarding:detectDavmail', arg) as Promise<DetectDavmailResult>
}

export function syncProgress(): Promise<SyncProgressResult> {
  return getInvoke()('onboarding:syncProgress') as Promise<SyncProgressResult>
}

export function complete(cfg: CompleteConfig): Promise<CompleteResult> {
  return getInvoke()('onboarding:complete', cfg) as Promise<CompleteResult>
}

/** 写核心 .env + 起后端 (不 reload)。NEW flow 在 StepConfig "开始同步" 时调,
 *  让后端先起, StepSync 才能轮询真实进度。handler 经 buildCoreConfigPatch 剔除
 *  plugin flag, 所以传整个 cfg 也只落核心键。 */
export function commitConfig(cfg: CompleteConfig): Promise<CommitConfigResult> {
  return getInvoke()('onboarding:commitConfig', cfg) as Promise<CommitConfigResult>
}

/** 写 plugin flag + reload 进 app。NEW flow 在 StepDone "进入收件箱" 时调。 */
export function finalize(plugins?: PluginFlags): Promise<FinalizeResult> {
  return getInvoke()('onboarding:finalize', { plugins }) as Promise<FinalizeResult>
}

export function detectLegacy(): Promise<DetectLegacyResult> {
  return getInvoke()('onboarding:detectLegacy') as Promise<DetectLegacyResult>
}

export function legacyInherit(cfg?: CompleteConfig): Promise<LegacyInheritResult> {
  return getInvoke()('onboarding:legacyInherit', cfg) as Promise<LegacyInheritResult>
}

export function legacyMigrate(): Promise<LegacyMigrateResult> {
  return getInvoke()('onboarding:legacyMigrate') as Promise<LegacyMigrateResult>
}

export function legacyVerify(): Promise<LegacyVerifyResult> {
  return getInvoke()('onboarding:legacyVerify') as Promise<LegacyVerifyResult>
}

export function legacyRollback(): Promise<LegacyRollbackResult> {
  return getInvoke()('onboarding:legacyRollback') as Promise<LegacyRollbackResult>
}

export function bootBackend(): Promise<BootBackendResult> {
  return getInvoke()('onboarding:bootBackend') as Promise<BootBackendResult>
}

/** 纯切界面: 主进程 reload 窗口去掉 ?onboarding=1, 不碰后端/数据。所有"进入主界面"
 *  的逃生口走它 (e.g. bootBackend hang 后"直接完成") —— 不像 bootBackend 会 waitReady
 *  可能 hang, enterApp 是同步 reload 必定生效。 */
export function enterApp(): Promise<{ ok: boolean }> {
  return getInvoke()('onboarding:enterApp') as Promise<{ ok: boolean }>
}

// ─── 多文件夹同步 (P4) — onboarding 「选择文件夹」步骤 ──────────────────────────
//
// 复用 handlers/folder.ts 已注册的 folder:discover / folder:setWhitelist 通道
// (davmail-only, Main→daemon→serve-api 转发)。这些通道返回 WriteEnvelope 形态
// ({ok,data} / {ok:false,code,message}) 以跨 IPC 保住 error.code, 故这里 unwrap:
// 成功 → data; 失败 → throw 带 .code 的 Error。非 davmail 后端 → code='E_INVALID_ARG',
// StepFolders 据此走门控态 (整步可跳过)。

interface FolderEnvelope<T> {
  ok: boolean
  data?: T
  code?: string
  message?: string
}

function unwrapFolderEnvelope<T>(raw: unknown): T {
  const env = raw as FolderEnvelope<T> | null
  if (env && env.ok === true) return env.data as T
  const err = new Error(env?.message ?? 'folder IPC failed')
  if (env?.code) (err as Error & { code?: string }).code = env.code
  throw err
}

/** 拉文件夹树 (davmail-only)。失败抛带 .code 的 Error (非 davmail = E_INVALID_ARG)。 */
export function discoverFolders(counts = true): Promise<FolderDiscoverResult> {
  return getInvoke()('folder:discover', { counts }).then((raw) =>
    unwrapFolderEnvelope<FolderDiscoverResult>(raw)
  )
}

/** 覆盖式保存白名单 (imap 原始名)。返回去重排序结果 + restart_required。 */
export function setFolderWhitelist(imapNames: string[]): Promise<FolderSetWhitelistResult> {
  return getInvoke()('folder:setWhitelist', imapNames).then((raw) =>
    unwrapFolderEnvelope<FolderSetWhitelistResult>(raw)
  )
}
