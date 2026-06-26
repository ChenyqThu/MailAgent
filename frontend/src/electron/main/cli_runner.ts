// REVIEW-LOG C-02 / H-06 / H-07 — `mailagent` CLI subprocess runner.
//
// Why this file is non-trivial:
//   - execa() default rejects on non-zero exit, so the original
//     `if (exitCode !== 0) throw` branch was unreachable (we set reject:false).
//   - catch must dispatch all 11 exit codes (0/1/2/4/5/6/7/8/9/130 + timeout),
//     not just the 9 (PM2 conflict) the first draft handled.
//   - stdout is the JSON channel; stderr is the log channel — never mix
//     `JSON.parse(stdout)` with stream forwarding on the same buffer.
//   - SQLite WAL is single-writer; readers don't block, so we cap reads at 4
//     parallel and writes at 1, matching the engine's natural concurrency.
//   - macOS Spotlight grabbing the venv on first invocation adds ~1s — we
//     `which mailagent` once at module load and store the absolute path.
//   - `app.before-quit` MUST kill in-flight children, otherwise we orphan
//     `mailagent` processes when the user closes the window mid-call.
//
// Long-lived spawn (backfill / batch-resync with streamed stdout) is **not**
// this file's job — that uses raw `spawn()` + checkpoint resume in Sprint 5.
// Here we cover the ≤60s request-response shape only.

import { execa, type ResultPromise, type Result } from 'execa'
import { app } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { resolveDataRoot, resolveDbPath } from './db'

// Packaging P1-3 — 打包模式下嵌入式 python 的 `mailagent` 在 .app bundle 的
// Resources/python/bin 下 (electron-builder extraResources 注入)。
// 与 02-landing-plan.md §3.3 的布局对齐。dev 模式不走这条, 见 getMailagentBin。
// 打包布局: extraResources 把 build-python-venv.sh 产出的 standalone CPython 注入到
// <Resources>/python/。bin/mailagent 是自定位 sh wrapper (python3.11 -P -c …), 直接
// execa(bin, args) 即可, 无需前端拼解释器路径 (wrapper 内部处理 shebang + cwd 遮蔽)。
const PACKAGED_BIN_REL = ['python', 'bin', 'mailagent']

import { Semaphore } from './sem'
import { getCliApiKey } from './keychain'
import { whichSync } from './bin_resolver'

// Resolved lazily on first call. The CLI is shipped by `pip install -e .[cli]`
// (project CLAUDE.md "CLI" section). Electron's GUI process inherits launchd
// PATH (not the user shell's PATH), so the project's `venv/bin/mailagent`
// isn't visible to `which`. Resolution order:
//   1. $MAILAGENT_BIN (explicit override)
//   2. <projectRoot>/venv/bin/mailagent — derived from db.ts's
//      `~/Documents/MailAgent/...` default, matching the dev layout
//   3. PATH lookup via `which`
let _binCache: string | null = null

function projectVenvBin(): string {
  // Mirror db.ts's project-root default; users following the README clone
  // into ~/Documents/MailAgent and `pip install -e .[cli]` lands the CLI
  // under venv/bin. Override via MAILAGENT_BIN for any non-default layout.
  return join(homedir(), 'Documents', 'MailAgent', 'venv', 'bin', 'mailagent')
}

/** Packaging P1-3 — 打包模式 (`app.isPackaged`) 下 CLI 的默认路径:
 *  `<Resources>/python/bin/mailagent` (嵌入式 python, electron-builder
 *  extraResources 注入)。仅在打包模式调用; dev 模式始终走 projectVenvBin()
 *  以保证现有开发行为零变更。 */
function packagedResourcesBin(): string {
  return join(process.resourcesPath, ...PACKAGED_BIN_REL)
}

/** Project root for the CLI's working directory — the path that contains
 *  `.env`, which pydantic's BaseSettings reads at import time. Same default
 *  layout as `projectVenvBin()` / db.ts; override via $MAILAGENT_PROJECT_ROOT. */
