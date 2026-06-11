// Onboarding IPC (打包 P2/P3 — 完整向导 + 老数据迁移)。
//
// 渲染层经 window.electron.ipcRenderer.invoke(channel, arg?) 调用; renderer 也可经
// ?onboarding=1 query 直接进向导。所有 handler 必须 defensive —— 绝不向 IPC 边界
// 抛异常, 失败一律返回 error 对象或契约约定的 zero/empty 形状。
//
// 频道一览:
//   onboarding:status        → 当前用户状态 (new | config-incomplete | configured)
//   onboarding:checkEnv      → 环境体检 (os / pythonRuntime / dataWritable / fda / automation)
//   onboarding:openPrivacyPane → 打开系统设置隐私面板 (AllFiles / Automation)
//   onboarding:listMailAccounts → 列 Mail.app 账户 + mailbox (走 CLI debug mail-structure)
//   onboarding:detectDavmail → TCP 探 davmail 桥 (IMAP/SMTP) + best-effort 从老 .env 预填
//   onboarding:syncProgress  → 同步进度 (readonly 直读 sync_store.db)
//   onboarding:complete      → 写 .env (必填 + backend + 邮箱 + 插件 flag) + 起后端 + reload
//
//   --- LEGACY 全量迁移 (SAFE COPY 模型: 老数据原件永不修改) ---
//   onboarding:detectLegacy  → 探测 ~/Documents/MailAgent 老数据
//   onboarding:legacyInherit → 复制老 data/ → 新 DATA_ROOT/data (含 double-writer 守卫 + 备份)
//   onboarding:legacyMigrate → 起后端让其自动迁移 schema 到 v17
//   onboarding:legacyVerify  → 校验迁移后 db_version / 表 / 行数
//   onboarding:legacyRollback→ 停后端 + 删 COPY + 清 .env (回到 'new'); 老原件不动
//   onboarding:bootBackend   → 仅起后端 + 等就绪 (不写 .env)
//
// 完整向导 PRD 见 docs/packaging/03-onboarding-prd.md。

import { BrowserWindow, app, ipcMain, shell } from 'electron'
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { createConnection } from 'net'
import { homedir, release as osRelease } from 'os'
import { join, resolve as resolvePath, sep } from 'path'

import Database from 'better-sqlite3'

import {
  EXPECTED_DB_VERSION,
  REQUIRED_TABLES,
  getBackendLifecycle,
  probeDbReady,
  registerBackendQuitHook,
  resolveApiPort
} from '../backend_lifecycle'
import { callCli, getMailagentBin } from '../cli_runner'
import { getDb, resolveDataRoot, resolveDbPath } from '../db'
import { ensureCliApiKey } from '../lib/cli-api-key'
import { ensureOutboxEnabled } from '../lib/outbox-default'
import { MANAGED_ENV_KEY_SET } from '../lib/env-keys'
import { resolveEnvPath } from '../lib/env-path'
import { MAIN_WINDOW } from '../lib/window-config'
import { detectUserState, ONBOARDING_REQUIRED_KEYS } from '../onboarding/detect'
import { writePatch } from './env'

// ---------------------------------------------------------------------------
// 共享类型 (renderer lane 据此对齐 IPC 形状)
// ---------------------------------------------------------------------------

/** 三态健康灯。pass=绿, warn=黄 (不可靠/不阻断), fail=红。 */
export type Status = 'pass' | 'fail' | 'warn'

