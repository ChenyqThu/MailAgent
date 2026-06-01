// `.env` path resolver (SSoT) — packaging-aware (#2 修复)。
//
// 死硬约束: 前端写/读的 .env 必须跟 Python 后端读的 .env 是同一个文件, 否则
// 用户走完向导写进 A 文件, 后端去读空的 B 文件 → config=Config() 校验失败 →
// serve 崩 → waitReady 超时 → 卡住。后端侧:
//   - config.py `_resolve_env_file()`: 优先 MAILAGENT_ENV_FILE, 否则 DATA_ROOT/.env
//   - backend_lifecycle spawn serve 时显式注入 MAILAGENT_ENV_FILE = resolveDataRoot()/.env
// 所以前端这里也对齐到 `resolveDataRoot()/.env`:
//   - dev:      resolveDataRoot() = ~/Documents/MailAgent → ~/Documents/MailAgent/.env (与历史一致, 零变更)
//   - packaged: resolveDataRoot() = <userData>            → <userData>/.env (修复前端写 getProjectRoot 老路径、
//                                                            后端读 userData 的分叉)
// MAILAGENT_ENV_FILE 显式覆写永远最高优先 (CI / vitest fixture / 隔离 dogfood)。
//
// 首次解析后缓存 (index.ts:52 bootstrapDotenv 是首个调用方, 此时 app.getPath('userData')
// 已可用)。`refreshEnvPath()` 仅用于单测; 生产代码不要调它。

import { join } from 'path'

import { resolveDataRoot } from '../db'

let _cached: string | null = null

/** Resolve the `.env` file path. Caches on first call. */
export function resolveEnvPath(): string {
  if (_cached !== null) return _cached

  // 显式覆写: 与后端 config.py + backend_lifecycle 注入口径一致, 最高优先。
  const override = process.env['MAILAGENT_ENV_FILE']
  if (override && override.length > 0) {
    _cached = override
    return _cached
  }

  // 默认 = DATA_ROOT/.env, 与后端读取位置 + backend_lifecycle 注入的
  // MAILAGENT_ENV_FILE=DATA_ROOT/.env 完全对齐 (dev 态 = 历史的
  // ~/Documents/MailAgent/.env, 零行为变更)。
  _cached = join(resolveDataRoot(), '.env')
  return _cached
}

/** Vitest-only: drop the cache so a fresh resolveEnvPath() picks up a
 *  changed env / fixture root. Do NOT call from production code. */
export function refreshEnvPath(): void {
  _cached = null
}
