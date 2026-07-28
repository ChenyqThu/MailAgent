// issue #67 item 3 — the exec card must disclose which per-skill secrets a run_command
// injected into the child process env.
//
// `injected_secret_names` / `first_run_recorded` have been on /api/exec/run since 877dc17c,
// whose comment literally says "W4 审批卡展示" — but nothing in the frontend read them, so an
// approved command could read the owner's stored secrets with no surface anywhere saying which.
//
// 🔴 Scope note (the issue's premise is only half right): these CANNOT appear on the
// pre-approval card. The overlay is resolved inside /exec/run, after the skill probe, and there
// is no preview endpoint — /api/exec/{run,file_read,file_write} are the only three routes. So
// the disclosure is a post-run one, pinned here on the result phase.

import { describe, expect, test } from 'vitest'

import {
  buildToolA2UIPayload,
  type ExecApprovalCardProps
} from '../../../src/shared/assistant/tools/a2ui'

function execProps(args: unknown, result: unknown): ExecApprovalCardProps {
  const payload = buildToolA2UIPayload('run_command', { args, result })
  return payload?.props as unknown as ExecApprovalCardProps
}

describe('run_command card — per-skill secret disclosure', () => {
  test('result-phase carries the injected secret NAMES', () => {
    const props = execProps(
      { argv: ['python3', 'main.py'], cwd: '/tmp' },
      {
        exit_code: 0,
        injected_secret_names: ['NOTION_TOKEN', 'TAVILY_API_KEY'],
        first_run_recorded: ['my_skill/main.py']
      }
    )
    expect(props.injectedSecretNames).toEqual(['NOTION_TOKEN', 'TAVILY_API_KEY'])
    expect(props.firstRunRecorded).toEqual(['my_skill/main.py'])
  })

  test('no secrets injected → empty, so the card renders nothing (no false alarm)', () => {
    const props = execProps({ argv: ['ls'] }, { exit_code: 0, injected_secret_names: [] })
    expect(props.injectedSecretNames).toEqual([])
  })

  test('pre-approval phase has no result → empty, never a stale/guessed list', () => {
    const props = execProps({ argv: ['ls'] }, undefined)
    expect(props.injectedSecretNames).toEqual([])
    expect(props.firstRunRecorded).toEqual([])
  })

  test('junk from the wire is filtered to strings, never passed through', () => {
    const props = execProps(
      { argv: ['ls'] },
      { exit_code: 0, injected_secret_names: ['OK', 42, null, { a: 1 }] }
    )
    expect(props.injectedSecretNames).toEqual(['OK'])
  })

  test('file_read / file_write never carry the exec-only disclosure fields', () => {
    // The overlay only applies to run_command; a file op must not render a secrets banner.
    const payload = buildToolA2UIPayload('file_read', {
      args: { path: '/tmp/x' },
      result: { injected_secret_names: ['SHOULD_NOT_APPEAR'] }
    })
    const props = payload?.props as unknown as ExecApprovalCardProps
    expect(props.injectedSecretNames).toBeNull()
  })
})
