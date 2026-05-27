// Compose — `email draft|send` argv builder + opts validation.
//
// Locks in the CLI contract the renderer depends on:
//   - composeArgs() exact argv shape per mode / recipients / subject / dry-run
//   - --yes is only appended for the send verb (via withYes)
//   - empty recipient arrays are NOT passed (CLI keeps derived recipients)
//   - validateComposeOpts rejects bad internalId / mode before forking

import { describe, expect, test } from 'vitest'

import { __testing } from '../../src/electron/main/handlers/draft'
import type { ComposeDraftOpts } from '@shared/api/types'

const { composeArgs, validateComposeOpts } = __testing

describe('composeArgs — argv shape', () => {
  test('minimal reply = ["email","draft","<id>","--mode","reply"]', () => {
    expect(composeArgs('draft', { internalId: 53675, mode: 'reply' })).toEqual([
      'email',
      'draft',
      '53675',
      '--mode',
      'reply'
    ])
  })

  test('reply-all with to/cc/bcc joins arrays with commas', () => {
    const opts: ComposeDraftOpts = {
      internalId: 1,
      mode: 'reply-all',
      to: ['a@b.com', 'c@d.com'],
      cc: ['e@f.com'],
      bcc: ['g@h.com']
    }
    expect(composeArgs('draft', opts)).toEqual([
      'email',
      'draft',
      '1',
      '--mode',
      'reply-all',
      '--to',
      'a@b.com,c@d.com',
      '--cc',
      'e@f.com',
      '--bcc',
      'g@h.com'
    ])
  })

  test('empty recipient arrays are not passed', () => {
    const args = composeArgs('draft', { internalId: 1, mode: 'reply', to: [], cc: [] })
    expect(args).not.toContain('--to')
    expect(args).not.toContain('--cc')
    expect(args).not.toContain('--bcc')
  })

  test('subject (incl. empty string) is forwarded verbatim', () => {
    const args = composeArgs('draft', { internalId: 1, mode: 'reply', subject: 'Re: x' })
    expect(args[args.indexOf('--subject') + 1]).toBe('Re: x')
    // empty string still overrides the Re:/Fwd: auto-prefix → must be passed
    const empty = composeArgs('draft', { internalId: 1, mode: 'reply', subject: '' })
    expect(empty).toContain('--subject')
    expect(empty[empty.indexOf('--subject') + 1]).toBe('')
  })

  test('dry-run appends --dry-run', () => {
    const args = composeArgs('draft', { internalId: 1, mode: 'forward' }, { dryRun: true })
    expect(args).toContain('--dry-run')
  })

  test('send verb with withYes appends --yes', () => {
    const args = composeArgs('send', { internalId: 1, mode: 'forward', to: ['x@y.z'] }, { withYes: true })
    expect(args[0]).toBe('email')
    expect(args[1]).toBe('send')
    expect(args).toContain('--yes')
    expect(args).toContain('--to')
  })

  test('draft verb never auto-appends --yes', () => {
    expect(composeArgs('draft', { internalId: 1, mode: 'reply' })).not.toContain('--yes')
  })
})

describe('validateComposeOpts — guards', () => {
  test('valid opts pass through unchanged', () => {
    const opts: ComposeDraftOpts = { internalId: 5, mode: 'reply' }
    expect(validateComposeOpts(opts, 'email:draft')).toBe(opts)
  })

  test('missing opts → E_INVALID_ARG envelope', () => {
    const out = validateComposeOpts(undefined, 'email:draft')
    expect(out).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('negative internalId → E_INVALID_ARG', () => {
    const out = validateComposeOpts({ internalId: -1, mode: 'reply' }, 'email:draft')
    expect(out).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('bad mode → E_INVALID_ARG', () => {
    const out = validateComposeOpts(
      { internalId: 1, mode: 'bogus' as ComposeDraftOpts['mode'] },
      'email:send'
    )
    expect(out).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })
})
