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
/** 多 service 测试: 按子命令 (serve / serve-api) 取对应 fake child。 */
const childByArgs = new Map<string, FakeChild>()
function childFor(arg: 'serve' | 'serve-api'): FakeChild {
  const c = childByArgs.get(arg)
  if (!c) throw new Error(`no spawned child for "${arg}"`)
  return c
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild
  // 仿真实 Node: kill() 成功发出信号后把 killed 置 true (表示"信号已发送", 不是
  // "进程已退出")。stop() 必须靠 'exit' 事件而非 child.killed 判断进程是否真退出 —
  // 这个 fake 行为能抓住误用 child.killed 做 SIGKILL 升级条件的回归 (codex #4)。
  ee.kill = vi.fn((_sig?: string) => {
    ee.killed = true
    return true
  })
  ee.killed = false
  return ee
}

vi.mock('child_process', () => ({
  spawn: vi.fn((bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args, opts })
    lastChild = makeFakeChild()
    childByArgs.set(args[0], lastChild)
    return lastChild
  })
}))

// ---- http.get mock (serve-api probeApiHealth 用) ----------------------------
//
// probeApiHealth 用 `import { get as httpGet } from 'http'` 发真实 GET /api/health。
// 这里把它换成可编程 fake: 每个 probeApiHealth 单测设 `httpHandler` 决定本次响应
// (200+ok / 非200 / ECONNREFUSED / 超时 / 坏 JSON)。registry 多 service 测试不依赖
// 它 (统一注入 apiProbe), 故这层 mock 对那些测试无副作用。
type HttpScenario =
  | { kind: 'json'; statusCode: number; body: string }
  | { kind: 'refused' }
  | { kind: 'timeout' }
let httpHandler: HttpScenario = { kind: 'refused' }

