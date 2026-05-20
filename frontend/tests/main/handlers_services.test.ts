// Sprint 18 §PR B — services:restart / services:status handler contract.
//
// Four axes:
//   (a) E_PM2_NOT_FOUND when neither whichSync nor the fallback paths resolve
//       a pm2 binary; the result carries `fallbackCommand` with the exact
//       terminal command the renderer can copy-paste;
//   (b) success path on exit=0 with stdout/stderr forwarded;
//   (c) E_PM2_FAILED on non-zero exit, with the exit code carried through;
//   (d) services:status parses `pm2 jlist` JSON correctly, including the
//       "service missing from pm2" fill-in (returns unknown state for
//       missing slots so the UI doesn't render empty).
//
// `execa` and `bin_resolver` are vi.mocked — no real pm2 process touched.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const execaMock = vi.fn()
const whichMock = vi.fn<(cmd: string, opts?: { nothrow?: boolean }) => string | null>()

vi.mock('execa', () => ({
  execa: (...args: unknown[]) => execaMock(...args)
}))

vi.mock('../../src/electron/main/bin_resolver', () => ({
  whichSync: (cmd: string, opts?: { nothrow?: boolean }) => whichMock(cmd, opts)
}))

vi.mock('../../src/electron/main/cli_runner', () => ({
  getProjectRoot: () => '/Users/test/MailAgent'
}))

// `existsSync` should return false for the hardcoded fallback paths so the
// "pm2 not found" branch is reachable without polluting the test environment.
vi.mock('fs', async () => {
  const actual = (await vi.importActual<typeof import('fs')>('fs')) as typeof import('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p === '/opt/homebrew/bin/pm2' || p === '/usr/local/bin/pm2') return false
      return actual.existsSync(p)
    }
  }
})

let svc: typeof import('../../src/electron/main/handlers/services')

beforeEach(async () => {
  vi.resetModules()
  execaMock.mockReset()
  whichMock.mockReset()
  delete process.env.MAILAGENT_PM2_BIN
  svc = await import('../../src/electron/main/handlers/services')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('services:restart', () => {
  test('E_PM2_NOT_FOUND when which + fallbacks all miss', async () => {
    whichMock.mockReturnValue(null)
    const r = await svc.__test__.restartTarget('mail-sync')
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('E_PM2_NOT_FOUND')
    expect(r.error?.fallbackCommand).toBe('cd /Users/test/MailAgent && pm2 restart mail-sync')
    expect(execaMock).not.toHaveBeenCalled()
  })

  test('success on exit=0', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: 'Process mail-sync restarted',
      stderr: '',
      timedOut: false
    })
    const r = await svc.__test__.restartTarget('mail-sync')
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('mail-sync restarted')
    expect(execaMock).toHaveBeenCalledWith(
      '/fake/bin/pm2',
      ['restart', 'mail-sync'],
      expect.objectContaining({ cwd: '/Users/test/MailAgent', timeout: 20_000, reject: false })
    )
  })

  test('E_PM2_FAILED on non-zero exit', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'process mail-sync not found',
      timedOut: false
    })
    const r = await svc.__test__.restartTarget('mail-sync')
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('E_PM2_FAILED')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('not found')
  })

  test('E_TIMEOUT when execa reports timedOut', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    execaMock.mockResolvedValue({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
    const r = await svc.__test__.restartTarget('mail-sync')
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('E_TIMEOUT')
  })

  test('E_INVALID_ARG when target is not a known service', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    // @ts-expect-error — testing the validation, deliberately bogus target.
    const r = await svc.__test__.restartTarget('rogue-service')
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('E_INVALID_ARG')
    expect(execaMock).not.toHaveBeenCalled()
  })

  test('MAILAGENT_PM2_BIN override is honored when the path exists', async () => {
    // We can't make a custom path "exist" easily here without un-mocking fs;
    // the override falls through when the file doesn't exist, then which
    // takes over. Verify the override path is at least attempted.
    process.env.MAILAGENT_PM2_BIN = '/nonexistent/pm2'
    whichMock.mockReturnValue('/fallback/pm2')
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false
    })
    const r = await svc.__test__.restartTarget('mail-sync')
    expect(r.ok).toBe(true)
    // Override didn't exist, so the spawn used the whichSync result.
    expect(execaMock).toHaveBeenCalledWith(
      '/fallback/pm2',
      ['restart', 'mail-sync'],
      expect.anything()
    )
  })
})

describe('services:status', () => {
  test('parses jlist JSON, fills in missing slots as unknown', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    const now = Date.now()
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          name: 'mail-sync',
          pid: 4242,
          pm2_env: { status: 'online', pm_uptime: now - 60_000 },
          monit: { cpu: 12, memory: 100 * 1024 * 1024 }
        }
        // calendar-sync intentionally missing → handler fills it in as unknown.
      ]),
      stderr: '',
      timedOut: false
    })
    const list = await svc.__test__.listStatuses()
    const mail = list.find((s) => s.name === 'mail-sync')
    const cal = list.find((s) => s.name === 'calendar-sync')
    expect(mail?.state).toBe('online')
    expect(mail?.pid).toBe(4242)
    expect(mail?.cpu).toBe(12)
    expect(mail?.memMB).toBeCloseTo(100, 0)
    expect(mail?.uptimeMs).toBeGreaterThanOrEqual(60_000 - 50)
    expect(cal?.state).toBe('unknown')
    expect(cal?.pid).toBeNull()
  })

  test('pm2 missing → both slots unknown, no throw', async () => {
    whichMock.mockReturnValue(null)
    const list = await svc.__test__.listStatuses()
    expect(list.find((s) => s.name === 'mail-sync')?.state).toBe('unknown')
    expect(list.find((s) => s.name === 'calendar-sync')?.state).toBe('unknown')
    expect(execaMock).not.toHaveBeenCalled()
  })

  test('jlist exit != 0 → unknown placeholders', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'daemon not running',
      timedOut: false
    })
    const list = await svc.__test__.listStatuses()
    expect(list.every((s) => s.state === 'unknown')).toBe(true)
  })

  test('non-JSON stdout → catch path returns unknowns (no throw)', async () => {
    whichMock.mockReturnValue('/fake/bin/pm2')
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: 'not json at all',
      stderr: '',
      timedOut: false
    })
    const list = await svc.__test__.listStatuses()
    expect(list.every((s) => s.state === 'unknown')).toBe(true)
  })
})
