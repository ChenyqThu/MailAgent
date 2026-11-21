// S2 W1 (task 07-02-s2-exec-skill-install, ADR-001 D4/D6) — derive a structured, full-PIN PolicyRule
// from an APPROVED exec action (the approval card's "always allow" affordance). Runs in the electron
// main process (fs access) when the owner ticks "always allow"; the derived matcher is persisted via
// the owner policy API (src/agent_config/policy.py evaluates it later).
//
// 🔴 Faithful to the Python matcher (src/agent_config/policy.py):
//   - exec argv[0] is resolved the SAME way as _resolve_argv0: a path with a separator → realpath of
//     the (cwd-relative) path; a bare command → searched on the FIXED exec PATH (the same 4 dirs the
//     child process spawns with) then realpath'd. A divergence just yields a rule that never matches
//     → the tool keeps asking (fail-SAFE, never fail-open).
//   - argv rest is ALWAYS every position pinned to its literal (never {any}). Per ADR-001 §6 a
//     dangerous argv0 (bash/python/node/git/…) may only get an all-pin rule — since we ONLY ever
//     generate all-pin, that constraint holds by construction (widening to {any} is a manual
//     Settings-only action).
//   - file rules pin the target's PARENT DIRECTORY realpath (the "always allow this location"
//     semantic), matching Python's realpath-prefix _within_prefix check.

import { accessSync, constants, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** The FIXED exec PATH the child process spawns with (mirror of secret_names.FIXED_EXEC_PATH). Bare
 *  commands are resolved against exactly this list so a derived rule matches what actually runs. */
const FIXED_EXEC_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const

/** A capability + structured matcher ready for POST /api/agent/policy/rules. */
export interface DerivedExecRule {
  capability: 'exec' | 'file_read' | 'file_write' | 'computer_use'
  matcher: Record<string, unknown>
}

/** An error the caller maps to a typed HTTP status (mirrors ApprovalError's `.code`). */
export class ExecRuleDeriveError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ExecRuleDeriveError'
    this.code = code
  }
}

/** Resolve argv[0] to a realpath the SAME way the Python executor does (_resolve_argv0). */
function resolveArgv0(argv0: string, cwd: string | undefined): string {
  if (argv0.includes('/')) {
    const base = isAbsolute(argv0) ? argv0 : resolve(cwd ?? process.cwd(), argv0)
    return realpathSync(base)
  }
  for (const dir of FIXED_EXEC_PATH) {
    const cand = join(dir, argv0)
    try {
      accessSync(cand, constants.X_OK)
      return realpathSync(cand)
    } catch {
      /* not here — keep looking */
    }
  }
  // Not found on the fixed PATH → realpath as-is (almost certainly won't match a run → safe ask).
  return realpathSync(argv0)
}

/**
 * Derive a full-PIN rule from an approved exec tool call. `input` is the APPROVED (effective) tool
 * input the run will use. Throws ExecRuleDeriveError on a non-exec tool, a malformed input, or a
 * filesystem error (a missing dir / unresolvable path) — the caller surfaces it so the card shows a
 * failure and no rule is created.
 */