interface FakeReq extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>
}
interface FakeRes extends EventEmitter {
  statusCode: number
  setEncoding: (enc: string) => void
  resume: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

const httpGetMock = vi.fn(
  (_opts: unknown, cb?: (res: FakeRes) => void): FakeReq => {
    const req = new EventEmitter() as FakeReq
    req.destroy = vi.fn(() => {
      // 真实 http: req.destroy() 触发 'error' (ECONNRESET-ish)。probeApiHealth 的
      // timeout handler 调 req.destroy() 后靠这条 'error' 收敛成 false。
      queueMicrotask(() => req.emit('error', new Error('socket destroyed')))
    })
    const scenario = httpHandler
    if (scenario.kind === 'refused') {
      // uvicorn 还没 bind → ECONNREFUSED 走 req 'error'。
      queueMicrotask(() => req.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:8200')))
      return req
    }
    if (scenario.kind === 'timeout') {
      // 不回 response, 模拟 socket timeout → probeApiHealth req.on('timeout') 触发。
      queueMicrotask(() => req.emit('timeout'))
      return req
    }
    // json 场景: 构造 fake response, 异步喂 data/end。
    const res = new EventEmitter() as FakeRes
    res.statusCode = scenario.statusCode
    res.setEncoding = () => {}
    res.resume = vi.fn()
    res.destroy = vi.fn()
    queueMicrotask(() => {
      cb?.(res)
      queueMicrotask(() => {
        if (scenario.body) res.emit('data', scenario.body)
        res.emit('end')
      })
    })
    return req
  }
)

vi.mock('http', () => ({
  get: (opts: unknown, cb?: (res: FakeRes) => void) => httpGetMock(opts, cb)
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
  DEFAULT_API_PORT,
  probeApiHealth,
  _resetBackendLifecycleForTests
} = await import('../../src/electron/main/backend_lifecycle')

beforeEach(() => {
  appMock.isPackaged = false
  spawnCalls.length = 0
  lastChild = null
  childByArgs.clear()
  // 默认 serve-api gate **关** → 既有单测走「serve-only」向后兼容 lane (行为与改造前
  // 逐字节一致: 只 spawn serve, 不触 http probe)。开 serve-api 的多 service 测试在各自
  // describe 内显式设 MAILAGENT_REMOTE_ACCESS_ENABLED=''/删掉, 见下。
  process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
  delete process.env.MAILAGENT_API_PORT
  httpHandler = { kind: 'refused' } // 默认: uvicorn 没起, probe 失败
  _resetBackendLifecycleForTests()
})

afterEach(() => {
  delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
  delete process.env.MAILAGENT_API_PORT
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
    // 不 emit exit, 让 grace 超时 → 升级 SIGKILL
    await vi.advanceTimersByTimeAsync(150)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    // SIGKILL 后进程退出: stop() 现在会等真正 exit 再返回 (防 cpSync 与濒死后端 race),
    // 模拟内核回收进程 → 触发 exit, stopP 随即 resolve (不必走 SIGKILL_WAIT_MS 上限)。
    child.emit('exit', null, 'SIGKILL')
    await stopP
    expect(mgr.getState()).toBe('stopped')
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

// ===========================================================================
// V2 远程访问 — serve-api 多 service 化
// ===========================================================================

// 多 service 测试统一注入一个不触真实 http 的 apiProbe (默认返 false), 各测试按需覆盖,
// 避免软门控后台轮询打真实 socket / 拖到 apiReadyTimeout。
function neverReadyApiProbe(): () => Promise<boolean> {
  return vi.fn(async () => false)
}

// 构造 gate-on manager 的默认 opts: 注入恒 false 的 apiProbe + 极短软门控超时, 让
// fire-and-forget 的 waitApiReady 快速收敛 (不在测试结束后留 30s background poll)。
function fastApiOpts(extra: Record<string, unknown> = {}) {
  return { pollIntervalMs: 1, apiReadyTimeoutMs: 5, apiProbe: neverReadyApiProbe(), ...extra }
}

describe('serve-api gate — 向后兼容 (gate off → 只 spawn serve)', () => {
  test('gate off (MAILAGENT_REMOTE_ACCESS_ENABLED=false): packaged 只 spawn serve, 不 spawn serve-api', () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    // 与改造前逐字节一致: 只有 serve 一个进程。
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].args).toEqual(['serve'])
    expect(childByArgs.has('serve-api')).toBe(false)
  })

  test('gate off: getState 聚合只看 serve (serve ready → ready, 不被 disabled serve-api 影响)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      readyTimeoutMs: 1000,
      apiProbe: neverReadyApiProbe()
    })
    mgr.start()
    await mgr.waitReady(() => readyResult())
    expect(mgr.getState()).toBe('ready')
  })
})

