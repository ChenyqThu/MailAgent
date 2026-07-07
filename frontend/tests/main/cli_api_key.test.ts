// lib/cli-api-key — MAILAGENT_CLI_API_KEY 自愈契约。
//
// 修复的产品缺陷: onboarding 不生成 CLI 写鉴权 key → userData .env 缺
// MAILAGENT_CLI_API_KEY → Python require_auth 对所有写命令 E_AUTH_FAILED。
// 覆盖:
//   (a) 缺失 → 自动生成 48-hex 写入 .env + 同步 process.env;
//   (b) 幂等 (重复调用不换 token);
//   (c) .env 不存在 → 不凭空建文件 (保护 detectUserState 'new' 判定);
//   (d) .env 有 key 但 process.env 没有 → 只同步 process.env;
//   (e) 生成后 keychain.getCliApiKey() env-first 能读到 (= cli_runner
//       needsAuth 路径拿得到 --api-key, CLI 写通过的前端侧前提)。
//
// 与 handlers_env.test.ts 同法: 真实 tmp 文件 + MAILAGENT_ENV_FILE 覆写 +
// refreshEnvPath() 防缓存串台。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// keychain 顶层 import keytar (native binding); mock 成"永远没存过"让
// getCliApiKey 的 env-first 分支可被单测验证。
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => undefined),
    deletePassword: vi.fn(async () => false)
  }
}))

import { CLI_API_KEY_ENV, ensureCliApiKey } from '../../src/electron/main/lib/cli-api-key'
import { refreshEnvPath } from '../../src/electron/main/lib/env-path'
import { getCliApiKey } from '../../src/electron/main/keychain'

let dir: string
let envPath: string

const SEED = `NOTION_TOKEN=secret_seed
EMAIL_DATABASE_ID=db_seed
USER_EMAIL=user@example.com
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailagent-cli-key-'))
  envPath = join(dir, '.env')
  writeFileSync(envPath, SEED, { encoding: 'utf8' })
  process.env.MAILAGENT_ENV_FILE = envPath
  delete process.env[CLI_API_KEY_ENV]
  refreshEnvPath()
})

afterEach(() => {
  delete process.env.MAILAGENT_ENV_FILE
  delete process.env[CLI_API_KEY_ENV]
  refreshEnvPath()
  rmSync(dir, { recursive: true, force: true })
})

describe('ensureCliApiKey', () => {
  test('key 缺失 → 生成 48-hex token 写入 .env 并同步 process.env', () => {
    const result = ensureCliApiKey()
    expect(result.outcome).toBe('generated')

    const fileText = readFileSync(envPath, 'utf8')
    const match = fileText.match(/^MAILAGENT_CLI_API_KEY=([0-9a-f]{48})$/m)
    expect(match).not.toBeNull()
    // writePatch 同步 process.env → keychain env-first 不重启即可读。
    expect(process.env[CLI_API_KEY_ENV]).toBe(match![1])
    // 原有键不被破坏。
    expect(fileText).toContain('NOTION_TOKEN=secret_seed')
  })

  test('幂等: 第二次调用不换 token', () => {
    ensureCliApiKey()
    const first = process.env[CLI_API_KEY_ENV]
    const result = ensureCliApiKey()
    expect(result.outcome).toBe('present')
    expect(process.env[CLI_API_KEY_ENV]).toBe(first)
    const fileText = readFileSync(envPath, 'utf8')
    expect(fileText).toContain(`MAILAGENT_CLI_API_KEY=${first}`)
  })

  test('process.env 已有值 → no-op 不碰 .env', () => {
    process.env[CLI_API_KEY_ENV] = 'preexisting-token'
    const before = readFileSync(envPath, 'utf8')
    const result = ensureCliApiKey()
    expect(result.outcome).toBe('present')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
    expect(process.env[CLI_API_KEY_ENV]).toBe('preexisting-token')
  })

  test('.env 不存在 → skipped, 不凭空建文件 (保护新用户 onboarding 判定)', () => {
    rmSync(envPath)
    refreshEnvPath()
    const result = ensureCliApiKey()
    expect(result.outcome).toBe('skipped-no-env')
    expect(existsSync(envPath)).toBe(false)
    expect(process.env[CLI_API_KEY_ENV]).toBeUndefined()
  })

  test('.env 有 key 但 process.env 没有 → 只同步 process.env 不重写文件', () => {
    writeFileSync(envPath, SEED + 'MAILAGENT_CLI_API_KEY=from-legacy-env\n', {
      encoding: 'utf8'
    })
    const before = readFileSync(envPath, 'utf8')
    const result = ensureCliApiKey()
    expect(result.outcome).toBe('present')
    expect(process.env[CLI_API_KEY_ENV]).toBe('from-legacy-env')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
  })

  test('生成后 keychain.getCliApiKey() env-first 读到同一 token (CLI 写鉴权前提)', async () => {
    const result = ensureCliApiKey()
    expect(result.outcome).toBe('generated')
    const fromKeychain = await getCliApiKey()
    expect(fromKeychain).toBe(process.env[CLI_API_KEY_ENV])
    expect(fromKeychain).toMatch(/^[0-9a-f]{48}$/)
  })
})
