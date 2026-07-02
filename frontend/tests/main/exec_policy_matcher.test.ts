// S2 W1 — deriveExecRule: the "always allow" affordance builds a full-PIN structured rule from an
// approved exec action. Uses real fs (realpath) against /bin + a tmp dir, matching how the Python
// matcher (policy.py) will later resolve the same action.

import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { deriveExecRule, ExecRuleDeriveError } from '../../src/electron/main/exec_policy_matcher'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exec-matcher-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deriveExecRule — run_command', () => {
  test('absolute argv[0] → argv0_realpath + all-pin argv rest + cwd_scope', () => {
    const { capability, matcher } = deriveExecRule('run_command', {
      argv: ['/bin/echo', 'hello', 'world'],
      cwd: dir
    })
    expect(capability).toBe('exec')
    expect(matcher.v).toBe(1)
    expect(matcher.argv0_realpath).toBe(realpathSync('/bin/echo'))
    // every rest position pinned to its literal — NEVER {any}
    expect(matcher.argv_template).toEqual([{ pin: 'hello' }, { pin: 'world' }])
    expect(matcher.cwd_scope).toBe(realpathSync(dir))
  })

  test('bare command → resolved on the fixed exec PATH (realpath of /bin or /usr/bin)', () => {
    const { matcher } = deriveExecRule('run_command', { argv: ['ls'] })
    // ls lives on /bin (macOS) — resolved via the fixed PATH search + realpath.
    expect(matcher.argv0_realpath).toBe(realpathSync('/bin/ls'))
    expect(matcher.argv_template).toEqual([])
    expect(matcher.cwd_scope).toBeUndefined()
  })

  test('no cwd → no cwd_scope (rule matches any cwd for the exact argv)', () => {
    const { matcher } = deriveExecRule('run_command', { argv: ['/bin/echo', 'hi'] })
    expect('cwd_scope' in matcher).toBe(false)
  })

  test('empty argv → E_INVALID_ARG', () => {
    expect(() => deriveExecRule('run_command', { argv: [] })).toThrow(ExecRuleDeriveError)
  })
})

describe('deriveExecRule — file_read / file_write', () => {
  test('file_read → realpath_prefix pins the PARENT directory', () => {
    const f = join(dir, 'notes.txt')
    writeFileSync(f, 'x')
    const { capability, matcher } = deriveExecRule('file_read', { path: f })
    expect(capability).toBe('file_read')
    expect(matcher).toEqual({ v: 1, realpath_prefix: realpathSync(dir) })
  })

  test('file_write (non-existent file, existing parent) → parent realpath_prefix', () => {
    const f = join(dir, 'out.txt') // does NOT exist yet (create_new)
    const { capability, matcher } = deriveExecRule('file_write', { path: f })
    expect(capability).toBe('file_write')
    expect(matcher.realpath_prefix).toBe(realpathSync(dirname(f)))
  })

  test('missing path → E_INVALID_ARG', () => {
    try {
      deriveExecRule('file_read', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ExecRuleDeriveError).code).toBe('E_INVALID_ARG')
    }
  })
})

describe('deriveExecRule — non-exec tool', () => {
  test('a non-exec tool name → E_NOT_FOUND (no whitelist rule)', () => {
    try {
      deriveExecRule('email_flag', { internal_id: 1 })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ExecRuleDeriveError).code).toBe('E_NOT_FOUND')
    }
  })
})
