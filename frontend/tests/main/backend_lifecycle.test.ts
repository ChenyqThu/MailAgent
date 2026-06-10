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
// vi.mock('fs') 下面会 hoist; 这里 import 拿到的是 mock 版 (用于断言 drain 落盘调用)。
import { createWriteStream, mkdirSync } from 'fs'

// ---- electron app mock (isPackaged 可切换) ---------------------------------

const appMock = { isPackaged: false } as {
  isPackaged: boolean
  on: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
}
// before-quit 钩子收集器 + quit 放行断言点 (registerBackendQuitHook 等 stop 后补发 app.quit)
appMock.on = vi.fn()
appMock.quit = vi.fn()

vi.mock('electron', () => ({ app: appMock }))

// ---- child_process.spawn mock ----------------------------------------------

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  /** 仿真实 ChildProcess: stdio=['ignore','pipe','pipe'] → stdout/stderr 是可读流。
   *  attachLogDrain 必须挂 .on('data') 抽干它们 (防 pipe 背压死锁), 测试据此断言消费。 */
  stdout: EventEmitter
  stderr: EventEmitter
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
  // pipe drain 的消费目标。真实 ChildProcess 的 stdout/stderr 也是 EventEmitter
  // (Readable)。attachLogDrain 会 child.stdout?.on('data', ...) —— 给真 EventEmitter
  // 让「消费者已挂上」可被 listenerCount('data') 断言 (防 pipe 背压死锁回归)。
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
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

// ---- fs mock (log drain 落盘流; 不碰真实磁盘) -------------------------------
//
// attachLogDrain 用 mkdirSync(DATA_ROOT/logs) + createWriteStream(.../*.log) 抽干
// stdout/stderr。测试里 DATA_ROOT=/fake/... 不存在, 真 fs 会 ENOENT。把这三个写操作
// 换成 no-op fake stream, 让 drain 走「成功接上」路径 (而非 catch 里 resume() 丢弃),
// 这样能断言 child.stdout/stderr 确实被 on('data') 消费。existsSync 仍透传真实 (probeDbReady
// / db.ts 路径判断用 — 但 db 已整体 mock, 这里 existsSync 透传不影响)。
const fakeWriteStream = () => ({
  write: vi.fn(),
  end: vi.fn()
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => fakeWriteStream())
  }
})

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

const httpGetMock = vi.fn((_opts: unknown, cb?: (res: FakeRes) => void): FakeReq => {
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
})

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
  registerBackendQuitHook,
  _resetBackendLifecycleForTests
} = await import('../../src/electron/main/backend_lifecycle')

beforeEach(() => {
  appMock.isPackaged = false
  spawnCalls.length = 0
  lastChild = null
  childByArgs.clear()
  // 默认 serve-api gate **关** → 既有单测走「serve-only」向后兼容 lane (行为与改造前
  // 逐字节一致: 只 spawn serve, 不触 http probe)。开 serve-api 的多 service 测试在各自
  // describe 内 enableGate() (删 MAILAGENT_REMOTE_ACCESS_ENABLED + 设 CF_AUDIENCE)。
  process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
  delete process.env.MAILAGENT_API_PORT
  // D1: serveApiEnabled() 只看 MAILAGENT_REMOTE_ACCESS_ENABLED (serve-api 是 Electron
  // 本地写面, 本地 token 恒可用, 不再要求 CF_AUDIENCE)。beforeEach 设 flag='false' → gate
  // off, 既有单测走 serve-only 向后兼容 lane; 多 service 测试在 describe 内 enableGate()
  // (删 flag → serveApiEnabled true)。CF_AUDIENCE 仅影响 serveApiEnv 透传 (远程 CF 腿) +
  // 相关 env 注入断言, 不再 gate spawn。
  delete process.env.CF_AUDIENCE
  delete process.env.CF_TEAM_DOMAIN
  delete process.env.MAILAGENT_API_ALLOWED_EMAIL
  delete process.env.MAILAGENT_MEM_LIMIT_MB // 防宿主 env 污染 buildBaseEnv 默认值断言
  httpHandler = { kind: 'refused' } // 默认: uvicorn 没起, probe 失败
  _resetBackendLifecycleForTests()
})

