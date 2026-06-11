// MAILAGENT_CLI_API_KEY 自愈 (产品缺陷修复)。
//
// 背景: onboarding 向导只写必填配置, 从不生成 MAILAGENT_CLI_API_KEY → userData
// .env 缺该 key → src/cli/auth.py require_auth 对所有写命令 (report:setConfig /
// runNow / delete 等 cli_runner needsAuth 路径) 抛 E_AUTH_FAILED (exit 4),
// UI 只表现为"开关弹回"且不显示原因。Python 端 expected 与前端 --api-key
// provided 读的是同一份 .env, 所以补一个随机 token 进 .env 两边即同时打通。
//
// 幂等契约 (boot + onboarding 各调一次, 重复调用安全):
//   - process.env 已有非空值 → no-op (bootstrapDotenv 已注入 / shell export 优先)。
//   - .env 不存在 → no-op。detectUserState 以"无 .env"判 'new', boot 期凭空建
//     文件会把全新用户误判成 config-incomplete; 新用户由 onboarding 写完核心
//     配置后再调本函数补 key。
//   - .env 有 key 但 process.env 没有 → 只同步 process.env (onboarding 刚写的
//     .env / legacy 继承带过来的 key, boot 时 bootstrapDotenv 还没见过它),
//     让 keychain.getCliApiKey() env-first 不重启即可读到。
//   - 两边都没有 → 生成随机 token, writePatch 写 .env (writePatch 自带
//     process.env 同步; key 在 MANAGED_ENV_KEYS + SECRET_ENV_KEYS 白名单内)。

import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'

import { writePatch } from '../handlers/env'
import { parseEnv, toRecord } from './env-parser'
import { resolveEnvPath } from './env-path'

export const CLI_API_KEY_ENV = 'MAILAGENT_CLI_API_KEY'

export interface EnsureCliApiKeyResult {
  /** present = 已有 (process.env 或 .env); generated = 本次新生成写入;
   *  skipped-no-env = .env 不存在不动; error = 写入失败 (best-effort 不抛)。 */
  outcome: 'present' | 'generated' | 'skipped-no-env' | 'error'
  error?: string
}

export function generateCliApiKey(): string {
  return randomBytes(24).toString('hex')
}

export function ensureCliApiKey(): EnsureCliApiKeyResult {
  try {
    const fromProcess = process.env[CLI_API_KEY_ENV]
    if (fromProcess && fromProcess.length > 0) return { outcome: 'present' }

    const path = resolveEnvPath()
    if (!existsSync(path)) return { outcome: 'skipped-no-env' }

    const values = toRecord(parseEnv(readFileSync(path, 'utf8')))
    const fromFile = values[CLI_API_KEY_ENV]
    if (fromFile && fromFile.length > 0) {
      process.env[CLI_API_KEY_ENV] = fromFile
      return { outcome: 'present' }
    }

    const res = writePatch({ [CLI_API_KEY_ENV]: generateCliApiKey() })
    if (!res.ok) {
      logWarn(`writePatch failed: ${res.error.message}`)
      return { outcome: 'error', error: res.error.message }
    }
    logInfo('generated missing MAILAGENT_CLI_API_KEY into .env')
    return { outcome: 'generated' }
  } catch (err) {
    const message = (err as Error).message
    logWarn(message)
    return { outcome: 'error', error: message }
  }
}

// 不打印 token 本体 (SECRET_ENV_KEYS 契约: secret 不进 log)。
function logInfo(msg: string): void {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[cli-api-key] ${msg}`)
  }
}
function logWarn(msg: string): void {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[cli-api-key] ${msg}`)
  }
}
