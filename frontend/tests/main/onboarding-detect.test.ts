import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectUserState } from '../../src/electron/main/onboarding/detect'

describe('detectUserState', () => {
  let dir: string
  let envPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailagent-onboard-'))
    envPath = join(dir, '.env')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns "new" when .env is absent', () => {
    expect(detectUserState({ envPath })).toBe('new')
  })

  it('returns "config-incomplete" when required keys missing', () => {
    writeFileSync(envPath, 'USER_EMAIL=a@b.com\n# 缺 NOTION_TOKEN / EMAIL_DATABASE_ID\n')
    expect(detectUserState({ envPath })).toBe('config-incomplete')
  })

  it('returns "config-incomplete" when a required key is present but empty', () => {
    writeFileSync(envPath, 'NOTION_TOKEN=\nEMAIL_DATABASE_ID=db\nUSER_EMAIL=a@b.com\n')
    expect(detectUserState({ envPath })).toBe('config-incomplete')
  })

  it('returns "configured" when all required keys have non-empty values', () => {
    writeFileSync(
      envPath,
      ['NOTION_TOKEN=ntn_x', 'EMAIL_DATABASE_ID=db123', 'USER_EMAIL=a@b.com', '# 注释'].join('\n')
    )
    expect(detectUserState({ envPath })).toBe('configured')
  })

  it('ignores comments and blank lines, treats quoted-empty as empty', () => {
    writeFileSync(envPath, 'NOTION_TOKEN=""\nEMAIL_DATABASE_ID=db\nUSER_EMAIL=a@b.com\n')
    expect(detectUserState({ envPath })).toBe('config-incomplete')
  })
})
