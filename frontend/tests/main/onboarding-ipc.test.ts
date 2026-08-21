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
  buildCoreConfigPatch,
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

  it('reports missing required keys when absent (07-12 P3b: only USER_EMAIL required)', () => {
    const { missing } = buildCompletePatch({ NOTION_TOKEN: 'x' })
    expect(missing).toEqual(['USER_EMAIL'])
  })

  it('treats whitespace-only required values as missing', () => {
    const { missing } = buildCompletePatch({
      NOTION_TOKEN: 'ntn_x',
      EMAIL_DATABASE_ID: 'db',
      USER_EMAIL: '  '
    })
    expect(missing).toEqual(['USER_EMAIL'])
  })

  // 07-12 P3b Notion 可选化 pin: Notion 两键留空 → missing 为空 (可提交) 且 patch
  // 里不出现空值行 (与 detect.ts「仅 USER_EMAIL」判据成对, 防循环弹向导)。
  it('allows submitting without Notion keys and never writes empty-valued lines', () => {
    const { patch, missing } = buildCompletePatch({ USER_EMAIL: 'a@b.com', NOTION_TOKEN: '  ' })
    expect(missing).toEqual([])
    expect(patch['NOTION_TOKEN']).toBeUndefined()
    expect(patch['EMAIL_DATABASE_ID']).toBeUndefined()
    expect(patch['USER_EMAIL']).toBe('a@b.com')
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
    expect(
      buildCompletePatch({ ...full, MAILAGENT_BACKEND: 'davmail' }).patch['MAILAGENT_BACKEND']
    ).toBe('davmail')
  })

  it('passes through SYNC_MAILBOXES trimmed, omits when blank', () => {
    expect(
      buildCompletePatch({ ...full, SYNC_MAILBOXES: ' 收件箱,已发送 ' }).patch['SYNC_MAILBOXES']
    ).toBe('收件箱,已发送')
    expect(
      buildCompletePatch({ ...full, SYNC_MAILBOXES: '   ' }).patch['SYNC_MAILBOXES']
    ).toBeUndefined()
  })

  it('maps every plugin to its env flag, writing explicit true/false', () => {
    const { patch } = buildCompletePatch({
      ...full,
      plugins: { island: false, llm: true, digest: false }
      // calendar omitted → defaults false
    })
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

  // task 08-20 Notion OAuth — 「未改动则保留」：向导里 Notion 授权成功后, token 由
  // main 直接写进 .env, renderer 手里只有空值 (没展示过) 或掩码 (`***`, 若某处回填了
  // env:get 的脱敏值)。两者都**不能**进 patch —— 写进去就是拿空/星号覆盖真 token。
  it('never overwrites a secret with the redaction mask (OAuth-written token survives)', () => {
    const { patch } = buildCompletePatch({
      USER_EMAIL: 'a@b.com',
      NOTION_TOKEN: '***',
      EMAIL_DATABASE_ID: ''
    })
    expect(patch['NOTION_TOKEN']).toBeUndefined()
    expect(patch['EMAIL_DATABASE_ID']).toBeUndefined()
    expect(patch['USER_EMAIL']).toBe('a@b.com')
  })

  it('same for the davmail cipher secret (masked value is not a new value)', () => {
    const { patch } = buildCompletePatch({
      USER_EMAIL: 'a@b.com',
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_MODE: 'false',
      DAVMAIL_POC_CIPHER_KEY: '******'
    })
    expect(patch['DAVMAIL_POC_CIPHER_KEY']).toBeUndefined()
  })

  // 端到端形态回归 (prd 验收 5): 向导里 OAuth 写完 → 用户继续走完向导点「开始同步」,
  // commitConfig 用的正是 buildCoreConfigPatch。此时表单里 Notion 三键都是空串
  // (buildCompleteConfig 恒填 '' 而非 undefined), patch 里一个 Notion 键都不许有。
  it('commitConfig patch after an OAuth-written .env touches no Notion key', () => {
    const { patch, missing } = buildCoreConfigPatch({
      NOTION_TOKEN: '',
      EMAIL_DATABASE_ID: '',
      USER_EMAIL: 'a@b.com',
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_MODE: 'true'
    })
    expect(missing).toEqual([])
    expect(
      Object.keys(patch).filter((k) => k.includes('NOTION') || k.includes('DATABASE'))
    ).toEqual([])
    expect(patch['USER_EMAIL']).toBe('a@b.com')
  })

  it('PLUGIN_FLAG_MAP points at the agreed config.py keys', () => {
    expect(PLUGIN_FLAG_MAP).toEqual({
      island: 'PING_ISLAND_ENABLED',
      llm: 'LLM_AGENT_ENABLED',
      digest: 'MAILAGENT_DAILY_DIGEST_ENABLED',
      calendar: 'CALENDAR_CALDAV_SYNC_ENABLED'
    })
  })
})