afterEach(() => {
  delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
  delete process.env.MAILAGENT_API_PORT
  delete process.env.CF_AUDIENCE
  delete process.env.CF_TEAM_DOMAIN
  delete process.env.MAILAGENT_API_ALLOWED_EMAIL
  delete process.env.MAILAGENT_MEM_LIMIT_MB
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
  // gate-on = 开关默认开 (删 flag) + CF_AUDIENCE 已配 (risk #2: 缺它 serve-api 不放行)。
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED // 默认开
    process.env.CF_AUDIENCE = 'aud-test-tag'
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
    process.env.CF_AUDIENCE = 'aud-test-tag'
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
    await vi.waitFor(() => expect(mgr.getServiceState('serve-api')).toBe('failed'), {
      timeout: 500
    })
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
    await vi.waitFor(() => expect(mgr.getServiceState('serve-api')).toBe('failed'), {
      timeout: 500
    })
    // serve 没 emit exit → 仍 starting → 聚合恒 starting (serve 门控未定型, serve-api 软态不抢占)。
    expect(mgr.getServiceState('serve')).toBe('starting')
    expect(mgr.getState()).toBe('starting')
  })

  test('serve 崩溃 (emit exit) → getState failed (serve 门控定型为崩, 正常聚合)', async () => {
    appMock.isPackaged = true
    enableGate()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    // 模拟 serve 进程崩溃 (bad config → exit)。崩溃瞬间~退避 re-spawn 前的窗口 = failed。
    childFor('serve').emit('exit', 1, null)
    expect(mgr.getServiceState('serve')).toBe('failed')
    expect(mgr.getState()).toBe('failed')
    // 清理: serve 崩溃现在也排自拉起退避 timer (memleak-orphan 修复), stop() 清掉它
    // 防 timer 在后续测试中途 fire 污染共享 spawnCalls。serve child 已 null → 立即收敛;
    // serve-api child 仍在 → emit exit 让 stop 不等 grace。
    const stopP = mgr.stop()
    childFor('serve-api').emit('exit', 0, null)
    await stopP
  })
})

describe('serve-api 多 service stop — 全部 SIGTERM', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-test-tag'
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

// ===========================================================================
// V2 整合 — pipe drain (防死锁) + DATA_ROOT/CF/SPA env 注入 + 软 gate (CF_AUDIENCE)
// ===========================================================================

describe('pipe drain — spawn 后消费 stdout/stderr (防 event loop 背压死锁)', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-test-tag'
  }

  test('serve: spawn 后 stdout/stderr 各挂上 data 消费者 (drain 抽干)', () => {
    appMock.isPackaged = true
    // gate off → 只 serve, 聚焦 serve 单进程的 drain。
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const serveChild = childFor('serve')
    // 🔴 核心不变量: 不消费 pipe 会背压死锁。spawn 后 stdout/stderr 必须各有 ≥1 个
    // 'data' listener (attachLogDrain 挂的)。这是 V2 上生产的头号 blocker 的回归守卫。
    expect(serveChild.stdout.listenerCount('data')).toBeGreaterThanOrEqual(1)
    expect(serveChild.stderr.listenerCount('data')).toBeGreaterThanOrEqual(1)
  })

  test('serve-api: spawn 后 stdout/stderr 各挂上 data 消费者 (drain 抽干)', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const apiChild = childFor('serve-api')
    // serve-api 比 serve 更易触发 pipe 死锁 (每请求都 log), 必须同样被消费。
    expect(apiChild.stdout.listenerCount('data')).toBeGreaterThanOrEqual(1)
    expect(apiChild.stderr.listenerCount('data')).toBeGreaterThanOrEqual(1)
  })

  test('多 service 各落独立日志文件 (serve→backend-process.log / serve-api→api-process.log)', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    // 每 service 各建一次 logs 目录 + 各开一条独立流 (不共用 createWriteStream)。
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith('/fake/DATA_ROOT/logs', { recursive: true })
    const streamPaths = vi.mocked(createWriteStream).mock.calls.map((c) => c[0])
    expect(streamPaths).toContainEqual('/fake/DATA_ROOT/logs/backend-process.log')
    expect(streamPaths).toContainEqual('/fake/DATA_ROOT/logs/api-process.log')
    // 两条流互不干扰 → createWriteStream 至少被调两次 (serve + serve-api)。
    expect(vi.mocked(createWriteStream).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('stop 关闭落盘流 (end() 防 fd 泄漏)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const mgr = new BackendLifecycleManager({ stopGraceMs: 1000, ...fastApiOpts() })
    mgr.start()
    // 抓 serve 那条 stream (createWriteStream 最近一次返回的 fake)。
    const streamResults = vi.mocked(createWriteStream).mock.results
    const lastStream = streamResults[streamResults.length - 1].value as {
      end: ReturnType<typeof vi.fn>
    }
    const serveChild = childFor('serve')
    const stopP = mgr.stop()
    serveChild.emit('exit', 0, null)
    await stopP
    expect(lastStream.end).toHaveBeenCalled()
  })
})

