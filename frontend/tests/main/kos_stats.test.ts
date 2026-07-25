// issue #59 R7 — kos:stats IPC handler contract.
//
// Same shape as llm_stats.test.ts: the only logic in the handler is the days
// clamp, and getting it wrong burns a subprocess that the CLI would reject.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli } = vi.hoisted(() => ({ mockCallCli: vi.fn() }))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual = await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
    '../../src/electron/main/cli_runner'
  )
  return { ...actual, callCli: mockCallCli }
})

import { runKosStats } from '../../src/electron/main/handlers/kos_stats'

beforeEach(() => {
  mockCallCli.mockReset()
  mockCallCli.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kos_stats — runKosStats', () => {
  test('default days=7', async () => {
    await runKosStats()
    expect(mockCallCli).toHaveBeenCalledWith(['kos', 'stats', '--days', '7'], { timeoutMs: 15_000 })
  })

  test('respects explicit days', async () => {
    await runKosStats(30)
    expect(mockCallCli).toHaveBeenCalledWith(['kos', 'stats', '--days', '30'], {
      timeoutMs: 15_000
    })
  })

  test('clamps days < 1 to 1', async () => {
    await runKosStats(0)
    expect(mockCallCli).toHaveBeenCalledWith(['kos', 'stats', '--days', '1'], { timeoutMs: 15_000 })
  })

  test('clamps days > 365 to 365', async () => {
    await runKosStats(9999)
    expect(mockCallCli).toHaveBeenCalledWith(['kos', 'stats', '--days', '365'], {
      timeoutMs: 15_000
    })
  })

  test('floors fractional days', async () => {
    await runKosStats(7.9)
    expect(mockCallCli).toHaveBeenCalledWith(['kos', 'stats', '--days', '7'], { timeoutMs: 15_000 })
  })
})
