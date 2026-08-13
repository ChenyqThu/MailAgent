// Mail.app reply-draft IPC handler — covers the script-spawn path that
// `createDraft` delegates to. We mock execa / better-sqlite3 lookup at the
// edges of the dispatcher in integration tests; here we just lock in the
// pure helpers:
//
//   - buildDraftCommand     → argv shape for create_reply_draft.sh
//   - parseScriptOutput     → tolerates trailing whitespace + interleaved logs
//   - classifyScriptError   → stderr / script-error keywords → E_* codes

import { afterEach, describe, expect, test, vi } from 'vitest'

import { __testing } from '../../src/electron/main/handlers/draft'

const {
  buildDraftCommand,
  parseScriptOutput,
  classifyScriptError,
  validateComposeOpts,
  usesServeApiDraftPath
} = __testing

describe('usesServeApiDraftPath (task 08-12: != applescript 都走 serve-api 通用 backend 路径)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('unset → applescript 默认 → Mail.app GUI 注入路径', () => {
    vi.stubEnv('MAILAGENT_BACKEND', '')
    expect(usesServeApiDraftPath()).toBe(false)
  })

  test('applescript → false', () => {
    vi.stubEnv('MAILAGENT_BACKEND', 'applescript')
    expect(usesServeApiDraftPath()).toBe(false)
  })

  test('davmail → true（原主路径不变）', () => {
    vi.stubEnv('MAILAGENT_BACKEND', 'davmail')
    expect(usesServeApiDraftPath()).toBe(true)
  })

  test('outlook_com → true（修 pre-08-12 误落 AppleScript 路径）', () => {
    vi.stubEnv('MAILAGENT_BACKEND', 'outlook_com')
    expect(usesServeApiDraftPath()).toBe(true)
  })

  test('大小写不敏感（镜像原 isDavmailBackend 的 toLowerCase 语义）', () => {
    vi.stubEnv('MAILAGENT_BACKEND', 'AppleScript')
    expect(usesServeApiDraftPath()).toBe(false)
  })
})

describe('buildDraftCommand', () => {
  test('without account → no --account flag', () => {
    const { cmd, args } = buildDraftCommand({
      scriptPath: '/repo/scripts/create_reply_draft.sh',
      internalId: 53675,
      mailbox: '收件箱',
      account: null,
      replyText: 'Hi Alice, …'
    })
    expect(cmd).toBe('bash')
    expect(args[0]).toBe('/repo/scripts/create_reply_draft.sh')
    expect(args).toContain('--mode')
    const modeIdx = args.indexOf('--mode')
    expect(args[modeIdx + 1]).toBe('reply-all')
    expect(args).toContain('--internal-id')
    expect(args[args.indexOf('--internal-id') + 1]).toBe('53675')
    expect(args).toContain('--mailbox')
    expect(args[args.indexOf('--mailbox') + 1]).toBe('收件箱')
    expect(args).toContain('--reply-text')
    expect(args[args.indexOf('--reply-text') + 1]).toBe('Hi Alice, …')
    expect(args).not.toContain('--account')
  })

  test('with account → appends --account flag', () => {
    const { args } = buildDraftCommand({
      scriptPath: '/repo/scripts/create_reply_draft.sh',
      internalId: 1,
      mailbox: 'INBOX',
      account: 'Exchange',
      replyText: 'ok'
    })
    expect(args).toContain('--account')
    expect(args[args.indexOf('--account') + 1]).toBe('Exchange')
  })
})

describe('parseScriptOutput', () => {
  test('plain JSON success object parses', () => {
    const out = parseScriptOutput('{"success":true,"method":"reply_all_internal_id"}')
    expect(out?.success).toBe(true)
    expect(out?.method).toBe('reply_all_internal_id')
  })

  test('tolerates trailing whitespace', () => {
    const out = parseScriptOutput('  {"success":true,"method":"reply_all"}\n\n')
    expect(out?.success).toBe(true)
  })

  test('picks the last JSON object when debug lines precede it', () => {
    const out = parseScriptOutput(
      ['Paste retry attempt 2/3', 'verify: ok', '{"success":true,"method":"reply_all"}'].join('\n')
    )
    expect(out?.success).toBe(true)
  })

  test('empty stdout → null', () => {
    expect(parseScriptOutput('')).toBeNull()
    expect(parseScriptOutput('   \n')).toBeNull()
  })

  test('non-JSON tail → null', () => {
    expect(parseScriptOutput('garbage output')).toBeNull()
  })
})

