// better-sqlite3 singleton. Sprint 0 = open with WAL + busy_timeout; Sprint 1
// IPC handlers (email.list / .get / .body / .search / attachment.list) consume
// this. Path resolution per ARCHITECTURE.md §5:
//   1. env SYNC_STORE_DB_PATH (matches the backend's pydantic Config)
//   2. user override from settings.json (`dbPath`) — Sprint 8 wire-through
//   3. ~/Documents/MailAgent/data/sync_store.db (project default)
// We never open the file write-mode from the renderer — schema is mail-sync
// territory (REVIEW-LOG C-05); frontend reads only, and writes go via the
// `mailagent` CLI subprocess.

import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { isSafeUserPath } from './lib/path-guard'

let _db: Database.Database | null = null
let _writeDb: Database.Database | null = null

/**
 * Read the user's `dbPath` override from `<userData>/settings.json`. Returns
 * the validated absolute path or null on any failure — Sprint 7 review
 * MEDIUM #1 fix: the IPC sanitizer was dead code without this wire.
 *
 * Defense-in-depth: even though `handlers/settings.ts:sanitize()` already
 * runs `isSafeUserPath()` on write, we re-validate on read so a settings
 * file that was tampered with out-of-band (manual edit, sync conflict
 * roll-back) cannot smuggle a traversal through.
 */
export function settingsDbPathOverride(): string | null {
  try {
    const SETTINGS_FILE = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(SETTINGS_FILE)) return null
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { dbPath?: unknown }
    if (typeof raw.dbPath !== 'string') return null
    if (!isSafeUserPath(raw.dbPath)) return null
    return raw.dbPath
  } catch {
    return null
  }
}

/**
 * Packaging P1-3/§3.4 — 统一可写数据根目录 `DATA_ROOT`。打包模式下所有可写
 * 数据 (sync_store.db / attachments / logs / .env) 归集到一个根, 与 bundle
 * 内只读资源分离。解析优先级:
 *   1. env `MAILAGENT_DATA_ROOT` (显式覆盖, dev/packaged 通用)
 *   2. packaged 模式 = `<userData>` (~/Library/Application Support/MailAgent)
 *   3. dev 模式 = `~/Documents/MailAgent` (现有项目根布局, 零变更)
 *
 * 注意: 与 `resolveDbPath()` 的 db/attachments `DATA_ROOT/data/` 同级硬约束
 * 配套 (见 attachment.ts `dirname(dirname(resolveDbPath()))` 倒推)。db 默认值
 * = `DATA_ROOT/data/sync_store.db`, 保持层级不变, 前端推算逻辑零改动。
 */
export function resolveDataRoot(): string {
  const fromEnv = process.env['MAILAGENT_DATA_ROOT']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  if (isPackaged()) {
    try {
      return app.getPath('userData')
    } catch {
      // app.getPath('userData') 在 app.whenReady 前会抛 —— 而 bootstrapDotenv() 是
      // index.ts 模块级调用(早于 whenReady), 必然命中这条。
      // 🔴 dogfood-2: 绝不能 fall through 到 ~/Documents —— 后续 existsSync(~/Documents/
      // MailAgent/.env) 会在打包 app 启动早期触发 macOS「文稿」TCC 授权框(用户反复反馈)。
      // 改用确定性推算的 userData 路径(= app.getPath('userData') 的实际值, name 由
      // package.json `mailagent-frontend` 决定; 见 userData 目录), 完全不碰 ~/Documents。
      return join(homedir(), 'Library', 'Application Support', 'mailagent-frontend')
    }
  }
  return join(homedir(), 'Documents', 'MailAgent')
}

/** `app.isPackaged` 的安全读取 — 单测里 mock 的 `app` 可能不带该字段,
 *  缺失时按 dev (false) 处理, 保证 dev 行为零变更。 */
function isPackaged(): boolean {
  try {
    return app.isPackaged === true
  } catch {
    return false
  }
}

export function resolveDbPath(): string {
  const fromEnv = process.env['SYNC_STORE_DB_PATH']
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  // Sprint 8 §2.2 — settings.json wire-through (Sprint 7 review MEDIUM #1).
  // `settingsDbPathOverride()` returns null when `app` isn't ready (e.g.
  // unit tests that import this module before `app.whenReady()`), keeping
  // existing fixture-based tests working without modification.
  try {
    const fromSettings = settingsDbPathOverride()
    if (fromSettings && existsSync(fromSettings)) return fromSettings
  } catch {
    /* app.getPath() can throw before app.whenReady() — fall through to default. */
  }
  // Packaging P1-3 — 默认值改为 `DATA_ROOT/data/sync_store.db`。dev 模式
  // resolveDataRoot() 返回 ~/Documents/MailAgent → 默认值与历史完全一致
  // (零变更); packaged 模式返回 <userData>/data/sync_store.db。env +
  // settings.json 两级覆盖仍优先于此, 优先级链不变。
  return join(resolveDataRoot(), 'data', 'sync_store.db')
}

export function getDb(): Database.Database {
  if (_db) return _db
  const path = resolveDbPath()
  if (!existsSync(path)) {
    throw new Error(
      `sync_store.db not found at ${path}. Set SYNC_STORE_DB_PATH or run mail-sync first.`
    )
  }
  _db = new Database(path, { readonly: true, fileMustExist: true })
  _db.pragma('journal_mode = WAL')
  // Sprint 16 perf — main 线程被锁阻塞 2s 是不可接受 (Electron single thread,
  // UI 会卡死). 500ms 已经够 SQLite WAL writer 完成一次正常事务 (~10ms typical);
  // 真锁住超过 500ms 则报错让上层 retry, 不应该让 IPC 调用挂死.
  _db.pragma('busy_timeout = 500')
  return _db
}

/**
 * Sprint 16 收尾 — IPC 直写 SQLite (打破 Sprint 5 "frontend readonly" 假设).
 * 独立的 readwrite connection 让 write_ops handler 不必 fork mailagent CLI
 * (~500-1000ms Python 冷启) 就能改 email_metadata + email_outbox.
 *
 * WAL mode 允许多个 reader + 单 writer 并发. mail-sync 是 outbox 消费者
 * (FanoutWorker) 也会写 email_metadata (update_local_flags), 但跟 frontend
 * 用户主动操作的并发概率极低 (秒级人工 vs 5s tick). busy_timeout=500ms 兜底
 * 极端 race.
 *
 * 不复用 _db: readonly handle 上 PRAGMA journal_mode=WAL 已设. readwrite 必须
 * 是独立 connection (better-sqlite3 不允许 readonly handle 升级 readwrite).
 */
export function getWriteDb(): Database.Database {
  if (_writeDb) return _writeDb
  const path = resolveDbPath()
  if (!existsSync(path)) {
    throw new Error(
      `sync_store.db not found at ${path}. Set SYNC_STORE_DB_PATH or run mail-sync first.`
    )
  }
  _writeDb = new Database(path, { readonly: false, fileMustExist: true })
  _writeDb.pragma('journal_mode = WAL')
  _writeDb.pragma('busy_timeout = 500')
  // 性能 — synchronous=NORMAL 在 WAL mode 下是 SQLite 推荐值; FULL 仅在
  // power-loss 场景才用得着, 损失 ~30% 写入吞吐. 跟 mail-sync 端默认对齐.
  _writeDb.pragma('synchronous = NORMAL')
  return _writeDb
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
  if (_writeDb) {
    _writeDb.close()
    _writeDb = null
  }
}