export function getProjectRoot(): string {
  const fromEnv = process.env['MAILAGENT_PROJECT_ROOT']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  // #7 打包态不碰 ~/Documents: 该目录是 macOS TCC 保护区, ad-hoc 签名每次重装会重置
  // TCC → 首次访问就弹「读取文稿中数据库」授权框 (每装一次弹一次)。打包态 .env / 数据根
  // 都在 userData (db.ts resolveDataRoot + Python get_project_root 经注入的
  // MAILAGENT_PROJECT_ROOT=userData 同源), 故锚 userData; dev 保持 ~/Documents/MailAgent
  // 零变更。与 resolveBundledResourcesRoot 同款 try/catch (单测 mock app 无 isPackaged)。
  try {
    if (app.isPackaged) return app.getPath('userData')
  } catch {
    /* 单测 mock app 可能无 isPackaged / getPath → 落 dev 默认 */
  }
  return join(homedir(), 'Documents', 'MailAgent')
}

/** Bundle 内【只读资源】根 (scripts/ 脚本 + prompts/ 出厂模板所在)。打包态 =
 *  process.resourcesPath (electron-builder extraResources 落点); dev = 仓库根
 *  ~/Documents/MailAgent。与可写数据根 (resolveDataRoot, 打包态=userData) 区分 ——
 *  getProjectRoot() 无 packaged 分支, 打包态恒落不存在的 ~/Documents/MailAgent (干净机器),
 *  故只读资源 (脚本 / 出厂模板) 改锚 resourcesPath。 */
export function resolveBundledResourcesRoot(): string {
  const fromEnv = process.env['MAILAGENT_PROJECT_ROOT']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  try {
    if (app.isPackaged) return process.resourcesPath
  } catch {
    /* 单测 mock app 可能无 isPackaged → 落 dev 默认 */
  }
  return join(homedir(), 'Documents', 'MailAgent')
}

export function getMailagentBin(): string {
  if (_binCache !== null) return _binCache
  // 三级回退顺序不变: ① $MAILAGENT_BIN → ② 默认 venv → ③ PATH。
  // Packaging P1-3 只改第②级的「默认 venv 在哪」: 打包模式指向 bundle 内嵌
  // 式 venv (process.resourcesPath/python/bin), dev 模式保持原有
  // projectVenvBin() (~/Documents/MailAgent/venv/bin) —— dev 行为零变更。
  const fromEnv = process.env['MAILAGENT_BIN']
  if (fromEnv && fromEnv.length > 0) {
    _binCache = fromEnv
    return _binCache
  }
  const venvBin = app.isPackaged ? packagedResourcesBin() : projectVenvBin()
  if (existsSync(venvBin)) {
    _binCache = venvBin
    return _binCache
  }
  const found = whichSync('mailagent', { nothrow: true })
  if (!found) {
    throw new CliError(
      'E_NO_BIN',
      -1,
      `mailagent CLI not found. Tried $MAILAGENT_BIN, ${venvBin}, and PATH. ` +
        'Install with `pip install -e .[cli]` or set MAILAGENT_BIN.'
    )
  }
  _binCache = found
  return _binCache
}

// Mirror of docs/cli-schema/error-codes.md. -1 is our local timeout sentinel.
export const EXIT_CODE_MAP: Record<number, string> = {
  0: 'OK',
  1: 'GENERIC',
  2: 'INVALID_ARG',
  4: 'AUTH',
  5: 'UPSTREAM',
  6: 'PARTIAL',
  7: 'ABORTED',
  8: 'MAX_FAILURES',
  9: 'PM2_CONFLICT',
  130: 'SIGINT2',
  [-1]: 'TIMEOUT'
}

export class CliError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly exitCode: number,
    public readonly hint?: string,
    public readonly rawStdout?: string,
    public readonly rawStderr?: string
  ) {
    super(`mailagent exit=${exitCode} code=${errorCode}${hint ? ` hint=${hint}` : ''}`)
    this.name = 'CliError'
  }
}

export interface RunOpts {
  write?: boolean
  needsAuth?: boolean
  signal?: AbortSignal
  /** Per-call timeout override. Default 60s. Long jobs must NOT use this path. */
  timeoutMs?: number
  /** Optional sink for stderr lines — IPC handlers forward to renderer log. */
  onStderr?: (chunk: string) => void
}