describe('serve-api env 注入 — MAILAGENT_DATA_ROOT / CF_* / MAILAGENT_SPA_DIR', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-test-tag'
  }

  test('serve + serve-api 两进程都注入 MAILAGENT_DATA_ROOT (=DATA_ROOT, 锚定可写根)', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    for (const name of ['serve', 'serve-api']) {
      const call = spawnCalls.find((c) => c.args[0] === name)!
      const env = call.opts.env as NodeJS.ProcessEnv
      // 🔴 缺 MAILAGENT_DATA_ROOT 后端 DATA_ROOT fallback 到只读 .app bundle → 读不到
      // 库/附件 + 日志错锚。serve 与 serve-api 必须都注入。
      expect(env.MAILAGENT_DATA_ROOT).toBe('/fake/DATA_ROOT')
    }
  })

  test('C2: serve + serve-api 两进程都注入 MAILAGENT_LOCAL_API_TOKEN (同一非空 token)', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const serveEnv = spawnCalls.find((c) => c.args[0] === 'serve')!.opts.env as NodeJS.ProcessEnv
    const apiEnv = spawnCalls.find((c) => c.args[0] === 'serve-api')!.opts.env as NodeJS.ProcessEnv
    // 9200 SSE 门 (serve) + 8200 dual-auth 本地腿 (serve-api) 都靠它 → 两进程必须同值非空。
    expect(serveEnv.MAILAGENT_LOCAL_API_TOKEN).toBeTruthy()
    expect(serveEnv.MAILAGENT_LOCAL_API_TOKEN).toBe(apiEnv.MAILAGENT_LOCAL_API_TOKEN)
    // 256-bit hex (randomBytes(32).toString('hex') = 64 hex chars)。
    expect(serveEnv.MAILAGENT_LOCAL_API_TOKEN).toMatch(/^[0-9a-f]{64}$/)
  })

  test('serve-api 注入 CF_AUDIENCE / CF_TEAM_DOMAIN / MAILAGENT_API_ALLOWED_EMAIL (从 process.env 透传)', () => {
    appMock.isPackaged = true
    enableGate()
    process.env.CF_TEAM_DOMAIN = 'acme.cloudflareaccess.com'
    process.env.MAILAGENT_API_ALLOWED_EMAIL = 'boss@acme.com'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    const apiCall = spawnCalls.find((c) => c.args[0] === 'serve-api')!
    const env = apiCall.opts.env as NodeJS.ProcessEnv
    expect(env.CF_AUDIENCE).toBe('aud-test-tag')
    expect(env.CF_TEAM_DOMAIN).toBe('acme.cloudflareaccess.com')
    expect(env.MAILAGENT_API_ALLOWED_EMAIL).toBe('boss@acme.com')
  })

  test('serve-api 注入 MAILAGENT_SPA_DIR (packaged: process.resourcesPath/web)', () => {
    appMock.isPackaged = true
    enableGate()
    // resolveSpaDir 读 process.resourcesPath; 单测里给它一个值模拟打包态。
    const orig = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', {
      value: '/fake/App.app/Contents/Resources',
      configurable: true
    })
    try {
      const mgr = new BackendLifecycleManager(fastApiOpts())
      mgr.start()
      const apiCall = spawnCalls.find((c) => c.args[0] === 'serve-api')!
      const env = apiCall.opts.env as NodeJS.ProcessEnv
      expect(env.MAILAGENT_SPA_DIR).toBe('/fake/App.app/Contents/Resources/web')
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: orig, configurable: true })
    }
  })

  test('process.resourcesPath 缺失 (非 Electron 环境) → 不注入 MAILAGENT_SPA_DIR (不崩)', () => {
    appMock.isPackaged = true
    enableGate()
    // vitest 下 process.resourcesPath 本就 undefined; 断言 serve-api 不因此抛 + 不注入 SPA。
    const mgr = new BackendLifecycleManager(fastApiOpts())
    expect(() => mgr.start()).not.toThrow()
    const apiCall = spawnCalls.find((c) => c.args[0] === 'serve-api')!
    const env = apiCall.opts.env as NodeJS.ProcessEnv
    expect(env.MAILAGENT_SPA_DIR).toBeUndefined()
  })

  test('memleak-orphan: serve + serve-api 都注入 MAILAGENT_PARENT_WATCHDOG=1 + MAILAGENT_MEM_LIMIT_MB 默认 4096', () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    for (const name of ['serve', 'serve-api']) {
      const call = spawnCalls.find((c) => c.args[0] === name)!
      const env = call.opts.env as NodeJS.ProcessEnv
      // Python 侧 src/utils/parent_watchdog.py (孤儿自杀兜底) + src/utils/mem_guard.py
      // (内存水位自愈) 全靠这两个 env gate; pm2/dev 不注入 → 那边零行为变更。
      expect(env.MAILAGENT_PARENT_WATCHDOG).toBe('1')
      expect(env.MAILAGENT_MEM_LIMIT_MB).toBe('4096')
    }
  })

  test('MAILAGENT_MEM_LIMIT_MB 可被用户 .env 覆盖 (bootstrapDotenv 注入 process.env 后优先于默认 4096)', () => {
    appMock.isPackaged = true
    enableGate()
    process.env.MAILAGENT_MEM_LIMIT_MB = '8192'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    for (const name of ['serve', 'serve-api']) {
      const call = spawnCalls.find((c) => c.args[0] === name)!
      const env = call.opts.env as NodeJS.ProcessEnv
      expect(env.MAILAGENT_MEM_LIMIT_MB).toBe('8192')
    }
  })
})

