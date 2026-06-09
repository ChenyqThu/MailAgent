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
//   - waitReady() : 直读 SQLite `sync_state` 判 db_version>=EXPECTED 且关键表
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
//
// V2 远程访问 — 多 service 化 (向后兼容硬约束): manager 从单 `serve` child 扩成
// 内部 ManagedService[] registry, 托管两个 mailagent CLI 进程:
//   - serve     : 主同步长驻进程 (行为/probe 完全不变, 门控 waitReady 的 SQLite 就绪);
//   - serve-api : FastAPI 远程访问后端 (bind 127.0.0.1:8200, REMOTE-ACCESS §3),
//                 env-gated (默认开, MAILAGENT_REMOTE_ACCESS_ENABLED=false 可关),
//                 ready probe = GET /api/health, **软门控** — 起不来只 warn 不阻塞开窗。
// public API (start/stop/restart/waitReady/getState/isManaged) 签名与语义全保留:
// waitReady() 仍只等 serve 的 SQLite 门控 (serve-api 软门控 fire-and-forget), 故不开
// serve-api (gate off) 时行为与改造前逐字节一致。cloudflared **不**纳入 lifecycle (依赖
// 用户环境态 + 该独立于 Electron 常驻, 由 runbook 教用户 pm2 托管)。

import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs'
import { get as httpGet } from 'http'
import { join } from 'path'

import Database from 'better-sqlite3'

import { getMailagentBin } from './cli_runner'
import { resolveDataRoot, resolveDbPath } from './db'
import { getLocalApiToken, LOCAL_TOKEN_ENV } from './local_token'

// ---------------------------------------------------------------------------
// DB 就绪判据 (复用 admin.py:193 health 逻辑, 但直读不走 CLI fork)
// ---------------------------------------------------------------------------

/** 与 src/mail/sync_store.py `SyncStore.DB_VERSION` 及 admin.py `EXPECTED_DB_VERSION`
 *  对齐 (当前 v23)。后端完成 `_init_database()` schema migration 后会把
 *  sync_state.db_version 写成 >= 此值 —— 就绪门控等它到位再开主窗口。
 *
 *  🔴 判据用 `>=` 而非 `===` (见 probeDbReady)。TS 无法 import Python 常量, 此处只能手抄;
 *  历史教训: bump 后端 DB_VERSION 时漏改这里 → `19 === 17` 恒假 → 等满 readyTimeout(120s)
 *  才降级开窗 (用户感知"App 打不开")。改 `>=` 后此常量退化为「就绪下限」: 只要 DB 迁到
 *  >= 此值即放行, 后端再 bump schema 也不会卡旧前端 (一体化 app 迁移单向前进 + 向后兼容
 *  加列加表, 不删不改语义)。bump 后端 schema 时**仍建议**同步抬高此下限保持语义清晰,
 *  但漏改不再致命 (admin.py 用 `= _SyncStore.DB_VERSION` 动态引用, 无此问题)。 */
export const EXPECTED_DB_VERSION = 23

/** 就绪判据的关键表子集 (02-landing-plan.md P1-6)。admin.py REQUIRED_TABLES 更全,
 *  但开窗门控只需保证「邮件读写主路径」三表已建: 元数据 / 正文 SSoT / outbox。 */
export const REQUIRED_TABLES = ['email_metadata', 'email_body', 'email_outbox'] as const

export interface ReadinessResult {
  /** db 文件存在 + 能打开 + db_version>=EXPECTED + 关键表齐全。 */
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

