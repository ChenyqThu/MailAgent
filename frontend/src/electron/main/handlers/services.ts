// Sprint 18 §PR B — services:restart / services:status IPC.
//
// `.env` writes via env:set don't take effect until Python services restart
// (config.py uses pydantic BaseSettings, single import-time read, no
// SIGHUP path). After every env:set returning restartRequired=true the
// renderer surfaces a banner with "立即重启" → confirm → services:restart
// IPC, which spawns `pm2 restart mail-sync` against the resolved pm2 binary.
//
// pm2 resolution order:
//   1. whichSync('pm2') via @shared/electron/main/bin_resolver — handles
//      Electron's launchd PATH gap (the GUI process doesn't inherit shell
//      PATH so global npm bins aren't visible unless we resolve manually).
//   2. /opt/homebrew/bin/pm2 (Apple Silicon Homebrew default)
//   3. /usr/local/bin/pm2 (Intel Homebrew + system-wide installs)
// Missing in all 3 → E_PM2_NOT_FOUND, renderer toasts a fallback
// "在终端运行: pm2 restart mail-sync" hint with the resolved repo root.
//
// `services:status` exists so RestartBanner can poll right after restart to
// confirm `mail-sync` is online before showing the success toast — exit code
// 0 from `pm2 restart` doesn't guarantee the Python process actually came up
// (it may exit-1 on a broken `.env`).

import { execa } from 'execa'
import { app, ipcMain } from 'electron'
import { existsSync } from 'fs'

import { getBackendLifecycle, type ServiceName } from '../backend_lifecycle'
import { whichSync } from '../bin_resolver'
import { getProjectRoot } from '../cli_runner'

type ServiceTarget = 'mail-sync' | 'calendar-sync' | 'all' | 'serve-api'

export interface ServiceRestartResult {
  ok: boolean
  target: string
  exitCode: number | null
  stdout: string
  stderr: string
  error?: {
    code: 'E_PM2_NOT_FOUND' | 'E_PM2_FAILED' | 'E_TIMEOUT' | 'E_INVALID_ARG'
    message: string
    /** Set when E_PM2_NOT_FOUND so the renderer can show the exact command
     *  in a toast detail field. */
    fallbackCommand?: string
  }
}

export interface ServiceStatus {
  name: 'mail-sync' | 'calendar-sync'
  state: 'online' | 'stopped' | 'errored' | 'unknown'
  pid: number | null
  uptimeMs: number | null
  cpu: number | null
  memMB: number | null
}

const VALID_TARGETS: ReadonlySet<ServiceTarget> = new Set([
  'mail-sync',
  'calendar-sync',
  'all',
  'serve-api'
])

/** pm2 path resolver. Caches on first successful resolution. */
let _pm2Cache: string | null = null
function resolvePm2(): string | null {
  if (_pm2Cache !== null) return _pm2Cache
  const override = process.env['MAILAGENT_PM2_BIN']
  if (override && existsSync(override)) {
    _pm2Cache = override
    return _pm2Cache
  }
  const found = whichSync('pm2', { nothrow: true })
  if (found) {
    _pm2Cache = found
    return _pm2Cache
  }
  for (const candidate of ['/opt/homebrew/bin/pm2', '/usr/local/bin/pm2']) {
    if (existsSync(candidate)) {
      _pm2Cache = candidate
      return _pm2Cache
    }
  }
  return null
}

async function restartTarget(target: ServiceTarget): Promise<ServiceRestartResult> {
  if (!VALID_TARGETS.has(target)) {
    return {
      ok: false,
      target,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: {
        code: 'E_INVALID_ARG',
        message: `services:restart: invalid target "${target}"`
      }
    }
  }

  // blocker B 修复: 打包态无 pm2 — 把 restart 分流到 BackendLifecycleManager。
  // mail-sync→'serve'(主同步), serve-api→'serve-api'(远程后端)。restartService() 会
  // stop + 重读 enabled gate(从被 env:set 同步过的 process.env, 见 blocker A) + respawn,
  // 让 Settings 改的开关/端口/CF 热生效, 不必重启整个 app。calendar-sync/all 是
  // dev-pm2 概念, 打包态无对应 → 继续走下面 pm2 路径(E_PM2_NOT_FOUND, renderer 兜底)。
  if (app.isPackaged && (target === 'mail-sync' || target === 'serve-api')) {
    const svcName: ServiceName = target === 'serve-api' ? 'serve-api' : 'serve'
    try {
      await getBackendLifecycle().restartService(svcName)
      return { ok: true, target, exitCode: 0, stdout: '', stderr: '' }
    } catch (err) {
      return {
        ok: false,
        target,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: {
          code: 'E_PM2_FAILED',
          message: `BackendLifecycle restartService('${svcName}') failed: ${(err as Error).message}`
        }
      }
    }
  }

  const pm2Path = resolvePm2()
  if (pm2Path === null) {
    return {
      ok: false,
      target,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: {
        code: 'E_PM2_NOT_FOUND',
        message:
          'pm2 binary not found. Install pm2 globally (npm i -g pm2) or set $MAILAGENT_PM2_BIN.',
        fallbackCommand: `cd ${getProjectRoot()} && pm2 restart ${target}`
      }
    }
  }

  try {
    const result = await execa(pm2Path, ['restart', target], {
      cwd: getProjectRoot(),
      timeout: 20_000,
      reject: false,
      env: { ...process.env }
    })

    if (result.timedOut) {
      return {
        ok: false,
        target,
        exitCode: result.exitCode ?? null,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        error: {
          code: 'E_TIMEOUT',
          message: `pm2 restart ${target} exceeded 20s timeout`
        }
      }
    }

    const ok = result.exitCode === 0
    return {
      ok,
      target,
      exitCode: result.exitCode ?? null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      error: ok
        ? undefined
        : {
            code: 'E_PM2_FAILED',
            message: `pm2 restart ${target} exit=${result.exitCode}`
          }
    }
  } catch (err) {
    const message = (err as Error).message
    return {
      ok: false,
      target,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: { code: 'E_PM2_FAILED', message }
    }
  }
}