describe('classifyScriptError', () => {
  test('automation-denied → E_AUTOMATION_DENIED + actionable hint', () => {
    const c = classifyScriptError({
      stderr: 'osascript is not allowed assistive access',
      scriptError: null
    })
    expect(c.code).toBe('E_AUTOMATION_DENIED')
    expect(c.message).toMatch(/System Settings/)
  })

  test('Mail not running → E_MAIL_NOT_RUNNING', () => {
    const c = classifyScriptError({
      stderr: 'execution error: Mail got an error: Can’t get message',
      scriptError: null
    })
    expect(c.code).toBe('E_MAIL_NOT_RUNNING')
  })

  test('script error "not found in any account" → E_NOT_FOUND', () => {
    const c = classifyScriptError({
      stderr: '',
      scriptError: 'internal_id not found in any account'
    })
    expect(c.code).toBe('E_NOT_FOUND')
  })

  test('paste verification failure → E_NOT_FOUND with the script message', () => {
    const c = classifyScriptError({
      stderr: 'verify: clipboard not updated',
      scriptError: 'Paste verification failed after retries'
    })
    expect(c.code).toBe('E_NOT_FOUND')
    expect(c.message).toContain('Paste verification failed')
  })

  test('unknown stderr → E_APPLESCRIPT with detail snippet', () => {
    const c = classifyScriptError({
      stderr: 'segfault',
      scriptError: null
    })
    expect(c.code).toBe('E_APPLESCRIPT')
    expect(c.message).toContain('segfault')
  })

  test('script error trumps stderr in the detail message', () => {
    const c = classifyScriptError({
      stderr: 'noise',
      scriptError: 'New mode requires --to and --subject'
    })
    expect(c.code).toBe('E_APPLESCRIPT')
    expect(c.message).toContain('--to and --subject')
  })
})

// 写新邮件 (mode='new'): 无源邮件, 哨兵 internalId=-1。adapter 层 (validateComposeOpts)
// 须对 mode='new' 放宽非负校验, 否则 -1 在到达 serve-api 前就被拒 (codex review HIGH)。
describe('validateComposeOpts', () => {
  test("mode='new' allows sentinel internalId=-1", () => {
    const r = validateComposeOpts(
      { internalId: -1, mode: 'new', to: ['x@y.com'] } as never,
      'email:draft'
    )
    // 通过 → 返回 opts 本身 (无 ok 字段); 失败 → {ok:false,...}。
    expect('ok' in r).toBe(false)
    expect((r as { internalId: number }).internalId).toBe(-1)
  })

  test('non-new mode rejects negative internalId', () => {
    const r = validateComposeOpts({ internalId: -1, mode: 'reply' } as never, 'email:draft')
    expect((r as { ok: boolean }).ok).toBe(false)
    expect((r as { code: string }).code).toBe('E_INVALID_ARG')
  })

  test("mode='new' still rejects non-integer internalId", () => {
    const r = validateComposeOpts({ internalId: 1.5, mode: 'new' } as never, 'email:draft')
    expect((r as { ok: boolean }).ok).toBe(false)
  })

  // D1 Bug A — sourceDraftId (草稿行自己的 internal_id, draft-edit 保存/发送带上,
  // 服务端恢复线程 linkage)。IPC 层是三层校验之一: 可选、给了必须是非负 int。
  test('sourceDraftId: 合法 int 放行且原样透传', () => {
    const r = validateComposeOpts(
      { internalId: -1, mode: 'new', sourceDraftId: 99 } as never,
      'email:draft'
    )
    expect('ok' in r).toBe(false)
    expect((r as { sourceDraftId: number }).sourceDraftId).toBe(99)
  })

  test('sourceDraftId: 缺省 (undefined) 不拦', () => {
    const r = validateComposeOpts(
      { internalId: -1, mode: 'new', to: ['x@y.com'] } as never,
      'email:draft'
    )
    expect('ok' in r).toBe(false)
  })

  test('sourceDraftId: 非整数 / 负数 → E_INVALID_ARG', () => {
    for (const bad of [1.5, -1, 'abc', null]) {
      const r = validateComposeOpts(
        { internalId: -1, mode: 'new', sourceDraftId: bad } as never,
        'email:draft'
      )
      expect((r as { ok: boolean }).ok).toBe(false)
      expect((r as { code: string }).code).toBe('E_INVALID_ARG')
    }
  })
})