    // `>=` 而非 `===`: DB 迁到 >= 期望下限即就绪 (见 EXPECTED_DB_VERSION 注释)。
    // dbVersion 为 null/NaN (verRow 缺 / parse 失败) 时显式判 not-ready, 不靠 null→0 隐式转换。
    const ready =
      dbVersion != null &&
      Number.isFinite(dbVersion) &&
      dbVersion >= EXPECTED_DB_VERSION &&
      missingTables.length === 0
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
// serve-api 就绪探针 (GET http://127.0.0.1:<port>/api/health)
// ---------------------------------------------------------------------------

/** serve-api 默认端口 (与 src/cli/main.py serve_api / cloudflared ingress 一致)。
 *  可经 env MAILAGENT_API_PORT 覆盖; host 恒 127.0.0.1 (loopback, 公网不可达)。 */
export const DEFAULT_API_PORT = 8200

/** serve-api 单次 probe 的 HTTP 超时 (ms)。uvicorn 起来后 /api/health 是常数时间, 短超时即可。 */
const API_PROBE_TIMEOUT_MS = 2500

/**
 * 探测 serve-api liveness: GET http://127.0.0.1:<port>/api/health。
 *
 * 判据: HTTP 200 + body JSON `status === 'ok'` (app.py:402 无鉴权 liveness,
 * 返回 `{"status":"ok","schema_version":N}`)。用 Node 内置 http.get, **不引第三方**
 * (better-sqlite3 是唯一 native dep, HTTP 探针不该加依赖)。
 *
 * 连接被拒 (ECONNREFUSED, uvicorn 还没 bind) / 超时 / 非 200 / body 不合法 → false
 * (退避重试, 类比 probeDbReady 的 db 文件不存在过渡态, 不区分"尚未就绪" vs "坏了")。
 *
 * @param port 默认 DEFAULT_API_PORT; 可注入便于单测。
 */
export function probeApiHealth(port: number = DEFAULT_API_PORT): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const req = httpGet(
      { host: '127.0.0.1', port, path: '/api/health', timeout: API_PROBE_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume() // drain 防 socket 挂起
          done(false)
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          // liveness body 很小; 防异常大 body 占内存, 超 64KB 直接判失败。
          if (body.length > 65_536) {
            res.destroy()
            done(false)
          }
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { status?: unknown }
            done(parsed?.status === 'ok')
          } catch {
            done(false)
          }
        })
        res.on('error', () => done(false))
      }
    )
    req.on('timeout', () => {
      req.destroy() // timeout 不会自动 abort, 必须显式 destroy 触发 'error'
    })
    req.on('error', () => done(false))
  })
}

// ---------------------------------------------------------------------------
// BackendLifecycleManager
// ---------------------------------------------------------------------------

export interface LifecycleOptions {
  /** waitReady 轮询间隔 (ms)。默认 500ms。serve-api 软门控轮询亦复用此间隔。 */
  pollIntervalMs?: number
  /** waitReady 总超时 (ms)。默认 120s — 大库首次建表 + 迁移可能较慢。 */
  readyTimeoutMs?: number
  /** stop() 等待子进程优雅退出的超时 (ms), 超时后 SIGKILL。默认 5s。 */
  stopGraceMs?: number
  /** serve-api 软门控总超时 (ms)。默认 min(readyTimeoutMs, 30s) — uvicorn import 远快于大库迁移。 */
  apiReadyTimeoutMs?: number
  /** serve-api 就绪探针 (可注入便于单测; 默认 probeApiHealth → 真实 HTTP GET /api/health)。 */
  apiProbe?: (port: number) => Promise<boolean>
  /** serve-api 崩溃自拉起退避梯度 (ms, 可注入便于单测; 默认 CRASH_RESTART_BACKOFF_MS)。 */
  crashBackoffMs?: number[]
  /** crash-loop 断路器上限: 连续崩溃达此数 (中间无一次 ready) → 放弃自拉起 (可注入; 默认 MAX_CRASH_RESTARTS)。 */
  maxCrashRestarts?: number
}

export type BackendState = 'idle' | 'starting' | 'ready' | 'stopped' | 'failed'

/** 托管的 mailagent CLI 子进程类型。'serve'=主同步 (门控 waitReady); 'serve-api'=FastAPI 远程后端 (软门控)。 */
export type ServiceName = 'serve' | 'serve-api'

/**
 * 内部托管单元 (方案 A: 单 child → ManagedService[] registry, public API 语义保持"整体")。
 * 每 service 独立持有 child / state / 就绪探针 / 启用判据, start/stop/restart 遍历 registry。
 */