// Hooked by Sprint 1.5 TitleBar/StatusBar so the renderer can surface CLI logs;
// kept module-level so tests can swap it without touching every call site.
let _globalStderrSink: ((chunk: string) => void) | null = null
export function setGlobalStderrSink(fn: ((chunk: string) => void) | null): void {
  _globalStderrSink = fn
}

class CliQueue {
  private readonly readSem = new Semaphore(4)
  private readonly writeSem = new Semaphore(1)
  private readonly inFlight = new Set<ResultPromise>()

  async run(args: string[], opts: RunOpts): Promise<unknown> {
    const sem = opts.write ? this.writeSem : this.readSem
    await sem.acquire()
    try {
      return await this._exec(args, opts)
    } finally {
      sem.release()
    }
  }

  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const sub of this.inFlight) {
      // execa swallows kill-after-exit internally; nothing to guard here.
      sub.kill(signal)
    }
    this.inFlight.clear()
  }

  get inFlightSize(): number {
    return this.inFlight.size
  }

  private async _exec(args: string[], opts: RunOpts): Promise<unknown> {
    // Lazy bin resolution — throws CliError('E_NO_BIN') if the CLI is missing,
    // which propagates to the IPC caller exactly like any other CLI error.
    const bin = getMailagentBin()
    const ac = new AbortController()
    const onParentAbort = (): void => ac.abort()
    opts.signal?.addEventListener('abort', onParentAbort, { once: true })

    const timeoutMs = opts.timeoutMs ?? 60_000

    const sub = execa(bin, args, {
      cancelSignal: ac.signal,
      reject: false, // disable default throw-on-nonzero; we dispatch by exit code
      timeout: timeoutMs,
      buffer: true,
      lines: false,
      all: false,
      // Run the CLI from the project root so pydantic's BaseSettings picks
      // up `.env` (NOTION_TOKEN / EMAIL_DATABASE_ID / USER_EMAIL — required
      // fields). Electron's app cwd is the .app bundle in production, not
      // the repo; without this the CLI dies in `Config()` before reaching
      // typer and surfaces as exit=1 / E_GENERIC with a python traceback.
      // cwd 用可写数据根 (打包态=userData, 必存在) 而非 getProjectRoot() —— 后者打包态恒落
      // ~/Documents/MailAgent, 干净机器 (无 dev clone) 上不存在 → execa chdir ENOENT → 所有
      // fork CLI 起不来。DB/.env 已由下面 env override 显式锚定, cwd 只需是存在且可写的目录。
      cwd: resolveDataRoot(),
      // 🔴 显式锚定数据根 (与 backend_lifecycle.buildBaseEnv 一致)。不注入则打包态 fork
      // 的 CLI 的 DB 路径靠 bootstrapDotenv 灌进的 dev .env (相对 SYNC_STORE_DB_PATH=
      // data/sync_store.db) 或 __file__ fallback → 落到错库 (dev stale 库 / bundle 内
      // site-packages 空库), draftPlan 等 fork-CLI 操作读不到最近邮件 → 回复预填收件人 +
      // 引用全空 (邮件列表/详情走 IPC 直读 userData 库, 故正常)。override 排在 ...process.env
      // 之后, 覆盖 dotenv 灌进的相对值; resolveDbPath/resolveDataRoot 自处理 dev/packaged 分支。
      env: {
        ...process.env,
        MAILAGENT_DATA_ROOT: resolveDataRoot(),
        MAILAGENT_ENV_FILE: join(resolveDataRoot(), '.env'),
        SYNC_STORE_DB_PATH: resolveDbPath()
      }
    })
    this.inFlight.add(sub)

    // Drain stderr through caller hook + global sink so logs reach the renderer
    // log panel without re-parsing stdout (REVIEW-LOG C-02 split).
    const stderrSinks: Array<(chunk: string) => void> = []
    if (opts.onStderr) stderrSinks.push(opts.onStderr)
    if (_globalStderrSink) stderrSinks.push(_globalStderrSink)
    if (stderrSinks.length > 0 && sub.stderr) {
      sub.stderr.setEncoding('utf8')
      sub.stderr.on('data', (chunk: string) => {
        // Sinks are caller-supplied (IPC log forward, renderer panel). One bad
        // sink must not abort CLI buffering, so isolate each.
        for (const sink of stderrSinks) {
          try {
            sink(chunk)
          } catch (err) {
            console.error('[cli_runner] stderr sink threw, dropping chunk', err)
          }
        }
      })
    }

    let result: Result
    try {
      result = (await sub) as Result
    } finally {
      this.inFlight.delete(sub)
      opts.signal?.removeEventListener('abort', onParentAbort)
    }

    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    const exitCode = result.exitCode ?? -1
    const isCanceled = result.isCanceled ?? false
    const timedOut = result.timedOut ?? false

    if (timedOut) {
      throw new CliError('E_TIMEOUT', -1, `CLI exceeded ${timeoutMs}ms`, stdout, stderr)
    }
    if (isCanceled) {
      throw new CliError('E_ABORTED', 7, 'CLI killed by AbortController', stdout, stderr)
    }

    // Try parse stdout. CLIs that crash before emitting JSON (segfault, missing
    // arg before typer formats output) land here.
    let parsed: unknown = null
    let parseFailed = false
    if (stdout.length > 0) {
      try {
        parsed = JSON.parse(stdout)
      } catch {
        parseFailed = true
      }
    }

    if (exitCode === 0) {
      if (parseFailed || parsed == null) {
        throw new CliError(
          'E_PARSE_FAIL',
          exitCode,
          `stdout did not parse as JSON (${stdout.length} bytes)`,
          stdout,
          stderr
        )
      }
      const wrapped = parsed as { status?: string; data?: unknown; error?: { code?: string } }
      if (wrapped.status === 'success') return wrapped.data
      // exit 0 but status=error inside wrapper is an upstream contract bug;
      // surface it via error path rather than silently returning undefined.
      throw new CliError(
        wrapped.error?.code ?? 'E_CONTRACT_VIOLATION',
        exitCode,
        `wrapper.status=${String(wrapped.status)} on exit 0`,
        stdout,
        stderr
      )
    }

    // Non-zero exit: prefer wrapper.error.code (CLI self-reported), fallback to
    // EXIT_CODE_MAP so we always emit `E_<NAME>` even on raw crashes.
    const wrapper = parsed as { error?: { code?: string; hint?: string } } | null
    const code = wrapper?.error?.code ?? `E_${EXIT_CODE_MAP[exitCode] ?? `EXIT_${exitCode}`}`
    const hint = wrapper?.error?.hint
    throw new CliError(code, exitCode, hint, stdout, stderr)
  }
}

