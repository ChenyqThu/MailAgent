// Onboarding IPC 纯逻辑单测。只覆盖不带 IPC / Electron 副作用的 helper:
//   buildCompletePatch  — cfg → .env patch (必填校验 / backend 回落 / plugin→flag)
//   isLikelyDoubleWriter— WAL mtime 守卫窗口
//   parseActiveEnvKeys  — .env 非空 key 解析
//   buildClearPatch     — rollback 清键
//
// 不写真实 .env (env 写守卫 hook 会拦截), 全用纯函数 + 注入参数。

import { describe, expect, it } from 'vitest'

import {
  buildClearPatch,
  buildCompletePatch,
  isLikelyDoubleWriter,
  isPathInside,
  parseActiveEnvKeys,
  pathsCollide,
  PLUGIN_FLAG_MAP,
  type OnboardingCompleteCfg
} from '../../src/electron/main/handlers/onboarding'

describe('buildCompletePatch', () => {
  const full: OnboardingCompleteCfg = {
    NOTION_TOKEN: 'ntn_x',
    EMAIL_DATABASE_ID: 'db123',
    USER_EMAIL: 'a@b.com'
  }

  it('reports missing required keys when absent', () => {
    const { missing } = buildCompletePatch({ NOTION_TOKEN: 'x' })
    expect(missing.sort()).toEqual(['EMAIL_DATABASE_ID', 'USER_EMAIL'].sort())
  })

  it('treats whitespace-only required values as missing', () => {
    const { patch, missing } = buildCompletePatch({
      NOTION_TOKEN: '  ',
      EMAIL_DATABASE_ID: 'db',
      USER_EMAIL: 'a@b.com'
    })
    expect(missing).toEqual(['NOTION_TOKEN'])
    expect(patch['NOTION_TOKEN']).toBeUndefined()
  })

  it('trims core account fields', () => {
    const { patch, missing } = buildCompletePatch({
      NOTION_TOKEN: '  ntn_x  ',
      EMAIL_DATABASE_ID: ' db123 ',
      USER_EMAIL: 'a@b.com '
    })
    expect(missing).toEqual([])
    expect(patch['NOTION_TOKEN']).toBe('ntn_x')
    expect(patch['EMAIL_DATABASE_ID']).toBe('db123')
    expect(patch['USER_EMAIL']).toBe('a@b.com')
  })

  it('defaults MAILAGENT_BACKEND to applescript when unset or invalid', () => {
    expect(buildCompletePatch(full).patch['MAILAGENT_BACKEND']).toBe('applescript')
    expect(
      buildCompletePatch({ ...full, MAILAGENT_BACKEND: 'bogus' as 'davmail' }).patch[
        'MAILAGENT_BACKEND'
      ]
    ).toBe('applescript')
  })

  it('honors davmail backend selection', () => {
    expect(buildCompletePatch({ ...full, MAILAGENT_BACKEND: 'davmail' }).patch['MAILAGENT_BACKEND']).toBe(
      'davmail'
    )
  })

  it('passes through SYNC_MAILBOXES trimmed, omits when blank', () => {
    expect(buildCompletePatch({ ...full, SYNC_MAILBOXES: ' 收件箱,已发送 ' }).patch['SYNC_MAILBOXES']).toBe(
      '收件箱,已发送'
    )
    expect(buildCompletePatch({ ...full, SYNC_MAILBOXES: '   ' }).patch['SYNC_MAILBOXES']).toBeUndefined()
  })

  it('maps every plugin to its env flag, writing explicit true/false', () => {
    const { patch } = buildCompletePatch({
      ...full,
      plugins: { agent: true, island: false, llm: true, digest: false }
      // calendar omitted → defaults false
    })
    expect(patch[PLUGIN_FLAG_MAP.agent]).toBe('true')
    expect(patch[PLUGIN_FLAG_MAP.island]).toBe('false')
    expect(patch[PLUGIN_FLAG_MAP.llm]).toBe('true')
    expect(patch[PLUGIN_FLAG_MAP.digest]).toBe('false')
    expect(patch[PLUGIN_FLAG_MAP.calendar]).toBe('false')
  })

  it('writes optional account fields only when non-empty', () => {
    const { patch } = buildCompletePatch({
      ...full,
      CALENDAR_DATABASE_ID: 'cal123',
      MAIL_ACCOUNT_NAME: ''
    })
    expect(patch['CALENDAR_DATABASE_ID']).toBe('cal123')
    expect(patch['MAIL_ACCOUNT_NAME']).toBeUndefined()
  })

  it('PLUGIN_FLAG_MAP points at the agreed config.py keys', () => {
    expect(PLUGIN_FLAG_MAP).toEqual({
      agent: 'MAILAGENT_AGENT_HARNESS',
      island: 'PING_ISLAND_ENABLED',
      llm: 'LLM_AGENT_ENABLED',
      digest: 'MAILAGENT_DAILY_DIGEST_ENABLED',
      calendar: 'CALENDAR_CALDAV_SYNC_ENABLED'
    })
  })
})