interface Pm2JlistRow {
  name?: string
  pid?: number
  pm2_env?: {
    status?: string
    pm_uptime?: number
  }
  monit?: {
    cpu?: number
    memory?: number
  }
}

function statusFromRow(row: Pm2JlistRow): ServiceStatus {
  const stateRaw = row.pm2_env?.status ?? 'unknown'
  let state: ServiceStatus['state'] = 'unknown'
  if (stateRaw === 'online') state = 'online'
  else if (stateRaw === 'stopped' || stateRaw === 'stopping') state = 'stopped'
  else if (stateRaw === 'errored' || stateRaw === 'one-launch-status') state = 'errored'

  const startedAt = row.pm2_env?.pm_uptime ?? null
  const uptimeMs = startedAt !== null && state === 'online' ? Date.now() - startedAt : null

  const name =
    row.name === 'calendar-sync' ? 'calendar-sync' : ('mail-sync' as ServiceStatus['name'])

  return {
    name,
    state,
    pid: typeof row.pid === 'number' && row.pid > 0 ? row.pid : null,
    uptimeMs,
    cpu: row.monit?.cpu ?? null,
    memMB: row.monit?.memory ? Math.round((row.monit.memory / (1024 * 1024)) * 10) / 10 : null
  }
}

async function listStatuses(): Promise<ServiceStatus[]> {
  const pm2Path = resolvePm2()
  if (pm2Path === null) {
    return [
      { name: 'mail-sync', state: 'unknown', pid: null, uptimeMs: null, cpu: null, memMB: null },
      {
        name: 'calendar-sync',
        state: 'unknown',
        pid: null,
        uptimeMs: null,
        cpu: null,
        memMB: null
      }
    ]
  }

  try {
    const result = await execa(pm2Path, ['jlist'], {
      timeout: 5_000,
      reject: false,
      env: { ...process.env }
    })
    if (result.exitCode !== 0) {
      return [
        {
          name: 'mail-sync',
          state: 'unknown',
          pid: null,
          uptimeMs: null,
          cpu: null,
          memMB: null
        },
        {
          name: 'calendar-sync',
          state: 'unknown',
          pid: null,
          uptimeMs: null,
          cpu: null,
          memMB: null
        }
      ]
    }
    const rows = JSON.parse(String(result.stdout)) as Pm2JlistRow[]
    const known = new Set<string>(['mail-sync', 'calendar-sync'])
    const out: ServiceStatus[] = []
    for (const row of rows) {
      if (row.name && known.has(row.name)) out.push(statusFromRow(row))
    }
    // Ensure both entries exist even if pm2 doesn't have them yet.
    for (const name of ['mail-sync', 'calendar-sync'] as const) {
      if (!out.find((s) => s.name === name)) {
        out.push({ name, state: 'unknown', pid: null, uptimeMs: null, cpu: null, memMB: null })
      }
    }
    return out
  } catch {
    return [
      { name: 'mail-sync', state: 'unknown', pid: null, uptimeMs: null, cpu: null, memMB: null },
      {
        name: 'calendar-sync',
        state: 'unknown',
        pid: null,
        uptimeMs: null,
        cpu: null,
        memMB: null
      }
    ]
  }
}

export function registerServicesHandlers(): void {
  ipcMain.handle(
    'services:restart',
    async (_event, target?: ServiceTarget): Promise<ServiceRestartResult> =>
      restartTarget(target ?? 'mail-sync')
  )
  ipcMain.handle('services:status', async (): Promise<ServiceStatus[]> => listStatuses())
}

// Vitest entry points (no IPC).
export const __test__ = { restartTarget, listStatuses, resolvePm2 }