describe('serve-api gate — D1 flip (本地写面: flag 开即起, CF_AUDIENCE 不再前置)', () => {
  test('flag 开 + CF_AUDIENCE 空 (纯本地装机) → 仍 spawn serve-api (本地写面)', () => {
    appMock.isPackaged = true
    // 99% 新装用户初始态: 远程访问开关默认开, 没配 CF。D1 起 serve-api 是 Electron 写面,
    // 必须起 (C2 已放宽 auth.py import 守卫为「≥1 鉴权方式」, 本地 token 即可起, 不 crash)。
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    delete process.env.CF_AUDIENCE
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(1)
    expect(spawnCalls.filter((c) => c.args[0] === 'serve')).toHaveLength(1)
  })

  test('flag 开 + CF_AUDIENCE 全空白 → 仍 spawn (CF_AUDIENCE 值不再 gate spawn)', () => {
    appMock.isPackaged = true
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = '   '
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(1)
  })

  test('flag 开 + CF_AUDIENCE 已配 → spawn serve-api (远程经 cloudflared 亦可达)', () => {
    appMock.isPackaged = true
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-real-tag'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(1)
  })

  test('flag=false → 不 spawn serve-api (显式关优先, 即便 CF_AUDIENCE 已配)', () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    process.env.CF_AUDIENCE = 'aud-real-tag'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start()
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(0)
  })
})

