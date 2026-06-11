// MAILAGENT_OUTBOX_ENABLED 默认值自愈 (产品缺陷修复)。
//
// 背景: Sprint 15 SSoT inversion 后服务层写路径 (mail_write.set_flags 等) 固定走
// 「写 SQLite + enqueue email_outbox」, 由 FanoutWorker 异步派发到 Mail 后端 +
// Notion。FanoutWorker 受 MAILAGENT_OUTBOX_ENABLED 控制 (代码默认 false, 灰度期
// 遗留), 而 onboarding 从不写这个 key → 打包 App 派发器永远不跑 → 用户的旗标/
// 已读/完成操作只改本地 SQLite, Exchange 和 Notion 永远收不到 (实测装机 10 天
// 静默积压 1564 条 pending flag_sync)。
//
// 幂等契约 (boot + onboarding 各调一次, 与 ensureCliApiKey 同模式):
//   - process.env 已有非空值 (含 'false') → no-op。显式配置 = 用户/运维的灰度
//     回退选择, 自愈绝不覆盖。
//   - .env 不存在 → no-op (detectUserState 以"无 .env"判 'new'; 新用户由
//     onboarding 写完核心配置后再调本函数补默认值)。
//   - .env 有 key 但 process.env 没有 → 只同步 process.env, 不重写文件
//     (同样不覆盖显式 false)。
//   - 两边都没有 → writePatch 写 'true' (writePatch 自带 process.env 同步;
//     key 在 MANAGED_ENV_KEYS 白名单内)。

import { existsSync, readFileSync } from 'fs'

import { writePatch } from '../handlers/env'
import { parseEnv, toRecord } from './env-parser'
import { resolveEnvPath } from './env-path'

export const OUTBOX_ENABLED_ENV = 'MAILAGENT_OUTBOX_ENABLED'

export interface EnsureOutboxEnabledResult {
  /** present = 已有显式值 (process.env 或 .env, 不覆盖); written = 本次写入默认
   *  'true'; skipped-no-env = .env 不存在不动; error = 写入失败 (best-effort 不抛)。 */
  outcome: 'present' | 'written' | 'skipped-no-env' | 'error'
  error?: string
}

export function ensureOutboxEnabled(): EnsureOutboxEnabledResult {
  try {
    const fromProcess = process.env[OUTBOX_ENABLED_ENV]
    if (fromProcess && fromProcess.length > 0) return { outcome: 'present' }

    const path = resolveEnvPath()
    if (!existsSync(path)) return { outcome: 'skipped-no-env' }

    const values = toRecord(parseEnv(readFileSync(path, 'utf8')))
    const fromFile = values[OUTBOX_ENABLED_ENV]
    if (fromFile && fromFile.length > 0) {
      process.env[OUTBOX_ENABLED_ENV] = fromFile
      return { outcome: 'present' }
    }

    const res = writePatch({ [OUTBOX_ENABLED_ENV]: 'true' })
    if (!res.ok) {
      logWarn(`writePatch failed: ${res.error.message}`)
      return { outcome: 'error', error: res.error.message }
    }
    logInfo('wrote missing MAILAGENT_OUTBOX_ENABLED=true into .env (fanout dispatcher default-on)')
    return { outcome: 'written' }
  } catch (err) {
    const message = (err as Error).message
    logWarn(message)
    return { outcome: 'error', error: message }
  }
}

function logInfo(msg: string): void {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[outbox-default] ${msg}`)
  }
}
function logWarn(msg: string): void {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[outbox-default] ${msg}`)
  }
}
