// Sprint 5 §2.2 — Mail.app reply-draft AppleScript handler.
//
// `osascript -e` is sandboxed via execa. Tests mock execa to assert:
//   - mailbox lookup queries email_metadata
//   - escapeAppleScriptString covers backslash + quote
//   - buildDraftScript branches on known/unknown account
//   - classifyAppleScriptError maps stderr to E_AUTOMATION_DENIED /
//     E_MAIL_NOT_RUNNING / E_NOT_FOUND / E_APPLESCRIPT
//
// We do NOT exercise the live osascript path (would mutate the user's
// Mail.app); Sprint 5 manual QA covers that.

import { describe, expect, test } from 'vitest'

import { __testing, escapeAppleScriptString } from '../../src/electron/main/handlers/draft'

describe('escapeAppleScriptString', () => {
  test('escapes backslashes first, then double quotes (order matters)', () => {
    expect(escapeAppleScriptString('a\\b')).toBe('a\\\\b')
    expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"')
    // backslash + quote should both be escaped, in order:
    // raw `\"` → `\\"` (backslash doubled) → `\\\"` (quote escaped) =
    // `\\\\\"` literal in the test string.
    expect(escapeAppleScriptString('\\"')).toBe('\\\\\\"')
  })

  test('passes through plain ASCII + CJK + newlines verbatim', () => {
    expect(escapeAppleScriptString('Re: 周报\n请查阅。')).toBe('Re: 周报\n请查阅。')
  })
})

describe('buildDraftScript', () => {
  test('known account branch — targeted "of account ...whose id is N" lookup', () => {
    const script = __testing.buildDraftScript({
      internalId: 53675,
      mailbox: '收件箱',
      account: 'me@example.com',
      body: null
    })
    expect(script).toContain('tell application "Mail"')
    expect(script).toContain('mailbox "收件箱"')
    expect(script).toContain('of account "me@example.com"')
    expect(script).toContain('whose id is 53675')
    expect(script).toContain('reply origMsg with opening window')
    expect(script).toContain('return id of draftMsg as string')
  })

  test('unknown account branch — loops `every account` until match', () => {
    const script = __testing.buildDraftScript({
      internalId: 99,
      mailbox: '收件箱',
      account: null,
      body: null
    })
    expect(script).toContain('repeat with acct in every account')
    expect(script).toContain('of mailbox "收件箱" of acct whose id is 99')
    expect(script).toContain('exit repeat')
    expect(script).toContain('internal_id not found in any account')
  })

  test('body prefill prepends to existing reply body with double-newline gap', () => {
    const script = __testing.buildDraftScript({
      internalId: 1,
      mailbox: '收件箱',
      account: 'me@x',
      body: 'Hi Alice,\nThanks!'
    })
    expect(script).toContain('set content of draftMsg to ')
    expect(script).toContain('"Hi Alice,\nThanks!"')
    // The script prepends the new body, then a double newline, then the
    // original quoted content.
    expect(script).toMatch(/"\s*&\s*return\s*&\s*return\s*&\s*\(content of draftMsg as string\)/)
  })

  test('escapes quotes / backslashes in mailbox + account + body so AppleScript parses', () => {
    const script = __testing.buildDraftScript({
      internalId: 1,
      mailbox: 'q"u\\ote',
      account: 'a"b',
      body: 'c"d'
    })
    expect(script).toContain('mailbox "q\\"u\\\\ote"')
    expect(script).toContain('account "a\\"b"')
    expect(script).toContain('"c\\"d"')
  })
})

describe('classifyAppleScriptError', () => {
  test('automation-denied stderr → E_AUTOMATION_DENIED + actionable hint', () => {
    const c = __testing.classifyAppleScriptError({
      stderr: 'osascript is not allowed assistive access',
      message: 'osascript exit 1'
    })
    expect(c.code).toBe('E_AUTOMATION_DENIED')
    expect(c.message).toMatch(/System Settings/)
  })

  test('Mail not running → E_MAIL_NOT_RUNNING', () => {
    const c = __testing.classifyAppleScriptError({
      stderr: 'execution error: Mail got an error: Can’t get message',
      message: ''
    })
    expect(c.code).toBe('E_MAIL_NOT_RUNNING')
  })

  test('not_found error from our own throw → E_NOT_FOUND', () => {
    const c = __testing.classifyAppleScriptError({
      stderr: 'execution error: internal_id not found in any account',
      message: ''
    })
    expect(c.code).toBe('E_NOT_FOUND')
  })

  test('unknown stderr → E_APPLESCRIPT (default)', () => {
    const c = __testing.classifyAppleScriptError({
      stderr: 'segfault',
      message: 'osascript exit -1'
    })
    expect(c.code).toBe('E_APPLESCRIPT')
    expect(c.message).toContain('segfault')
  })
})
