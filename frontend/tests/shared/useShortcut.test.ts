// @vitest-environment happy-dom

// Sprint 4 H-1 — `useShortcut` single keydown bus regression suite.
//
// Sprint 3 used per-component `useGlobalShortcuts` that each installed its
// own `document.keydown` listener. Sprint 4 adds ⌘L / ⌘↩ / ⌥A / ⌥B / ⌘N for
// AI chat (DESIGN §9.5) — running 5+ independent listeners that each have to
// re-walk the same evt for an early-return makes ordering brittle. This file
// pins the new contract:
//
//   - one shared module-level document.keydown listener (no listener leaks)
//   - LIFO precedence (latest registered handler fires first; lets a focused
//     panel hijack ⌘↩ ahead of a global "search send")
//   - opt-in `allowInEditable` for shortcuts that need to fire inside an
//     <input> / <textarea> (e.g. composer ⌘↩)
//   - macOS `⌥T` emits the dead-key glyph `†` as `evt.key`; spec 'alt+t'
//     must still match (REVIEW-LOG H-1 carry-forward from Sprint 3
//     useGlobalShortcuts)

import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useShortcut, __resetShortcutBus } from '../../src/shared/hooks/useShortcut'

function key(spec: {
  key: string
  meta?: boolean
  alt?: boolean
  shift?: boolean
  target?: EventTarget | null
}): KeyboardEvent {
  const evt = new KeyboardEvent('keydown', {
    key: spec.key,
    metaKey: spec.meta ?? false,
    altKey: spec.alt ?? false,
    shiftKey: spec.shift ?? false,
    bubbles: true,
    cancelable: true
  })
  if (spec.target) Object.defineProperty(evt, 'target', { value: spec.target })
  return evt
}

function dispatch(evt: KeyboardEvent): void {
  document.dispatchEvent(evt)
}

beforeEach(() => {
  __resetShortcutBus()
})

afterEach(() => {
  __resetShortcutBus()
})

describe('useShortcut — single bus, multi handler', () => {
  test('single handler fires on matching key', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('cmd+k', handler))
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('non-matching key never fires', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('cmd+k', handler))
    dispatch(key({ key: 'j', meta: true }))
    dispatch(key({ key: 'k', meta: false }))
    dispatch(key({ key: 'k', alt: true }))
    expect(handler).not.toHaveBeenCalled()
  })

  test('two handlers on different keys both fire independently', () => {
    const onK = vi.fn()
    const onT = vi.fn()
    renderHook(() => useShortcut('cmd+k', onK))
    renderHook(() => useShortcut('alt+t', onT))
    dispatch(key({ key: 'k', meta: true }))
    expect(onK).toHaveBeenCalledTimes(1)
    expect(onT).not.toHaveBeenCalled()
    dispatch(key({ key: 't', alt: true }))
    expect(onT).toHaveBeenCalledTimes(1)
  })

  test('LIFO precedence: latest handler wins when both match the same spec', () => {
    const order: string[] = []
    const earlier = vi.fn(() => {
      order.push('earlier')
    })
    const later = vi.fn(() => {
      order.push('later')
      return true // consume → earlier should NOT fire
    })
    renderHook(() => useShortcut('cmd+enter', earlier))
    renderHook(() => useShortcut('cmd+enter', later))
    dispatch(key({ key: 'Enter', meta: true }))
    expect(order).toEqual(['later'])
    expect(earlier).not.toHaveBeenCalled()
  })

  test('LIFO precedence: later handler that returns nothing still blocks via preventDefault', () => {
    const order: string[] = []
    const earlier = vi.fn(() => {
      order.push('earlier')
    })
    const later = vi.fn((evt: KeyboardEvent) => {
      order.push('later')
      evt.preventDefault()
    })
    renderHook(() => useShortcut('cmd+enter', earlier))
    renderHook(() => useShortcut('cmd+enter', later))
    dispatch(key({ key: 'Enter', meta: true }))
    expect(order).toEqual(['later'])
    expect(earlier).not.toHaveBeenCalled()
  })

  test('LIFO: later handler with no consume → falls through to earlier', () => {
    const order: string[] = []
    const earlier = vi.fn(() => {
      order.push('earlier')
    })
    const later = vi.fn(() => {
      order.push('later')
    })
    renderHook(() => useShortcut('cmd+enter', earlier))
    renderHook(() => useShortcut('cmd+enter', later))
    dispatch(key({ key: 'Enter', meta: true }))
    expect(order).toEqual(['later', 'earlier'])
  })

  test('unmount unregisters its handler', () => {
    const handler = vi.fn()
    const { unmount } = renderHook(() => useShortcut('cmd+k', handler))
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).toHaveBeenCalledTimes(1)
    unmount()
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).toHaveBeenCalledTimes(1) // still 1 — unregistered
  })

  test('unmount one of two handlers leaves the other intact', () => {
    const a = vi.fn()
    const b = vi.fn()
    renderHook(() => useShortcut('cmd+k', a))
    const second = renderHook(() => useShortcut('cmd+k', b))
    second.unmount()
    dispatch(key({ key: 'k', meta: true }))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })
})

