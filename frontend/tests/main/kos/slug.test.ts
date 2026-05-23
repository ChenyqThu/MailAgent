// Sprint 19 PR-2f — Sender email → KOS slug helper tests.

import { describe, expect, test } from 'vitest'
import { senderToKosPeopleSlug } from '../../../src/electron/main/kos/slug'

describe('senderToKosPeopleSlug', () => {
  test('plain email', () => {
    expect(senderToKosPeopleSlug('bob@acme.com')).toBe('people/bob-acme-com')
  })

  test('uppercase normalized to lowercase', () => {
    expect(senderToKosPeopleSlug('BOB@ACME.COM')).toBe('people/bob-acme-com')
  })

  test('display-name in angle brackets stripped', () => {
    expect(senderToKosPeopleSlug('Bob <bob@acme.com>')).toBe('people/bob-bob-acme-com')
  })

  test('quoted display-name handled', () => {
    expect(senderToKosPeopleSlug('"Bob Acme" <bob@acme.com>')).toBe('people/bob-acme-bob-acme-com')
  })

  test('multiple consecutive punctuation collapsed', () => {
    expect(senderToKosPeopleSlug('bob...acme@@@example')).toBe('people/bob-acme-example')
  })

  test('plus-addressing and subdomain handled', () => {
    expect(senderToKosPeopleSlug('bob+ml@news.acme.co.uk')).toBe('people/bob-ml-news-acme-co-uk')
  })

  test('empty returns unknown', () => {
    expect(senderToKosPeopleSlug('')).toBe('people/unknown')
    expect(senderToKosPeopleSlug(null)).toBe('people/unknown')
    expect(senderToKosPeopleSlug(undefined)).toBe('people/unknown')
  })

  test('only punctuation returns unknown', () => {
    expect(senderToKosPeopleSlug('<<>>...@@@')).toBe('people/unknown')
  })

  test('custom prefix override (companies / projects / concepts)', () => {
    expect(senderToKosPeopleSlug('bob@acme.com', 'companies/')).toBe('companies/bob-acme-com')
    expect(senderToKosPeopleSlug('bob@acme.com', 'projects/')).toBe('projects/bob-acme-com')
    expect(senderToKosPeopleSlug('bob@acme.com', 'concepts/')).toBe('concepts/bob-acme-com')
  })

  test('non-string input safe', () => {
    expect(senderToKosPeopleSlug(123 as unknown as string)).toBe('people/unknown')
    expect(senderToKosPeopleSlug({} as unknown as string)).toBe('people/unknown')
  })
})
