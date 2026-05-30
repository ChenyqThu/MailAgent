// Onboarding IPC client — typed wrappers over window.electron.ipcRenderer.invoke
// for every onboarding:* channel (contract owned by Lane 2 / handlers/onboarding.ts).
//
// Defensive by design: getInvoke() throws a clear error if the preload bridge is
// missing (same pattern as OnboardingPage.tsx / shared/api/ElectronApi.ts). Each
// wrapper preserves the channel's documented shape; callers add their own
// try/catch + graceful-degradation fallbacks (the wizard must never white-screen
// when a single channel errors).

export type Status = 'pass' | 'fail' | 'warn'

type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

/** Resolve the preload-exposed invoke fn or throw — mirrors the existing
 *  OnboardingPage.tsx defensive pattern so a missing preload surfaces an
 *  explicit message instead of "cannot read property 'invoke' of undefined". */
function getInvoke(): IpcInvoke {
  const w = window as unknown as { electron?: { ipcRenderer?: { invoke?: IpcInvoke } } }
  const fn = w.electron?.ipcRenderer?.invoke
  if (typeof fn !== 'function') {
    throw new Error(
      'onboarding IPC: window.electron.ipcRenderer.invoke missing — preload not loaded?'
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
}

export interface CompleteResult {
  ok: boolean
  ready?: boolean
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

export function syncProgress(): Promise<SyncProgressResult> {
  return getInvoke()('onboarding:syncProgress') as Promise<SyncProgressResult>
}

export function complete(cfg: CompleteConfig): Promise<CompleteResult> {
  return getInvoke()('onboarding:complete', cfg) as Promise<CompleteResult>
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
