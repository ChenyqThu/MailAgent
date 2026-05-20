// Sprint 18 — repo-root `.env` path resolver (SSoT).
//
// 是 `handlers/settings.ts:loadUserEmailFromEnv` 候选顺序的提炼版, 让所有
// 新的 env:* IPC 跟 settings:get 用同一份路径解析。Python 后端 (mail-sync /
// calendar-sync / mailagent CLI) 实际读的 `.env` 必须跟我们写的 `.env` 是
// 同一个文件, 所以这里跟 `cli_runner.ts:getProjectRoot()` 对齐:
//
//   $MAILAGENT_ENV_FILE   绝对路径覆写, 永远最高优先
//   $MAILAGENT_PROJECT_ROOT/.env  CI / 测试 / 非默认 layout
//   <getProjectRoot()>/.env       默认 ~/Documents/MailAgent/.env
//   cwd()/../.env                 dev mode: pnpm dev 时 cwd=frontend/, 父目录是 repo root
//
// 首次解析后缓存。`refreshEnvPath()` 仅用于单测; 生产代码不要调它。

import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { getProjectRoot } from '../cli_runner'

let _cached: string | null = null

/** Resolve the `.env` file path. Caches on first call. */
export function resolveEnvPath(): string {
  if (_cached !== null) return _cached

  // `MAILAGENT_ENV_FILE` is an explicit override (vitest fixtures, dev with
  // non-default layout, CI). When set we use it verbatim WITHOUT falling
  // back to production candidates — otherwise a missing fixture file in a
  // test would silently hit the real project's .env. env:get checks
  // existsSync separately and surfaces `exists: false`.
  const override = process.env['MAILAGENT_ENV_FILE']
  if (override && override.length > 0) {
    _cached = override
    return _cached
  }

  const candidates: string[] = []

  // Mirror cli_runner.getProjectRoot() — the CLI runs in this cwd and
  // pydantic-settings reads `.env` from there, so writing the same file is
  // the only way Python picks up our changes after `pm2 restart mail-sync`.
  candidates.push(join(getProjectRoot(), '.env'))

  // Dev fallback: `electron-vite dev` runs with cwd=frontend/, parent =
  // repo root. Only used when getProjectRoot() points elsewhere (e.g. a
  // non-default install) AND we happen to be running from inside frontend.
  candidates.push(join(process.cwd(), '..', '.env'))

  // Last-resort packaged-install path (matches handlers/settings.ts:86).
  // app may not be ready when this module loads during tests — guard the
  // homedir lookup so the function stays usable from vitest harness.
  try {
    candidates.push(join(app.getPath('home'), 'Documents', 'MailAgent', '.env'))
  } catch {
    /* app not ready, skip */
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      _cached = p
      return _cached
    }
  }

  // None of the candidates exists yet — pick the highest-priority production
  // path so a future env:set lands `<getProjectRoot()>/.env`, the file the
  // Python service reads on next `pm2 restart`.
  _cached = candidates[0]
  return _cached
}

/** Vitest-only: drop the cache so a fresh resolveEnvPath() picks up a
 *  changed env / fixture root. Do NOT call from production code. */
export function refreshEnvPath(): void {
  _cached = null
}
