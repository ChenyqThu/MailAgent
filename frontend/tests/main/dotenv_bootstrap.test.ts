// Sprint 19 — dotenv-bootstrap: load 项目根 .env into process.env BEFORE
// any module reads it. Tests cover:
//   - missing file → exists:false, no throw, no env mutation
//   - present file → active kv 写进 process.env
//   - already-set process.env keys NOT overwritten (POSIX export > .env, 跟
//     dotenv 业界默认 override:false align)
//   - commented-out kv 不 load
//   - returns counts {loaded, skipped, totalInFile} accurate
//   - bootstrapDotenv (wrapper) 不抛 on malformed/missing file
//
// 复用 handlers_env.test.ts 同款 MAILAGENT_ENV_FILE 覆写 + refreshEnvPath()
// pattern, 真 tmp file 不 mock fs.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  bootstrapDotenv,
  loadDotenvIntoProcessEnv
} from '../../src/electron/main/lib/dotenv-bootstrap'
import { refreshEnvPath } from '../../src/electron/main/lib/env-path'

let dir: string
let envPath: string

// 故意用真 MANAGED_ENV_KEYS 里的 key (NOTION_TOKEN / FEISHU_NOTIFY_ENABLED)
// + 一个 commented 的 LLM_AGENT_ENABLED. 真 key 才能 toRecord 出来 (env-parser
// 不 whitelist, 但 toRecord 只返 active kv index 里的 key, 跟 whitelist 无关
// — 实际 toRecord 是不过滤的, MANAGED_ENV_KEY_SET 过滤在 env-handler 内部).
const SEED = `# fixture seed for dotenv-bootstrap
NOTION_TOKEN=secret_for_test
EMAIL_DATABASE_ID=db_test
FEISHU_NOTIFY_ENABLED=true
# LLM_AGENT_ENABLED=false
MAILAGENT_KOS_INGEST_ENABLED=true
MAILAGENT_KOS_CONSUMER_ENABLED=true
`

// 保存 test 启动前可能已设的 process.env 值, afterEach 还原.
const PRESERVE_KEYS = [
  'NOTION_TOKEN',
  'EMAIL_DATABASE_ID',
  'FEISHU_NOTIFY_ENABLED',
  'LLM_AGENT_ENABLED',
  'MAILAGENT_KOS_INGEST_ENABLED',
  'MAILAGENT_KOS_CONSUMER_ENABLED'
]
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  // Snapshot keys we might mutate; wipe so each test starts from a clean slate.
  for (const k of PRESERVE_KEYS) {
    originalEnv[k] = process.env[k]
    delete process.env[k]
  }
  dir = mkdtempSync(join(tmpdir(), 'mailagent-dotenv-'))
  envPath = join(dir, '.env')
  writeFileSync(envPath, SEED, { encoding: 'utf8' })
  process.env.MAILAGENT_ENV_FILE = envPath
  refreshEnvPath()
})

afterEach(() => {
  delete process.env.MAILAGENT_ENV_FILE
  // Restore snapshotted env values.
  for (const k of PRESERVE_KEYS) {
    if (originalEnv[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = originalEnv[k]
    }
  }
  refreshEnvPath()
  rmSync(dir, { recursive: true, force: true })
})

describe('loadDotenvIntoProcessEnv', () => {
  test('loads active kv into process.env when file exists', () => {
    const r = loadDotenvIntoProcessEnv()
    expect(r.exists).toBe(true)
    expect(r.path).toBe(envPath)
    expect(r.totalInFile).toBe(5) // 5 active kv (commented 不算)
    expect(r.loaded).toBe(5)
    expect(r.skipped).toBe(0)
    expect(process.env.NOTION_TOKEN).toBe('secret_for_test')
    expect(process.env.EMAIL_DATABASE_ID).toBe('db_test')
    expect(process.env.FEISHU_NOTIFY_ENABLED).toBe('true')
    expect(process.env.MAILAGENT_KOS_INGEST_ENABLED).toBe('true')
    expect(process.env.MAILAGENT_KOS_CONSUMER_ENABLED).toBe('true')
  })

  test('commented-out kv NOT loaded', () => {
    loadDotenvIntoProcessEnv()
    expect(process.env.LLM_AGENT_ENABLED).toBeUndefined()
  })

  test('does NOT overwrite already-set process.env key (export wins)', () => {
    process.env.NOTION_TOKEN = 'exported_wins'
    process.env.MAILAGENT_KOS_INGEST_ENABLED = 'false'
    const r = loadDotenvIntoProcessEnv()
    expect(process.env.NOTION_TOKEN).toBe('exported_wins')
    expect(process.env.MAILAGENT_KOS_INGEST_ENABLED).toBe('false')
    expect(r.skipped).toBe(2)
    expect(r.loaded).toBe(3)
    expect(r.totalInFile).toBe(5)
  })

  test('missing file → exists:false, no mutation, no throw', () => {
    rmSync(envPath)
    const r = loadDotenvIntoProcessEnv()
    expect(r.exists).toBe(false)
    expect(r.path).toBe(envPath) // path resolved, just file gone
    expect(r.loaded).toBe(0)
    expect(r.skipped).toBe(0)
    expect(r.totalInFile).toBe(0)
    expect(process.env.NOTION_TOKEN).toBeUndefined()
  })

  test('returns sum loaded+skipped == totalInFile', () => {
    process.env.EMAIL_DATABASE_ID = 'already_set'
    const r = loadDotenvIntoProcessEnv()
    expect(r.loaded + r.skipped).toBe(r.totalInFile)
  })
})

describe('bootstrapDotenv', () => {
  test('returns same shape as loadDotenvIntoProcessEnv on success', () => {
    const r = bootstrapDotenv()
    expect(r.exists).toBe(true)
    expect(r.loaded).toBe(5)
    expect(process.env.MAILAGENT_KOS_CONSUMER_ENABLED).toBe('true')
  })

  test('does not throw on missing file', () => {
    rmSync(envPath)
    expect(() => bootstrapDotenv()).not.toThrow()
    const r = bootstrapDotenv()
    expect(r.exists).toBe(false)
  })

  test('survives malformed .env without crash (parser may throw)', () => {
    // env-parser is line-tolerant — write a line it definitely doesn't like:
    // a key with lowercase chars (env-parser only matches /[A-Z_][A-Z0-9_]*/).
    // It will be treated as a comment/skip line, NOT crash. So this test
    // mainly proves the try/catch wrapper survives whatever parser does.
    writeFileSync(envPath, 'lowercase_key=should_be_ignored\nVALID_KEY=ok\n')
    expect(() => bootstrapDotenv()).not.toThrow()
    const r = bootstrapDotenv()
    expect(r.exists).toBe(true)
  })
})
