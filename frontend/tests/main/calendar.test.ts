// Sprint 6 §2.2 — calendar IPC handler contract.

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
  runCalendarExpand,
  runRecurringDiscover,
  runRecurringReplay
} from '../../src/electron/main/handlers/calendar'

beforeEach(() => {
  mockCallCli.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('calendar — runRecurringDiscover', () => {
  test('no opts → no flags', async () => {
    mockCallCli.mockResolvedValue([])
    await runRecurringDiscover()
    expect(mockCallCli).toHaveBeenCalledWith(['calendar', 'recurring', 'discover'], {
      timeoutMs: 30_000
    })
  })

  test('since flag forwarded', async () => {
    mockCallCli.mockResolvedValue([])
    await runRecurringDiscover({ since: '2026-01-01' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'discover', '--since', '2026-01-01'],
      { timeoutMs: 30_000 }
    )
  })

  test('normalizes {items} shape into array', async () => {
    mockCallCli.mockResolvedValue({ items: [{ internal_id: 1 }] })
    const out = await runRecurringDiscover()
    expect(out).toEqual([{ internal_id: 1 }])
  })

  test('returns [] for malformed object', async () => {
    mockCallCli.mockResolvedValue({ other: 1 })
    expect(await runRecurringDiscover()).toEqual([])
  })
})

describe('calendar — runRecurringReplay', () => {
  test('internalId path: write+auth + 120s', async () => {
    mockCallCli.mockResolvedValue({})
    await runRecurringReplay({ internalId: 42 })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'replay', '--internal-id', '42'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('ids path: joins with comma', async () => {
    mockCallCli.mockResolvedValue({})
    await runRecurringReplay({ ids: [1, 2, 3] })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'replay', '--ids', '1,2,3'],
      { write: true, needsAuth: true, timeoutMs: 120_000 }
    )
  })

  test('dry-run skips write+auth + adds --dry-run', async () => {
    mockCallCli.mockResolvedValue({})
    await runRecurringReplay({ internalId: 42, dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'recurring', 'replay', '--internal-id', '42', '--dry-run'],
      { write: false, needsAuth: false, timeoutMs: 120_000 }
    )
  })
})

describe('calendar — runCalendarExpand', () => {
  test('default: write+auth no horizon', async () => {
    mockCallCli.mockResolvedValue({})
    await runCalendarExpand()
    expect(mockCallCli).toHaveBeenCalledWith(['calendar', 'expand'], {
      write: true,
      needsAuth: true,
      timeoutMs: 120_000
    })
  })

  test('horizonWeeks + dryRun', async () => {
    mockCallCli.mockResolvedValue({})
    await runCalendarExpand({ horizonWeeks: 4, dryRun: true })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['calendar', 'expand', '--horizon-weeks', '4', '--dry-run'],
      { write: false, needsAuth: false, timeoutMs: 120_000 }
    )
  })
})

describe('calendar — envelope', () => {
  test('rolls CliError into ok:false with code', async () => {
    const env = await __testing.envelopeFromCli(
      Promise.reject(new CliError('E_PM2_CONFLICT', 9, undefined))
    )
    expect(env).toMatchObject({ ok: false, code: 'E_PM2_CONFLICT' })
  })

  test('rolls success into ok:true', async () => {
    const env = await __testing.envelopeFromCli(Promise.resolve({ replayed: 1 }))
    expect(env).toEqual({ ok: true, data: { replayed: 1 } })
  })
})
