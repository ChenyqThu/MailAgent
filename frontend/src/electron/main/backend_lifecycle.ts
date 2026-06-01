// Packaging P1-4~P1-7 — BackendLifecycleManager 骨架。
//
// 现状空白 (02-landing-plan.md R3): 当前 Electron 完全不 spawn/kill/health-watch
// 后端 main.py, 仅间接依赖外部 pm2 且假设已托管 —— 这是打包最大缺口。打包后没有
// pm2, 必须由主进程自己监督后端。
//
// 职责 (§3.2):
//   - start()     : `app.whenReady` 后、`createWindow` 前 spawn `mailagent serve`
//                   (注入 MAILAGENT_PROJECT_ROOT / MAILAGENT_ENV_FILE /
//                   SYNC_STORE_DB_PATH 三 env), cwd = DATA_ROOT。
//   - waitReady() : 直读 SQLite `sync_state` 判 db_version==EXPECTED 且关键表
//                   exist (取代 admin:health CLI fork 500ms), 迁移期锁表 (SQLITE_BUSY)
//                   退避重试 → DB 就绪门控放行 createWindow。
//   - restart()   : kill + re-spawn (取代 pm2 restart), 供 env:set 后 banner 调用。
//   - stop()      : before-quit SIGTERM + 等待退出, 无僵尸进程。
//
// 🔴 dev 模式不接管 (硬约束①): 仅在 `app.isPackaged` 时 spawn/kill 内嵌进程;
// dev 模式与服务器部署继续走 pm2 (`pm2 start main.py --interpreter ./venv/bin/python3`
// 不变)。registerBackendLifecycle() 在 dev 模式是 no-op。
//
// spawn 契约 (P1-4a, C-1): 长驻服务是 `mailagent serve` → src.service.EmailNotionSyncApp
// (Python 侧已落地), **不是** spawn `main.py`。bin 解析复用 cli_runner.getMailagentBin()。
//
// 真机 spawn / waitReady / SIGTERM 验证留给后续真机 dogfood; 本文件是可单测骨架。

import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs'
import { join } from 'path'

import Database from 'better-sqlite3'

import { getMailagentBin } from './cli_runner'
import { resolveDataRoot, resolveDbPath } from './db'

// ---------------------------------------------------------------------------
// DB 就绪判据 (复用 admin.py:193 health 逻辑, 但直读不走 CLI fork)
// ---------------------------------------------------------------------------

/** 与 src/mail/sync_store.py `SyncStore.DB_VERSION` 及 admin.py `EXPECTED_DB_VERSION`
 *  保持同步 (当前 v17)。后端完成 `_init_database()` schema migration 后会把
 *  sync_state.db_version 写成这个值 —— 就绪门控等它到位再开主窗口。 */
export const EXPECTED_DB_VERSION = 17

/** 就绪判据的关键表子集 (02-landing-plan.md P1-6)。admin.py REQUIRED_TABLES 更全,
 *  但开窗门控只需保证「邮件读写主路径」三表已建: 元数据 / 正文 SSoT / outbox。 */
export const REQUIRED_TABLES = ['email_metadata', 'email_body', 'email_outbox'] as const

export interface ReadinessResult {
  /** db 文件存在 + 能打开 + db_version==EXPECTED + 关键表齐全。 */
  ready: boolean
  /** db 文件还不存在 (后端首启建表前) / 打不开。 */
  dbAccessible: boolean
  dbVersion: number | null
  /** REQUIRED_TABLES 中缺失的表 (建表中途会非空)。 */
  missingTables: string[]
  /** 锁表 (SQLITE_BUSY) — 迁移期 CREATE INDEX 锁库, 应退避重试而非判 not-ready。 */
  busy: boolean
  error?: string
}

/**
 * 直读 SQLite 探测就绪状态。短生命周期 readonly 连接 (不复用 db.ts 的单例, 因为
 * waitReady 期 db 文件可能还不存在 —— db.ts getDb() 会 throw)。
 *
 * 迁移期大库 `CREATE INDEX` 会持锁, 这里 busy_timeout=200ms 兜底; 仍 BUSY 则
 * 把 `busy=true` 上抛让 waitReady() 退避重试, 不误判 not-ready。
 *
 * @param dbPath 默认 resolveDbPath(); 可注入便于单测。
 */
