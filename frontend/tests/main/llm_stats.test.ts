// Sprint 6 §2.2 — llm dashboard IPC handler contract.
//
// Verifies that:
//   - stats 走本机 serve-api (daemonRead GET /llm/stats), **不再** fork CLI
//     (task 08-20-perf-dashboards: 看板每次取数 fork 一个 Python = ~500ms-1s)
//   - days param is clamped to [1, 365] before reaching the backend
//   - selftest 仍走 CLI 且拿 30s timeout (gateway round-trip, 主动按钮低频)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockCallCli, mockDaemonRead } = vi.hoisted(() => ({
  mockCallCli: vi.fn(),
  mockDaemonRead: vi.fn()
}))

vi.mock('../../src/electron/main/cli_runner', async () => {
  const actual = await vi.importActual<typeof import('../../src/electron/main/cli_runner')>(
    '../../src/electron/main/cli_runner'
  )
  return { ...actual, callCli: mockCallCli }
})

vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRead: mockDaemonRead }))

import { runLlmSelfTest, runLlmStats } from '../../src/electron/main/handlers/llm_stats'

beforeEach(() => {
  mockCallCli.mockReset()
  mockCallCli.mockResolvedValue({})
  mockDaemonRead.mockReset()
  mockDaemonRead.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('llm_stats — runLlmStats', () => {
  test('default days=7, 走 serve-api 而不是 CLI', async () => {
    await runLlmStats()
    expect(mockDaemonRead).toHaveBeenCalledWith('/llm/stats', { query: { days: '7' } })
    expect(mockCallCli).not.toHaveBeenCalled()
  })

  test('respects explicit days', async () => {
    await runLlmStats(30)
    expect(mockDaemonRead).toHaveBeenCalledWith('/llm/stats', { query: { days: '30' } })
  })

  test('clamps days < 1 to 1', async () => {
    await runLlmStats(0)
    expect(mockDaemonRead).toHaveBeenCalledWith('/llm/stats', { query: { days: '1' } })
  })

  test('clamps days > 365 to 365', async () => {
    await runLlmStats(9999)
    expect(mockDaemonRead).toHaveBeenCalledWith('/llm/stats', { query: { days: '365' } })
  })

  test('floors fractional days', async () => {
    await runLlmStats(7.9)
    expect(mockDaemonRead).toHaveBeenCalledWith('/llm/stats', { query: { days: '7' } })
  })

  test('serve-api 不可达 → 原样抛（前端已有错误态），不回落 CLI', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'E_NETWORK' })
    mockDaemonRead.mockRejectedValue(err)
    await expect(runLlmStats()).rejects.toThrow('connect ECONNREFUSED')
    expect(mockCallCli).not.toHaveBeenCalled()
  })
})

describe('llm_stats — runLlmSelfTest', () => {
  test('有意留在 CLI: 30s timeout 的主动探针', async () => {
    await runLlmSelfTest()
    expect(mockCallCli).toHaveBeenCalledWith(['llm', 'selftest'], { timeoutMs: 30_000 })
    expect(mockDaemonRead).not.toHaveBeenCalled()
  })
})