describe('restartService — 单独重启 serve-api 不动 serve (Settings 改远程配置用)', () => {
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-test-tag'
  }

  test('restartService(serve-api): 只对 serve-api 发 SIGTERM + re-spawn, serve 进程不动', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager({ stopGraceMs: 1000, ...fastApiOpts() })
    mgr.start()
    const serveChild = childFor('serve')
    const apiChild0 = childFor('serve-api')

    const p = mgr.restartService('serve-api')
    apiChild0.emit('exit', 0, null) // 旧 serve-api 优雅退出
    await p

    // serve 没被 kill (不打断同步批次), serve-api re-spawn 一次。
    expect(serveChild.kill).not.toHaveBeenCalled()
    expect(apiChild0.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnCalls.filter((c) => c.args[0] === 'serve')).toHaveLength(1) // 仅首启
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(2) // 首启 + restart
  })

  test('restartService(serve-api) 在远程访问开关被关 (flag=false) 后 → 停了不再 spawn (gate 重读)', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager({ stopGraceMs: 1000, ...fastApiOpts() })
    mgr.start()
    const apiChild0 = childFor('serve-api')
    // 模拟 Settings 关掉远程访问开关后重启 serve-api (D1: gate 只看此开关, 不看 CF_AUDIENCE)。
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const p = mgr.restartService('serve-api')
    apiChild0.emit('exit', 0, null)
    await p
    // gate 重读 → 不再 spawn; serve-api 停留 stopped。
    expect(spawnCalls.filter((c) => c.args[0] === 'serve-api')).toHaveLength(1) // 仅首启, 无 restart spawn
    expect(mgr.getServiceState('serve-api')).toBe('stopped')
  })

  test('dev 模式 restartService no-op (不 spawn)', async () => {
    appMock.isPackaged = false
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-test-tag'
    const mgr = new BackendLifecycleManager(fastApiOpts())
    mgr.start() // dev: 不 spawn
    await mgr.restartService('serve-api')
    expect(spawnCalls).toHaveLength(0)
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

// ===========================================================================
// C2 — serve-api 崩溃自拉起 (指数退避 re-spawn + crash-loop 断路器)
// ===========================================================================

describe('serve-api 崩溃自拉起 — 退避 re-spawn + 断路器', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  function enableGate() {
    delete process.env.MAILAGENT_REMOTE_ACCESS_ENABLED
    process.env.CF_AUDIENCE = 'aud-test-tag'
  }
  const apiCount = () => spawnCalls.filter((c) => c.args[0] === 'serve-api').length

  test('serve-api 崩溃 (emit exit, 非 stop) → 退避后自动 re-spawn', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [5],
      maxCrashRestarts: 5
    })
    mgr.start()
    expect(apiCount()).toBe(1)
    childFor('serve-api').emit('exit', 1, null) // 崩溃 (非 stop)
    await vi.waitFor(() => expect(apiCount()).toBe(2), { timeout: 500 })
  })

  test('断路器: 连续崩溃达上限 (maxCrashRestarts) 后停止自拉起 (不无限重启)', async () => {
    appMock.isPackaged = true
    enableGate()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [5],
      maxCrashRestarts: 2
    })
    mgr.start() // spawn #1
    // crash #1 → re-spawn #2
    childFor('serve-api').emit('exit', 1, null)
    await vi.waitFor(() => expect(apiCount()).toBe(2), { timeout: 500 })
    // crash #2 → re-spawn #3
    childFor('serve-api').emit('exit', 1, null)
    await vi.waitFor(() => expect(apiCount()).toBe(3), { timeout: 500 })
    // crash #3 → 断路器打开, 不再 re-spawn
    childFor('serve-api').emit('exit', 1, null)
    await sleep(40)
    expect(apiCount()).toBe(3) // 无 #4
  })

  test('崩溃后 ready → 计数清零 (再崩仍有完整退避额度, 不被旧计数提前断路)', async () => {
    appMock.isPackaged = true
    enableGate()
    // re-spawn #2 起 apiProbe 转 true → waitApiReady 标 ready + 清零 restartAttempts。
    const apiProbe = vi.fn(async () => apiCount() >= 2)
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 300,
      apiProbe,
      crashBackoffMs: [5],
      maxCrashRestarts: 1 // 若计数不清零, crash#2 必被断路 (attempts 1>=1)
    })
    mgr.start() // #1
    childFor('serve-api').emit('exit', 1, null) // crash#1 → re-spawn #2 (attempts 0→1)
    await vi.waitFor(() => expect(apiCount()).toBe(2), { timeout: 500 })
    await vi.waitFor(() => expect(mgr.getServiceState('serve-api')).toBe('ready'), { timeout: 500 }) // 清零
    childFor('serve-api').emit('exit', 1, null) // crash#2 (清零后 attempts 0→1) → re-spawn #3
    await vi.waitFor(() => expect(apiCount()).toBe(3), { timeout: 500 })
  })

  test('stop() 取消退避中的 pending re-spawn (停掉后不再拉起)', async () => {
    appMock.isPackaged = true
    enableGate()
    const mgr = new BackendLifecycleManager({
      stopGraceMs: 1000,
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [50], // 较长退避, 留出 stop() 抢先清 timer 的窗口
      maxCrashRestarts: 5
    })
    mgr.start()
    const serveChild = childFor('serve')
    childFor('serve-api').emit('exit', 1, null) // 崩溃 → 排了一个 50ms 后的 re-spawn
    const stopP = mgr.stop() // 退避未到即 stop → 应清掉 restartTimer
    serveChild.emit('exit', 0, null) // serve 优雅退出让 stop 收敛
    await stopP
    await sleep(80) // 越过退避窗口
    expect(apiCount()).toBe(1) // 无第二次 serve-api spawn
  })
})