interface ManagedService {
  readonly name: ServiceName
  /** spawn 参数: ['serve'] | ['serve-api']。 */
  readonly args: string[]
  child: ChildProcess | null
  /** 每 service 独立状态 (getState() 聚合成单个 BackendState 不破坏调用方)。 */
  state: BackendState
  /** C2 崩溃自拉起 — 连续 crash 计数 (waitApiReady 标 ready 后清零; 达 maxCrashRestarts
   *  触发断路器停止重启)。仅 serve-api 用。 */
  restartAttempts: number
  /** C2 崩溃自拉起 — 退避中的 re-spawn 定时器 (stop/restartService 时清, 防多余重启)。 */
  restartTimer: NodeJS.Timeout | null
  /** 该 service 是否 spawn (serve 恒 true; serve-api 由 env gate)。 */
  readonly enabled: () => boolean
  /** 抽干该 service stdout/stderr 的落盘流 (防 pipe 背压死锁, 见 attachLogDrain)。
   *  🔴 多 service 必须**各自**一条流 + 独立文件名 (serve→backend-process.log /
   *  serve-api→api-process.log), 共用一个 createWriteStream 会交错/竞争。 */
  logStream: WriteStream | null
  /** 该 service 抽干日志的文件名 (落在 DATA_ROOT/logs/<logFile>)。 */
  readonly logFile: string
}

/**
 * serve-api 是否启用 (软 gate)。D1 起 serve-api 是 **Electron 本地写面** (write_ops /
 * draft 写工具经 daemon_api 转发到它); V2.1 3c cutover 后 **整个 chat 引擎** 也经它
 * (renderer 经 chat_local_bridge webRequest 直连 loopback 8200 跑 shared harness) —— 故
 * flag 名为「远程访问」实为**本地 daemon/serve-api 总开关**, `=false` 连本地写 + chat 都挂
 * (非仅关远程)。纯本地装机 (无 CF_AUDIENCE) 也必须起。唯一关掉条件 = 显式
 * `MAILAGENT_REMOTE_ACCESS_ENABLED='false'`。详见 docs/claude/remote-chat-report-architecture.md §8。
 *
 * 历史 (C2 及之前): 曾额外要求 `CF_AUDIENCE` 非空才 spawn —— 因 serve-api 的 auth.py
 * 在**模块 import 期** `if not AUTH_DISABLED and not CF_AUDIENCE: raise` 会 crash。
 * C2 已把该守卫放宽为「≥1 鉴权方式」(CF_AUDIENCE 或 MAILAGENT_LOCAL_API_TOKEN 任一即可),
 * 而本地 token 恒由 buildBaseEnv 注入 → 无 CF 也不再 crash。配合 C2 的崩溃自拉起 + 断路器
 * (maybeRestartAfterCrash), 此 flip 安全。CF_AUDIENCE 现仅决定「远程 (cloudflared) 是否
 * 可达」(serveApiEnv 透传它给远程 CF 腿), 不再是 serve-api 启动的前提。
 *
 * (env 经 index.ts bootstrapDotenv 从 app .env 注入 process.env, 这里直读。)
 */
function serveApiEnabled(): boolean {
  return process.env.MAILAGENT_REMOTE_ACCESS_ENABLED !== 'false'
}

/** serve-api uvicorn 端口 (env MAILAGENT_API_PORT, 默认 DEFAULT_API_PORT)。
 *  V2.1 3c-3: export 供 index.ts createWindow 经 `?apiPort=` 把端口透传 renderer
 *  —— ChatRuntime 的 loopback baseUrl 端口须 = serve-api 实际端口 =
 *  chat_local_bridge webRequest filter 端口 (三者同源此函数, 单一真源)。 */
export function resolveApiPort(): number {
  const raw = process.env.MAILAGENT_API_PORT
  const n = raw != null ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_API_PORT
}

/**
 * 打包后 web SPA 资源目录 (electron-builder extraResources `to: web` → Resources/web)。
 * serve-api 的 app.py `_SPA_DIR` 优先读此 env, 命中则 mount /app 静态 SPA (远程 Web);
 * dev 模式不注入 (返回 null), app.py fallback 到 worktree frontend/out/web (零变更)。
 * 锚点同 cli_runner.packagedResourcesBin (process.resourcesPath = .app/Contents/Resources)。
 */
function resolveSpaDir(): string | null {
  try {
    if (app.isPackaged !== true) return null
  } catch {
    return null
  }
  // process.resourcesPath 是 Electron 运行时注入的 (打包态必有); 单测/非 Electron
  // 环境缺失 → 不注入 (返 null), app.py fallback worktree out/web。防 join(undefined)。
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) return null
  return join(resourcesPath, 'web')
}

