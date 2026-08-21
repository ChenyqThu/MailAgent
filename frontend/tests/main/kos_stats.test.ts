// issue #59 R7 — kos:stats IPC handler contract.
//
// Same shape as llm_stats.test.ts: the only logic in the handler is the days
// clamp + 传输端 (task 08-20-perf-dashboards 起 = 本机 serve-api, 不再 fork CLI;
// /llm 挂载时它与 llm:stats 并发, 两个 Python 冷启互抢 CPU 正是「进看板要等 1 秒」
// 的一半)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRead } = vi.hoisted(() => ({ mockDaemonRead: vi.fn() }))

vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRead: mockDaemonRead }))

import { runKosStats } from '../../src/electron/main/handlers/kos_stats'

beforeEach(() => {
  mockDaemonRead.mockReset()
  mockDaemonRead.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('kos_stats — runKosStats', () => {
  test('default days=7', async () => {
    await runKosStats()
    expect(mockDaemonRead).toHaveBeenCalledWith('/kos/stats', { query: { days: '7' } })
  })

  test('respects explicit days', async () => {
    await runKosStats(30)
    expect(mockDaemonRead).toHaveBeenCalledWith('/kos/stats', { query: { days: '30' } })
  })

  test('clamps days < 1 to 1', async () => {
    await runKosStats(0)
    expect(mockDaemonRead).toHaveBeenCalledWith('/kos/stats', { query: { days: '1' } })
  })

  test('clamps days > 365 to 365', async () => {
    await runKosStats(9999)
    expect(mockDaemonRead).toHaveBeenCalledWith('/kos/stats', { query: { days: '365' } })
  })

  test('floors fractional days', async () => {
    await runKosStats(7.9)
    expect(mockDaemonRead).toHaveBeenCalledWith('/kos/stats', { query: { days: '7' } })
  })
})