const _queue = new CliQueue()

/**
 * High-level wrapper. IPC handlers call this; never construct CliQueue
 * directly so the singleton's before-quit cleanup applies.
 */
export async function callCli(args: string[], opts: RunOpts = {}): Promise<unknown> {
  // Sprint 5 ship-review (codex HIGH): `--api-key` is a root Typer option on
  // the `mailagent` CLI (src/cli/main.py:82), NOT a subcommand option. It
  // MUST come BEFORE the subcommand name; appending it at the end yields
  // `No such option: --api-key` and breaks every keyed write. `-o json`
  // is also a global, so we group globals up front.
  const globals: string[] = ['-o', 'json']
  if (opts.needsAuth) {
    const apiKey = await getCliApiKey()
    if (apiKey) globals.push('--api-key', apiKey)
    // No key configured is not an error here — `mailagent` itself enforces the
    // policy via MAILAGENT_CLI_API_KEY env and will exit 4 (AUTH) if needed.
  }
  const fullArgs = [...globals, ...args]
  return _queue.run(fullArgs, opts)
}

export function registerCliLifecycle(): void {
  // Best-effort: kill in-flight subprocesses on Electron quit. Even with
  // sandbox:false, Electron does not forward signals to grandchildren by
  // default — without this, `pnpm dev` Cmd+Q can leave `mailagent` zombies.
  app.on('before-quit', () => {
    _queue.killAll('SIGTERM')
  })
}

export function _cliQueueForTests(): CliQueue {
  return _queue
}