describe('useShortcut — editable target gating', () => {
  function inInput(): HTMLInputElement {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    return input
  }

  test('default: skips when target is <input>', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('alt+t', handler))
    const input = inInput()
    dispatch(key({ key: 't', alt: true, target: input }))
    expect(handler).not.toHaveBeenCalled()
  })

  test('default: skips when target is <textarea>', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('alt+t', handler))
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    dispatch(key({ key: 't', alt: true, target: ta }))
    expect(handler).not.toHaveBeenCalled()
  })

  test('default: skips when target is contenteditable', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('alt+t', handler))
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    dispatch(key({ key: 't', alt: true, target: div }))
    expect(handler).not.toHaveBeenCalled()
  })

  test('allowInEditable: composer ⌘↩ fires inside <textarea>', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('cmd+enter', handler, { allowInEditable: true }))
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    dispatch(key({ key: 'Enter', meta: true, target: ta }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('⌘+key combos auto-allow in editable (matches macOS UX expectation)', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('cmd+k', handler))
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    dispatch(key({ key: 'k', meta: true, target: ta }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('useShortcut — modifier matching strictness', () => {
  test('cmd+k does not fire on ctrl+k unless explicitly opted', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('cmd+k', handler))
    // ctrl-only (no meta) — must not fire on macOS spec
    const evt = key({ key: 'k', meta: false })
    Object.defineProperty(evt, 'ctrlKey', { value: true })
    dispatch(evt)
    expect(handler).not.toHaveBeenCalled()
  })

  test('ctrl alias: spec accepts both "cmd+k" and "ctrl+k" — cross-platform', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('ctrl+k', handler))
    // Either ctrl OR meta fires (so Windows/Linux on the V2 web build still works)
    const ctrlEvt = key({ key: 'k' })
    Object.defineProperty(ctrlEvt, 'ctrlKey', { value: true })
    dispatch(ctrlEvt)
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).toHaveBeenCalledTimes(2)
  })

  test('shift modifier matched strictly', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('shift+/', handler))
    dispatch(key({ key: '/' }))
    expect(handler).not.toHaveBeenCalled()
    dispatch(key({ key: '/', shift: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('useShortcut — macOS dead-key alt glyphs', () => {
  test('⌥T emitting "†" as evt.key still matches "alt+t"', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('alt+t', handler))
    dispatch(key({ key: '†', alt: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('⌥K emitting "˚" still matches "alt+k"', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('alt+k', handler))
    dispatch(key({ key: '˚', alt: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('alt+letter is case-insensitive (alt+T fires)', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('alt+t', handler))
    dispatch(key({ key: 'T', alt: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('useShortcut — listener lifecycle', () => {
  test('the document.keydown listener is only installed once across many hooks', () => {
    const spy = vi.spyOn(document, 'addEventListener')
    spy.mockClear()
    renderHook(() => useShortcut('cmd+k', () => {}))
    renderHook(() => useShortcut('alt+t', () => {}))
    renderHook(() => useShortcut('cmd+enter', () => {}, { allowInEditable: true }))
    const keydownInstalls = spy.mock.calls.filter((c) => c[0] === 'keydown')
    // Bus installs at most once for the lifetime of the test (after the
    // bus-level reset in beforeEach). renderHook itself may add unrelated
    // listeners; we only care about 'keydown'.
    expect(keydownInstalls.length).toBeLessThanOrEqual(1)
    spy.mockRestore()
  })

  test('preventDefault on a matched handler stops native default', () => {
    const evt = key({ key: 'k', meta: true })
    const pd = vi.spyOn(evt, 'preventDefault')
    const handler = vi.fn((e: KeyboardEvent) => e.preventDefault())
    renderHook(() => useShortcut('cmd+k', handler))
    dispatch(evt)
    expect(pd).toHaveBeenCalled()
  })

  test('enabled=false skips registration (no fire even if key matches)', () => {
    const handler = vi.fn()
    renderHook(() => useShortcut('cmd+k', handler, { enabled: false }))
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).not.toHaveBeenCalled()
  })

  test('toggling enabled re-registers / unregisters cleanly', () => {
    const handler = vi.fn()
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useShortcut('cmd+k', handler, { enabled }),
      { initialProps: { enabled: false } }
    )
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).not.toHaveBeenCalled()
    rerender({ enabled: true })
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    dispatch(key({ key: 'k', meta: true }))
    expect(handler).toHaveBeenCalledTimes(1) // still 1 — disabled
  })
})