export interface CheckEnvResult {
  os: Status
  pythonRuntime: Status
  dataWritable: Status
  fda: Status
  automation: Status
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

export interface OnboardingResult {
  ok: boolean
  ready?: boolean
  error?: { code: string; message: string }
}

export interface PrivacyPaneResult {
  ok: boolean
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
  error?: { code: string; message: string }
}

export interface LegacyMigrateResult {
  ok: boolean
  dbVersionBefore?: number | null
  dbVersionAfter?: number | null
  ready?: boolean
  error?: { code: string; message: string }
}

export interface LegacyVerifyCheck {
  key: string
  label: string
  pass: boolean
}

export interface LegacyVerifyResult {
  verified: boolean
  checks: LegacyVerifyCheck[]
  emailCount?: number
}

export interface LegacyRollbackResult {
  ok: boolean
  error?: { code: string; message: string }
}

/** onboarding:complete 配置对象 (renderer → main)。 */
export interface OnboardingCompleteCfg {
  NOTION_TOKEN?: string
  EMAIL_DATABASE_ID?: string
  USER_EMAIL?: string
  CALENDAR_DATABASE_ID?: string
  MAIL_ACCOUNT_NAME?: string
  MAILAGENT_BACKEND?: 'applescript' | 'davmail'
  SYNC_MAILBOXES?: string
  plugins?: Partial<Record<PluginKey, boolean>>
  // — DavMail 连接配置 (仅 MAILAGENT_BACKEND==='davmail' 时落 patch)。host/port 非空
  //   才写; POC_MODE 总写 'true'/'false'; cipher 仅非空写。
  DAVMAIL_HOST?: string
  DAVMAIL_IMAP_PORT?: string
  DAVMAIL_SMTP_PORT?: string
  DAVMAIL_POC_MODE?: 'true' | 'false'
  DAVMAIL_POC_CIPHER_KEY?: string
}

/** onboarding:detectDavmail 结果 (renderer ↔ main)。bridgeUp = IMAP 端口可达。
 *  detected = best-effort 从老 .env 读出的预填值; cipher 绝不明文回传, 只回 hasCipher。 */
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

// ---------------------------------------------------------------------------
// 纯逻辑 helper (导出供 vitest 单测)
// ---------------------------------------------------------------------------

/** 向导可写入 .env 的核心 key (必填 + 可选账户字段)。都在 MANAGED_ENV_KEYS
 *  白名单内; writePatch 会再校验一次。backend / SYNC_MAILBOXES / plugin flag
 *  另行通过 buildCompletePatch 合入。 */
export const ONBOARDING_WRITABLE_KEYS = [
  'NOTION_TOKEN',
  'EMAIL_DATABASE_ID',
  'CALENDAR_DATABASE_ID',
  'USER_EMAIL',
  'MAIL_ACCOUNT_NAME'
] as const

export type PluginKey = 'agent' | 'island' | 'llm' | 'digest' | 'calendar'

/** 插件勾选 → config.py env flag。值写 'true'/'false' 字符串 (pydantic bool 解析)。 */
export const PLUGIN_FLAG_MAP: Record<PluginKey, string> = {
  agent: 'MAILAGENT_AGENT_HARNESS',
  island: 'PING_ISLAND_ENABLED',
  llm: 'LLM_AGENT_ENABLED',
  digest: 'MAILAGENT_DAILY_DIGEST_ENABLED',
  calendar: 'CALENDAR_CALDAV_SYNC_ENABLED'
}

/**
 * 把向导 cfg 编译成 writePatch 的 patch (managed key 子集)。纯函数 —— 不碰文件,
 * 便于单测覆盖 backend / SYNC_MAILBOXES / plugin→flag 的映射。
 *
 * 返回 { patch, missing }: missing 是缺失的必填 key 列表 (调用方据此短路)。
 */
export function buildCompletePatch(cfg: OnboardingCompleteCfg): {
  patch: Record<string, string>
  missing: string[]
} {
  const patch: Record<string, string> = {}

  // 1) 核心账户字段 (trim, 空串丢弃)。
  for (const key of ONBOARDING_WRITABLE_KEYS) {
    const v = (cfg as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim() !== '') patch[key] = v.trim()
  }

  // 2) backend (默认 applescript; 只接受白名单两值, 否则回落默认避免写脏值)。
  const backend = cfg.MAILAGENT_BACKEND
  const isDavmail = backend === 'davmail'
  patch['MAILAGENT_BACKEND'] = isDavmail ? 'davmail' : 'applescript'

  // 3) SYNC_MAILBOXES (逗号拼接的字符串, 直接透传 trim)。
  if (typeof cfg.SYNC_MAILBOXES === 'string' && cfg.SYNC_MAILBOXES.trim() !== '') {
    patch['SYNC_MAILBOXES'] = cfg.SYNC_MAILBOXES.trim()
  }

  // 4) DavMail 连接配置 (仅 davmail 模式写; applescript 模式完全不碰这些 key)。
  //    host/port 非空才写; POC_MODE 总写 'true'/'false' (pydantic bool); cipher 仅非空写。
  if (isDavmail) {
    for (const key of ['DAVMAIL_HOST', 'DAVMAIL_IMAP_PORT', 'DAVMAIL_SMTP_PORT'] as const) {
      const v = cfg[key]
      if (typeof v === 'string' && v.trim() !== '') patch[key] = v.trim()
    }
    patch['DAVMAIL_POC_MODE'] = cfg.DAVMAIL_POC_MODE === 'true' ? 'true' : 'false'
    const cipher = cfg.DAVMAIL_POC_CIPHER_KEY
    if (typeof cipher === 'string' && cipher.trim() !== '') {
      patch['DAVMAIL_POC_CIPHER_KEY'] = cipher.trim()
    }
  }

  // 5) 插件 flag (显式写 true/false, 让向导能关掉之前开过的项)。
  const plugins = cfg.plugins ?? {}
  for (const pk of Object.keys(PLUGIN_FLAG_MAP) as PluginKey[]) {
    const flagKey = PLUGIN_FLAG_MAP[pk]
    patch[flagKey] = plugins[pk] === true ? 'true' : 'false'
  }

  // 6) 必填校验。两后端都要核心三项 (NOTION_TOKEN/EMAIL_DATABASE_ID/USER_EMAIL)。
  //    davmail 额外要求一种认证方式 (POC 默认密钥 或 非空 cipher), 否则
  //    DavMailConnectionError —— 加一项可读 missing 提示。
  const missing: string[] = ONBOARDING_REQUIRED_KEYS.filter((k) => !patch[k])
  if (isDavmail) {
    const hasAuth = patch['DAVMAIL_POC_MODE'] === 'true' || !!patch['DAVMAIL_POC_CIPHER_KEY']
    if (!hasAuth) missing.push('DAVMAIL_AUTH')
  }
  return { patch, missing }
}

/**
 * 把向导 cfg 编译成"仅核心键"的 patch —— 不含 plugin flag (插件由 finalize 阶段
 * 单独写)。给 commitConfig (NEW flow 提交时机前移: StepConfig 起后端就只落核心
 * 配置, 让 StepSync 能轮询真实进度; 插件勾选留到 StepDone 的 finalize 再写)。
 *
 * 复用 buildCompletePatch 的核心键逻辑 (账户字段 / backend / SYNC_MAILBOXES),
 * 仅剔除 PLUGIN_FLAG_MAP 派生的 flag, 避免重复实现。buildCompletePatch 本体保留
 * (handleComplete + legacyInherit + 单测仍用)。
 *
 * 返回 { patch, missing }: missing 是缺失的必填 key 列表 (调用方据此短路)。
 */
export function buildCoreConfigPatch(cfg: OnboardingCompleteCfg): {
  patch: Record<string, string>
  missing: string[]
} {
  const { patch, missing } = buildCompletePatch(cfg)
  const corePatch: Record<string, string> = {}
  const pluginFlagSet = new Set(Object.values(PLUGIN_FLAG_MAP))
  for (const k of Object.keys(patch)) {
    if (!pluginFlagSet.has(k)) corePatch[k] = patch[k]
  }
  return { patch: corePatch, missing }
}

/**
 * 把插件勾选编译成 plugin flag patch (finalize 阶段写)。显式 true/false, 让
 * 用户在 StepPlugins 关掉某项时也能落地。
 */
export function buildPluginPatch(
  plugins: Partial<Record<PluginKey, boolean>> | undefined
): Record<string, string> {
  const patch: Record<string, string> = {}
  const p = plugins ?? {}
  for (const pk of Object.keys(PLUGIN_FLAG_MAP) as PluginKey[]) {
    patch[PLUGIN_FLAG_MAP[pk]] = p[pk] === true ? 'true' : 'false'
  }
  return patch
}

/**
 * Double-writer 守卫判据 (纯函数, 便于单测)。老 data 目录的 sync_store.db-wal
 * 若存在且 mtime 在最近 windowMs 内 → 判定老后端可能仍在运行, 拒绝继承。
 *
 * @param walMtimeMs WAL 文件 mtimeMs; null 表示 WAL 不存在 (放行)。
 * @param nowMs      当前 wall-clock (可注入便于单测)。
 * @param windowMs   时间窗 (默认 120s)。
 */
export function isLikelyDoubleWriter(
  walMtimeMs: number | null,
  nowMs: number = Date.now(),
  windowMs = 120_000
): boolean {
  if (walMtimeMs == null) return false
  return nowMs - walMtimeMs < windowMs
}

/** 老数据根目录 = ~/Documents/MailAgent (打包前的项目根布局)。 */
export function legacyOldDataPath(): string {
  return join(homedir(), 'Documents', 'MailAgent')
}

/** 老 sync_store.db 绝对路径。 */
function legacyOldDbPath(): string {
  return join(legacyOldDataPath(), 'data', 'sync_store.db')
}

/** 老 .env 绝对路径。 */
function legacyOldEnvPath(): string {
  return join(legacyOldDataPath(), '.env')
}

/** 新数据目的地 data/ 目录 = DATA_ROOT/data。 */
function destDataDir(): string {
  return join(resolveDataRoot(), 'data')
}

// 主进程层 DATA_ROOT/data 操作世代号 (codex review #2 — 进程级竞态防护)。
// 任何"填充 DATA_ROOT/data"的操作 (commitConfig 起后端 / legacyInherit 复制) 完成后 bump 它。
// 慢操作 (legacyRollback) 在真正 rm 前比对世代: 若 DATA_ROOT/data 已被更新的操作重新填充
// (epoch 变了), 放弃 rm —— 防止迟到的回滚删掉用户刚重新配置/继承的数据。
// UI 层的 genRef 只挡渲染层迟到回调, 挡不住主进程进程级竞态, 故在此再加一道。
let _dataEpoch = 0
function bumpDataEpoch(): void {
  _dataEpoch += 1
}

// ---------------------------------------------------------------------------
// LEGACY 安全守卫 (纯路径逻辑导出供单测) —— 任何破坏性操作都不得落到老原件上
// ---------------------------------------------------------------------------

/** child 是否等于 parent 或在 parent 子树内 (绝对路径规范化比较)。 */
export function isPathInside(child: string, parent: string): boolean {
  const c = resolvePath(child)
  const p = resolvePath(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 两路径是否重合 (相等或互相包含) —— COPY 目标绝不可与老原件重合。 */
export function pathsCollide(a: string, b: string): boolean {
  return isPathInside(a, b) || isPathInside(b, a)
}

/**
 * LEGACY 破坏性操作 (inherit/migrate/rollback) 前置守卫。返回 error 对象=拒绝,
 * null=放行。两道闸:
 *   1) 仅打包模式 —— dev 下 resolveDataRoot()=~/Documents/MailAgent 与老原件
 *      重合, 破坏性操作会直接删/盖用户真库, 一律禁用。
 *   2) COPY 目标 (DATA_ROOT/data) 不得与老原件 data/ 路径重合 (防 MAILAGENT_DATA_ROOT
 *      覆盖把两者指到一起)。
 */
function legacyMutationBlock(): { code: string; message: string } | null {
  let packaged = false
  try {
    packaged = app.isPackaged === true
  } catch {
    packaged = false
  }
  if (!packaged) {
    return {
      code: 'E_NOT_PACKAGED',
      message:
        '老数据迁移仅在打包应用中可用。开发模式下数据根与老数据路径重合, 已禁用破坏性操作以保护原始数据。'
    }
  }
  if (pathsCollide(destDataDir(), join(legacyOldDataPath(), 'data'))) {
    return {
      code: 'E_SAME_PATH',
      message: '复制目标与老数据原件路径重合, 拒绝任何破坏性操作 (保护原始数据不被覆盖/删除)。'
    }
  }
  return null
}

/**
 * resolveEnvPath() 是否落在老数据路径之外 (= 独立的可安全写/清的 .env)。
 * 打包态 resolveEnvPath() 仍解析到 ~/Documents/MailAgent/.env (老原件) —— 此时
 * 返回 false, 让 rollback 绝不剥离用户原始配置 (legacyInherit 写 .env 是 additive,
 * 与 complete() 一致, 不算破坏; 真正危险的是 rollback 的清键)。
 */
function envPathSafeToManage(): boolean {
  try {
    return !isPathInside(resolveEnvPath(), legacyOldDataPath())
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// SQLite readonly 小工具 (绝不抛: 失败回 fallback)
// ---------------------------------------------------------------------------

/** 打开一个一次性 readonly 连接执行 fn, finally 必关。db 不存在或出错时返回
 *  fallback。不复用 db.ts 的 getDb() 单例 (legacy 老库是不同文件)。 */
function withReadonlyDb<T>(dbPath: string, fn: (db: Database.Database) => T, fallback: T): T {
  if (!existsSync(dbPath)) return fallback
  let conn: Database.Database | null = null
  try {
    conn = new Database(dbPath, { readonly: true, fileMustExist: true })
    conn.pragma('busy_timeout = 200')
    return fn(conn)
  } catch {
    return fallback
  } finally {
    if (conn) {
      try {
        conn.close()
      } catch {
        /* readonly 短连接 close 失败无所谓, GC 回收。 */
      }
    }
  }
}

/** 读 sync_state.db_version → number | null (绝不抛)。 */
function readDbVersion(db: Database.Database): number | null {
  try {
    const row = db.prepare("SELECT value FROM sync_state WHERE key = 'db_version'").get() as
      | { value?: string }
      | undefined
    return row?.value != null ? Number.parseInt(String(row.value), 10) : null
  } catch {
    return null
  }
}

/** 读 email_metadata 行数 (表缺失/出错 → 0)。 */
function readEmailCount(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM email_metadata').get() as
      | { n?: number }
      | undefined
    return row?.n ?? 0
  } catch {
    return 0
  }
}

/** 递归累加目录大小 (best-effort, 任意子项出错跳过, 不抛)。 */
function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const ent of entries) {
    const p = join(dir, String(ent.name))
    try {
      if (ent.isDirectory()) {
        total += dirSizeBytes(p)
      } else if (ent.isFile()) {
        total += statSync(p).size
      }
    } catch {
      /* 单项 stat 失败 (符号链接/权限) 跳过, 继续累加。 */
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// onboarding:checkEnv
// ---------------------------------------------------------------------------

/** Darwin major 版本号 → number | null (uname release, e.g. '21.6.0' → 21)。
 *  Darwin 21 = macOS 12 (Monterey)。 */
function darwinMajor(): number | null {
  try {
    if (process.platform !== 'darwin') return null
    const major = Number.parseInt(osRelease().split('.')[0] ?? '', 10)
    return Number.isFinite(major) ? major : null
  } catch {
    return null
  }
}

function checkEnv(): CheckEnvResult {
  // os: darwin && Darwin major >= 21 (macOS 12) → pass。
  let os: Status = 'fail'
  const major = darwinMajor()
  if (process.platform === 'darwin' && major != null && major >= 21) os = 'pass'

  // pythonRuntime: getMailagentBin() 解析成功 + 文件存在 → pass。
  let pythonRuntime: Status = 'fail'
  try {
    const bin = getMailagentBin()
    if (bin && existsSync(bin)) pythonRuntime = 'pass'
  } catch {
    pythonRuntime = 'fail'
  }

  // dataWritable: 能在 DATA_ROOT 下 mkdir + 写临时文件 → pass。
  let dataWritable: Status = 'fail'
  try {
    const root = resolveDataRoot()
    mkdirSync(root, { recursive: true })
    const probeDir = mkdtempSync(join(root, '.onboard-write-'))
    const probeFile = join(probeDir, 'probe.tmp')
    writeFileSync(probeFile, 'ok')
    rmSync(probeDir, { recursive: true, force: true })
    dataWritable = 'pass'
  } catch {
    dataWritable = 'fail'
  }

  // fda: 能 R_OK ~/Library/Mail → pass; EACCES/EPERM → fail; ENOENT → warn。
  let fda: Status = 'fail'
  try {
    accessSync(join(homedir(), 'Library', 'Mail'), fsConstants.R_OK)
    fda = 'pass'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') fda = 'warn'
    else fda = 'fail' // EACCES / EPERM / 其它
  }

  // automation: AppleScript 自动化授权无可靠探测手段 → 恒 warn。
  const automation: Status = 'warn'

  return { os, pythonRuntime, dataWritable, fda, automation }
}

// ---------------------------------------------------------------------------
// onboarding:openPrivacyPane
// ---------------------------------------------------------------------------

const PRIVACY_PANE_URL: Record<'AllFiles' | 'Automation', string> = {
  AllFiles: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  Automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
}

async function openPrivacyPane(raw: unknown): Promise<PrivacyPaneResult> {
  try {
    const pane = (raw as { pane?: unknown } | null)?.pane
    if (pane !== 'AllFiles' && pane !== 'Automation') return { ok: false }
    await shell.openExternal(PRIVACY_PANE_URL[pane])
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// onboarding:listMailAccounts
// ---------------------------------------------------------------------------

async function listMailAccounts(): Promise<ListMailAccountsResult> {
  try {
    // callCli 自动前置 ['-o','json'] 并解包 wrapper.data, 所以这里只传子命令。
    // data 形状: { accounts:[{name}], mailboxes:[{name,...}], total_accounts, total_mailboxes }
    const data = (await callCli(['debug', 'mail-structure'], { timeoutMs: 30_000 })) as {
      accounts?: Array<{ name?: string }>
      mailboxes?: Array<{ name?: string }>
    } | null
    const accounts = Array.isArray(data?.accounts)
      ? data!.accounts.map((a) => a?.name).filter((n): n is string => typeof n === 'string')
      : []
    const mailboxes = Array.isArray(data?.mailboxes)
      ? data!.mailboxes.map((m) => m?.name).filter((n): n is string => typeof n === 'string')
      : []
    return { accounts, mailboxes }
  } catch (err) {
    return { accounts: [], mailboxes: [], error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// onboarding:detectDavmail
// ---------------------------------------------------------------------------

/** TCP 探活: 2s 内能 connect 到 host:port → true; error/timeout → false。绝不抛,
 *  务必 destroy socket 释放句柄。davmail 桥探测用 (IMAP 1143 / SMTP 1025)。 */
function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* destroy 失败无所谓, GC 回收。 */
      }
      resolve(ok)
    }
    let socket: ReturnType<typeof createConnection>
    try {
      socket = createConnection({ host, port })
    } catch {
      resolve(false)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** best-effort 从老 ~/Documents/MailAgent/.env 读 davmail 预填值。读不到回空对象。
 *  cipher 绝不明文回传 —— 只回 hasCipher boolean。 */
function readLegacyDavmailHints(): DetectDavmailResult['detected'] {
  const out: DetectDavmailResult['detected'] = {}
  try {
    const p = legacyOldEnvPath()
    if (!existsSync(p)) return out
    const vals = parseEnvValues(readFileSync(p, 'utf8'))
    const host = vals['DAVMAIL_HOST']
    if (host) out.host = host
    const imapPort = Number.parseInt(vals['DAVMAIL_IMAP_PORT'] ?? '', 10)
    if (Number.isFinite(imapPort)) out.imapPort = imapPort
    const smtpPort = Number.parseInt(vals['DAVMAIL_SMTP_PORT'] ?? '', 10)
    if (Number.isFinite(smtpPort)) out.smtpPort = smtpPort
    const pocMode = vals['DAVMAIL_POC_MODE']
    if (pocMode != null) out.pocMode = /^(true|1|yes)$/i.test(pocMode.trim())
    // 新名或旧名任一非空都算"已配 cipher"(预填时提示用户已有密钥, 不必重填)。
    out.hasCipher =
      (vals['DAVMAIL_POC_CIPHER_KEY'] ?? '').trim() !== '' ||
      (vals['DAVMAIL_CIPHER_KEY'] ?? '').trim() !== ''
    const userEmail = vals['USER_EMAIL']
    if (userEmail) out.userEmail = userEmail
  } catch {
    /* 读不了就回已收集的部分 (可能为空), 不抛。 */
  }
  return out
}

/** 解析 .env 文本为 key→value (去成对引号; 含空值)。与 legacyEnvManagedPatch 同口径,
 *  但不过滤空串/managed 白名单 (detected 预填需要原始值含 hasCipher 判定)。 */
function parseEnvValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

async function detectDavmail(raw: unknown): Promise<DetectDavmailResult> {
  // arg 或默认 127.0.0.1/1143/1025。
  const arg =
    typeof raw === 'object' && raw !== null
      ? (raw as { host?: unknown; imapPort?: unknown; smtpPort?: unknown })
      : {}
  const host =
    typeof arg.host === 'string' && arg.host.trim() !== '' ? arg.host.trim() : '127.0.0.1'
  const imapPort = typeof arg.imapPort === 'number' && arg.imapPort > 0 ? arg.imapPort : 1143
  const smtpPort = typeof arg.smtpPort === 'number' && arg.smtpPort > 0 ? arg.smtpPort : 1025

  let imapReachable = false
  let smtpReachable = false
  try {
    ;[imapReachable, smtpReachable] = await Promise.all([
      tcpReachable(host, imapPort),
      tcpReachable(host, smtpPort)
    ])
  } catch {
    imapReachable = false
    smtpReachable = false
  }

  const detected = readLegacyDavmailHints()

  return {
    bridgeUp: imapReachable,
    imapReachable,
    smtpReachable,
    host,
    imapPort,
    smtpPort,
    detected
  }
}

// ---------------------------------------------------------------------------
// onboarding:syncProgress
// ---------------------------------------------------------------------------

function syncProgress(): SyncProgressResult {
  const empty: SyncProgressResult = {
    exists: false,
    total: 0,
    byStatus: {},
    synced: 0,
    dbVersion: null,
    ready: false
  }
  try {
    const dbPath = resolveDbPath()
    if (!existsSync(dbPath)) return empty

    // db_version + ready 走 probeDbReady (同一份就绪判据)。
    const probe = probeDbReady(dbPath)

    // total + byStatus 走 readonly 直读。
    return withReadonlyDb<SyncProgressResult>(
      dbPath,
      (db) => {
        const totalRow = db.prepare('SELECT COUNT(*) AS n FROM email_metadata').get() as
          | { n?: number }
          | undefined
        const total = totalRow?.n ?? 0
        const rows = db
          .prepare(
            'SELECT sync_status AS s, COUNT(*) AS n FROM email_metadata GROUP BY sync_status'
          )
          .all() as Array<{ s?: string; n?: number }>
        const byStatus: Record<string, number> = {}
        for (const r of rows) {
          if (typeof r.s === 'string') byStatus[r.s] = r.n ?? 0
        }
        return {
          exists: true,
          total,
          byStatus,
          synced: byStatus['synced'] ?? 0,
          dbVersion: probe.dbVersion,
          ready: probe.ready
        }
      },
      // readonly 打开失败 (锁/损坏): 至少回 probe 的 dbVersion/ready, 计数清零。
      { ...empty, exists: true, dbVersion: probe.dbVersion, ready: probe.ready }
    )
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// onboarding:complete
// ---------------------------------------------------------------------------

async function handleComplete(
  evt: Electron.IpcMainInvokeEvent,
  raw: unknown
): Promise<OnboardingResult> {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return {
        ok: false,
        error: { code: 'E_INVALID', message: 'onboarding:complete 需要配置对象' }
      }
    }
    const cfg = raw as OnboardingCompleteCfg

    const { patch, missing } = buildCompletePatch(cfg)
    if (missing.length > 0) {
      return { ok: false, error: { code: 'E_MISSING', message: `缺必填项: ${missing.join(', ')}` } }
    }

    // 确保 DATA_ROOT + data/ 存在 (writePatch 不建父目录; 大库附件也落 data/)。
    const dataRoot = resolveDataRoot()
    try {
      mkdirSync(join(dataRoot, 'data'), { recursive: true })
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'E_MKDIR',
          message: `无法创建数据目录 ${dataRoot}: ${(err as Error).message}`
        }
      }
    }

    // 写 .env (writePatch: 缺文件→创建 + mode 0600 + MANAGED_ENV_KEYS 校验)。
    const res = writePatch(patch)
    if (!res.ok) {
      return { ok: false, error: res.error ?? { code: 'E_WRITE', message: '.env 写入失败' } }
    }

    // 补 CLI 写鉴权 key (向导不收集它; 缺失则所有 CLI 写命令 E_AUTH_FAILED)。
    // 必须在起后端前写入 —— Python require_auth 的 expected 读同一份 .env。
    // best-effort: 失败不阻断 onboarding, boot 兜底下次启动会重试。
    ensureCliApiKey()
    // 补 outbox 派发器默认开 (向导不收集它; 缺失则 FanoutWorker 不跑, 旗标/已读
    // 只改本地永不同步到 Exchange/Notion)。同样起后端前写、best-effort。
    ensureOutboxEnabled()

    // 起后端 + 等就绪 (打包模式; dev 走 pm2 不接管, 视为就绪)。
    registerBackendQuitHook()
    const mgr = getBackendLifecycle()
    mgr.start()
    // 后端开始写 DATA_ROOT/data, 标记新世代 (与 commitConfig 一致; 当前 UI 已不调
    // 本 channel, 仅为契约一致性 —— 防未来复用时迟到 rollback 误删)。
    bumpDataEpoch()
    const ready = app.isPackaged ? await mgr.waitReady() : true

    // 切回主界面: reload 窗口去掉 ?onboarding=1 (loadFile 无 search)。
    reloadToMain(evt)

    return { ok: true, ready }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

// ---------------------------------------------------------------------------
// onboarding:commitConfig (NEW flow 提交时机前移: 只写核心 .env + 起后端, 不 reload)
// ---------------------------------------------------------------------------

/**
 * 写核心 .env (必填 + backend + 邮箱 + SYNC_MAILBOXES, 不含 plugin flag) + 建
 * DATA_ROOT/data + 起后端 + 等就绪。**不 reload** —— 向导还要留在 Sync/Plugins/
 * Done 步骤。这样 StepSync 才能轮询到真实后端进度 (旧实现把提交放在最后 StepDone,
 * Sync 步骤时后端根本没起, 进度永远 exists=false)。
 *
 * plugin flag 留给 finalize 阶段 (StepDone "进入收件箱") 再写。
 */
async function commitConfig(raw: unknown): Promise<OnboardingResult> {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return {
        ok: false,
        error: { code: 'E_INVALID', message: 'onboarding:commitConfig 需要配置对象' }
      }
    }
    const cfg = raw as OnboardingCompleteCfg

    const { patch, missing } = buildCoreConfigPatch(cfg)
    if (missing.length > 0) {
      return { ok: false, error: { code: 'E_MISSING', message: `缺必填项: ${missing.join(', ')}` } }
    }

    // 确保 DATA_ROOT + data/ 存在 (writePatch 不建父目录; 大库附件也落 data/)。
    const dataRoot = resolveDataRoot()
    try {
      mkdirSync(join(dataRoot, 'data'), { recursive: true })
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'E_MKDIR',
          message: `无法创建数据目录 ${dataRoot}: ${(err as Error).message}`
        }
      }
    }

    // 写核心 .env (writePatch: 缺文件→创建 + mode 0600 + MANAGED_ENV_KEYS 校验)。
    const res = writePatch(patch)
    if (!res.ok) {
      return { ok: false, error: res.error ?? { code: 'E_WRITE', message: '.env 写入失败' } }
    }

    // 补 CLI 写鉴权 key (向导不收集它; 缺失则 report 开关等 CLI 写命令 E_AUTH_FAILED)。
    // 起后端前写入, Python require_auth 的 expected 读同一份 .env。best-effort。
    ensureCliApiKey()
    // 补 outbox 派发器默认开 (缺失则写操作静默积压, 永不派发)。见 lib/outbox-default。
    ensureOutboxEnabled()

    // 起后端 + 等就绪 (打包模式; dev 走 pm2 不接管, 视为就绪)。
    registerBackendQuitHook()
    const mgr = getBackendLifecycle()
    mgr.start()
    // 后端开始写 DATA_ROOT/data, 标记新世代 —— 若用户随后返回又进 legacy 触发 rollback,
    // rollback 的世代比对会发现数据已易主, 放弃删除 (防删新用户刚建的库)。
    bumpDataEpoch()
    const ready = app.isPackaged ? await mgr.waitReady() : true

    // 后端启动失败 (davmail 桥未跑 / 端口不通 / cipher 错 → probe 失败 → 进程 exit →
    // state='failed') 不能当"慢启动"放行 —— 否则用户被带进 StepSync 假象 (后端其实死了)。
    // 区分 failed (真崩, 配置错, 需用户修) vs 仅超时 (慢, ready=false 但仍 starting)。
    if (app.isPackaged && !ready && mgr.getState() === 'failed') {
      return {
        ok: false,
        error: {
          code: 'E_BACKEND_FAILED',
          message:
            '后端启动失败。davmail 模式请确认 davmail-poc 桥在运行 (IMAP/SMTP 端口可达) + 认证 (PoC 密钥或 cipher) 正确; 检查配置后重试。'
        }
      }
    }

    // 不 reload —— 向导继续走 Sync/Plugins/Done。
    return { ok: true, ready }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

// ---------------------------------------------------------------------------
// onboarding:finalize (NEW flow 收尾: 写 plugin flag + reload 进 app)
// ---------------------------------------------------------------------------

/**
 * 写 plugin flag (PLUGIN_FLAG_MAP 映射) + reload 窗口进主界面。核心配置已由
 * commitConfig 写过 + 后端已起, 这里只补插件开关并切界面。
 *
 * raw 形状: { plugins?: Partial<Record<PluginKey, boolean>> }
 */
async function finalize(evt: Electron.IpcMainInvokeEvent, raw: unknown): Promise<OnboardingResult> {
  try {
    const plugins =
      typeof raw === 'object' && raw !== null
        ? (raw as { plugins?: Partial<Record<PluginKey, boolean>> }).plugins
        : undefined

    // 写 plugin flag (best-effort: 写失败不阻断进 app, 用户可在设置里再调)。
    const pluginPatch = buildPluginPatch(plugins)
    if (Object.keys(pluginPatch).length > 0) {
      const wr = writePatch(pluginPatch)
      if (!wr.ok) {
        return { ok: false, error: wr.error ?? { code: 'E_WRITE', message: '插件配置写入失败' } }
      }
    }

    // 切回主界面: reload 窗口去掉 ?onboarding=1 (loadFile 无 search)。
    reloadToMain(evt)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

/** reload 当前窗口到主界面 (去掉 ?onboarding=1 query)。 */
function reloadToMain(evt: Electron.IpcMainInvokeEvent): void {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win || win.isDestroyed()) return
    // onboarding 用固定小窗 (768×640 resizable:false)。进主界面是同窗 reload (不新建窗口),
    // 故必须把窗口恢复成主窗尺寸 + 可缩放, 否则主 App 被塞进小窗且无法调整大小
    // (此前 bug: 完成/跳过补全进主界面后窗口卡 768×640, 关闭重开才正常)。
    // setResizable 必须在 setSize 前 (不可缩放窗口会忽略 setSize); 尺寸单一来源 window-config。
    win.setResizable(true)
    win.setMaximizable(true)
    win.setMinimumSize(MAIN_WINDOW.minWidth, MAIN_WINDOW.minHeight)
    win.setSize(MAIN_WINDOW.width, MAIN_WINDOW.height)
    win.center()
    // V2.1 3c-3: 同 createWindow，reload 进主界面也须注入 apiPort —— 否则
    // MAILAGENT_API_PORT 覆盖时 onboarding 完成进入的窗口 ElectronApi.chat 丢端口
    // 静默回退 8200（codex 3c-3 MEDIUM）。端口同源 resolveApiPort（= serve-api 实际端口）。
    const search = new URLSearchParams({ apiPort: String(resolveApiPort()) }).toString()
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search })
  } catch {
    /* 窗口已销毁等边界情况, 不阻断 complete 成功返回。 */
  }
}

// ---------------------------------------------------------------------------
// onboarding:detectLegacy
// ---------------------------------------------------------------------------

function detectLegacy(): DetectLegacyResult {
  try {
    const oldDataPath = legacyOldDataPath()
    const oldDbPath = legacyOldDbPath()
    const found = existsSync(oldDbPath)
    if (!found) return { found: false }

    const { dbVersion, emailCount } = withReadonlyDb(
      oldDbPath,
      (db) => ({ dbVersion: readDbVersion(db), emailCount: readEmailCount(db) }),
      { dbVersion: null as number | null, emailCount: 0 }
    )

    // sizeBytes: 老 data/ 目录大小 (best-effort)。
    const sizeBytes = dirSizeBytes(join(oldDataPath, 'data'))

    // hasConfig: 老 .env 含三必填项且非空。
    const hasConfig = legacyEnvHasConfig()

    return { found: true, oldDataPath, dbVersion, emailCount, sizeBytes, hasConfig }
  } catch {
    return { found: false }
  }
}

/** 老 .env 是否含 NOTION_TOKEN + EMAIL_DATABASE_ID + USER_EMAIL 非空值。 */
function legacyEnvHasConfig(): boolean {
  try {
    const p = legacyOldEnvPath()
    if (!existsSync(p)) return false
    const present = parseActiveEnvKeys(readFileSync(p, 'utf8'))
    return ONBOARDING_REQUIRED_KEYS.every((k) => present.has(k))
  } catch {
    return false
  }
}

/** 解析 .env 文本里"有非空值"的 key 集合 (与 detect.ts activeEnvKeys 同口径)。 */
export function parseActiveEnvKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key && val !== '' && val !== '""' && val !== "''") keys.add(key)
  }
  return keys
}

// ---------------------------------------------------------------------------
// onboarding:legacyInherit (SAFE COPY: 老原件永不修改)
// ---------------------------------------------------------------------------

async function legacyInherit(raw: unknown): Promise<LegacyInheritResult> {
  try {
    // 破坏性操作前置守卫 (仅打包 + COPY 目标 ≠ 老原件路径)。
    const blocked = legacyMutationBlock()
    if (blocked) return { ok: false, error: blocked }

    const oldDataPath = legacyOldDataPath()
    const oldDbPath = legacyOldDbPath()
    if (!existsSync(oldDbPath)) {
      return { ok: false, error: { code: 'E_NO_LEGACY', message: '未找到老数据 sync_store.db' } }
    }

    // HARD GUARD: 老 WAL 在最近 120s 内有写动作 → 老后端可能仍在跑, 拒绝。
    const walPath = oldDbPath + '-wal'
    let walMtimeMs: number | null = null
    try {
      walMtimeMs = statSync(walPath).mtimeMs
    } catch {
      walMtimeMs = null // WAL 不存在 → 放行
    }
    if (isLikelyDoubleWriter(walMtimeMs)) {
      return {
        ok: false,
        error: {
          code: 'E_DOUBLE_WRITER',
          message:
            '检测到老 mail-sync 可能仍在运行 (sync_store.db-wal 刚被写入)。请先退出老版 mail-sync 再继承数据。'
        }
      }
    }

    // CONFIG 守卫: 老 .env 无完整配置 且 NEW 表单也没填全必填 → 拒绝复制/起后端。
    // 否则后续 migrate 会用缺配置起后端 → 崩 → rollback (误删 COPY)。让用户先用
    // 新用户向导填配置再迁移。这道闸必须在破坏性 copy 之前。
    const cfgMissing =
      typeof raw === 'object' && raw !== null
        ? buildCompletePatch(raw as OnboardingCompleteCfg).missing
        : ONBOARDING_REQUIRED_KEYS.slice()
    if (!legacyEnvHasConfig() && cfgMissing.length > 0) {
      return {
        ok: false,
        error: {
          code: 'E_MISSING_CONFIG',
          message:
            '未在旧目录找到完整配置 (Notion Token / 邮件库 ID / 邮箱)。请先用新用户向导填写配置, 再迁移。'
        }
      }
    }

    // 不再往老目录写 .bak 副本: 老原件全程只读、从不修改, 它本身就是回滚备份
    // (rollback 只删 COPY)。往老目录写文件既多余, 又违反"原件零写入"不变式。
    const backupPath = oldDbPath // 安全网 = 未改动的老原件本体

    // 进程级竞态防护 (codex #2): 复制前必须停掉任何正在写 DATA_ROOT/data 的后端 ——
    // 可能是 NEW flow 的 commitConfig 起的后端 (用户从 StepSync 一路返回又进 legacy),
    // 或上一次 legacyMigrate 的迁移后端 (用户 bail 后重试)。不停就 cpSync 同一路径 =
    // 覆盖正在写的 SQLite 库 → 损坏。stop() 对无后端时是安全 no-op。
    await getBackendLifecycle().stop()

    // 复制整个老 data/ → DATA_ROOT/data (recursive)。SOURCE 只读不改。
    const src = join(oldDataPath, 'data')
    const dest = destDataDir()
    try {
      mkdirSync(resolveDataRoot(), { recursive: true })
      cpSync(src, dest, { recursive: true })
    } catch (err) {
      return {
        ok: false,
        error: { code: 'E_COPY', message: `复制老数据目录失败: ${(err as Error).message}` }
      }
    }
    // COPY 已落地, 标记新世代 (rollback 据此判断 DATA_ROOT/data 是否已易主)。
    bumpDataEpoch()

    // 配置: 老 .env 有完整配置 → 复制其值 (managed key only); 否则用 cfg。
    let cfgPatch: Record<string, string> = {}
    if (legacyEnvHasConfig()) {
      cfgPatch = legacyEnvManagedPatch()
    } else if (typeof raw === 'object' && raw !== null) {
      cfgPatch = buildCompletePatch(raw as OnboardingCompleteCfg).patch
    }
    if (Object.keys(cfgPatch).length > 0) {
      const wr = writePatch(cfgPatch)
      if (!wr.ok) {
        return { ok: false, error: wr.error ?? { code: 'E_WRITE', message: '.env 写入失败' } }
      }
    }

    // 补 CLI 写鉴权 key (老 .env 若带 key 则只同步 process.env; 没带则生成)。
    ensureCliApiKey()
    // 补 outbox 派发器默认开 (老 .env 带显式值则尊重不覆盖; 没带则写 true)。
    ensureOutboxEnabled()

    // 不起后端 (留给 legacyMigrate)。
    return { ok: true, backupPath }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

/** 把老 .env 里的 managed 值提取成 writePatch 可用的 patch (非 managed key 丢弃)。 */
function legacyEnvManagedPatch(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const text = readFileSync(legacyOldEnvPath(), 'utf8')
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      // 去掉成对引号 (老 .env 可能引用带空格的值)。
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (key && val !== '') out[key] = val
    }
  } catch {
    /* 读不了就回空 patch — 调用方已确认 hasConfig, 极端 race 时降级为不写。 */
  }
  // writePatch 自带 MANAGED_ENV_KEYS 白名单校验, 但它遇到非 managed key 会
  // 整体 E_INVALID_KEY 拒绝 → 这里先过滤掉非 managed key, 只留可写部分。
  const managed = filterManagedOnly(out)
  // 旧文档名兼容 (codex #davmail BLOCKER): 后端 config.py 只读 env=DAVMAIL_POC_CIPHER_KEY;
  // 旧文档/报错曾让用户配 DAVMAIL_CIPHER_KEY。若老 .env 用旧名且无新名, 映射到新名让后端
  // 读得到 (否则按旧文档配过 cipher 的非 PoC davmail 老用户迁移后后端起不来 → 死路),
  // 并去掉旧名, 只留一个 canonical key。
  if (managed['DAVMAIL_CIPHER_KEY'] && !managed['DAVMAIL_POC_CIPHER_KEY']) {
    managed['DAVMAIL_POC_CIPHER_KEY'] = managed['DAVMAIL_CIPHER_KEY']
  }
  delete managed['DAVMAIL_CIPHER_KEY']
  return managed
}

/** 过滤出 MANAGED_ENV_KEYS 白名单内的键 (writePatch 遇非 managed key 会整体
 *  E_INVALID_KEY 拒绝, 所以继承老 .env 前先剔除其多余键)。 */
function filterManagedOnly(patch: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(patch)) {
    if (MANAGED_ENV_KEY_SET.has(k)) out[k] = patch[k]
  }
  return out
}

// ---------------------------------------------------------------------------
// onboarding:legacyMigrate
// ---------------------------------------------------------------------------

async function legacyMigrate(): Promise<LegacyMigrateResult> {
  try {
    // 破坏性操作前置守卫 (起后端会在 COPY 上写迁移; 守卫确保 COPY ≠ 老原件)。
    const blocked = legacyMutationBlock()
    if (blocked) return { ok: false, error: blocked }

    // 读 COPY 的 db_version (before)。
    const copiedDb = resolveDbPath()
    const dbVersionBefore = withReadonlyDb(copiedDb, readDbVersion, null as number | null)

    // 起后端让其 _init_database() 自动迁移到 v17。
    registerBackendQuitHook()
    const mgr = getBackendLifecycle()
    mgr.start()
    const ready = app.isPackaged ? await mgr.waitReady() : true

    // 读迁移后 db_version (after, 走 probeDbReady)。
    const dbVersionAfter = probeDbReady(copiedDb).dbVersion

    // 后端未就绪 (大库慢迁移 >120s waitReady 超时): 不报 ok:true —— 否则 renderer
    // 直接 startVerify, verify 因后端没就绪而失败 → 误回滚一个只是慢的成功迁移。
    // 返回 E_NOT_READY 让 renderer 停在 migrate 等待 / 重新检查, 而非 rollback。
    // dbVersion 仍带回, 供 renderer 显示进度。
    if (ready === false) {
      // 区分: state='failed' = 后端崩 (davmail 桥没开 / 配置错 / spawn 失败) —— 不是"慢",
      // 重试 copy / 自动 rollback 都不对, 让用户修配置后重试迁移 (E_BACKEND_FAILED);
      // 仅超时 = 大库慢迁移 → E_NOT_READY (继续等待 / 重新检查)。两者都不自动 rollback (COPY 完好)。
      const failed = mgr.getState() === 'failed'
      return {
        ok: false,
        error: failed
          ? {
              code: 'E_BACKEND_FAILED',
              message:
                '迁移后端启动失败 (davmail 桥未运行 / 配置错误？)。原始旧数据未受影响, 请检查后重试迁移。'
            }
          : {
              code: 'E_NOT_READY',
              message: '数据库升级耗时较长, 后端尚未就绪 (大库可能需数分钟)。可继续等待后重新检查。'
            },
        dbVersionBefore,
        dbVersionAfter,
        ready
      }
    }

    return { ok: true, dbVersionBefore, dbVersionAfter, ready }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

// ---------------------------------------------------------------------------
// onboarding:legacyVerify
// ---------------------------------------------------------------------------

function legacyVerify(): LegacyVerifyResult {
  const checks: LegacyVerifyCheck[] = []
  let emailCount: number | undefined

  try {
    const dbPath = resolveDbPath()

    // getDb readonly 能打开 (复用单例; 失败 throw → 捕获置 false)。
    let getDbOk = false
    try {
      getDb()
      getDbOk = true
    } catch {
      getDbOk = false
    }

    const probe = probeDbReady(dbPath)
    emailCount = withReadonlyDb(dbPath, readEmailCount, 0)

    checks.push({
      key: 'db_version',
      // `>=` 与 backend_lifecycle 就绪门控一致 (迁到 >= 期望下限即通过); 用 `===` 会在
      // 后端 bump schema 后误报 legacy 库不达标。见 backend_lifecycle.EXPECTED_DB_VERSION 注释。
      label: `db_version >= ${EXPECTED_DB_VERSION}`,
      pass: probe.dbVersion != null && probe.dbVersion >= EXPECTED_DB_VERSION
    })
    checks.push({
      key: 'required_tables',
      label: `关键表齐全 (${REQUIRED_TABLES.join(', ')})`,
      pass: probe.dbAccessible && probe.missingTables.length === 0
    })
    checks.push({
      key: 'email_rows',
      label: 'email_metadata 行数 >= 1',
      pass: emailCount >= 1
    })
    checks.push({
      key: 'getdb_open',
      label: 'getDb() readonly 可打开',
      pass: getDbOk
    })

    const verified = checks.every((c) => c.pass)
    return { verified, checks, emailCount }
  } catch (err) {
    // 任意未预期错误: 返回未验证 + 错误 check, 不抛。
    checks.push({ key: 'error', label: `校验异常: ${(err as Error).message}`, pass: false })
    return { verified: false, checks, emailCount }
  }
}

// ---------------------------------------------------------------------------
// onboarding:legacyRollback (只删 COPY, 老原件永不动)
// ---------------------------------------------------------------------------

async function legacyRollback(): Promise<LegacyRollbackResult> {
  try {
    // 破坏性操作前置守卫: 仅打包 + dest ≠ 老原件。这是防止 rmSync 删到用户真库的
    // 核心闸 —— dev 或 MAILAGENT_DATA_ROOT=老路径 时 dest 会塌缩成老原件目录。
    const blocked = legacyMutationBlock()
    if (blocked) return { ok: false, error: blocked }

    // 捕获进场世代 (codex #2): 若 stop/rm 期间有更新的操作 (commitConfig 起后端 /
    // legacyInherit 复制) 重新填充了 DATA_ROOT/data, 世代会变, 届时放弃 rm —— 防止
    // 迟到的回滚 (例如 idle-timeout 放行返回后用户已重新配置) 删掉新数据。
    const myEpoch = _dataEpoch

    // 停后端 (释放对 COPY db 的句柄)。
    const mgr = getBackendLifecycle()
    await mgr.stop()

    // 世代比对: 期间 DATA_ROOT/data 已易主 → 不删 (这份已不是当初要回滚的 COPY)。
    if (_dataEpoch !== myEpoch) {
      return { ok: true }
    }

    // 删 COPY (DATA_ROOT/data) —— 守卫已确保它 ≠ 老原件; 老原件 ~/Documents/MailAgent 不动。
    const dest = destDataDir()
    try {
      rmSync(dest, { recursive: true, force: true })
    } catch (err) {
      return {
        ok: false,
        error: { code: 'E_RM', message: `删除 COPY 失败: ${(err as Error).message}` }
      }
    }
    // COPY 已删, 标记新世代。
    bumpDataEpoch()

    // 清 managed .env 键 (回 'new') —— 仅当 .env 是独立副本时才清。若 resolveEnvPath()
    // 解析到老原件 ~/Documents/MailAgent/.env (打包态当前正是如此), 绝不剥离用户原始
    // 配置, 直接跳过 (老原件零写入不变式)。
    if (envPathSafeToManage()) {
      const nulls = buildClearPatch()
      const wr = writePatch(nulls)
      if (!wr.ok) {
        return { ok: false, error: wr.error ?? { code: 'E_WRITE', message: '清 .env 失败' } }
      }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

/** davmail 连接键 (buildCompletePatch 在 davmail 模式可写的集合; buildClearPatch
 *  据此对称清除, 避免 rollback 残留半截 davmail 配置)。 */
const DAVMAIL_WRITABLE_KEYS = [
  'DAVMAIL_HOST',
  'DAVMAIL_IMAP_PORT',
  'DAVMAIL_SMTP_PORT',
  'DAVMAIL_POC_MODE',
  'DAVMAIL_POC_CIPHER_KEY',
  // 旧名也清, rollback 不残留 (即便极端情况下被写过)。
  'DAVMAIL_CIPHER_KEY'
] as const

/** 构造 rollback 清键 patch (null→删): 对称于 buildCompletePatch 的写入集 ——
 *  必填三项 + 可选账户字段 + MAILAGENT_BACKEND + SYNC_MAILBOXES + davmail 连接键 +
 *  全部插件 flag, 让 rollback 把 .env 干净复位到 'new' 态 (不残留 backend/davmail/
 *  插件半截配置)。 */
export function buildClearPatch(): Record<string, null> {
  const out: Record<string, null> = {}
  // 必填三项 + 可选账户字段 (= ONBOARDING_WRITABLE_KEYS 全集) → 删。
  for (const k of ONBOARDING_WRITABLE_KEYS) out[k] = null
  out['MAILAGENT_BACKEND'] = null
  out['SYNC_MAILBOXES'] = null
  for (const k of DAVMAIL_WRITABLE_KEYS) out[k] = null
  for (const pk of Object.keys(PLUGIN_FLAG_MAP) as PluginKey[]) out[PLUGIN_FLAG_MAP[pk]] = null
  return out
}

// ---------------------------------------------------------------------------
// onboarding:bootBackend (HALF: 不写 .env, 只起后端 + 等就绪)
// ---------------------------------------------------------------------------

async function bootBackend(evt: Electron.IpcMainInvokeEvent): Promise<OnboardingResult> {
  try {
    registerBackendQuitHook()
    const mgr = getBackendLifecycle()
    mgr.start()
    const ready = app.isPackaged ? await mgr.waitReady() : true
    // bootBackend = "启动并进入 app" 的触发 (LegacyFlow.finish / HalfFlow 用它收尾)。
    // 成功后 reload 窗口进主界面, 与 complete 一致 —— 否则迁移成功也进不去主界面
    // (renderer 的 onComplete 是 no-op, 真正导航由主进程 reload 驱动)。
    reloadToMain(evt)
    return { ok: true, ready }
  } catch (err) {
    return { ok: false, error: { code: 'E_GENERIC', message: (err as Error).message } }
  }
}

// ---------------------------------------------------------------------------
// onboarding:enterApp (纯切界面: reload 窗口去掉 ?onboarding=1, 不碰后端/数据)
// ---------------------------------------------------------------------------

/** 所有"进入主界面"的逃生口统一走这里。修 codex #2 (BLOCKER 1 残留): bootBackend
 *  若 hang (waitReady 永不返回) 就永不 reload, 而 renderer 的 bootHung 逃生口"直接完成"
 *  原来只调 no-op onComplete → 进不去 app。现在改调本 IPC, 由主进程直接 reload。 */
function enterApp(evt: Electron.IpcMainInvokeEvent): { ok: boolean } {
  reloadToMain(evt)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:status', () => ({ state: detectUserState() }))
  ipcMain.handle('onboarding:checkEnv', () => checkEnv())
  ipcMain.handle('onboarding:openPrivacyPane', (_evt, arg: unknown) => openPrivacyPane(arg))
  ipcMain.handle('onboarding:listMailAccounts', () => listMailAccounts())
  ipcMain.handle('onboarding:detectDavmail', (_evt, arg: unknown) => detectDavmail(arg))
  ipcMain.handle('onboarding:syncProgress', () => syncProgress())
  ipcMain.handle('onboarding:complete', handleComplete)
  // NEW flow 提交时机前移: commitConfig 写核心 .env + 起后端 (不 reload), finalize
  // 写 plugin flag + reload 进 app。让 StepSync 能轮询真实后端进度。
  ipcMain.handle('onboarding:commitConfig', (_evt, arg: unknown) => commitConfig(arg))
  ipcMain.handle('onboarding:finalize', (evt, arg: unknown) => finalize(evt, arg))

  // LEGACY 全量迁移。
  ipcMain.handle('onboarding:detectLegacy', () => detectLegacy())
  ipcMain.handle('onboarding:legacyInherit', (_evt, arg: unknown) => legacyInherit(arg))
  ipcMain.handle('onboarding:legacyMigrate', () => legacyMigrate())
  ipcMain.handle('onboarding:legacyVerify', () => legacyVerify())
  ipcMain.handle('onboarding:legacyRollback', () => legacyRollback())
  // bootBackend 成功后 reloadToMain(evt) 进 app (LegacyFlow/HalfFlow 收尾触发)。
  ipcMain.handle('onboarding:bootBackend', (evt) => bootBackend(evt))
  ipcMain.handle('onboarding:enterApp', (evt) => enterApp(evt))
}

// 暴露给 vitest 的纯逻辑 (不含 IPC 副作用)。
export const __test__ = {
  checkEnv,
  syncProgress,
  detectLegacy,
  legacyVerify,
  buildCompletePatch,
  buildCoreConfigPatch,
  buildPluginPatch,
  isLikelyDoubleWriter,
  parseActiveEnvKeys,
  buildClearPatch,
  isPathInside,
  pathsCollide,
  PLUGIN_FLAG_MAP
}
