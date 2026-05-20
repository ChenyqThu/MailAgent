// Sprint 18 §PR B — env:get / env:set IPC.
//
// 渲染层通过 EnvField 调用 mailApi.env.get() 一次, 在 useEnvStore 缓存; 字段
// 失焦时调 mailApi.env.set({KEY: value}) 同步落项目根 `.env`。Python 端
// (mail-sync) 不支持热 reload, 所以 set 完毕后返回 restartRequired=true,
// 前端 surface RestartBanner (PR E) 让用户走 services:restart('mail-sync').
//
// 安全契约:
//   - SECRET_ENV_KEYS 的 value 在 env:get 响应里 redact 成 '***' (已设) 或
//     '' (未设). 明文 NEVER crosses IPC for read.
//   - env:set 接受任何 string value (含 secret), 但不打日志.
//   - 任何非 MANAGED_ENV_KEYS 的 key 触发 E_INVALID_KEY 拒绝 (env-parser
//     已经做了 throw, handler 层再 catch 包成 envelope, 避免 IPC 把 Error
//     custom property 吞掉 — REVIEW-LOG codex M-3).
//
// 原子写: `writeFileSync(.env.tmp)` 然后 `renameSync(.env.tmp, .env)`. POSIX
// rename 是原子操作, 哪怕 Electron 主进程 panic 也只会留下 .env.tmp 而不会
// 把 .env 截断成半个文件. Tmp file 落在 `.env` 同目录避免 cross-device rename
// 失败 (Linux tmpfs / Mac /tmp 是不同 fs).

import { ipcMain } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'

import { mergeEnv, parseEnv, serializeEnv, toRecord } from '../lib/env-parser'
import {
  MANAGED_ENV_KEYS,
  MANAGED_ENV_KEY_SET,
  SECRET_ENV_KEYS,
  type ManagedEnvKey
} from '../lib/env-keys'
import { resolveEnvPath } from '../lib/env-path'

/** Renderer-facing shape returned by env:get. Plaintext secrets NEVER leak —
 *  any SECRET key value is replaced with '***' (set) or '' (unset). */
export interface EnvSnapshot {
  /** Absolute path to the resolved `.env` file. */
  path: string
  /** False if `.env` is missing on disk; renderer still gets an empty values map. */
  exists: boolean
  /** Active keys only (commented-out kv lines are NOT in this map). Secrets
   *  are redacted; non-secrets carry their plaintext value. */
  values: Record<string, string>
  /** Echo of MANAGED_ENV_KEYS so the UI doesn't need to import the whitelist
   *  separately (single roundtrip, single source of managed names). */
  managedKeys: readonly ManagedEnvKey[]
  /** Subset of managedKeys that are secret. */
  secretKeys: string[]
}

export type EnvSetResult =
  | {
      ok: true
      path: string
      changedKeys: string[]
      /** Always true if changedKeys.length > 0. The renderer hooks this into
       *  the RestartBanner store (PR E). */
      restartRequired: boolean
    }
  | {
      ok: false
      path: string
      error: { code: 'E_INVALID_KEY' | 'E_NOT_FOUND' | 'E_WRITE'; message: string }
    }

function redactSnapshot(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(values)) {
    if (SECRET_ENV_KEYS.has(key)) {
      out[key] = values[key].length > 0 ? '***' : ''
    } else {
      out[key] = values[key]
    }
  }
  return out
}

function readSnapshot(): EnvSnapshot {
  const path = resolveEnvPath()
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      values: {},
      managedKeys: MANAGED_ENV_KEYS,
      secretKeys: Array.from(SECRET_ENV_KEYS)
    }
  }
  const text = readFileSync(path, 'utf8')
  const parsed = parseEnv(text)
  const all = toRecord(parsed)
  // Filter to managed keys only — anything else (stray test vars, legacy
  // keys we no longer recognize) stays in the file but doesn't ride the IPC.
  const managedOnly: Record<string, string> = {}
  for (const key of Object.keys(all)) {
    if (MANAGED_ENV_KEY_SET.has(key)) managedOnly[key] = all[key]
  }
  return {
    path,
    exists: true,
    values: redactSnapshot(managedOnly),
    managedKeys: MANAGED_ENV_KEYS,
    secretKeys: Array.from(SECRET_ENV_KEYS)
  }
}

function writePatch(patch: Record<string, string | null>): EnvSetResult {
  const path = resolveEnvPath()

  // Defensive whitelist check at the handler boundary so the error is well-
  // formed even before we touch the parser (which also throws but with a
  // more parser-flavoured message).
  for (const key of Object.keys(patch)) {
    if (!MANAGED_ENV_KEY_SET.has(key)) {
      return {
        ok: false,
        path,
        error: {
          code: 'E_INVALID_KEY',
          message: `env:set refused: "${key}" is not in MANAGED_ENV_KEYS`
        }
      }
    }
  }

  // Empty patch is a no-op success — saves the renderer from having to special-
  // case "user clicked save but nothing changed".
  if (Object.keys(patch).length === 0) {
    return { ok: true, path, changedKeys: [], restartRequired: false }
  }

  let originalText = ''
  if (existsSync(path)) {
    try {
      originalText = readFileSync(path, 'utf8')
    } catch (err) {
      return {
        ok: false,
        path,
        error: {
          code: 'E_NOT_FOUND',
          message: `env:set could not read existing .env: ${(err as Error).message}`
        }
      }
    }
  }
  // Missing file → start from empty parsed state. mergeEnv will append all
  // patch keys; the resulting .env has just the keys we wrote, no banner
  // comments. Better than refusing to operate when the user wiped their .env.

  const parsed = parseEnv(originalText)
  let next
  try {
    next = mergeEnv(parsed, patch)
  } catch (err) {
    const e = err as Error & { code?: string }
    if (e.code === 'E_INVALID_KEY') {
      return { ok: false, path, error: { code: 'E_INVALID_KEY', message: e.message } }
    }
    return { ok: false, path, error: { code: 'E_WRITE', message: e.message } }
  }

  const nextText = serializeEnv(next)
  const tmpPath = path + '.tmp'
  try {
    writeFileSync(tmpPath, nextText, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, path)
  } catch (err) {
    return {
      ok: false,
      path,
      error: { code: 'E_WRITE', message: `env:set write failed: ${(err as Error).message}` }
    }
  }

  // Only report keys whose values actually changed (or moved between
  // active/commented/missing states). Mainly so RestartBanner doesn't fire
  // when the user blurs a field they didn't actually edit.
  const before = toRecord(parsed)
  const after = toRecord(next)
  const changedKeys: string[] = []
  for (const key of Object.keys(patch)) {
    const wasActive = before[key] !== undefined
    const isActive = after[key] !== undefined
    if (wasActive !== isActive) {
      changedKeys.push(key)
    } else if (isActive && before[key] !== after[key]) {
      changedKeys.push(key)
    }
  }

  return {
    ok: true,
    path,
    changedKeys,
    restartRequired: changedKeys.length > 0
  }
}

export function registerEnvHandlers(): void {
  ipcMain.handle('env:get', async (): Promise<EnvSnapshot> => readSnapshot())

  ipcMain.handle(
    'env:set',
    async (_event, patch: Record<string, string | null>): Promise<EnvSetResult> => {
      if (patch === null || typeof patch !== 'object') {
        return {
          ok: false,
          path: resolveEnvPath(),
          error: { code: 'E_INVALID_KEY', message: 'env:set patch must be an object' }
        }
      }
      return writePatch(patch)
    }
  )
}

// Exposed for vitest.
export const __test__ = { readSnapshot, writePatch }