describe('isLikelyDoubleWriter', () => {
  const now = 1_000_000_000_000

  it('returns false when WAL is absent (mtime null)', () => {
    expect(isLikelyDoubleWriter(null, now)).toBe(false)
  })

  it('returns true when WAL mtime is within the 120s window', () => {
    expect(isLikelyDoubleWriter(now - 1_000, now)).toBe(true)
    expect(isLikelyDoubleWriter(now - 119_999, now)).toBe(true)
  })

  it('returns false when WAL mtime is older than the window', () => {
    expect(isLikelyDoubleWriter(now - 120_000, now)).toBe(false)
    expect(isLikelyDoubleWriter(now - 500_000, now)).toBe(false)
  })

  it('honors a custom window', () => {
    expect(isLikelyDoubleWriter(now - 5_000, now, 10_000)).toBe(true)
    expect(isLikelyDoubleWriter(now - 5_000, now, 1_000)).toBe(false)
  })
})

describe('parseActiveEnvKeys', () => {
  it('collects keys with non-empty values, skips comments/blank/quoted-empty', () => {
    const text = [
      'NOTION_TOKEN=ntn_x',
      '# comment',
      '',
      'EMPTY=',
      'QUOTED_EMPTY=""',
      "SINGLE_EMPTY=''",
      'USER_EMAIL=a@b.com'
    ].join('\n')
    const keys = parseActiveEnvKeys(text)
    expect(keys.has('NOTION_TOKEN')).toBe(true)
    expect(keys.has('USER_EMAIL')).toBe(true)
    expect(keys.has('EMPTY')).toBe(false)
    expect(keys.has('QUOTED_EMPTY')).toBe(false)
    expect(keys.has('SINGLE_EMPTY')).toBe(false)
  })
})

describe('buildClearPatch', () => {
  it('nulls the three required keys so detect returns "new"', () => {
    const patch = buildClearPatch()
    expect(patch['NOTION_TOKEN']).toBeNull()
    expect(patch['EMAIL_DATABASE_ID']).toBeNull()
    expect(patch['USER_EMAIL']).toBeNull()
  })

  it('also nulls backend / sync / every plugin flag (symmetric to buildCompletePatch writes)', () => {
    const patch = buildClearPatch()
    expect(patch['MAILAGENT_BACKEND']).toBeNull()
    expect(patch['SYNC_MAILBOXES']).toBeNull()
    for (const flag of Object.values(PLUGIN_FLAG_MAP)) {
      expect(patch[flag]).toBeNull()
    }
  })

  it('every key buildCompletePatch can write is cleared by buildClearPatch', () => {
    // 写入集 ⊆ 清除集 —— rollback 不留 backend/插件半截配置。
    const { patch: written } = buildCompletePatch({
      NOTION_TOKEN: 'ntn_x',
      EMAIL_DATABASE_ID: 'db',
      USER_EMAIL: 'a@b.com',
      CALENDAR_DATABASE_ID: 'cal',
      MAIL_ACCOUNT_NAME: 'Exchange',
      MAILAGENT_BACKEND: 'davmail',
      SYNC_MAILBOXES: '收件箱',
      plugins: { agent: true, island: true, llm: true, digest: true, calendar: true }
    })
    const cleared = buildClearPatch()
    for (const k of Object.keys(written)) {
      expect(cleared[k]).toBeNull()
    }
  })
})

// ── LEGACY 安全守卫: 同路径 / 子树包含判定 (防 rmSync/cpSync 落到老原件) ──
describe('isPathInside', () => {
  it('treats an exact path as inside itself', () => {
    expect(isPathInside('/Users/x/Documents/MailAgent/data', '/Users/x/Documents/MailAgent/data')).toBe(
      true
    )
  })
  it('detects a child path inside a parent', () => {
    expect(isPathInside('/a/b/c', '/a/b')).toBe(true)
    expect(isPathInside('/a/b', '/a')).toBe(true)
  })
  it('does NOT treat a sibling sharing a name prefix as inside', () => {
    // '/a-b' must not count as inside '/a' (separator-aware).
    expect(isPathInside('/ab', '/a')).toBe(false)
    expect(isPathInside('/a-b', '/a')).toBe(false)
  })
  it('does NOT treat a parent as inside its child', () => {
    expect(isPathInside('/a', '/a/b')).toBe(false)
  })
  it('normalizes . and .. segments', () => {
    expect(isPathInside('/a/b/../b/c', '/a/b')).toBe(true)
  })
})

describe('pathsCollide', () => {
  it('is false for the real packaged case (userData vs ~/Documents/MailAgent)', () => {
    const copyDest = '/Users/x/Library/Application Support/MailAgent/data'
    const oldData = '/Users/x/Documents/MailAgent/data'
    expect(pathsCollide(copyDest, oldData)).toBe(false)
  })
  it('is true when dest collapses onto the original (dev / MAILAGENT_DATA_ROOT=old)', () => {
    const same = '/Users/x/Documents/MailAgent/data'
    expect(pathsCollide(same, same)).toBe(true)
  })
  it('is true when one path contains the other (either direction)', () => {
    expect(pathsCollide('/a/data', '/a')).toBe(true)
    expect(pathsCollide('/a', '/a/data')).toBe(true)
  })
  it('is false for unrelated paths', () => {
    expect(pathsCollide('/a/data', '/b/data')).toBe(false)
  })
})
