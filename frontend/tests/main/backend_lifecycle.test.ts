// Packaging P1-4~P1-7 — BackendLifecycleManager 骨架单测。
//
// 覆盖三轴 (真机 spawn / waitReady / SIGTERM 留给后续 dogfood):
//   (a) start() 仅在 packaged 模式 spawn, 且注入三 env + cwd=DATA_ROOT;
//   (b) waitReady() 就绪判定: ready / 锁表(busy)退避 / 缺表→超时返回 false;
//   (c) stop() 发 SIGTERM, 超时升级 SIGKILL。
//
// 全部 mock 掉 child_process.spawn / better-sqlite3 / electron / cli_runner / db,
// 不触碰真实进程或 SQLite 文件。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'events'

// ---- electron app mock (isPackaged 可切换) ---------------------------------

const appMock = { isPackaged: false } as { isPackaged: boolean; on: ReturnType<typeof vi.fn> }
// before-quit 钩子收集器
appMock.on = vi.fn()

vi.mock('electron', () => ({ app: appMock }))

// ---- child_process.spawn mock ----------------------------------------------

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>
  killed: boolean
}

const spawnCalls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> = []
let lastChild: FakeChild | null = null

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.kill = vi.fn((_sig?: string) => {
    return true
  })
  ee.killed = false
  return ee
}

vi.mock('child_process', () => ({
  spawn: vi.fn((bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args, opts })
    lastChild = makeFakeChild()
    return lastChild
  })
}))

// ---- cli_runner / db mocks (bin + 路径解析) --------------------------------

vi.mock('../../src/electron/main/cli_runner', () => ({
  getMailagentBin: () => '/fake/Resources/python/bin/mailagent'
}))

vi.mock('../../src/electron/main/db', () => ({
  resolveDataRoot: () => '/fake/DATA_ROOT',
  resolveDbPath: () => '/fake/DATA_ROOT/data/sync_store.db'
}))

// ---- 被测模块 (mock 后再 import) -------------------------------------------

const {
  BackendLifecycleManager,
  EXPECTED_DB_VERSION,
  REQUIRED_TABLES,
  _resetBackendLifecycleForTests
} = await import('../../src/electron/main/backend_lifecycle')

beforeEach(() => {
  appMock.isPackaged = false
  spawnCalls.length = 0
  lastChild = null
  _resetBackendLifecycleForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

// 就绪判据 helper — 构造 probe 返回值
function readyResult(over: Partial<ReturnType<typeof okResult>> = {}) {
  return { ...okResult(), ...over }
}
function okResult() {
  return {
    ready: true,
    dbAccessible: true,
    dbVersion: EXPECTED_DB_VERSION,
    missingTables: [] as string[],
    busy: false as boolean
  }
}

describe('BackendLifecycleManager.start — env 注入 + dev 不接管', () => {
  test('dev 模式 (isPackaged=false) 不 spawn', () => {
    appMock.isPackaged = false
    const mgr = new BackendLifecycleManager()
    mgr.start()
    expect(spawnCalls).toHaveLength(0)
    expect(mgr.isManaged()).toBe(false)
  })

  test('packaged 模式 spawn `mailagent serve`, cwd=DATA_ROOT, 注入三 env', () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager()
    mgr.start()

    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]
    expect(call.bin).toBe('/fake/Resources/python/bin/mailagent')
    expect(call.args).toEqual(['serve'])
    expect(call.opts.cwd).toBe('/fake/DATA_ROOT')

    const env = call.opts.env as NodeJS.ProcessEnv
    expect(env.MAILAGENT_PROJECT_ROOT).toBe('/fake/DATA_ROOT')
    expect(env.MAILAGENT_ENV_FILE).toBe('/fake/DATA_ROOT/.env')
    expect(env.SYNC_STORE_DB_PATH).toBe('/fake/DATA_ROOT/data/sync_store.db')
  })

  test('packaged 模式重复 start 幂等 (不二次 spawn)', () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager()
    mgr.start()
    mgr.start()
    expect(spawnCalls).toHaveLength(1)
  })
})

describe('BackendLifecycleManager.waitReady — 判定', () => {
  test('首次探测即 ready → true', async () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager({ pollIntervalMs: 1, readyTimeoutMs: 1000 })
    const probe = vi.fn(() => readyResult())
    await expect(mgr.waitReady(probe)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(mgr.getState()).toBe('ready')
  })

  test('锁表 (busy) 先退避, 后续 ready → true (轮询多次)', async () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager({ pollIntervalMs: 1, readyTimeoutMs: 1000 })
    const probe = vi
      .fn()
      .mockReturnValueOnce(readyResult({ ready: false, busy: true, dbVersion: null }))
      .mockReturnValueOnce(readyResult({ ready: false, missingTables: [...REQUIRED_TABLES] }))
      .mockReturnValueOnce(readyResult())
    await expect(mgr.waitReady(probe)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  test('始终缺表 → 超时返回 false (不死循环)', async () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager({ pollIntervalMs: 1, readyTimeoutMs: 20 })
    const probe = vi.fn(() =>
      readyResult({ ready: false, missingTables: ['email_outbox'], dbVersion: EXPECTED_DB_VERSION })
    )
    await expect(mgr.waitReady(probe)).resolves.toBe(false)
    expect(probe.mock.calls.length).toBeGreaterThan(0)
  })

  test('db_version 不匹配 → not ready', async () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager({ pollIntervalMs: 1, readyTimeoutMs: 15 })
    const probe = vi.fn(() => readyResult({ ready: false, dbVersion: EXPECTED_DB_VERSION - 1 }))
    await expect(mgr.waitReady(probe)).resolves.toBe(false)
  })
})

describe('BackendLifecycleManager.stop — SIGTERM', () => {
  test('packaged: stop 发 SIGTERM, 子进程及时退出不 SIGKILL', async () => {
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager({ stopGraceMs: 1000 })
    mgr.start()
    const child = lastChild!
    const stopP = mgr.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // 模拟子进程优雅退出
    child.emit('exit', 0, null)
    await stopP
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(mgr.getState()).toBe('stopped')
  })

  test('packaged: 优雅退出超时 → 升级 SIGKILL', async () => {
    vi.useFakeTimers()
    appMock.isPackaged = true
    const mgr = new BackendLifecycleManager({ stopGraceMs: 100 })
    mgr.start()
    const child = lastChild!
    const stopP = mgr.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // 不 emit exit, 让 grace 超时
    await vi.advanceTimersByTimeAsync(150)
    await stopP
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    vi.useRealTimers()
  })

  test('dev 模式: 无子进程时 stop 安全 no-op', async () => {
    appMock.isPackaged = false
    const mgr = new BackendLifecycleManager()
    mgr.start()
    await expect(mgr.stop()).resolves.toBeUndefined()
    expect(mgr.getState()).toBe('stopped')
  })
})
