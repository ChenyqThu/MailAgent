// Sprint 18 §PR B — line-level .env parser contract.
//
// Five axes cover the production guarantees:
//   (a) `serialize(parse(text))` round-trips byte-identically on well-formed
//       .env files — comments, blank lines, trailing newline, quoting all
//       preserved;
//   (b) `mergeEnv` with empty patch is a no-op;
//   (c) updating one key touches ONE line, leaves the rest byte-identical;
//   (d) `value === null` comments out the active line (preserves key for
//       future un-comment); a subsequent set un-comments it;
//   (e) Non-MANAGED keys throw `Error & { code: 'E_INVALID_KEY' }`.
//
// No file I/O, no mocks — the parser is a pure function.

import { describe, expect, test } from 'vitest'

import { mergeEnv, parseEnv, serializeEnv, toRecord } from '../../src/electron/main/lib/env-parser'

const FIXTURES: Record<string, string> = {
  empty: '',
  emptyTrailingNL: '\n',
  bannerOnly: `# Sprint 18 fixture banner
# (no kv lines here)
`,
  mixed: `# — Accounts
NOTION_TOKEN=ntn_abc
EMAIL_DATABASE_ID=db_xyz

# — Sync (commented out — re-enable when ready)
# SYNC_MAILBOXES=收件箱,发件箱
SYNC_START_DATE=2026-01-01  # ISO date

# — Notifications
FEISHU_NOTIFY_ENABLED=true
`,
  trailingComment: `LLM_MODEL=claude-sonnet-4-6  # primary, fallbacks below
LLM_FALLBACK_MODELS=gpt-5.4,claude-opus-4-7
`,
  quotedHash: `DASHBOARD_PASSWORD="hash#with#hash"
NOTION_TOKEN=plain_no_quotes
`,
  noTrailingNL: 'NOTION_TOKEN=foo'
}

describe('parseEnv / serializeEnv round-trip', () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    test(`fixture: ${name}`, () => {
      const parsed = parseEnv(text)
      const out = serializeEnv(parsed)
      expect(out).toBe(text)
    })
  }
})

describe('parseEnv classification', () => {
  test('mixed fixture: active kv + commented kv + comments + blanks all distinguished', () => {
    const parsed = parseEnv(FIXTURES.mixed)
    // Active kv keys (4): NOTION_TOKEN, EMAIL_DATABASE_ID, SYNC_START_DATE, FEISHU_NOTIFY_ENABLED
    expect(Array.from(parsed.index.keys()).sort()).toEqual([
      'EMAIL_DATABASE_ID',
      'FEISHU_NOTIFY_ENABLED',
      'NOTION_TOKEN',
      'SYNC_START_DATE'
    ])
    // Commented kv key (1): SYNC_MAILBOXES
    expect(Array.from(parsed.commentedIndex.keys())).toEqual(['SYNC_MAILBOXES'])
    // toRecord exposes the active set with stripped values.
    expect(toRecord(parsed)).toEqual({
      NOTION_TOKEN: 'ntn_abc',
      EMAIL_DATABASE_ID: 'db_xyz',
      SYNC_START_DATE: '2026-01-01',
      FEISHU_NOTIFY_ENABLED: 'true'
    })
  })

  test('quoted values are unquoted on read', () => {
    const parsed = parseEnv(FIXTURES.quotedHash)
    expect(toRecord(parsed).DASHBOARD_PASSWORD).toBe('hash#with#hash')
    expect(toRecord(parsed).NOTION_TOKEN).toBe('plain_no_quotes')
  })

  test('no-trailing-newline fixture preserves the missing newline on round-trip', () => {
    const parsed = parseEnv(FIXTURES.noTrailingNL)
    expect(parsed.trailingNewline).toBe(false)
    expect(serializeEnv(parsed)).toBe(FIXTURES.noTrailingNL)
  })
})

