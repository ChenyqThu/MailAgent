// Sprint 6 §2.2 — admin IPC handler contract.
//
// Mocks `callCli` to exercise:
//   - argv shape for health / stats / dead-letter list / retry / cleanup
//   - read commands carry no auth + cap at 15s timeout
//   - dead-letter retry flips to write+auth
//   - envelope shape on success / CliError / unknown rejection
//   - deadLetterList normalizes both `[...]` and `{items: [...]}` CLI shapes

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'

const { mockCallCli } = vi.hoisted(() => ({ mockCallCli: vi.fn() }))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual = await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
    '../../src/electron/main/cli_runner'
  )
  return { ...actual, callCli: mockCallCli }
})

// runDavmailHealth/runSystemAlerts 直读 better-sqlite3 (不走 callCli) — 换成
// in-memory fixture db (contact_suggest.test.ts 同款套路)。
let fixtureDb: Database.Database | null = null

vi.mock('../../src/electron/main/db', () => ({
  getDb: () => fixtureDb as Database.Database,
  closeDb: () => {},
  resolveDbPath: () => ':memory:'
}))

import { CliError } from '../../src/electron/main/cli_runner'
import {
  __testing,
  runAdminHealth,
  runAdminStats,
  runCleanupDeadLetter,
  runDavmailHealth,
  runDeadLetterList,
  runDeadLetterRetry,
  runSystemAlerts
} from '../../src/electron/main/handlers/admin'