describe('serve-api gate — 默认开 (gate on → spawn serve + serve-api)', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED // 默认开
  }

  test('packaged 默认开: spawn serve + serve-api 两个进程, args 正确', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    expect(spawnCalls).toHaveLength(2)
    const argsList = spawnCalls.map((c) => c.args)
    expect(argsList).toContainEqual(['serve'])
    expect(argsList).toContainEqual(['serve-api'])
  })

  test('serve-api spawn 注入三 env + MAILAGENT_API_PORT (默认 8200), cwd=DATA_ROOT', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const apiCall = spawnCalls.find((c) => c.args[0] === 'serve-api')!
    expect(apiCall.bin).toBe('/fake/Resources/python/bin/mailagent')
    expect(apiCall.opts.cwd).toBe('/fake/DATA_ROOT')
    const env = apiCall.opts.env as NodeJS.ProcessEnv
    // 与 serve 同款三 env 注入。
    expect(env.MAILAGENT_PROJECT_ROOT).toBe('/fake/DATA_ROOT')
    expect(env.MAILAGENT_ENV_FILE).toBe('/fake/DATA_ROOT/.env')
    expect(env.SYNC_STORE_DB_PATH).toBe('/fake/DATA_ROOT/data/sync_store.db')
    // serve-api 额外注入端口。
    expect(env.MAILAGENT_API_PORT).toBe(String(DEFAULT_API_PORT))
  })

  test('MAILAGENT_API_PORT 自定义端口透传给 serve-api', () => {
    appMock.isPackaged = true
    enableGate()
    process.env.MAILAGENT_API_PORT = '9300'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const apiCall = spawnCalls.find((c) => c.args[0] === 'serve-api')!
    const env = apiCall.opts.env as NodeJS.ProcessEnv
    expect(env.MAILAGENT_API_PORT).toBe('9300')
  })

  test('serve 的 env 不带 MAILAGENT_API_PORT (端口只注入 serve-api)', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const serveCall = spawnCalls.find((c) => c.args[0] === 'serve')!
    const env = serveCall.opts.env as NodeJS.ProcessEnv
    expect(env.MAILAGENT_API_PORT).toBeUndefined()
  })

  test('dev 模式 (isPackaged=false) 即便 gate on 也不 spawn 任何进程', () => {
    appMock.isPackaged = false
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    expect(spawnCalls).toHaveLength(0)
  })

  test('重复 start 幂等: serve + serve-api 各只 spawn 一次', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    mgr.start()
    expect(spawnCalls.filter((c) => c.args[0] === 'serve')).toHaveLength(1)
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(1)
  })
})

describe('serve-api 软门控 — waitReady 只 gate serve (向后兼容硬约束)', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
  }

  test('serve-api probe 永不就绪也不阻塞 waitReady (软门控): serve ready → waitReady true', async () => {
    appMock.isPackaged = true
    enableGate()
    // apiProbe 恒 false (serve-api 起不来) — waitReady 不该因此 hang/false。
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      readyTimeoutMs: 1000,
      apiReadyTimeoutMs: 20,
      apiProbe: vi.fn(async () => false)
    })
    mgr.start()
    // waitReady 只看 serve 的 SQLite probe → serve ready 即 true, 与 serve-api 无关。
    await expect(mgr.waitReady(() => readyResult())).resolves.toBe(true)
  })

  test('serve-api 起来 → getServiceState(serve-api)=ready (软门控后台轮询置位)', async () => {
    appMock.isPackaged = true
    enableGate()
    const apiProbe = vi.fn(async () => true) // uvicorn /api/health 200 ok
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 1000,
      apiProbe
    })
    mgr.start()
    // 软门控是 fire-and-forget; 轮一小会儿等它置 ready。
    await vi.waitFor(() => expect(mgr.getServiceState('serve-api')).toBe('ready'), { timeout: 500 })
    expect(apiProbe).toHaveBeenCalled()
  })

  test('serve-api 永不就绪 → 软门控超时标 serve-api failed (只 warn, 不影响 serve)', async () => {
    appMock.isPackaged = true
    enableGate()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 10,
      apiProbe: vi.fn(async () => false)
    })
    mgr.start()
    await vi.waitFor(() => expect(mgr.getServiceState('serve-api')).toBe('failed'), { timeout: 500 })
    // serve 仍是 starting (SQLite 未就绪, 没 emit exit) → 不受 serve-api 软失败影响。
    expect(mgr.getServiceState('serve')).toBe('starting')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test('🔴 向后兼容: serve 慢迁移 (starting) + serve-api 软失败 → getState 仍 starting (不误报 failed)', async () => {
    // 这是 onboarding.ts:883/1189 区分「真崩 vs 慢迁移」的命脉: serve-api 软失败
    // 不得把聚合状态拉成 failed, 否则 serve 还在慢迁移就被误判 E_BACKEND_FAILED。
    appMock.isPackaged = true
    enableGate()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 10,
      apiProbe: vi.fn(async () => false)
    })
    mgr.start()
    // 等 serve-api 软失败定型。
    await vi.waitFor(() => expect(mgr.getServiceState('serve-api')).toBe('failed'), { timeout: 500 })
    // serve 没 emit exit → 仍 starting → 聚合恒 starting (serve 门控未定型, serve-api 软态不抢占)。
    expect(mgr.getServiceState('serve')).toBe('starting')
    expect(mgr.getState()).toBe('starting')
  })

  test('serve 崩溃 (emit exit) → getState failed (serve 门控定型为崩, 正常聚合)', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    // 模拟 serve 进程崩溃 (bad config → exit)。
    childFor('serve').emit('exit', 1, null)
    expect(mgr.getServiceState('serve')).toBe('failed')
    expect(mgr.getState()).toBe('failed')
  })
})

