// Sprint 7 D2 — SHORTCUTS SSoT shape contract. Locks the keys the help
// modal renders so a rename / removal of any binding doesn't break the
// modal silently.

import { describe, expect, test } from 'vitest'

import {
  SCOPE_ORDER,
  SHORTCUTS,
  getShortcutById,
  groupByScope,
  type ShortcutScope
} from '../../src/shared/keymap'

describe('SHORTCUTS catalog', () => {
  test('every binding has a unique id', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every binding has the required fields', () => {
    for (const def of SHORTCUTS) {
      expect(def.id).toBeTruthy()
      expect(def.spec).toBeTruthy()
      expect(def.display).toBeTruthy()
      expect(['global', 'inbox', 'row', 'chat', 'calendar', 'contacts']).toContain(def.scope)
      expect(def.labelKey).toMatch(/^shortcutHelp\.binding\./)
      expect(typeof def.wired).toBe('boolean')
    }
  })

  test('contains the DESIGN §9.5 headliners', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(ids).toContain('commandPalette')
    expect(ids).toContain('shortcutHelp')
    expect(ids).toContain('settings')
    expect(ids).toContain('nextEmail')
    expect(ids).toContain('prevEmail')
    expect(ids).toContain('translate')
    expect(ids).toContain('sendChat')
  })

  test('getShortcutById returns a typed match', () => {
    const cmdK = getShortcutById('commandPalette')
    expect(cmdK?.spec).toBe('cmd+k')
    expect(cmdK?.display).toBe('⌘K')
    expect(getShortcutById('missing-id')).toBeUndefined()
  })

  test('groupByScope splits by ShortcutScope without losing entries', () => {
    const grouped = groupByScope()
    const total = SCOPE_ORDER.reduce((sum, scope: ShortcutScope) => sum + grouped[scope].length, 0)
    expect(total).toBe(SHORTCUTS.length)
  })

  test('SCOPE_ORDER is exhaustive', () => {
    // 阶段2·2.7 — calendar scope 收编进统一登记面 (ux-benchmark §五-5)
    // WP2 — contacts scope（通讯录 j/k 导航）随 08-13 通讯录批收编。
    expect(SCOPE_ORDER).toEqual(['global', 'inbox', 'row', 'chat', 'calendar', 'contacts'])
  })
})