describe('mergeEnv — write semantics', () => {
  test('empty patch is a no-op (byte-identical serialize)', () => {
    const parsed = parseEnv(FIXTURES.mixed)
    const next = mergeEnv(parsed, {})
    expect(serializeEnv(next)).toBe(FIXTURES.mixed)
  })

  test('update single active kv: touches only the matching line', () => {
    const parsed = parseEnv(FIXTURES.mixed)
    const next = mergeEnv(parsed, { NOTION_TOKEN: 'ntn_new' })
    const out = serializeEnv(next)
    // The NOTION_TOKEN line is changed, everything else identical.
    expect(out).toContain('NOTION_TOKEN=ntn_new\n')
    expect(out).toContain('EMAIL_DATABASE_ID=db_xyz')
    expect(out).toContain('# — Sync')
    expect(out).toContain('# SYNC_MAILBOXES=收件箱,发件箱')
    // Byte-for-byte diff: only one line changed.
    const before = FIXTURES.mixed.split('\n')
    const after = out.split('\n')
    expect(after.length).toBe(before.length)
    const diffs = before
      .map((line, i) => [line, after[i]] as const)
      .filter(([a, b]) => a !== b)
    expect(diffs.length).toBe(1)
    expect(diffs[0][1]).toBe('NOTION_TOKEN=ntn_new')
  })

  test('value === null comments out the active line (key still discoverable)', () => {
    const parsed = parseEnv(FIXTURES.mixed)
    const next = mergeEnv(parsed, { NOTION_TOKEN: null })
    const out = serializeEnv(next)
    expect(out).toContain('# NOTION_TOKEN=ntn_abc')
    expect(out).not.toMatch(/^NOTION_TOKEN=/m)
    // index no longer holds NOTION_TOKEN; commentedIndex does.
    expect(next.index.has('NOTION_TOKEN')).toBe(false)
    expect(next.commentedIndex.has('NOTION_TOKEN')).toBe(true)
  })

  test('un-comment + set: brings a commented kv back active', () => {
    const parsed = parseEnv(FIXTURES.mixed)
    // SYNC_MAILBOXES was commented in the fixture. Set it → un-comment.
    const next = mergeEnv(parsed, { SYNC_MAILBOXES: '收件箱' })
    const out = serializeEnv(next)
    expect(out).toContain('SYNC_MAILBOXES=收件箱\n')
    expect(out).not.toContain('# SYNC_MAILBOXES=收件箱,发件箱')
    expect(next.index.has('SYNC_MAILBOXES')).toBe(true)
    expect(next.commentedIndex.has('SYNC_MAILBOXES')).toBe(false)
  })

  test('append: a missing key lands at EOF', () => {
    const parsed = parseEnv(FIXTURES.bannerOnly)
    const next = mergeEnv(parsed, { LLM_AGENT_ENABLED: 'true' })
    const out = serializeEnv(next)
    expect(out.endsWith('LLM_AGENT_ENABLED=true\n')).toBe(true)
  })

  test('value with whitespace / hash gets quoted on write', () => {
    const parsed = parseEnv('')
    const next = mergeEnv(parsed, { LLM_API_BASE: 'https://example.com/v1/api  spaced' })
    const out = serializeEnv(next)
    expect(out).toContain('LLM_API_BASE="https://example.com/v1/api  spaced"')
  })

  test('non-managed key throws E_INVALID_KEY', () => {
    const parsed = parseEnv('')
    expect.assertions(2)
    try {
      mergeEnv(parsed, { TOTALLY_UNKNOWN_KEY: 'x' })
    } catch (err) {
      const e = err as Error & { code?: string }
      expect(e.code).toBe('E_INVALID_KEY')
      expect(e.message).toMatch(/TOTALLY_UNKNOWN_KEY/)
    }
  })

  test('trailing inline comment is preserved when value is updated', () => {
    const parsed = parseEnv(FIXTURES.trailingComment)
    const next = mergeEnv(parsed, { LLM_MODEL: 'claude-opus-4-7' })
    const out = serializeEnv(next)
    // The "  # primary, fallbacks below" comment is kept intact.
    expect(out).toContain('LLM_MODEL=claude-opus-4-7  # primary, fallbacks below')
  })
})
