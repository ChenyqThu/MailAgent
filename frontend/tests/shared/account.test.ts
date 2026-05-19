// Sprint 11 V1.4 — deriveAccount() pure-function unit tests.
//
// The nav-shell header + collapsed avatar both derive their visuals from
// one email string through `deriveAccount`. Regression here would silently
// break the badge + monogram across every page, so the matrix below
// covers the realistic and the pathological inputs.

import { describe, expect, test } from 'vitest'

import { deriveAccount } from '../../src/shared/lib/account'

describe('deriveAccount', () => {
  test('full domain with hyphen — splits at @ and the first dot', () => {
    expect(deriveAccount('lucien.chen@tp-link.com')).toEqual({
      localPart: 'lucien.chen',
      badge: 'tp-link',
      monogram: 'L'
    })
  })

  test('simple gmail address — local-part keeps digits, monogram uppercases', () => {
    expect(deriveAccount('s1021964827@gmail.com')).toEqual({
      localPart: 's1021964827',
      badge: 'gmail',
      monogram: 'S'
    })
  })

  test('multi-dot domain — badge is only the first segment', () => {
    expect(deriveAccount('me@mail.corp.example.com')).toEqual({
      localPart: 'me',
      badge: 'mail',
      monogram: 'M'
    })
  })

  test('null / undefined / empty — fallback monogram M, no badge', () => {
    const expected = { localPart: 'me', badge: '', monogram: 'M' }
    expect(deriveAccount(null)).toEqual(expected)
    expect(deriveAccount(undefined)).toEqual(expected)
    expect(deriveAccount('')).toEqual(expected)
  })

  test('no @ sign — same fallback as null/empty', () => {
    expect(deriveAccount('no-at-sign')).toEqual({
      localPart: 'me',
      badge: '',
      monogram: 'M'
    })
  })

  test('domain with no dot — badge takes the whole domain', () => {
    expect(deriveAccount('user@localhost')).toEqual({
      localPart: 'user',
      badge: 'localhost',
      monogram: 'U'
    })
  })
})
