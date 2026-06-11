// lib/outbox-default — MAILAGENT_OUTBOX_ENABLED 默认值自愈契约。
//
// 修复的产品缺陷: onboarding 不写 MAILAGENT_OUTBOX_ENABLED → 后端代码默认
// false → FanoutWorker 永不跑 → 旗标/已读/完成只改本地 SQLite, 永不派发到
// Exchange/Notion (实测装机 10 天积压 1564 条 pending flag_sync)。
// 覆盖:
//   (a) 缺失 → 写 'true' 到 .env + 同步 process.env;
//   (b) 幂等 (重复调用 'present');
//   (c) 显式 false (process.env 或 .env) → 绝不覆盖 (灰度回退选择被尊重);
//   (d) .env 不存在 → 不凭空建文件 (保护 detectUserState 'new' 判定)。
//
// 与 cli_api_key.test.ts 同法: 真实 tmp 文件 + MAILAGENT_ENV_FILE 覆写 +
// refreshEnvPath() 防缓存串台。

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { OUTBOX_ENABLED_ENV, ensureOutboxEnabled } from '../../src/electron/main/lib/outbox-default'
import { refreshEnvPath } from '../../src/electron/main/lib/env-path'

let dir: string
let envPath: string

const SEED = `NOTION_TOKEN=secret_seed
EMAIL_DATABASE_ID=db_seed
USER_EMAIL=user@example.com
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailagent-outbox-default-'))
  envPath = join(dir, '.env')
  writeFileSync(envPath, SEED, { encoding: 'utf8' })
  process.env.MAILAGENT_ENV_FILE = envPath
  delete process.env[OUTBOX_ENABLED_ENV]
  refreshEnvPath()
})

afterEach(() => {
  delete process.env.MAILAGENT_ENV_FILE
  delete process.env[OUTBOX_ENABLED_ENV]
  refreshEnvPath()
  rmSync(dir, { recursive: true, force: true })
})

describe('ensureOutboxEnabled', () => {
  test('key 缺失 → 写 MAILAGENT_OUTBOX_ENABLED=true 到 .env 并同步 process.env', () => {
    const result = ensureOutboxEnabled()
    expect(result.outcome).toBe('written')

    const fileText = readFileSync(envPath, 'utf8')
    expect(fileText).toMatch(/^MAILAGENT_OUTBOX_ENABLED=true$/m)
    // writePatch 同步 process.env → 后端 spawn 不重启即继承。
    expect(process.env[OUTBOX_ENABLED_ENV]).toBe('true')
    // 原有键不被破坏。
    expect(fileText).toContain('NOTION_TOKEN=secret_seed')
  })

  test('幂等: 第二次调用 present, 不重写文件', () => {
    ensureOutboxEnabled()
    const before = readFileSync(envPath, 'utf8')
    const result = ensureOutboxEnabled()
    expect(result.outcome).toBe('present')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
  })

  test('process.env 显式 false → no-op 不碰 .env (灰度回退被尊重)', () => {
    process.env[OUTBOX_ENABLED_ENV] = 'false'
    const before = readFileSync(envPath, 'utf8')
    const result = ensureOutboxEnabled()
    expect(result.outcome).toBe('present')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
    expect(process.env[OUTBOX_ENABLED_ENV]).toBe('false')
  })

  test('.env 显式 false 但 process.env 没有 → 只同步 process.env, 值保持 false', () => {
    writeFileSync(envPath, SEED + 'MAILAGENT_OUTBOX_ENABLED=false\n', {
      encoding: 'utf8'
    })
    const before = readFileSync(envPath, 'utf8')
    const result = ensureOutboxEnabled()
    expect(result.outcome).toBe('present')
    expect(process.env[OUTBOX_ENABLED_ENV]).toBe('false')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
  })

  test('.env 不存在 → skipped, 不凭空建文件 (保护新用户 onboarding 判定)', () => {
    rmSync(envPath)
    refreshEnvPath()
    const result = ensureOutboxEnabled()
    expect(result.outcome).toBe('skipped-no-env')
    expect(existsSync(envPath)).toBe(false)
    expect(process.env[OUTBOX_ENABLED_ENV]).toBeUndefined()
  })
})
