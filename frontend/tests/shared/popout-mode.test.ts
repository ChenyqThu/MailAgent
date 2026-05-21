// @vitest-environment happy-dom
//
// Sprint 14 PR E — popout-mode store + boot-from-query parser.
//
// `bootPopoutModeFromQuery` is called from renderer/main.tsx BEFORE
// React.render, so the parser has to be defensive against:
//   - missing query string (most renders, including hot-reload)
//   - popout=1 without email (malformed URL — main process always sets
//     both, but the parser shouldn't crash on a hand-typed URL)
//   - non-numeric email values (cosmic-ray bit flip; reject silently)
//   - negative email ids (internal_id is always >= 0 in our schema)
//
// We don't test main.tsx's call site directly — that's just a one-liner
// invocation. The store boundary is the contract.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { bootPopoutModeFromQuery, usePopoutMode } from '../../src/shared/state/popout-mode'

function setSearch(search: string): void {
  // happy-dom exposes window.location with mutable accessors; mirror the
  // main-process URL hand-off by writing the raw search string.
  window.history.replaceState({}, '', `${window.location.pathname}${search}`)
}

beforeEach(() => {
  setSearch('')
  // Reset only the data slots; passing `true` would replace the entire
  // store snapshot, dropping the `setPopout` action with it.
  usePopoutMode.setState({ isPopout: false, emailId: null })
})

afterEach(() => {
  setSearch('')
})

describe('bootPopoutModeFromQuery', () => {
  test('no query string → isPopout stays false', () => {
    const result = bootPopoutModeFromQuery()
    expect(result).toBeNull()
    expect(usePopoutMode.getState().isPopout).toBe(false)
    expect(usePopoutMode.getState().emailId).toBeNull()
  })

  test('popout=1 with valid email → store is hydrated', () => {
    setSearch('?popout=1&email=53675')
    const result = bootPopoutModeFromQuery()
    expect(result).toBe(53675)
    expect(usePopoutMode.getState().isPopout).toBe(true)
    expect(usePopoutMode.getState().emailId).toBe(53675)
  })

  test('popout=0 → not a popout, store untouched', () => {
    setSearch('?popout=0&email=53675')
    const result = bootPopoutModeFromQuery()
    expect(result).toBeNull()
    expect(usePopoutMode.getState().isPopout).toBe(false)
  })

  test('popout=1 without email → silently rejected', () => {
    setSearch('?popout=1')
    const result = bootPopoutModeFromQuery()
    expect(result).toBeNull()
    expect(usePopoutMode.getState().isPopout).toBe(false)
  })

  test('popout=1 with non-numeric email → silently rejected', () => {
    setSearch('?popout=1&email=abc')
    const result = bootPopoutModeFromQuery()
    expect(result).toBeNull()
    expect(usePopoutMode.getState().isPopout).toBe(false)
  })

  test('popout=1 with negative email id → silently rejected', () => {
    setSearch('?popout=1&email=-1')
    const result = bootPopoutModeFromQuery()
    expect(result).toBeNull()
    expect(usePopoutMode.getState().isPopout).toBe(false)
  })

  test('popout=1 with email=0 is accepted (0 is a valid internal_id)', () => {
    setSearch('?popout=1&email=0')
    const result = bootPopoutModeFromQuery()
    expect(result).toBe(0)
    expect(usePopoutMode.getState().isPopout).toBe(true)
    expect(usePopoutMode.getState().emailId).toBe(0)
  })
})

describe('usePopoutMode.setPopout', () => {
  test('setting popout flips the flag and stores the email id', () => {
    expect(usePopoutMode.getState().isPopout).toBe(false)
    usePopoutMode.getState().setPopout(42)
    expect(usePopoutMode.getState().isPopout).toBe(true)
    expect(usePopoutMode.getState().emailId).toBe(42)
  })
})
