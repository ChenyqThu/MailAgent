// Sprint 6 §2.2 — llm dashboard IPC handler contract.
//
// Verifies that:
//   - days param is clamped to [1, 365] before reaching the CLI
//   - selftest takes the longer 30s timeout (gateway round-trip)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli } = vi.hoisted(() => ({ mockCallCli: vi.fn() }))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
      '../../src/electron/main/cli_runner'
    )
  return { ...actual, callCli: mockCallCli }
})

import { runLlmSelfTest, runLlmStats } from '../../src/electron/main/handlers/llm_stats'

beforeEach(() => {
  mockCallCli.mockReset()
  mockCallCli.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('llm_stats — runLlmStats', () => {
  test('default days=7', async () => {
    await runLlmStats()
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'stats', '--days', '7'], { timeoutMs: 15_000 })
  })

  test('respects explicit days', async () => {
    await runLlmStats(30)
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'stats', '--days', '30'], {
      timeoutMs: 15_000
    })
  })

  test('clamps days < 1 to 1', async () => {
    await runLlmStats(0)
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'stats', '--days', '1'], { timeoutMs: 15_000 })
  })

  test('clamps days > 365 to 365', async () => {
    await runLlmStats(9999)
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'stats', '--days', '365'], {
      timeoutMs: 15_000
    })
  })

  test('floors fractional days', async () => {
    await runLlmStats(7.9)
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'stats', '--days', '7'], { timeoutMs: 15_000 })
  })
})

describe('llm_stats — runLlmSelfTest', () => {
  test('uses the longer 30s timeout', async () => {
    await runLlmSelfTest()
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'selftest'], { timeoutMs: 30_000 })
  })
})