describe('buildCompletePatch — davmail branch', () => {
  const core: OnboardingCompleteCfg = {
    NOTION_TOKEN: 'ntn_x',
    EMAIL_DATABASE_ID: 'db123',
    USER_EMAIL: 'a@b.com'
  }

  it('writes davmail connection fields only in davmail mode (poc mode on)', () => {
    const { patch, missing } = buildCompletePatch({
      ...core,
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_HOST: '127.0.0.1',
      DAVMAIL_IMAP_PORT: '1143',
      DAVMAIL_SMTP_PORT: '1025',
      DAVMAIL_POC_MODE: 'true'
    })
    expect(missing).toEqual([])
    expect(patch['MAILAGENT_BACKEND']).toBe('davmail')
    expect(patch['DAVMAIL_HOST']).toBe('127.0.0.1')
    expect(patch['DAVMAIL_IMAP_PORT']).toBe('1143')
    expect(patch['DAVMAIL_SMTP_PORT']).toBe('1025')
    expect(patch['DAVMAIL_POC_MODE']).toBe('true')
    // cipher omitted in poc mode → not written.
    expect(patch['DAVMAIL_POC_CIPHER_KEY']).toBeUndefined()
  })

  it('does NOT write davmail fields in applescript mode', () => {
    const { patch } = buildCompletePatch({
      ...core,
      MAILAGENT_BACKEND: 'applescript',
      // even if a stray davmail field rides along, applescript must drop it.
      DAVMAIL_HOST: '127.0.0.1',
      DAVMAIL_POC_MODE: 'true'
    })
    expect(patch['DAVMAIL_HOST']).toBeUndefined()
    expect(patch['DAVMAIL_POC_MODE']).toBeUndefined()
    expect(patch['DAVMAIL_IMAP_PORT']).toBeUndefined()
  })

  it('always writes DAVMAIL_POC_MODE as explicit true/false in davmail mode', () => {
    const off = buildCompletePatch({
      ...core,
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_MODE: 'false',
      DAVMAIL_POC_CIPHER_KEY: 'cipher-xyz'
    })
    expect(off.patch['DAVMAIL_POC_MODE']).toBe('false')
    expect(off.patch['DAVMAIL_POC_CIPHER_KEY']).toBe('cipher-xyz')
    // unset POC_MODE → defaults to 'false' (not undefined).
    const unset = buildCompletePatch({
      ...core,
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_CIPHER_KEY: 'cipher-xyz'
    })
    expect(unset.patch['DAVMAIL_POC_MODE']).toBe('false')
  })

  it('requires an auth method (poc mode OR non-empty cipher) in davmail mode', () => {
    // no poc mode + no cipher → DAVMAIL_AUTH missing.
    const noAuth = buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'davmail' })
    expect(noAuth.missing).toContain('DAVMAIL_AUTH')
    // poc mode satisfies auth.
    const pocAuth = buildCompletePatch({
      ...core,
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_MODE: 'true'
    })
    expect(pocAuth.missing).not.toContain('DAVMAIL_AUTH')
    // non-empty cipher satisfies auth (even with poc mode off).
    const cipherAuth = buildCompletePatch({
      ...core,
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_MODE: 'false',
      DAVMAIL_POC_CIPHER_KEY: 'cipher-xyz'
    })
    expect(cipherAuth.missing).not.toContain('DAVMAIL_AUTH')
  })

  it('davmail mode with USER_EMAIL only is complete (Notion optional, no MAIL_ACCOUNT_NAME)', () => {
    const { missing } = buildCompletePatch({
      USER_EMAIL: 'a@b.com',
      MAILAGENT_BACKEND: 'davmail',
      DAVMAIL_POC_MODE: 'true'
    })
    expect(missing).toEqual([])
    // 缺 USER_EMAIL 才 missing。
    const noEmail = buildCompletePatch({ MAILAGENT_BACKEND: 'davmail', DAVMAIL_POC_MODE: 'true' })
    expect(noEmail.missing).toEqual(['USER_EMAIL'])
    expect(noEmail.missing).not.toContain('MAIL_ACCOUNT_NAME')
  })
})

