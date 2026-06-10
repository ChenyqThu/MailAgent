// Sprint 18 §PR B — env:get / env:set handler contract.
//
// Three axes:
//   (a) env:get redacts every SECRET_ENV_KEYS value to '***' (length>0) or
//       '' (unset); plaintext NEVER appears in the IPC payload;
//   (b) env:set rejects non-MANAGED keys with E_INVALID_KEY;
//   (c) env:set returns restartRequired=true with the list of changedKeys
//       (and false / [] when the patch was a no-op).
//
// Uses a real tmp file (no fs mock) and `MAILAGENT_ENV_FILE` to override the
// resolver. `refreshEnvPath()` between tests so the cached path doesn't
// leak across cases.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { __test__ as envHandler } from '../../src/electron/main/handlers/env'
import { refreshEnvPath } from '../../src/electron/main/lib/env-path'
import { MANAGED_ENV_KEY_SET } from '../../src/electron/main/lib/env-keys'

let dir: string
let envPath: string

const SEED = `# fixture seed
NOTION_TOKEN=secret_seed_value
EMAIL_DATABASE_ID=db_seed
FEISHU_NOTIFY_ENABLED=true
# LLM_AGENT_ENABLED=false
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailagent-env-'))
  envPath = join(dir, '.env')
  writeFileSync(envPath, SEED, { encoding: 'utf8' })
  process.env.MAILAGENT_ENV_FILE = envPath
  refreshEnvPath()
})

afterEach(() => {
  delete process.env.MAILAGENT_ENV_FILE
  refreshEnvPath()
  rmSync(dir, { recursive: true, force: true })
})

describe('env:get', () => {
  test('redacts SECRET keys, exposes non-secret values', () => {
    const snap = envHandler.readSnapshot()
    expect(snap.exists).toBe(true)
    expect(snap.path).toBe(envPath)
    expect(snap.values.NOTION_TOKEN).toBe('***')
    expect(snap.values.EMAIL_DATABASE_ID).toBe('db_seed')
    expect(snap.values.FEISHU_NOTIFY_ENABLED).toBe('true')
    expect(snap.secretKeys).toContain('NOTION_TOKEN')
    expect(snap.managedKeys.length).toBeGreaterThan(30)
  })

  test('commented-out keys do NOT appear in values map', () => {
    const snap = envHandler.readSnapshot()
    expect(snap.values.LLM_AGENT_ENABLED).toBeUndefined()
  })

  test('exists=false when .env missing', () => {
    rmSync(envPath)
    const snap = envHandler.readSnapshot()
    expect(snap.exists).toBe(false)
    expect(snap.values).toEqual({})
  })

  test('plaintext SECRET value never appears in IPC payload', () => {
    const snap = envHandler.readSnapshot()
    const payload = JSON.stringify(snap)
    expect(payload).not.toContain('secret_seed_value')
  })
})

describe('env:set', () => {
  test('writes a non-secret update, sets restartRequired=true', () => {
    const result = envHandler.writePatch({ EMAIL_DATABASE_ID: 'db_new' })
    expect(result).toMatchObject({
      ok: true,
      changedKeys: ['EMAIL_DATABASE_ID'],
      restartRequired: true
    })
    const text = readFileSync(envPath, 'utf8')
    expect(text).toContain('EMAIL_DATABASE_ID=db_new')
    // Other keys untouched.
    expect(text).toContain('NOTION_TOKEN=secret_seed_value')
    expect(text).toContain('# fixture seed')
  })

  test('writes a secret update through (env file gets plaintext, IPC return masks downstream)', () => {
    const result = envHandler.writePatch({ NOTION_TOKEN: 'ntn_real_new' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.changedKeys).toEqual(['NOTION_TOKEN'])
      expect(result.restartRequired).toBe(true)
    }
    // The .env file holds the plaintext (Python needs it).
    expect(readFileSync(envPath, 'utf8')).toContain('NOTION_TOKEN=ntn_real_new')
  })

  test('rejects non-MANAGED key with E_INVALID_KEY', () => {
    const result = envHandler.writePatch({ BOGUS_KEY: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_INVALID_KEY')
      expect(result.error.message).toMatch(/BOGUS_KEY/)
    }
  })

  test('empty patch returns ok with empty changedKeys + restartRequired=false', () => {
    const result = envHandler.writePatch({})
    expect(result).toMatchObject({
      ok: true,
      changedKeys: [],
      restartRequired: false
    })
  })

  test('writing the SAME value is a no-op for changedKeys but file is rewritten', () => {
    const result = envHandler.writePatch({ EMAIL_DATABASE_ID: 'db_seed' })
    // Value identical to seed → diff says nothing changed.
    expect(result).toMatchObject({ ok: true, changedKeys: [], restartRequired: false })
  })

  test('null value comments the line out and records it as changed', () => {
    const result = envHandler.writePatch({ EMAIL_DATABASE_ID: null })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.changedKeys).toEqual(['EMAIL_DATABASE_ID'])
      expect(result.restartRequired).toBe(true)
    }
    const text = readFileSync(envPath, 'utf8')
    expect(text).toContain('# EMAIL_DATABASE_ID=db_seed')
    expect(text).not.toMatch(/^EMAIL_DATABASE_ID=/m)
  })

  test('uncommenting a previously-commented key flips it back active', () => {
    const result = envHandler.writePatch({ LLM_AGENT_ENABLED: 'true' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.changedKeys).toEqual(['LLM_AGENT_ENABLED'])
    expect(readFileSync(envPath, 'utf8')).toContain('LLM_AGENT_ENABLED=true')
  })

  // Regression: LLM_ENABLED_MODELS was missing from MANAGED_ENV_KEYS and caused
  // a runtime E_INVALID_KEY when AiTab's handleToggleModel called applyEnvPatch.
  // This test is intentionally minimal — just assert membership in the set.
  test('LLM_ENABLED_MODELS is in MANAGED_ENV_KEY_SET (AiTab multi-select regression)', () => {
    expect(MANAGED_ENV_KEY_SET.has('LLM_ENABLED_MODELS')).toBe(true)
  })
})