beforeEach(() => {
  mockCallCli.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('admin handlers — read', () => {
  test('runAdminHealth forwards no flags + 15s timeout', async () => {
    mockCallCli.mockResolvedValue({ healthy: true } as unknown)
    await runAdminHealth()
    expect(mockCallCli).toHaveBeenCalledWith(['admin', 'health'], { timeoutMs: 15_000 })
  })

  test('runAdminStats forwards no flags + 15s timeout', async () => {
    mockCallCli.mockResolvedValue({})
    await runAdminStats()
    expect(mockCallCli).toHaveBeenCalledWith(['admin', 'stats'], { timeoutMs: 15_000 })
  })

  test('runDeadLetterList composes --limit + --mailbox', async () => {
    mockCallCli.mockResolvedValue([])
    await runDeadLetterList({ limit: 25, mailbox: '收件箱' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['admin', 'dead-letter', 'list', '--limit', '25', '--mailbox', '收件箱'],
      { timeoutMs: 15_000 }
    )
  })

  test('runDeadLetterList normalizes {items} wrapper shape', async () => {
    mockCallCli.mockResolvedValue({ items: [{ internal_id: 1, subject: 'x' }] })
    const out = await runDeadLetterList({ limit: 5 })
    expect(out).toEqual([{ internal_id: 1, subject: 'x' }])
  })

  test('runDeadLetterList returns [] when CLI returns malformed object', async () => {
    mockCallCli.mockResolvedValue({ not_items: 1 })
    const out = await runDeadLetterList()
    expect(out).toEqual([])
  })
})

describe('admin handlers — write', () => {
  test('runDeadLetterRetry runs write+auth path with 60s timeout', async () => {
    mockCallCli.mockResolvedValue({ ok: true })
    await runDeadLetterRetry(53675)
    expect(mockCallCli).toHaveBeenCalledWith(['admin', 'dead-letter', 'retry', '53675'], {
      write: true,
      needsAuth: true,
      timeoutMs: 60_000
    })
  })

  test('runDeadLetterDelete runs write+auth path with --yes + 60s timeout', async () => {
    mockCallCli.mockResolvedValue({ deleted: true })
    await __testing.runDeadLetterDelete(53675)
    expect(mockCallCli).toHaveBeenCalledWith(['admin', 'dead-letter', 'delete', '53675', '--yes'], {
      write: true,
      needsAuth: true,
      timeoutMs: 60_000
    })
  })

  test('runCleanupDeadLetter dry-run skips auth + skips --no-dry-run', async () => {
    mockCallCli.mockResolvedValue({})
    await runCleanupDeadLetter({ dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(['admin', 'cleanup-deadletter'], {
      write: false,
      needsAuth: false,
      timeoutMs: 60_000
    })
  })

  test('runCleanupDeadLetter real run adds --no-dry-run --yes + write+auth', async () => {
    mockCallCli.mockResolvedValue({})
    await runCleanupDeadLetter({ olderThan: 14, dryRun: false })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['admin', 'cleanup-deadletter', '--older-than', '14', '--no-dry-run', '--yes'],
      { write: true, needsAuth: true, timeoutMs: 60_000 }
    )
  })
})

describe('admin handlers — envelope + validation', () => {
  test('envelopeFromCli rolls success into { ok:true, data }', async () => {
    const env = await __testing.envelopeFromCli(Promise.resolve({ a: 1 }))
    expect(env).toEqual({ ok: true, data: { a: 1 } })
  })

  test('envelopeFromCli preserves CliError code + hint', async () => {
    const env = await __testing.envelopeFromCli(
      Promise.reject(new CliError('E_AUTH', 4, 'configure --api-key'))
    )
    expect(env).toMatchObject({
      ok: false,
      code: 'E_AUTH',
      hint: 'configure --api-key'
    })
  })

  test('envelopeFromCli folds non-CliError into E_DISPATCH', async () => {
    const env = await __testing.envelopeFromCli(Promise.reject(new Error('boom')))
    expect(env).toMatchObject({ ok: false, code: 'E_DISPATCH', message: 'boom' })
  })

  test('ensureInternalId rejects non-integer', () => {
    const r = __testing.ensureInternalId('1.5' as unknown, 'admin:deadLetterRetry')
    expect(r).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('ensureInternalId rejects negative', () => {
    const r = __testing.ensureInternalId(-1, 'admin:deadLetterRetry')
    expect(r).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('ensureInternalId passes valid integer', () => {
    expect(__testing.ensureInternalId(42, 'admin:deadLetterRetry')).toBe(42)
  })
})

describe('admin handlers — davmail health (L2a IMAP LOGIN probe)', () => {
  function seedSyncState(rows: Record<string, string>): void {
    fixtureDb = new Database(':memory:')
    fixtureDb.exec('CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)')
    const insert = fixtureDb.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(rows)) insert.run(k, v)
  }

  afterEach(() => {
    fixtureDb?.close()
    fixtureDb = null
  })

  const baseHealthy = {
    'davmail.last_probe_at': '2026-07-14T10:00:00',
    'davmail.imap_reachable': '1',
    'davmail.smtp_reachable': '1',
    'davmail.token_age_days': '5.00'
  }

  test('login degraded (>=3 consecutive failures) drives level critical', () => {
    seedSyncState({
      ...baseHealthy,
      'davmail.imap_login_ok': '0',
      'davmail.consecutive_login_failures': '3'
    })
    const h = runDavmailHealth()
    expect(h.level).toBe('critical')
    expect(h.imap_login_ok).toBe(false)
    expect(h.consecutive_login_failures).toBe(3)
  })

  test('login ok / skipped ("" → null) keep level ok', () => {
    seedSyncState({
      ...baseHealthy,
      'davmail.imap_login_ok': '1',
      'davmail.consecutive_login_failures': '0'
    })
    let h = runDavmailHealth()
    expect(h.level).toBe('ok')
    expect(h.imap_login_ok).toBe(true)

    seedSyncState({ ...baseHealthy, 'davmail.imap_login_ok': '' })
    h = runDavmailHealth()
    expect(h.level).toBe('ok')
    expect(h.imap_login_ok).toBeNull()
  })

  test('missing login keys (older backend) parse as null/0 without breaking', () => {
    seedSyncState(baseHealthy)
    const h = runDavmailHealth()
    expect(h.level).toBe('ok')
    expect(h.imap_login_ok).toBeNull()
    expect(h.consecutive_login_failures).toBe(0)
  })

  test('runSystemAlerts synthesizes critical item on login degraded', () => {
    seedSyncState({
      ...baseHealthy,
      'davmail.imap_login_ok': '0',
      'davmail.consecutive_login_failures': '4'
    })
    const alerts = runSystemAlerts()
    const login = alerts.alerts.find((a) => a.title === 'DavMail IMAP LOGIN 持续失败')
    expect(login).toBeDefined()
    expect(login?.level).toBe('critical')
    expect(alerts.critical_count).toBeGreaterThanOrEqual(1)
  })

  // F5 — 阈值经 sync_state davmail.login_fail_threshold 传播, 不再硬编码 3
  test('F5: non-default threshold (5) — 4 fails stays ok, 5 goes critical', () => {
    seedSyncState({
      ...baseHealthy,
      'davmail.login_fail_threshold': '5',
      'davmail.imap_login_ok': '0',
      'davmail.consecutive_login_failures': '4'
    })
    expect(runDavmailHealth().level).toBe('ok')

    seedSyncState({
      ...baseHealthy,
      'davmail.login_fail_threshold': '5',
      'davmail.imap_login_ok': '0',
      'davmail.consecutive_login_failures': '5'
    })
    expect(runDavmailHealth().level).toBe('critical')
  })

  test('F5: missing threshold key falls back to 3 (older backend)', () => {
    seedSyncState({
      ...baseHealthy,
      'davmail.imap_login_ok': '0',
      'davmail.consecutive_login_failures': '3'
    })
    expect(runDavmailHealth().level).toBe('critical')
  })

  test('F5: runSystemAlerts respects propagated threshold (5) — 4 fails no alert', () => {
    seedSyncState({
      ...baseHealthy,
      'davmail.login_fail_threshold': '5',
      'davmail.imap_login_ok': '0',
      'davmail.consecutive_login_failures': '4'
    })
    const login = runSystemAlerts().alerts.find((a) => a.title === 'DavMail IMAP LOGIN 持续失败')
    expect(login).toBeUndefined()
  })
})