// ===========================================================================
// memleak-orphan 修复 — serve 纳入崩溃自拉起 + before-quit 等 stop 完成
// ===========================================================================

describe('serve 崩溃自拉起 — 与 serve-api 同一退避 + 断路器 (memleak-orphan 修复)', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const serveCount = () => spawnCalls.filter((c) => c.args[0] === 'serve').length
  // gate off → serve-only lane, 聚焦 serve 的自拉起 (serve-api 不掺和)。

  test('serve 崩溃 (emit exit, 非 stop) → 退避后自动 re-spawn (邮件同步/mem_guard 退出后不再静默死)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [5],
      maxCrashRestarts: 5
    })
    mgr.start()
    expect(serveCount()).toBe(1)
    childFor('serve').emit('exit', 1, null) // 崩溃 (非 stop)
    // 崩溃瞬间~re-spawn 前的窗口: failed (waitReady 若命中此窗口快速 false 是接受的取舍)。
    expect(mgr.getServiceState('serve')).toBe('failed')
    await vi.waitFor(() => expect(serveCount()).toBe(2), { timeout: 500 })
    // 🔴 getState 聚合硬约束: 自拉起 re-spawn 把 serve 置回 starting → 聚合恒 starting
    // (onboarding 靠 getState()==='failed' 区分真崩 vs 慢迁移, 自拉起期间不得误报 failed)。
    expect(mgr.getServiceState('serve')).toBe('starting')
    expect(mgr.getState()).toBe('starting')
  })

  test('断路器: serve 连续崩溃达上限 (maxCrashRestarts) 后停止自拉起, 停在 failed', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [5],
      maxCrashRestarts: 2
    })
    mgr.start() // spawn #1
    childFor('serve').emit('exit', 1, null) // crash#1 → re-spawn #2
    await vi.waitFor(() => expect(serveCount()).toBe(2), { timeout: 500 })
    childFor('serve').emit('exit', 1, null) // crash#2 → re-spawn #3
    await vi.waitFor(() => expect(serveCount()).toBe(3), { timeout: 500 })
    childFor('serve').emit('exit', 1, null) // crash#3 → 断路器打开, 不再 re-spawn
    await sleep(40)
    expect(serveCount()).toBe(3) // 无 #4
    expect(mgr.getServiceState('serve')).toBe('failed')
    expect(mgr.getState()).toBe('failed') // 断路器打开后正确停在 failed (onboarding 可见真崩)
  })

  test('waitReady 标 ready → serve 崩溃计数清零 (再崩仍有完整退避额度, 不被旧计数提前断路)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      pollIntervalMs: 1,
      readyTimeoutMs: 1000,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [5],
      maxCrashRestarts: 1 // 若计数不清零, crash#2 必被断路 (attempts 1>=1)
    })
    mgr.start() // #1
    childFor('serve').emit('exit', 1, null) // crash#1 (attempts 0→1) → re-spawn #2
    await vi.waitFor(() => expect(serveCount()).toBe(2), { timeout: 500 })
    await expect(mgr.waitReady(() => readyResult())).resolves.toBe(true) // ready → 清零
    expect(mgr.getServiceState('serve')).toBe('ready')
    childFor('serve').emit('exit', 1, null) // crash#2 (清零后 0→1, 不被断路) → re-spawn #3
    await vi.waitFor(() => expect(serveCount()).toBe(3), { timeout: 500 })
  })

  test('stop() 取消退避中的 serve pending re-spawn (退出后不再拉起)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = new BackendLifecycleManager({
      stopGraceMs: 1000,
      pollIntervalMs: 1,
      apiReadyTimeoutMs: 5,
      apiProbe: neverReadyApiProbe(),
      crashBackoffMs: [50], // 较长退避, 留出 stop() 抢先清 timer 的窗口
      maxCrashRestarts: 5
    })
    mgr.start()
    childFor('serve').emit('exit', 1, null) // 崩溃 → 排了一个 50ms 后的 re-spawn
    await mgr.stop() // serve child 已 null (崩溃清掉) → stop 立即收敛, 同时清 restartTimer
    await sleep(80) // 越过退避窗口
    expect(serveCount()).toBe(1) // 无第二次 serve spawn
  })
})

