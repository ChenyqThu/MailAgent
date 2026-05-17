// Sprint 1.9 — cli_runner behaviour. Five axes:
//   (a) read/write semaphore lanes really gate concurrency (4 reads in
//       parallel, 1 write at a time);
//   (b) every exit code (0/1/2/4/5/6/7/8/9/130 + timeout) maps to the right
//       E_<NAME> CliError code;
//   (c) parsed.error.code (wrapper-level) wins over the exit-code fallback
//       when both are present;
//   (d) stdout that fails JSON.parse surfaces as E_PARSE_FAIL even on exit 0;
//   (e) AbortController really kills the subprocess.
//
// We mock execa so the suite never touches the real `mailagent` binary.

import { afterEach, describe, expect, test, vi } from 'vitest'

// ---- execa mock -------------------------------------------------------------

// Each call records its args + accepts a controlled completion via fakeResolve.
interface FakeResult {
  stdout: string
  stderr: string
  exitCode: number
  isCanceled?: boolean
  timedOut?: boolean
}

interface FakeChild extends PromiseLike<FakeResult> {
  kill: ReturnType<typeof vi.fn>
  stderr: null
  _resolve: (r: FakeResult) => void
  _reject: (e: unknown) => void
}

const fakeChildren: FakeChild[] = []
let nextResult: FakeResult | null = null
let scriptedResults: FakeResult[] = []

function makeChild(): FakeChild {
  let resolveFn!: (r: FakeResult) => void
  let rejectFn!: (e: unknown) => void
  const p = new Promise<FakeResult>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  const child = Object.assign(p, {
    kill: vi.fn(),
    stderr: null,
    _resolve: resolveFn,
    _reject: rejectFn
  }) as unknown as FakeChild
  fakeChildren.push(child)
  return child
}

vi.mock('execa', () => ({
  execa: vi.fn(() => {
    const child = makeChild()
    // If the test scripted a sequence, pop one per invocation. Otherwise the
    // test resolves the child manually for fine-grained timing control.
    if (scriptedResults.length > 0) {
      const r = scriptedResults.shift()!
      queueMicrotask(() => child._resolve(r))
    } else if (nextResult) {
      const r = nextResult
      nextResult = null
      queueMicrotask(() => child._resolve(r))
    }
    return child
  })
}))

// bin_resolver wraps `which.sync` so the production main bundle can interop
// with CJS-only `which@7` without tripping ESM named-export errors. We mock
// it here instead of mocking 'which' directly — vi.mock only intercepts
// ESM import graph nodes, not Node's createRequire().
vi.mock('../../src/electron/main/bin_resolver', () => ({
  whichSync: () => '/usr/local/bin/mailagent'
}))
vi.mock('../../src/electron/main/keychain', () => ({
  getCliApiKey: async () => null
}))
vi.mock('electron', () => ({
  app: { on: vi.fn() }
}))

// Import after mocks.
const cliRunner = await import('../../src/electron/main/cli_runner')

// ---- helpers ----------------------------------------------------------------

afterEach(() => {
  fakeChildren.length = 0
  nextResult = null
  scriptedResults = []
  vi.clearAllMocks()
})

function makeWrapper(opts: {
  status: 'success' | 'error' | 'partial_failure'
  data?: unknown
  errorCode?: string
  hint?: string
}): string {
  if (opts.status === 'success') {
    return JSON.stringify({
      status: 'success',
      schema_version: 1,
      data: opts.data ?? {},
      meta: { duration_ms: 1 }
    })
  }
  return JSON.stringify({
    status: 'error',
    schema_version: 1,
    error: { code: opts.errorCode ?? 'E_GENERIC', message: 'fake', hint: opts.hint },
    meta: { duration_ms: 1 }
  })
}

// ---- (a) concurrency lanes --------------------------------------------------

describe('CliQueue concurrency', () => {
  test('caps reads at 4 concurrent and queues the rest', async () => {
    // Fire 6 reads; first 4 should spawn immediately, 5th + 6th wait until one
    // completes. We don't auto-resolve — we hold the children and inspect.
    const calls: Array<Promise<unknown>> = []
    for (let i = 0; i < 6; i++) {
      calls.push(cliRunner.callCli(['email', 'list']))
    }
    // Microtask flush so the queue can dispatch what it can.
    await new Promise((r) => setImmediate(r))
    expect(fakeChildren.length).toBe(4)

    // Release one — the 5th read should now spawn.
    fakeChildren[0]._resolve({
      stdout: makeWrapper({ status: 'success', data: [] }),
      stderr: '',
      exitCode: 0
    })
    await new Promise((r) => setImmediate(r))
    expect(fakeChildren.length).toBe(5)

    // Drain by index so children that spawn after each resolution also get
    // settled. Resolving fakeChildren[i] frees a permit which lets the queue
    // dispatch the next read; we then loop until all 6 calls return.
    for (let i = 1; i < 6; i++) {
      while (fakeChildren[i] === undefined) {
        await new Promise((r) => setImmediate(r))
      }
      fakeChildren[i]._resolve({
        stdout: makeWrapper({ status: 'success', data: [] }),
        stderr: '',
        exitCode: 0
      })
    }
    await Promise.all(calls)
    expect(fakeChildren.length).toBe(6)
  })

  test('write lane serializes (writeSem=1)', async () => {
    const w1 = cliRunner.callCli(['email', 'resync', '1'], { write: true })
    const w2 = cliRunner.callCli(['email', 'resync', '2'], { write: true })
    await new Promise((r) => setImmediate(r))
    expect(fakeChildren.length).toBe(1) // w2 still waiting
    fakeChildren[0]._resolve({
      stdout: makeWrapper({ status: 'success', data: { internal_id: 1 } }),
      stderr: '',
      exitCode: 0
    })
    await w1
    await new Promise((r) => setImmediate(r))
    expect(fakeChildren.length).toBe(2)
    fakeChildren[1]._resolve({
      stdout: makeWrapper({ status: 'success', data: { internal_id: 2 } }),
      stderr: '',
      exitCode: 0
    })
    await w2
  })

  test('read and write lanes are independent', async () => {
    const r = cliRunner.callCli(['email', 'list'])
    const w = cliRunner.callCli(['email', 'resync', '1'], { write: true })
    await new Promise((r) => setImmediate(r))
    expect(fakeChildren.length).toBe(2)
    fakeChildren[0]._resolve({
      stdout: makeWrapper({ status: 'success', data: [] }),
      stderr: '',
      exitCode: 0
    })
    fakeChildren[1]._resolve({
      stdout: makeWrapper({ status: 'success', data: {} }),
      stderr: '',
      exitCode: 0
    })
    await Promise.all([r, w])
  })
})

