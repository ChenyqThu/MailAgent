// Sprint 7 D2 — keyboard help store + module-level helpers.

import { describe, expect, test } from 'vitest'

import {
  closeKeyboardHelp,
  openKeyboardHelp,
  useKeyboardHelp
} from '../../src/shared/state/keyboard-help'

describe('keyboard-help store', () => {
  test('starts closed', () => {
    // Reset by closing first (other tests may have flipped the singleton).
    useKeyboardHelp.getState().setOpen(false)
    expect(useKeyboardHelp.getState().open).toBe(false)
  })

  test('openKeyboardHelp flips open=true', () => {
    useKeyboardHelp.getState().setOpen(false)
    openKeyboardHelp()
    expect(useKeyboardHelp.getState().open).toBe(true)
  })

  test('closeKeyboardHelp flips open=false', () => {
    useKeyboardHelp.getState().setOpen(true)
    closeKeyboardHelp()
    expect(useKeyboardHelp.getState().open).toBe(false)
  })

  test('setOpen idempotent on same value', () => {
    useKeyboardHelp.getState().setOpen(true)
    useKeyboardHelp.getState().setOpen(true)
    expect(useKeyboardHelp.getState().open).toBe(true)
    closeKeyboardHelp()
  })
})