export class BackendLifecycleManager {
  /** service registry (替代旧的单 this.child)。serve 恒在; serve-api 由 enabled() 决定是否 spawn。 */
  private readonly services: ManagedService[] = [
    {
      name: 'serve',
      args: ['serve'],
      child: null,
      state: 'idle',
      restartAttempts: 0,
      restartTimer: null,
      enabled: () => true,
      logStream: null,
      logFile: 'backend-process.log'
    },
    {
      name: 'serve-api',
      args: ['serve-api'],
      child: null,
      state: 'idle',
      restartAttempts: 0,
      restartTimer: null,
      enabled: serveApiEnabled,
      logStream: null,
      logFile: 'api-process.log'
    }
  ]
  private readonly pollIntervalMs: number
  private readonly readyTimeoutMs: number
  private readonly stopGraceMs: number
  private readonly apiReadyTimeoutMs: number
  private readonly apiProbe: (port: number) => Promise<boolean>
  private readonly crashBackoffMs: number[]
  private readonly maxCrashRestarts: number

  constructor(opts: LifecycleOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000
    this.stopGraceMs = opts.stopGraceMs ?? 5_000
    // serve-api 软门控: uvicorn import 远快于大库迁移, 默认 min(readyTimeout, 30s) 上限。
    this.apiReadyTimeoutMs = opts.apiReadyTimeoutMs ?? Math.min(this.readyTimeoutMs, 30_000)
    this.apiProbe = opts.apiProbe ?? probeApiHealth
    this.crashBackoffMs = opts.crashBackoffMs ?? CRASH_RESTART_BACKOFF_MS
    this.maxCrashRestarts = opts.maxCrashRestarts ?? MAX_CRASH_RESTARTS
  }

  /**
   * 聚合各 enabled service 状态成单个 BackendState (不破坏 index.ts / onboarding 单状态调用方)。
   *
   * 🔴 向后兼容硬约束: **serve 的 'starting' 优先于 serve-api 的 'failed'**。理由 —
   * onboarding.ts:883/1189 在 `waitReady()` (serve-only 门控) 返回 not-ready 后, 用
   * `getState() === 'failed'` 区分「后端真崩 (配置错)」vs「大库慢迁移 (仍 starting)」。
   * 若让 serve-api 软失败 (端口占用等) 把聚合状态拉成 'failed', 会在 serve 仍慢迁移时
   * 误报 E_BACKEND_FAILED → 回归。故 serve 还在 starting 时, 聚合恒返回 'starting',
   * 不被 serve-api 的软状态抢占 (spec: serve-api 崩溃不应阻断 serve 的就绪门控)。
   *
   * serve 一旦定型 (ready/failed/stopped) 才回到常规聚合: 任一 failed→failed (此时
   * serve-api 失败会正确显示 'failed', 供 banner 提示远程访问降级); 全 ready→ready。
   */
  getState(): BackendState {
    const active = this.services.filter((s) => s.enabled())
    if (active.length === 0) return 'idle'
    const serve = this.services.find((s) => s.name === 'serve')
    // serve 门控未定型 (慢迁移中) → serve-api 软状态不得抢占, 保持 'starting'。
    if (serve && serve.state === 'starting') return 'starting'
    if (active.some((s) => s.state === 'failed')) return 'failed'
    if (active.every((s) => s.state === 'ready')) return 'ready'
    if (active.some((s) => s.state === 'starting')) return 'starting'
    if (active.some((s) => s.state === 'stopped')) return 'stopped'
    return 'idle'
  }

  /** 精细化: 单个 service 的状态 (可选, 供诊断/banner; index.ts 不强制用)。 */
  getServiceState(name: ServiceName): BackendState {
    const svc = this.services.find((s) => s.name === name)
    return svc ? svc.state : 'idle'
  }

  /** 当前是否由本 manager 托管后端 (仅打包模式)。dev 模式恒 false。 */
  isManaged(): boolean {
    return this.safeIsPackaged()
  }

