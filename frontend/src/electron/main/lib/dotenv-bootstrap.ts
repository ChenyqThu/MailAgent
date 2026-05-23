// Sprint 19 — Load 项目根 .env 进 process.env at main-process boot.
//
// 背景: env-handler 复用 resolveEnvPath() + parseEnv() 给 SettingsPage UI
// 读写, 但 main process 启动时不 auto-load 这个 .env. 结果 chat/config.ts
// 的 readEnvBool('MAILAGENT_AGENT_HARNESS' / 'MAILAGENT_KOS_*') 永远拿
// undefined → default false → harness path / KOS consumer / L1 hot block
// 全没生效. PR-2g dogfood checklist §3.1 改根 .env 后 frontend 看不到.
//
// 这个 module 在 index.ts import 后立即调一次, 把项目根 .env 注入 process.env.
//
// 行为契约:
//   - process.env[KEY] 已存在 (shell export / OS-level / electron-vite 注入)
//     时优先保留, 不覆盖. dotenv 业界默认 (override:false), 让 user 能用
//     `MAILAGENT_AGENT_HARNESS=1 pnpm dev` 临时覆盖.
//   - .env 缺失返回 exists:false 不抛, 跟 env-handler readSnapshot 行为一致.
//   - parse 错误 swallow + warn — main process 不该因 .env 问题 boot 失败.
//   - 不打印 secret value 到 log, 只列 key 数量.
//   - 不被 MAILAGENT_ENV_FILE 影响以外的 override 路径覆盖 (resolveEnvPath
//     的 cache 一致性由它自己保证).

import { existsSync, readFileSync } from 'fs'

import { resolveEnvPath } from './env-path'
import { parseEnv, toRecord } from './env-parser'

export interface DotenvBootstrapResult {
  path: string
  exists: boolean
  /** 写进 process.env 的 key 数 (已 export 的不算) */
  loaded: number
  /** .env 里有但 process.env 已存在被保留的 key 数 */
  skipped: number
  /** .env 解析出的 active kv 总数 */
  totalInFile: number
}

/** Pure load function — no logging, no error swallow. Tests use this. */
export function loadDotenvIntoProcessEnv(): DotenvBootstrapResult {
  const path = resolveEnvPath()
  if (!existsSync(path)) {
    return { path, exists: false, loaded: 0, skipped: 0, totalInFile: 0 }
  }
  const text = readFileSync(path, 'utf8')
  const parsed = parseEnv(text)
  const all = toRecord(parsed)
  let loaded = 0
  let skipped = 0
  for (const [key, value] of Object.entries(all)) {
    if (process.env[key] !== undefined) {
      skipped++
      continue
    }
    process.env[key] = value
    loaded++
  }
  return {
    path,
    exists: true,
    loaded,
    skipped,
    totalInFile: Object.keys(all).length
  }
}

/** Boot wrapper: logs a one-line summary + swallows errors so a malformed
 *  .env doesn't crash main process. Used from index.ts on boot. */
export function bootstrapDotenv(): DotenvBootstrapResult {
  try {
    const result = loadDotenvIntoProcessEnv()
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(
        `[dotenv-bootstrap] path=${result.path} exists=${result.exists} ` +
          `loaded=${result.loaded}/${result.totalInFile} skipped=${result.skipped}`
      )
    }
    return result
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn('[dotenv-bootstrap] failed:', (err as Error).message)
    }
    return { path: '', exists: false, loaded: 0, skipped: 0, totalInFile: 0 }
  }
}