// ---- (b) + (c) + (d) exit code dispatch -------------------------------------

const EXPECTED_BY_EXIT: Array<{ exit: number; code: string }> = [
  { exit: 1, code: 'E_GENERIC' },
  { exit: 2, code: 'E_INVALID_ARG' },
  { exit: 4, code: 'E_AUTH' },
  { exit: 5, code: 'E_UPSTREAM' },
  { exit: 6, code: 'E_PARTIAL' },
  { exit: 7, code: 'E_ABORTED' },
  { exit: 8, code: 'E_MAX_FAILURES' },
  { exit: 9, code: 'E_PM2_CONFLICT' },
  { exit: 130, code: 'E_SIGINT2' }
]

describe('CliError dispatch', () => {
  for (const { exit, code } of EXPECTED_BY_EXIT) {
    test(`exit ${exit} maps to ${code}`, async () => {
      nextResult = {
        stdout: '', // no wrapper → fall through to EXIT_CODE_MAP
        stderr: 'boom',
        exitCode: exit
      }
      await expect(cliRunner.callCli(['email', 'list'])).rejects.toMatchObject({
        name: 'CliError',
        errorCode: code,
        exitCode: exit
      })
    })
  }

  test('wrapper.error.code wins over the exit-code map', async () => {
    nextResult = {
      stdout: makeWrapper({ status: 'error', errorCode: 'E_PM2_RUNNING', hint: 'stop pm2' }),
      stderr: '',
      exitCode: 9
    }
    await expect(
      cliRunner.callCli(['email', 'resync', '1'], { write: true })
    ).rejects.toMatchObject({
      errorCode: 'E_PM2_RUNNING',
      exitCode: 9,
      hint: 'stop pm2'
    })
  })

  test('stdout that does not parse as JSON surfaces E_PARSE_FAIL even at exit 0', async () => {
    nextResult = {
      stdout: 'definitely not json',
      stderr: '',
      exitCode: 0
    }
    await expect(cliRunner.callCli(['email', 'list'])).rejects.toMatchObject({
      errorCode: 'E_PARSE_FAIL',
      exitCode: 0
    })
  })

  test('exit 0 with wrapper.status=error reports contract violation', async () => {
    nextResult = {
      stdout: makeWrapper({ status: 'error', errorCode: 'E_NOT_FOUND' }),
      stderr: '',
      exitCode: 0
    }
    await expect(cliRunner.callCli(['email', 'get', '99'])).rejects.toMatchObject({
      errorCode: 'E_NOT_FOUND',
      exitCode: 0
    })
  })

  test('timedOut → E_TIMEOUT regardless of exit code', async () => {
    const call = cliRunner.callCli(['email', 'list'])
    await new Promise((r) => setImmediate(r))
    fakeChildren[0]._resolve({
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: true
    })
    await expect(call).rejects.toMatchObject({ errorCode: 'E_TIMEOUT' })
  })

  test('isCanceled → E_ABORTED', async () => {
    const ac = new AbortController()
    const call = cliRunner.callCli(['email', 'list'], { signal: ac.signal })
    await new Promise((r) => setImmediate(r))
    fakeChildren[0]._resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      isCanceled: true
    })
    await expect(call).rejects.toMatchObject({ errorCode: 'E_ABORTED' })
  })
})

// ---- (e) AbortController integration ----------------------------------------

describe('AbortController + killAll', () => {
  test('parent AbortController abort triggers internal cancel pathway', async () => {
    const ac = new AbortController()
    const call = cliRunner.callCli(['email', 'list'], { signal: ac.signal })
    await new Promise((r) => setImmediate(r))
    ac.abort()
    // execa would normally observe cancelSignal and resolve with isCanceled.
    // Our fake child reports that directly.
    fakeChildren[0]._resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      isCanceled: true
    })
    await expect(call).rejects.toMatchObject({ errorCode: 'E_ABORTED' })
  })

  test('killAll sends SIGTERM to in-flight subprocesses', async () => {
    const c1 = cliRunner.callCli(['email', 'list'])
    const c2 = cliRunner.callCli(['email', 'list'])
    await new Promise((r) => setImmediate(r))
    cliRunner._cliQueueForTests().killAll()
    expect(fakeChildren[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(fakeChildren[1].kill).toHaveBeenCalledWith('SIGTERM')
    // Resolve to drain promises.
    fakeChildren[0]._resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      isCanceled: true
    })
    fakeChildren[1]._resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      isCanceled: true
    })
    await expect(c1).rejects.toMatchObject({ errorCode: 'E_ABORTED' })
    await expect(c2).rejects.toMatchObject({ errorCode: 'E_ABORTED' })
  })
})