// task 08-12: backend 平台收敛（值域/平台合法性单源 @shared/lib/mailBackend）。
// 病根回归锁: 老二值钳制曾把 win 上选的 outlook_com 静默改写成 applescript。
describe('buildCompletePatch — platform-aware backend coercion (task 08-12)', () => {
  const core: OnboardingCompleteCfg = { USER_EMAIL: 'a@b.com' }

  it('win32: outlook_com 原样保留（不被改写成 applescript —— 修 pre-08-12 钳制病根）', () => {
    const { patch } = buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'outlook_com' }, 'win32')
    expect(patch['MAILAGENT_BACKEND']).toBe('outlook_com')
  })

  it('win32: unset / 脏值 → 平台首选 outlook_com', () => {
    expect(buildCompletePatch(core, 'win32').patch['MAILAGENT_BACKEND']).toBe('outlook_com')
    expect(
      buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'bogus' as 'davmail' }, 'win32').patch[
        'MAILAGENT_BACKEND'
      ]
    ).toBe('outlook_com')
  })

  it('win32: 平台外值 applescript（Mail.app 不存在）收敛为 outlook_com', () => {
    const { patch } = buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'applescript' }, 'win32')
    expect(patch['MAILAGENT_BACKEND']).toBe('outlook_com')
  })

  it('win32: davmail 平台内合法, 保留且 davmail 分支照常生效', () => {
    const { patch, missing } = buildCompletePatch(
      { ...core, MAILAGENT_BACKEND: 'davmail', DAVMAIL_POC_MODE: 'true' },
      'win32'
    )
    expect(patch['MAILAGENT_BACKEND']).toBe('davmail')
    expect(patch['DAVMAIL_POC_MODE']).toBe('true')
    expect(missing).toEqual([])
  })

  it('darwin: 平台外值 outlook_com（COM 是 Windows 专属）收敛为 applescript', () => {
    const { patch } = buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'outlook_com' }, 'darwin')
    expect(patch['MAILAGENT_BACKEND']).toBe('applescript')
  })

  it('darwin/other: davmail 保留; other 平台按 mac 侧规则处理（保守不误砍）', () => {
    expect(
      buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'davmail' }, 'darwin').patch[
        'MAILAGENT_BACKEND'
      ]
    ).toBe('davmail')
    expect(
      buildCompletePatch({ ...core, MAILAGENT_BACKEND: 'outlook_com' }, 'other').patch[
        'MAILAGENT_BACKEND'
      ]
    ).toBe('applescript')
  })

  it('平台外值收敛后不带出该 backend 的连接配置（win 提交 applescript+davmail 字段 → outlook_com, 不写 DAVMAIL_*）', () => {
    const { patch } = buildCompletePatch(
      { ...core, MAILAGENT_BACKEND: 'applescript', DAVMAIL_HOST: '127.0.0.1' },
      'win32'
    )
    expect(patch['MAILAGENT_BACKEND']).toBe('outlook_com')
    expect(patch['DAVMAIL_HOST']).toBeUndefined()
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
  it('nulls the core account keys so detect returns "new"', () => {
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
      DAVMAIL_HOST: '127.0.0.1',
      DAVMAIL_IMAP_PORT: '1143',
      DAVMAIL_SMTP_PORT: '1025',
      DAVMAIL_POC_MODE: 'false',
      DAVMAIL_POC_CIPHER_KEY: 'cipher-xyz',
      plugins: { island: true, llm: true, digest: true, calendar: true }
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
    expect(
      isPathInside('/Users/x/Documents/MailAgent/data', '/Users/x/Documents/MailAgent/data')
    ).toBe(true)
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
