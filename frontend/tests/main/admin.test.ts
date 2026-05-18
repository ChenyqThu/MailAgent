// Sprint 6 §2.2 — admin IPC handler contract.
//
// Mocks `callCli` to exercise:
//   - argv shape for health / stats / dead-letter list / retry / cleanup
//   - read commands carry no auth + cap at 15s timeout
//   - dead-letter retry flips to write+auth
//   - envelope shape on success / CliError / unknown rejection
//   - deadLetterList normalizes both `[...]` and `{items: [...]}` CLI shapes

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli } = vi.hoisted(() => ({ mockCallCli: vi.fn() }))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
      '../../src/electron/main/cli_runner'
    )
  return { ...actual, callCli: mockCallCli }
})

import { CliError } from '../../src/electron/main/cli_runner'
import {
  __testing,
  runAdminHealth,
  runAdminStats,
  runCleanupDeadLetter,
  runDeadLetterList,
  runDeadLetterRetry
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
