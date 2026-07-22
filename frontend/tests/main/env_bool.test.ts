// task 07-21 (codex R3 HIGH) — pins the gateway env kill-switch judgment (envBool) so it
// cannot drift from the Python mirror (src/skills/invoke.py `_gateway_envbool_on`). The
// SAME truth table is asserted table-driven on BOTH ends; the two test files cross-reference
// each other. If you touch a row here, touch it there (and in env-bool.ts's header).

import { afterEach, describe, expect, test } from 'vitest'

import { envBool } from '../../src/electron/main/lib/env-bool'

const KEY = 'MAILAGENT_NOTION_AGENT_TOOL'
const saved = process.env[KEY]

afterEach(() => {
  if (saved == null) delete process.env[KEY]
  else process.env[KEY] = saved
})

function setRaw(raw: string | undefined): void {
  if (raw === undefined) delete process.env[KEY]
  else process.env[KEY] = raw
}

// The canonical truth table (default=true, i.e. the notion_agent kill-switch: on unless
// explicitly turned off). `undefined` sentinel = key unset.
type Row = { raw: string | undefined; on: boolean; note: string }
const TABLE: Row[] = [
  { raw: undefined, on: true, note: 'unset → default(on)' },
  { raw: '', on: true, note: "empty string '' → default(on) (checked before trim)" },
  { raw: '   ', on: false, note: "whitespace-only → trims to '' → off (asymmetry vs '')" },
  { raw: '1', on: true, note: "'1' → on" },
  { raw: ' 1 ', on: true, note: "' 1 ' → on (trimmed)" },
  { raw: 'true', on: true, note: "'true' → on" },
  { raw: 'TRUE', on: true, note: "'TRUE' → on (case-insensitive)" },
  { raw: 'True', on: true, note: "'True' → on" },
  { raw: ' true ', on: true, note: "' true ' → on (trimmed)" },
  { raw: '0', on: false, note: "'0' → off" },
  { raw: 'false', on: false, note: "'false' → off" },
  { raw: 'FALSE', on: false, note: "'FALSE' → off" },
  { raw: 'no', on: false, note: "'no' → off" },
  { raw: 'off', on: false, note: "'off' → off" },
  { raw: 'garbage', on: false, note: "'garbage' (any other non-empty) → off" },
  { raw: 'yes', on: false, note: "'yes' → off (only 1/true are truthy)" },
  { raw: '2', on: false, note: "'2' → off" }
]

describe('envBool(MAILAGENT_NOTION_AGENT_TOOL, true) — gateway kill-switch truth table', () => {
  test.each(TABLE)('$note', ({ raw, on }) => {
    setRaw(raw)
    expect(envBool(KEY, true)).toBe(on)
  })
})