describe('registerBackendQuitHook — before-quit 等 stop 完成 (SIGKILL 升级链 / 孤儿进程修复)', () => {
  type QuitEvent = { preventDefault: ReturnType<typeof vi.fn> }
  /** 取最近一次注册的 before-quit handler (每个测试 reset 后重新注册, 绑定当前单例 mgr)。 */
  function lastBeforeQuitHandler(): (event: QuitEvent) => void {
    const calls = appMock.on.mock.calls.filter((c) => c[0] === 'before-quit')
    expect(calls.length).toBeGreaterThan(0)
    return calls[calls.length - 1][1] as (event: QuitEvent) => void
  }

  test('打包态首次 before-quit: preventDefault + stop 被调; settle 后 app.quit 放行 (不再拦截)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false' // serve-only
    const mgr = registerBackendQuitHook()
    mgr.start()
    const serveChild = childFor('serve')
    const handler = lastBeforeQuitHandler()

    const event = { preventDefault: vi.fn() }
    handler(event)
    // 🔴 必须 preventDefault + 等 stop: 旧 fire-and-forget 下 SIGTERM 发出后 main 立即
    // 退出 → 5s grace 后的 SIGKILL 升级永不执行 → 17GB 孤儿进程 (生产事故)。
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(serveChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(appMock.quit).not.toHaveBeenCalled() // stop 未 settle → 还不放行

    serveChild.emit('exit', 0, null) // 后端优雅退出 → stop settle
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalledTimes(1))

    // stop 完成后的 before-quit (app.quit() 重新触发的那次) → 放行, 不再 preventDefault。
    const event2 = { preventDefault: vi.fn() }
    handler(event2)
    expect(event2.preventDefault).not.toHaveBeenCalled()
  })

  test('重复 before-quit (连按 Cmd+Q): 共享同一 stop promise, 不重复调度 stop()', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const mgr = registerBackendQuitHook()
    mgr.start()
    const serveChild = childFor('serve')
    const handler = lastBeforeQuitHandler()
    const stopSpy = vi.spyOn(mgr, 'stop')

    handler({ preventDefault: vi.fn() })
    const event2 = { preventDefault: vi.fn() }
    handler(event2) // stop settle 前再按一次 Cmd+Q
    expect(event2.preventDefault).toHaveBeenCalledTimes(1) // 仍拦截
    expect(stopSpy).toHaveBeenCalledTimes(1) // 但不重复调度

    serveChild.emit('exit', 0, null)
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalledTimes(1)) // quit 也只补发一次
  })

  test('stop() 拒绝 (异常) → 记日志 + 仍放行 quit (退出绝不被错误卡死)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = registerBackendQuitHook()
    // Once: 首次 before-quit 的 stop() 炸; 放行后补发 quit 触发的二次 handler 里
    // `void mgr.stop()` 落回真实实现 (无 child → 立即收敛), 不留 unhandled rejection。
    vi.spyOn(mgr, 'stop').mockRejectedValueOnce(new Error('boom'))
    const handler = lastBeforeQuitHandler()

    const event = { preventDefault: vi.fn() }
    handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(appMock.quit).toHaveBeenCalledTimes(1)) // 拒绝也放行
    expect(errSpy).toHaveBeenCalled() // 不吞错: 失败留日志

    // 放行后的 before-quit → 不再拦截 (失败也算"停妥", 不能反复拦截卡死退出)。
    const event2 = { preventDefault: vi.fn() }
    handler(event2)
    expect(event2.preventDefault).not.toHaveBeenCalled()
  })

  test('stop() hang (永不 settle) → 10s 硬上限后仍放行 quit (最后防线)', async () => {
    appMock.isPackaged = true
    process.env.MAILAGENT_REMOTE_ACCESS_ENABLED = 'false'
    vi.useFakeTimers()
    try {
      const mgr = registerBackendQuitHook()
      vi.spyOn(mgr, 'stop').mockReturnValue(new Promise<void>(() => {})) // 永不 settle
      const handler = lastBeforeQuitHandler()
      const event = { preventDefault: vi.fn() }
      handler(event)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(appMock.quit).not.toHaveBeenCalled()
      // 9.9s: 硬上限未到 → 仍在等 stop (不提前放行)。
      await vi.advanceTimersByTimeAsync(9_900)
      expect(appMock.quit).not.toHaveBeenCalled()
      // 满 10s (QUIT_STOP_HARD_CAP_MS) → hardCap 赢下 race → 放行 quit。
      await vi.advanceTimersByTimeAsync(100)
      expect(appMock.quit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('dev 模式 (isManaged=false): 不 preventDefault, 行为与旧版零变更', () => {
    appMock.isPackaged = false
    const mgr = registerBackendQuitHook()
    mgr.start() // dev: 不 spawn
    expect(mgr.isManaged()).toBe(false)
    const handler = lastBeforeQuitHandler()
    const event = { preventDefault: vi.fn() }
    handler(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(appMock.quit).not.toHaveBeenCalled()
    expect(spawnCalls).toHaveLength(0)
  })
})