export function deriveExecRule(toolName: string, input: unknown): DerivedExecRule {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'run_command') {
    const argv = obj.argv
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new ExecRuleDeriveError('E_INVALID_ARG', 'run_command requires a non-empty string argv')
    }
    const cwd = typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : undefined
    let argv0Real: string
    try {
      argv0Real = resolveArgv0(argv[0] as string, cwd)
    } catch (e) {
      throw new ExecRuleDeriveError('E_BAD_PATH', `cannot resolve argv[0]: ${(e as Error).message}`)
    }
    const matcher: Record<string, unknown> = {
      v: 1,
      argv0_realpath: argv0Real,
      // ALWAYS all-pin (never {any}) — the safe, narrow suggestion; widening is Settings-only.
      argv_template: (argv as string[]).slice(1).map((a) => ({ pin: a }))
    }
    if (cwd) {
      try {
        matcher.cwd_scope = realpathSync(cwd)
      } catch (e) {
        throw new ExecRuleDeriveError('E_BAD_CWD', `cannot resolve cwd: ${(e as Error).message}`)
      }
    }
    return { capability: 'exec', matcher }
  }
  if (toolName === 'file_read' || toolName === 'file_write') {
    const path = obj.path
    if (typeof path !== 'string' || !path) {
      throw new ExecRuleDeriveError('E_INVALID_ARG', `${toolName} requires a path`)
    }
    let prefix: string
    try {
      // Pin the PARENT directory realpath (allow-list the location, not the single file).
      prefix = realpathSync(dirname(isAbsolute(path) ? path : resolve(path)))
    } catch (e) {
      throw new ExecRuleDeriveError(
        'E_BAD_PATH',
        `cannot resolve parent dir: ${(e as Error).message}`
      )
    }
    return { capability: toolName, matcher: { v: 1, realpath_prefix: prefix } }
  }
  if (toolName === 'computer_use_run') {
    if (obj.stop_before_submit === false) {
      throw new ExecRuleDeriveError(
        'E_INVALID_ARG',
        'cannot remember computer_use_run with stop_before_submit=false'
      )
    }
    const wildcards = new Set(['*', '*.*', 'all', 'any'])
    const normalizeApps = (raw: unknown): string[] => {
      if (raw === undefined) return []
      if (!Array.isArray(raw)) {
        throw new ExecRuleDeriveError('E_INVALID_ARG', 'allowed_apps must be an array')
      }
      const out: string[] = []
      const seen = new Set<string>()
      for (const item of raw) {
        if (typeof item !== 'string') {
          throw new ExecRuleDeriveError('E_INVALID_ARG', 'allowed_apps must contain strings')
        }
        const trimmed = item.trim()
        const lower = trimmed.toLowerCase()
        if (!trimmed || trimmed.includes('*') || wildcards.has(lower)) {
          throw new ExecRuleDeriveError('E_INVALID_ARG', `invalid allowed_apps entry: ${item}`)
        }
        const key = lower.replace(/\.app$/, '')
        if (!seen.has(key)) {
          seen.add(key)
          out.push(trimmed)
        }
      }
      return out
    }
    const normalizeDomains = (raw: unknown): string[] => {
      if (raw === undefined) return []
      if (!Array.isArray(raw)) {
        throw new ExecRuleDeriveError('E_INVALID_ARG', 'allowed_domains must be an array')
      }
      const out: string[] = []
      const seen = new Set<string>()
      for (const item of raw) {
        if (typeof item !== 'string') {
          throw new ExecRuleDeriveError('E_INVALID_ARG', 'allowed_domains must contain strings')
        }
        let s = item.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
        if (!s || s.includes('*') || wildcards.has(s)) {
          throw new ExecRuleDeriveError('E_INVALID_ARG', `invalid allowed_domains entry: ${item}`)
        }
        if (s.includes('://')) {
          try {
            s = new URL(s).hostname.toLowerCase().replace(/\.+$/, '')
          } catch {
            throw new ExecRuleDeriveError('E_INVALID_ARG', `invalid allowed_domains entry: ${item}`)
          }
        } else {
          s = s.split('/', 1)[0]?.split(':', 1)[0] ?? ''
        }
        s = s.replace(/^\.+/, '').replace(/\.+$/, '')
        if (!s || s.includes('*') || wildcards.has(s)) {
          throw new ExecRuleDeriveError('E_INVALID_ARG', `invalid allowed_domains entry: ${item}`)
        }
        if (!seen.has(s)) {
          seen.add(s)
          out.push(s)
        }
      }
      return out
    }
    const allowedApps = normalizeApps(obj.allowed_apps)
    const allowedDomains = normalizeDomains(obj.allowed_domains)
    if (allowedApps.length === 0 && allowedDomains.length === 0) {
      throw new ExecRuleDeriveError(
        'E_INVALID_ARG',
        'computer_use_run remember requires non-empty allowed_apps or allowed_domains'
      )
    }
    return {
      capability: 'computer_use',
      matcher: {
        v: 1,
        allowed_apps: allowedApps,
        allowed_domains: allowedDomains,
        stop_before_submit: true
      }
    }
  }
  throw new ExecRuleDeriveError(
    'E_NOT_FOUND',
    `${toolName} is not an exec tool (no whitelist rule)`
  )
}
