// Sprint 7 D1 — extracted envelope helpers contract. The three handler
// files (admin / calendar / write_ops) now import from lib/envelope; this
// suite locks the public surface so a regression breaks one file's worth
// of tests rather than three identical copies.

import { describe, expect, test, vi } from 'vitest'

// `cli_runner.CliError` is the one external dep `envelope.ts` references.
// Stub it minimally so we can construct one without firing up the real
// subprocess machinery.
vi.mock('../../src/electron/main/cli_runner', () => ({
  CliError: class CliErrorStub extends Error {
    errorCode: string
    hint?: string
    constructor(code: string, message: string, hint?: string) {
      super(message)
      this.errorCode = code
      this.hint = hint
    }
  }
}))

const { ensureInternalId, envelopeFromCli } = await import(
  '../../src/electron/main/lib/envelope'
)
const { CliError } = await import('../../src/electron/main/cli_runner')

describe('envelopeFromCli', () => {
  test('wraps a resolved promise as ok=true + data', async () => {
    const out = await envelopeFromCli(Promise.resolve({ page_id: 'abc' }))
    expect(out).toEqual({ ok: true, data: { page_id: 'abc' } })
  })

  test('CliError flows through with code + hint preserved', async () => {
    const err = new (CliError as new (
      code: string,
      msg: string,
      hint?: string
    ) => Error & { errorCode: string; hint?: string })(
      'E_AUTH',
      'auth failed',
      'set MAILAGENT_CLI_API_KEY'
    )
    const out = await envelopeFromCli(Promise.reject(err))
    expect(out).toEqual({
      ok: false,
      code: 'E_AUTH',
      message: 'auth failed',
      hint: 'set MAILAGENT_CLI_API_KEY'
    })
  })

  test('non-CliError reduces to E_DISPATCH', async () => {
    const out = await envelopeFromCli(Promise.reject(new Error('boom')))
    expect(out).toEqual({ ok: false, code: 'E_DISPATCH', message: 'boom' })
  })

  test('non-Error rejection falls through to String(err)', async () => {
    const out = await envelopeFromCli(Promise.reject('plain-string'))
    expect(out).toEqual({ ok: false, code: 'E_DISPATCH', message: 'plain-string' })
  })
})

describe('ensureInternalId', () => {
  test('accepts non-negative integer', () => {
    expect(ensureInternalId(42, 'test:channel')).toBe(42)
    expect(ensureInternalId(0, 'test:channel')).toBe(0)
  })

  test('rejects negative integer', () => {
    const out = ensureInternalId(-1, 'test:channel')
    expect(out).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG',
      message: expect.stringContaining('test:channel')
    })
  })

  test('rejects non-integer', () => {
    expect(ensureInternalId(1.5, 'test:channel')).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
    expect(ensureInternalId('42', 'test:channel')).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
    expect(ensureInternalId(null, 'test:channel')).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
    expect(ensureInternalId(undefined, 'test:channel')).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
  })

  test('error message echoes channel name + offending value', () => {
    const out = ensureInternalId(-5, 'admin:retry')
    if (out !== null && typeof out === 'object' && 'message' in out) {
      expect(out.message).toContain('admin:retry')
      expect(out.message).toContain('-5')
    } else {
      throw new Error('expected envelope error, got: ' + JSON.stringify(out))
    }
  })
})