describe('serve-api 多 service stop — 全部 SIGTERM', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
  }

  test('stop 对 serve + serve-api 两个进程都发 SIGTERM, 各退出后整体 stopped', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager({
      stopGraceMs: 1000,
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5, // 软门控快速收敛, 不留长 background poll
      apiProbe: vi.fn(async () => false)
    })
    mgr.start()
    const serveChild = childFor('serve')
    const apiChild = childFor('serve-api')

    const stopP = mgr.stop()
    expect(serveChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(apiChild.kill).toHaveBeenCalledWith('SIGTERM')
    // 两个进程都优雅退出。
    serveChild.emit('exit', 0, null)
    apiChild.emit('exit', 0, null)
    await stopP
    expect(serveChild.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(apiChild.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(mgr.getState()).toBe('stopped')
  })

  test('restart 重新 spawn serve + serve-api (env 变更两进程都 reload)', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager({
      stopGraceMs: 1000,
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5, // 软门控快速收敛, 不留长 background poll
      apiProbe: vi.fn(async () => false)
    })
    mgr.start()
    // restart = stop + start。stop 阶段对 **当前** (首批) child 发 SIGTERM; 抓住它们,
    // emit exit 让 stop 优雅收敛 (childByArgs 在 restart re-spawn 后会指向新 child, 故先抓)。
    const serveChild0 = childFor('serve')
    const apiChild0 = childFor('serve-api')
    const restartP = mgr.restart()
    serveChild0.emit('exit', 0, null)
    apiChild0.emit('exit', 0, null)
    await restartP
    // 两进程各被 spawn 两次 (首启 + restart 重启)。
    expect(spawnCalls.filter((c) => c.args[0] === 'serve')).toHaveLength(2)
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(2)
  })
})

describe('probeApiHealth — HTTP GET /api/health 三态 (Node http.get mock)', () => {
  test('200 + {"status":"ok"} → true', async () => {
    httpHandler = { kind: 'json', statusCode: 200, body: '{"status":"ok","schema_version":1}' }
    await expect(probeApiHealth(8200)).resolves.toBe(true)
  })

  test('200 但 status != ok → false', async () => {
    httpHandler = { kind: 'json', statusCode: 200, body: '{"status":"degraded"}' }
    await expect(probeApiHealth(8200)).resolves.toBe(false)
  })

  test('非 200 (503) → false', async () => {
    httpHandler = { kind: 'json', statusCode: 503, body: '{"status":"ok"}' }
    await expect(probeApiHealth(8200)).resolves.toBe(false)
  })

  test('200 但 body 非法 JSON → false (不 throw)', async () => {
    httpHandler = { kind: 'json', statusCode: 200, body: 'not-json<<<' }
    await expect(probeApiHealth(8200)).resolves.toBe(false)
  })

  test('ECONNREFUSED (uvicorn 没起) → false', async () => {
    httpHandler = { kind: 'refused' }
    await expect(probeApiHealth(8200)).resolves.toBe(false)
  })

  test('socket timeout → false (req.destroy 收敛)', async () => {
    httpHandler = { kind: 'timeout' }
    await expect(probeApiHealth(8200)).resolves.toBe(false)
  })
})
