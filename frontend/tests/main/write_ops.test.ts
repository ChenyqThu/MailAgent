// Sprint 5 §2.2 — CLI-backed write IPC handler contract.
//
// Mocks `callCli` so we exercise:
//   - exact argv shape (--dry-run / --replace-existing / --is-read / …)
//   - write+auth flags forwarded correctly (dry runs don't enroll the queue
//     write slot, real runs do)
//   - timeoutMs per command class (resync 120s, llm 90s, updateFlag 30s)
//   - envelope shape on success + on CliError + on unknown rejection
//   - notion:updateFlag rejects when no flag is supplied

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli } = vi.hoisted(() => ({
  mockCallCli: vi.fn()
}))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual = await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
    '../../src/electron/main/cli_runner'
  )
  return {
    ...actual,
    callCli: mockCallCli
  }
})

import { CliError } from '../../src/electron/main/cli_runner'
import {
  __testing,
  runResync,
  runLlmRun,
  runUpdateFlag,
  type WriteEnvelope
} from '../../src/electron/main/handlers/write_ops'

beforeEach(() => {
  mockCallCli.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('write_ops — argv builders', () => {
  test('resync minimal args = ["email", "resync", "<id>"]', () => {
    expect(__testing.resyncArgs(53675, {})).toEqual(['email', 'resync', '53675'])
  })

  test('resync flags compose: dry-run + replace-existing + skip-parent', () => {
    expect(
      __testing.resyncArgs(53675, { dryRun: true, replaceExisting: true, skipParentLookup: true })
    ).toEqual(['email', 'resync', '53675', '--dry-run', '--replace-existing', '--no-parent'])
  })

  test('llm:run flags compose: --dry-run + --force + --no-overwrite', () => {
    expect(__testing.llmRunArgs(53675, { dryRun: true, force: true, noOverwrite: true })).toEqual([
      'llm',
      'run',
      '53675',
      '--dry-run',
      '--force',
      '--no-overwrite'
    ])
  })

  test('updateFlag emits --is-read true / false explicitly (CLI expects boolean text)', () => {
    expect(__testing.updateFlagArgs(53675, { isRead: true })).toEqual([
      'notion',
      'update-flag',
      '53675',
      '--is-read',
      'true'
    ])
    expect(__testing.updateFlagArgs(53675, { isRead: false })).toEqual([
      'notion',
      'update-flag',
      '53675',
      '--is-read',
      'false'
    ])
  })

  test('updateFlag emits --processing-status with the literal status string', () => {
    expect(__testing.updateFlagArgs(53675, { processingStatus: 'AI Reviewed' })).toEqual([
      'notion',
      'update-flag',
      '53675',
      '--processing-status',
      'AI Reviewed'
    ])
  })

  test('updateFlag combines flag + processing-status (single CLI call updates both)', () => {
    expect(
      __testing.updateFlagArgs(53675, {
        isFlagged: true,
        processingStatus: '已完成'
      })
    ).toEqual([
      'notion',
      'update-flag',
      '53675',
      '--is-flagged',
      'true',
      '--processing-status',
      '已完成'
    ])
  })
})

describe('write_ops — runResync / runLlmRun / runUpdateFlag → callCli plumbing', () => {
  test('resync forwards write:true + needsAuth:true + 120s timeout (non-dry-run)', async () => {
    mockCallCli.mockResolvedValueOnce({ status: 'success', internal_id: 53675 })
    await runResync(53675, { replaceExisting: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['email', 'resync', '53675', '--replace-existing'],
      expect.objectContaining({ write: true, needsAuth: true, timeoutMs: 120_000 })
    )
  })

  test('resync dry-run flips write/needsAuth to false (skips auth + write slot)', async () => {
    mockCallCli.mockResolvedValueOnce({ status: 'success', dry_run: true })
    await runResync(53675, { dryRun: true, replaceExisting: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['email', 'resync', '53675', '--dry-run', '--replace-existing'],
      expect.objectContaining({ write: false, needsAuth: false })
    )
  })

  test('llm:run timeout is 90s', async () => {
    mockCallCli.mockResolvedValueOnce({ status: 'success' })
    await runLlmRun(53675, { force: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['llm', 'run', '53675', '--force'],
      expect.objectContaining({ timeoutMs: 90_000 })
    )
  })

  test('updateFlag timeout is 30s', async () => {
    mockCallCli.mockResolvedValueOnce({ status: 'success' })
    await runUpdateFlag(53675, { isFlagged: false })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['notion', 'update-flag', '53675', '--is-flagged', 'false'],
      expect.objectContaining({ timeoutMs: 30_000 })
    )
  })
})

describe('write_ops — envelopeFromCli', () => {
  test('resolved CLI value → { ok: true, data }', async () => {
    const env = (await __testing.envelopeFromCli<{ x: 1 }>(
      Promise.resolve({ x: 1 })
    )) as WriteEnvelope<{ x: 1 }>
    expect(env.ok).toBe(true)
    if (env.ok) expect(env.data).toEqual({ x: 1 })
  })

  test('CliError → envelope preserves code + hint (renderer branches on code)', async () => {
    const err = new CliError('E_AUTH', 4, 'set MAILAGENT_CLI_API_KEY')
    const env = await __testing.envelopeFromCli<unknown>(Promise.reject(err))
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_AUTH')
      expect(env.hint).toBe('set MAILAGENT_CLI_API_KEY')
    }
  })

  test('unknown rejection → E_DISPATCH (the IPC adapter contract)', async () => {
    const env = await __testing.envelopeFromCli<unknown>(Promise.reject(new Error('something bad')))
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_DISPATCH')
      expect(env.message).toBe('something bad')
    }
  })
})

describe('write_ops — ensureInternalId guard', () => {
  test('rejects non-numbers + negatives', () => {
    const cases: unknown[] = ['x', null, undefined, -1, 1.5, NaN]
    for (const c of cases) {
      const r = __testing.ensureInternalId(c, 'email:resync')
      expect(typeof r === 'object' && r !== null && r.ok === false).toBe(true)
      if (typeof r === 'object' && r !== null && r.ok === false)
        expect(r.code).toBe('E_INVALID_ARG')
    }
  })

  test('accepts valid non-negative integers', () => {
    expect(__testing.ensureInternalId(0, 'email:resync')).toBe(0)
    expect(__testing.ensureInternalId(53675, 'email:resync')).toBe(53675)
  })
})