  /**
   * spawn 所有 enabled service (serve + serve-api if gated on)。仅打包模式接管;
   * dev 模式 no-op (走 pm2)。各 service 注入三 env: MAILAGENT_PROJECT_ROOT /
   * MAILAGENT_ENV_FILE / SYNC_STORE_DB_PATH, cwd = DATA_ROOT。serve-api 额外注入
   * MAILAGENT_API_PORT (透传或默认 8200)。幂等 (child && !killed → skip 该 service)。
   *
   * serve-api 就绪是**软门控**: start() 内 fire-and-forget 后台轮询 probeApiHealth,
   * 失败仅 console.warn + 标该 service failed, 不阻塞开窗 (waitReady 只 gate serve)。
   */
  start(): void {
    if (!this.safeIsPackaged()) {
      // dev / 服务器部署: 后端由 pm2 托管, 不接管。
      return
    }
    const dataRoot = resolveDataRoot()
    const baseEnv = this.buildBaseEnv(dataRoot)
    for (const svc of this.services) {
      if (!svc.enabled()) continue
      this.spawnService(svc, baseEnv, dataRoot)
    }
  }

  /** 路径 env (serve + serve-api 共享): DATA_ROOT / ENV_FILE / DB_PATH 等。 */
  private buildBaseEnv(dataRoot: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // cwd 已是 DATA_ROOT, 但显式注入路径 env 让 Python 侧解析无歧义。
      // 🔴 MAILAGENT_DATA_ROOT 才是 config.py `_resolve_data_root()` 真正读的 key ——
      // 缺它则后端 (serve + serve-api 都一样) DATA_ROOT fallback 到
      // dirname(dirname(__file__)) = 打包 bundle 内只读的 site-packages, 令 log_file /
      // attachment_storage_dir 等所有 _under_data_root 默认路径错锚进只读 .app
      // (serve-api 的 EmailRepository 读 SQLite / 附件 stream 都靠它锚定可写根)。
      // PROJECT_ROOT 后端并不读 (仅前端 cli_runner 用), 保留仅为兼容。
      MAILAGENT_PROJECT_ROOT: dataRoot,
      MAILAGENT_DATA_ROOT: dataRoot,
      MAILAGENT_ENV_FILE: join(dataRoot, '.env'),
      SYNC_STORE_DB_PATH: resolveDbPath(),
      // C2 双层鉴权: per-session 本地 token 注入 serve (9200 SSE 门) + serve-api (8200
      // dual-auth 本地腿)。同一单例也供 events_bridge 带 header → 两端同值。getLocalApiToken
      // 首次取用即 randomBytes 生成, 进程级常驻。
      [LOCAL_TOKEN_ENV]: getLocalApiToken()
    }
  }

  /**
   * spawn **单个** service + 接 drain + exit/error handler + serve-api 软门控。
   * 幂等 (child 在跑 → skip)。start() 与 restartService() 共用此路径, 保证两入口
   * env 注入 / pipe drain / 状态机完全一致。
   */
  private spawnService(svc: ManagedService, baseEnv: NodeJS.ProcessEnv, dataRoot: string): void {
    if (svc.child && !svc.child.killed) return // 幂等: 该 service 已在跑
    const bin = getMailagentBin()
    const env: NodeJS.ProcessEnv = svc.name === 'serve-api' ? this.serveApiEnv(baseEnv) : baseEnv
    svc.state = 'starting'
    const child = spawn(bin, svc.args, { cwd: dataRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    svc.child = child
    // 🔴 spawn 后**立刻** (任何 await 之前) 抽干 stdout/stderr —— 不消费 pipe 会背压
    // 死锁把进程整个拖死 (详见 attachLogDrain)。serve 与 serve-api 各落独立文件。
    this.attachLogDrain(svc, dataRoot)
    child.on('exit', (code, signal) => {
      // 非主动 stop() 触发的退出 → 标记该 service failed (带 name 维度)。
      if (svc.state !== 'stopped') {
        svc.state = 'failed'
        console.error(`[backend_lifecycle] ${svc.name} exited code=${code} signal=${signal}`)
        svc.child = null
        // C2: serve-api 崩溃自拉起 (指数退避 + crash-loop 断路器)。其它 service / 主动 stop 不触发。
        this.maybeRestartAfterCrash(svc)
        return
      }
      svc.child = null
    })
    child.on('error', (err) => {
      svc.state = 'failed'
      console.error(`[backend_lifecycle] ${svc.name} spawn error`, err)
    })
    // serve-api 软门控: 后台轮询其 /api/health, 起来标 ready, 超时只 warn — 不阻塞开窗。
    if (svc.name === 'serve-api') {
      void this.waitApiReady(svc)
    }
  }

  /**
   * C2 — serve-api 崩溃自拉起 (指数退避 + crash-loop 断路器)。仅 serve-api: 它是远程写面,
   * 崩了不该静默无人拉 (serve 崩由 waitReady 门控兜底降级, 不在此列)。dev 模式不接管。
   *
   * 断路器: 连续崩溃 (中间无一次就绪) 达 maxCrashRestarts → 放弃自拉起, 停在 failed —
   * 防 import 期必崩的配置错误 (坏依赖等) 把 CPU 烧穿。waitApiReady 标 ready 时清零计数,
   * 故「崩→恢复→再崩」每次都有完整退避额度, 只有持续崩才触发断路器。
   * gate 关 (enabled()=false, 如 CF_AUDIENCE 被清空) 也不重启 (留在 failed)。
   */
  private maybeRestartAfterCrash(svc: ManagedService): void {
    if (svc.name !== 'serve-api') return
    if (!this.safeIsPackaged()) return
    if (!svc.enabled()) return // gate 关 → 不自拉起
    if (svc.restartAttempts >= this.maxCrashRestarts) {
      console.error(
        `[backend_lifecycle] serve-api 连续崩溃 ${svc.restartAttempts} 次 (断路器打开), 停止自拉起。` +
          ' 检查 .env (CF_AUDIENCE / 依赖) 后手动 restart。远程访问暂不可用, 本地 Electron 不受影响。'
      )
      return
    }
    const idx = Math.min(svc.restartAttempts, this.crashBackoffMs.length - 1)
    const delayMs = this.crashBackoffMs[idx]
    svc.restartAttempts += 1
    if (svc.restartTimer) clearTimeout(svc.restartTimer)
    svc.restartTimer = setTimeout(() => {
      svc.restartTimer = null
      // 退避期间被 stop() (state=stopped) 或已被别的路径拉起 → 不重复 spawn。
      if (svc.state === 'stopped') return
      if (svc.child) return
      const dataRoot = resolveDataRoot()
      this.spawnService(svc, this.buildBaseEnv(dataRoot), dataRoot)
    }, delayMs)
  }

  /**
   * serve-api child 的完整 env (在 baseEnv 之上叠加远程访问专属 env)。
   *
   * baseEnv 已含 MAILAGENT_DATA_ROOT / ENV_FILE / DB_PATH (serve 共享)。serve-api 另需:
   *   - MAILAGENT_API_PORT     : uvicorn bind 端口 (默认 8200, 透传用户自定义);
   *   - MAILAGENT_SPA_DIR      : 打包后 web 资源绝对路径 (app.py 优先读它 mount /app
   *                              静态 SPA; dev 不注入 → app.py fallback worktree out/web);
   *   - CF_AUDIENCE / CF_TEAM_DOMAIN / MAILAGENT_API_ALLOWED_EMAIL : Cloudflare Access
   *     鉴权三件套, auth.py 模块 import 期直读 (其中 CF_AUDIENCE 缺失会 raise → 进程崩,
   *     已由 serveApiEnabled() 软 gate 拦在 spawn 前; 此处显式注入是为契约可测 +
   *     不依赖子命令是否自行 load_dotenv)。
   *
   * 这些值经 index.ts bootstrapDotenv 从 app .env 注入 process.env, baseEnv 已透传 ——
   * 此处再显式列出是为「serve-api spawn 注入完整 env」契约清晰可断言 (而非靠继承的隐式
   * 透传)。仅当 process.env 里非空才 set, 避免把 undefined 写成字面 "undefined" 字符串。
   */
  private serveApiEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv, MAILAGENT_API_PORT: String(resolveApiPort()) }
    const spaDir = resolveSpaDir()
    if (spaDir) env.MAILAGENT_SPA_DIR = spaDir
    // Cloudflare Access 鉴权 env: 仅透传非空值 (空值交由 Python 端按未配置处理)。
    for (const key of ['CF_AUDIENCE', 'CF_TEAM_DOMAIN', 'MAILAGENT_API_ALLOWED_EMAIL'] as const) {
      const v = process.env[key]
      if (v != null && v.length > 0) env[key] = v
    }
    return env
  }

  /**
   * 持续抽干**单个 service** 的 stdout/stderr → DATA_ROOT/logs/<svc.logFile>。
   *
   * 🔴 防 pipe 背压死锁 (本类最关键的不变量): stdio=pipe 的内核缓冲区只有几十 KB,
   * 后端 loguru 默认往 stdout 加了全量 sink, 不读则写满后, 进程下一次 write() 会永久
   * 阻塞在 asyncio event loop 主线程 → 邮件同步 + SSE / serve-api 全部卡死且永不自愈。
   * serve-api 比 serve 更危险: 每个请求都可能 log, 写满 pipe 后 /api/health 永不响应
   * → probeApiHealth 超时 → 误判 failed。
   *
   * 多 service 各持独立流 + 独立文件名 (serve→backend-process.log / serve-api→
   * api-process.log), 决不共用一个 createWriteStream (会交错/竞争)。截断模式 (flags:'w')
   * 每次 spawn 覆盖, 只留本次进程输出防无限增长。drain 接不上 (建目录/开流失败) 退化
   * resume() 丢弃 —— 宁丢诊断日志, 也不能让 pipe 写满把进程拖死。
   */
  private attachLogDrain(svc: ManagedService, dataRoot: string): void {
    const child = svc.child
    if (!child) return
    try {
      const logDir = join(dataRoot, 'logs')
      mkdirSync(logDir, { recursive: true })
      const stream = createWriteStream(join(logDir, svc.logFile), { flags: 'w' })
      svc.logStream = stream
      child.stdout?.on('data', (chunk: Buffer) => stream.write(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stream.write(chunk))
    } catch (err) {
      console.error(
        `[backend_lifecycle] ${svc.name} log drain 接入失败, 退化为丢弃 (防 pipe 死锁)`,
        err
      )
      svc.logStream = null
      child.stdout?.resume()
      child.stderr?.resume()
    }
  }

  /** 关闭单个 service 的落盘流 (stop() 内调, 防 fd 泄漏)。 */
  private closeLogStream(svc: ManagedService): void {
    if (svc.logStream) {
      try {
        svc.logStream.end()
      } catch {
        /* 关流失败无所谓 — GC 会回收 fd。 */
      }
      svc.logStream = null
    }
  }

  /**
   * 软门控后台轮询 serve-api 的 /api/health (fire-and-forget, 不入 waitReady 返回值)。
   * 起来 → 标该 service 'ready'; 超时/崩溃 → 只 console.warn (远程访问是增量能力,
   * serve-api 起不来不该让本地 Electron 黑屏)。serve-api 启动只是 uvicorn import,
   * 远快于大库迁移, 给独立的 apiReadyTimeoutMs (默认复用 readyTimeoutMs 但更短上限)。
   */
  private async waitApiReady(svc: ManagedService): Promise<void> {
    const port = resolveApiPort()
    const deadline = Date.now() + this.apiReadyTimeoutMs
    for (;;) {
      // 进程已崩溃 (on('exit'/'error') 置 failed) → 停止轮询, exit handler 已 warn。
      if (svc.state === 'failed') return
      // 被 stop() 主动停掉 → 不再轮询。
      if (svc.state === 'stopped') return
      const ok = await this.apiProbe(port)
      if (ok) {
        // 仅当未被 stop()/崩溃抢先改状态时才标 ready (避免 clobber stopped/failed)。
        if (svc.state === 'starting') {
          svc.state = 'ready'
          svc.restartAttempts = 0 // C2: 一次成功就绪 → 清零崩溃计数 (断路器复位)
        }
        return
      }
      if (Date.now() >= deadline) {
        if (svc.state === 'starting') {
          svc.state = 'failed'
          console.warn(
            `[backend_lifecycle] serve-api 未在 ${this.apiReadyTimeoutMs}ms 内就绪 (GET 127.0.0.1:${port}/api/health); ` +
              '远程访问 (cloudflared tunnel) 暂不可用, 本地 Electron 不受影响。'
          )
        }
        return
      }
      await delay(this.pollIntervalMs)
    }
  }

  /**
   * 轮询直读 SQLite 直到 **serve** 就绪 (db_version>=EXPECTED 且关键表齐全)。
   * **只 gate serve** (开主窗门控): Electron 本地 IPC 走 serve 的 SQLite, 与 serve-api
   * 无关 — serve-api 是远程 Web 用的, 主窗不依赖它, 故其就绪不入此返回值 (软门控)。
   * 这是向后兼容关键点: 不开 serve-api 时 waitReady 行为与改造前逐字节一致。
   * - 锁表 (SQLITE_BUSY): 退避重试, 不判失败。
   * - 超过 readyTimeoutMs: resolve(false), 由调用方决定降级 (导回 onboarding /
   *   仍开窗但 IPC 自带 not-found 兜底)。
   *
   * @param probe 可注入的探测函数, 便于单测。默认 probeDbReady。
   */
  async waitReady(probe: () => ReadinessResult = probeDbReady): Promise<boolean> {
    const serve = this.services.find((s) => s.name === 'serve')!
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const r = probe()
      if (r.ready) {
        if (this.safeIsPackaged()) serve.state = 'ready'
        return true
      }
      // serve 进程已崩溃 (bad config / spawn error → on('exit'/'error') 置 failed) →
      // 快速失败, 不傻等满 readyTimeoutMs (120s 是给大库迁移留的, 崩溃不该等)。
      if (this.safeIsPackaged() && serve.state === 'failed') {
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
   * kill + re-spawn 所有 enabled service (取代 pm2 restart), 供 env:set 后 banner 调用。
   * dev 模式 no-op。两个进程都 reload 新 .env (正确: env 变更影响 serve + serve-api)。
   * 重启后需调用方自行 waitReady (serve 门控; serve-api 软门控在 start() 内自恢复)。
   */
  async restart(): Promise<void> {
    if (!this.safeIsPackaged()) return
    await this.stop()
    this.start()
  }

  /**
   * 只重启**单个** service (不动其它), 供 Settings 改远程访问配置 (CF/port/开关) 后
   * 单独 reload serve-api —— 不打断 serve 的同步批次 (restart() 会顺带 stop serve 中断
   * 几秒同步)。dev 模式 no-op。
   *
   * 重新读 enabled() gate (serveApiEnabled 重读 MAILAGENT_REMOTE_ACCESS_ENABLED +
   * CF_AUDIENCE 是否就绪): 关→开 / 填好 CF_AUDIENCE 后 spawn; 开→关 / 清空 CF 后只 stop
   * 不再 spawn (service 留在 stopped, getState 聚合时 enabled()=false 不计入)。
   * env 从最新 process.env 重建 —— 但 .env 改动需先经 bootstrapDotenv/env:set 落到
   * process.env 才会被读到 (Settings 流程: env:set 写 .env + 同步 process.env → 调本方法)。
   */
  async restartService(name: ServiceName): Promise<void> {
    if (!this.safeIsPackaged()) return
    const svc = this.services.find((s) => s.name === name)
    if (!svc) return
    await this.stopService(svc)
    if (!svc.enabled()) return // gate 关 (开关 off / CF_AUDIENCE 空) → 停了就不再起
    svc.restartAttempts = 0 // C2: 手动重启 = 一次干净起步, 复位崩溃自拉起断路器计数。
    const dataRoot = resolveDataRoot()
    this.spawnService(svc, this.buildBaseEnv(dataRoot), dataRoot)
  }

  /**
   * before-quit: 对所有在跑 service 发 SIGTERM + 等待优雅退出, 各自超过 stopGraceMs
   * 升级 SIGKILL。dev 模式 no-op。逐 service 复用旧的 SIGTERM→grace→SIGKILL→等 exit 语义。
   */
  async stop(): Promise<void> {
    await Promise.all(this.services.map((svc) => this.stopService(svc)))
  }

  /** 停单个 service (SIGTERM → grace → SIGKILL → 等真正 exit)。逐 service 复用 codex #3/#4 教训。 */
  private async stopService(svc: ManagedService): Promise<void> {
    // C2: 取消退避中的崩溃自拉起定时器 (主动 stop 优先于自拉起, 防停掉后又被拉起)。
    if (svc.restartTimer) {
      clearTimeout(svc.restartTimer)
      svc.restartTimer = null
    }
    const child = svc.child
    if (!child || child.killed) {
      svc.state = 'stopped'
      this.closeLogStream(svc)
      return
    }
    svc.state = 'stopped'
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
    svc.child = null
    this.closeLogStream(svc)
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

/** C2 serve-api 崩溃自拉起退避梯度 (ms, 仿 events_bridge BACKOFF_MS): 1s→2s→5s→10s→30s 封顶。 */
const CRASH_RESTART_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
/** C2 crash-loop 断路器上限: 连续崩溃 (中间无一次 ready) 达此数 → 放弃自拉起 (防必崩配置烧 CPU)。 */
const MAX_CRASH_RESTARTS = 5

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
