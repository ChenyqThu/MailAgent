// Sprint 7 D3 — command palette store + helpers.

import { describe, expect, test } from 'vitest'

import {
  closeCommandPalette,
  openCommandPalette,
  useCommandPalette
} from '../../src/shared/state/command-palette'

describe('command-palette store', () => {
  test('starts closed', () => {
    useCommandPalette.getState().setOpen(false)
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test('openCommandPalette flips open=true', () => {
    useCommandPalette.getState().setOpen(false)
    openCommandPalette()
    expect(useCommandPalette.getState().open).toBe(true)
  })

  test('closeCommandPalette flips open=false', () => {
    useCommandPalette.getState().setOpen(true)
    closeCommandPalette()
    expect(useCommandPalette.getState().open).toBe(false)
  })

  test('toggle flips between true/false', () => {
    useCommandPalette.getState().setOpen(false)
    useCommandPalette.getState().toggle()
    expect(useCommandPalette.getState().open).toBe(true)
    useCommandPalette.getState().toggle()
    expect(useCommandPalette.getState().open).toBe(false)
  })
})