export function probeDbReady(dbPath: string = resolveDbPath()): ReadinessResult {
  if (!existsSync(dbPath)) {
    // 后端还没建库 —— 正常的首启过渡态, 不是错误。
    return {
      ready: false,
      dbAccessible: false,
      dbVersion: null,
      missingTables: [...REQUIRED_TABLES],
      busy: false
    }
  }
  let conn: Database.Database | null = null
  try {
    conn = new Database(dbPath, { readonly: true, fileMustExist: true })
    conn.pragma('busy_timeout = 200')
    const verRow = conn.prepare("SELECT value FROM sync_state WHERE key = 'db_version'").get() as
      | { value?: string }
      | undefined
    const dbVersion = verRow?.value != null ? Number.parseInt(String(verRow.value), 10) : null

    const tableRows = conn
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all() as Array<{ name: string }>
    const present = new Set(tableRows.map((r) => r.name))
    const missingTables = REQUIRED_TABLES.filter((t) => !present.has(t))

    const ready = dbVersion === EXPECTED_DB_VERSION && missingTables.length === 0
    return { ready, dbAccessible: true, dbVersion, missingTables, busy: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // better-sqlite3 把锁错误 message 暴露成含 'SQLITE_BUSY' / 'database is locked'。
    const busy = /SQLITE_BUSY|database is locked/i.test(msg)
    return {
      ready: false,
      dbAccessible: !busy, // BUSY 说明库在 (只是被锁), 其它错误才算不可访问
      dbVersion: null,
      missingTables: [...REQUIRED_TABLES],
      busy,
      error: msg
    }
  } finally {
    if (conn) {
      try {
        conn.close()
      } catch {
        /* close 失败无所谓 — readonly 短连接, GC 会回收。 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BackendLifecycleManager
// ---------------------------------------------------------------------------

export interface LifecycleOptions {
  /** waitReady 轮询间隔 (ms)。默认 500ms。 */
  pollIntervalMs?: number
  /** waitReady 总超时 (ms)。默认 120s — 大库首次建表 + 迁移可能较慢。 */
  readyTimeoutMs?: number
  /** stop() 等待子进程优雅退出的超时 (ms), 超时后 SIGKILL。默认 5s。 */
  stopGraceMs?: number
}

export type BackendState = 'idle' | 'starting' | 'ready' | 'stopped' | 'failed'

export class BackendLifecycleManager {
  private child: ChildProcess | null = null
  private state: BackendState = 'idle'
  /** 抽干后端 stdout/stderr 的落盘流 (防 pipe 背压死锁, 见 attachLogDrain)。 */
  private logStream: WriteStream | null = null
  private readonly pollIntervalMs: number
  private readonly readyTimeoutMs: number
  private readonly stopGraceMs: number

  constructor(opts: LifecycleOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000
    this.stopGraceMs = opts.stopGraceMs ?? 5_000
  }

  getState(): BackendState {
    return this.state
  }

  /** 当前是否由本 manager 托管后端 (仅打包模式)。dev 模式恒 false。 */
  isManaged(): boolean {
    return this.safeIsPackaged()
  }

  /**
   * spawn `mailagent serve`。仅在打包模式接管; dev 模式 no-op (走 pm2)。
   * 注入三 env: MAILAGENT_PROJECT_ROOT / MAILAGENT_ENV_FILE / SYNC_STORE_DB_PATH,
   * cwd = DATA_ROOT (pydantic import-time 读 .env 必须在此目录)。
   */
  start(): void {
    if (!this.safeIsPackaged()) {
      // dev / 服务器部署: 后端由 pm2 托管, 不接管。
      return
    }
    if (this.child && !this.child.killed) {
      // 已在运行, 幂等返回 (restart 走 restart())。
      return
    }
    const dataRoot = resolveDataRoot()
    const bin = getMailagentBin()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // cwd 已是 DATA_ROOT, 但显式注入路径 env 让 Python 侧解析无歧义。
      // 🔴 MAILAGENT_DATA_ROOT 才是 config.py `_resolve_data_root()` 真正读的 key ——
      // 缺它则后端 DATA_ROOT fallback 到 dirname(dirname(__file__)) = 打包 bundle 内的
      // site-packages, 令 log_file / attachment_storage_dir 等所有 _under_data_root
      // 默认路径错锚进只读的 .app (日志曾因此写进 bundle)。PROJECT_ROOT 后端并不读
      // (仅前端 cli_runner 用), 此前注入它属无效 env, 保留仅为兼容。
      MAILAGENT_PROJECT_ROOT: dataRoot,
      MAILAGENT_DATA_ROOT: dataRoot,
      MAILAGENT_ENV_FILE: join(dataRoot, '.env'),
      SYNC_STORE_DB_PATH: resolveDbPath()
    }
    this.state = 'starting'
    this.child = spawn(bin, ['serve'], {
      cwd: dataRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // 🔴 spawn 后立刻抽干 stdout/stderr —— 不消费 pipe 会背压死锁把后端整个拖死
    // (详见 attachLogDrain)。必须在任何 await 之前接上。
    this.attachLogDrain(dataRoot)
    this.child.on('exit', (code, signal) => {
      // 非主动 stop() 触发的退出 → 标记 failed (供 onboarding / banner 兜底)。
      if (this.state !== 'stopped') {
        this.state = 'failed'
        console.error(`[backend_lifecycle] serve exited code=${code} signal=${signal}`)
      }
      this.child = null
    })
    this.child.on('error', (err) => {
      this.state = 'failed'
      console.error('[backend_lifecycle] spawn error', err)
    })
  }

  /**
   * 轮询直读 SQLite 直到就绪 (db_version==EXPECTED 且关键表齐全)。
   * - 锁表 (SQLITE_BUSY): 退避重试, 不判失败。
   * - 超过 readyTimeoutMs: resolve(false), 由调用方决定降级 (导回 onboarding /
   *   仍开窗但 IPC 自带 not-found 兜底)。
   *
   * dev 模式直接返回当前探测结果 (不轮询托管, 因为后端由 pm2 起, 可能已就绪)。
   * @param probe 可注入的探测函数, 便于单测。默认 probeDbReady。
   */
  async waitReady(probe: () => ReadinessResult = probeDbReady): Promise<boolean> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const r = probe()
      if (r.ready) {
        if (this.safeIsPackaged()) this.state = 'ready'
        return true
      }
      // 后端进程已崩溃 (bad config / spawn error → on('exit'/'error') 置 failed) →
      // 快速失败, 不傻等满 readyTimeoutMs (120s 是给大库迁移留的, 崩溃不该等)。
      if (this.safeIsPackaged() && this.state === 'failed') {
        return false
      }
      if (Date.now() >= deadline) {
        return false
      }
      // BUSY 用稍长退避, 让迁移期 CREATE INDEX 完成; 其余用常规间隔。
      const wait = r.busy ? this.pollIntervalMs * 2 : this.pollIntervalMs
      await delay(wait)
    }
  }

  /**
   * kill + re-spawn (取代 pm2 restart), 供 env:set 后 banner 调用。
   * dev 模式 no-op。重启后需调用方自行 waitReady。
   */
  async restart(): Promise<void> {
    if (!this.safeIsPackaged()) return
    await this.stop()
    this.start()
  }

  /**
   * before-quit: SIGTERM + 等待优雅退出, 超过 stopGraceMs 升级 SIGKILL。
   * dev 模式 no-op。
   */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.killed) {
      this.state = 'stopped'
      this.closeLogStream()
      return
    }
    this.state = 'stopped'
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    child.kill('SIGTERM')
    const timedOut = await Promise.race([
      exited.then(() => false),
      delay(this.stopGraceMs).then(() => true)
    ])
    if (timedOut) {
      // 优雅退出超时 → 强杀, 防僵尸进程。
      // 注意: 不能用 `!child.killed` 做条件 —— Node 里 child.killed 表示"信号已成功
      // 发送"(SIGTERM 后即 true), 不是"进程已退出"。用它会让 SIGKILL 永不触发
      // (codex #4 BLOCKER)。timedOut=true 已严格表示 grace 内未收到 exit, 直接升级。
      child.kill('SIGKILL')
      // SIGKILL 后必须等到进程真正 exit 再返回 (codex #3 BLOCKER): 否则 caller
      // (legacyInherit) 的 `await stop()` 返回时, 后端可能还没死透、仍持有 DB 写锁/
      // 正在写, 随后的 cpSync/rm 会与濒死后端 race → 损坏。SIGKILL 后内核通常毫秒级
      // 回收, 加一个短 hard cap 防极端僵死 (uninterruptible syscall) 永久 hang。
      await Promise.race([exited, delay(SIGKILL_WAIT_MS)])
    }
    this.child = null
    this.closeLogStream()
  }

  /**
   * 持续抽干后端 stdout/stderr → DATA_ROOT/logs/backend-process.log。
   *
   * 🔴 防 pipe 背压死锁 (本类最关键的不变量): stdio=pipe 的内核缓冲区只有几十 KB,
   * 后端 loguru 默认往 stdout 加了全量 sink (utils/logger.py), 不读则写满后, 后端
   * 下一次 write() 会永久阻塞在 asyncio event loop 主线程 → 邮件同步 + SSE 全部卡死
   * 且永不自愈 (现象: 邮件不更新 + 前端左下角一直"重连中")。
   *
   * 截断模式 (flags:'w') 每次 spawn 覆盖, 只留本次进程输出防无限增长 (跨重启的历史
   * 看 loguru 自轮转的 sync.log)。drain 一旦接不上 (建目录/开流失败), 退化为 resume()
   * 丢弃 —— 宁可丢诊断日志, 也不能让 pipe 写满把后端拖死。
   */
  private attachLogDrain(dataRoot: string): void {
    const child = this.child
    if (!child) return
    try {
      const logDir = join(dataRoot, 'logs')
      mkdirSync(logDir, { recursive: true })
      const stream = createWriteStream(join(logDir, 'backend-process.log'), { flags: 'w' })
      this.logStream = stream
      child.stdout?.on('data', (chunk: Buffer) => stream.write(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stream.write(chunk))
    } catch (err) {
      console.error('[backend_lifecycle] log drain 接入失败, 退化为丢弃 (防 pipe 死锁)', err)
      this.logStream = null
      child.stdout?.resume()
      child.stderr?.resume()
    }
  }

  private closeLogStream(): void {
    if (this.logStream) {
      try {
        this.logStream.end()
      } catch {
        /* 关流失败无所谓 — GC 会回收 fd。 */
      }
      this.logStream = null
    }
  }

  private safeIsPackaged(): boolean {
    // 单测里 mock 的 app 可能不带 isPackaged; 缺失按 dev (false) 处理。
    try {
      return app.isPackaged === true
    } catch {
      return false
    }
  }
}

/** SIGKILL 后等待进程真正 exit 的硬上限 (codex #3): 防极端僵死 (uninterruptible
 *  syscall) 让 stop() 永久 hang。正常 SIGKILL 内核毫秒级回收, 远不到此上限。 */
const SIGKILL_WAIT_MS = 2000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 单例 + 注册 (沿用 cli_runner.ts:289-295 registerCliLifecycle 风格)
// ---------------------------------------------------------------------------

let _manager: BackendLifecycleManager | null = null

/** 进程内单例。index.ts 与 services.ts 共享同一实例。 */
export function getBackendLifecycle(): BackendLifecycleManager {
  if (!_manager) _manager = new BackendLifecycleManager()
  return _manager
}

/**
 * 在 app.whenReady 后调用: 打包模式 spawn 后端 + 注册 before-quit SIGTERM 钩子。
 * dev 模式只注册无害的 before-quit (stop() 内部已 no-op), 不接管 spawn。
 *
 * 沿用 registerCliLifecycle 的 before-quit 模式; 与之并存 (CLI 子进程 vs 长驻
 * 后端是两类进程, 各自清理)。返回 manager 供调用方在 createWindow 前 waitReady。
 */
let _quitHookRegistered = false

/**
 * 只注册 before-quit SIGTERM 钩子 (幂等), 不 start。供 onboarding 场景: 新用户开窗时
 * 还没配置、不能 start 后端, 但要先挂好退出清理钩子; 待 onboarding:complete 写完 .env
 * 再调 mgr.start()。dev 模式 stop() 内部 no-op, 钩子无害。
 */
export function registerBackendQuitHook(): BackendLifecycleManager {
  const mgr = getBackendLifecycle()
  if (!_quitHookRegistered) {
    _quitHookRegistered = true
    app.on('before-quit', () => {
      // fire-and-forget: before-quit 不等 async; SIGTERM 已发出, OS 会回收。
      void mgr.stop()
    })
  }
  return mgr
}

export function registerBackendLifecycle(): BackendLifecycleManager {
  const mgr = registerBackendQuitHook()
  mgr.start()
  return mgr
}

export function _resetBackendLifecycleForTests(): void {
  _manager = null
  _quitHookRegistered = false
}
