// @vitest-environment happy-dom

// 阶段2·2.7 (F18/UX-P0④) — useCalendarShortcuts 新增 n/j/k/Enter 的契约:
//   - n → onNew (未接线时 no-op, 对应远程 web IS_WEB_BUILD 门控)
//   - j/k → onNextEvent/onPrevEvent (只动锚点, 不触发 onOpenSelected)
//   - Enter → onOpenSelected; 焦点在按钮/链接上让位原生激活
//   - INPUT/TEXTAREA/contentEditable 聚焦不劫持 (既有 guard 覆盖新键)
//   - ⌘/Ctrl/⌥ 修饰时让位 (⌘J chat modal / ⌘N compose 全局绑定同键)
//   - G 前缀序列进行中吞掉 j/k (g→j 是视图序列误键, 不是巡航)

import { describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useCalendarShortcuts } from '../../src/shared/components/calendar/hooks/useCalendarShortcuts'

type Handlers = Parameters<typeof useCalendarShortcuts>[0]

function makeHandlers(over: Partial<Handlers> = {}): Handlers {
  return {
    onView: vi.fn(),
    onToday: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onSync: vi.fn(),
    onHelp: vi.fn(),
    onEsc: vi.fn(),
    onNew: vi.fn(),
    onNextEvent: vi.fn(),
    onPrevEvent: vi.fn(),
    onOpenSelected: vi.fn(),
    ...over
  }
}

function press(spec: {
  key: string
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  target?: EventTarget
}): void {
  const evt = new KeyboardEvent('keydown', {
    key: spec.key,
    metaKey: spec.meta ?? false,
    ctrlKey: spec.ctrl ?? false,
    altKey: spec.alt ?? false,
    bubbles: true,
    cancelable: true
  })
  if (spec.target) Object.defineProperty(evt, 'target', { value: spec.target })
  window.dispatchEvent(evt)
}

function withHook(handlers: Handlers, run: () => void): void {
  const { unmount } = renderHook(() => useCalendarShortcuts(handlers))
  try {
    run()
  } finally {
    unmount()
  }
}

describe('useCalendarShortcuts — 2.7 n/j/k/Enter', () => {
  test('n fires onNew', () => {
    const h = makeHandlers()
    withHook(h, () => press({ key: 'n' }))
    expect(h.onNew).toHaveBeenCalledTimes(1)
  })

  test('n without onNew wired (web build) is a silent no-op', () => {
    const h = makeHandlers({ onNew: undefined })
    withHook(h, () => press({ key: 'n' }))
    expect(h.onNextEvent).not.toHaveBeenCalled()
    expect(h.onOpenSelected).not.toHaveBeenCalled()
  })

  test('j/k fire onNextEvent/onPrevEvent and never open the drawer', () => {
    const h = makeHandlers()
    withHook(h, () => {
      press({ key: 'j' })
      press({ key: 'j' })
      press({ key: 'k' })
    })
    expect(h.onNextEvent).toHaveBeenCalledTimes(2)
    expect(h.onPrevEvent).toHaveBeenCalledTimes(1)
    expect(h.onOpenSelected).not.toHaveBeenCalled()
  })

  test('Enter fires onOpenSelected', () => {
    const h = makeHandlers()
    withHook(h, () => press({ key: 'Enter' }))
    expect(h.onOpenSelected).toHaveBeenCalledTimes(1)
  })

  test('Enter on a focused button yields to native activation', () => {
    const h = makeHandlers()
    const btn = document.createElement('button')
    withHook(h, () => press({ key: 'Enter', target: btn }))
    expect(h.onOpenSelected).not.toHaveBeenCalled()
  })

  test('editable targets are not hijacked (input / textarea / contentEditable)', () => {
    const h = makeHandlers()
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    withHook(h, () => {
      for (const target of [input, textarea, div]) {
        press({ key: 'n', target })
        press({ key: 'j', target })
        press({ key: 'k', target })
        press({ key: 'Enter', target })
      }
    })
    expect(h.onNew).not.toHaveBeenCalled()
    expect(h.onNextEvent).not.toHaveBeenCalled()
    expect(h.onPrevEvent).not.toHaveBeenCalled()
    expect(h.onOpenSelected).not.toHaveBeenCalled()
  })

  test('modified n/j/k yield to global bindings (⌘J chat, ⌘N compose, ⌥ combos)', () => {
    const h = makeHandlers()
    withHook(h, () => {
      press({ key: 'j', meta: true })
      press({ key: 'n', meta: true })
      press({ key: 'k', ctrl: true })
      press({ key: 'j', alt: true })
    })
    expect(h.onNew).not.toHaveBeenCalled()
    expect(h.onNextEvent).not.toHaveBeenCalled()
    expect(h.onPrevEvent).not.toHaveBeenCalled()
  })

  test('j during a pending G-prefix sequence is consumed by the prefix, not nav', () => {
    const h = makeHandlers()
    withHook(h, () => {
      press({ key: 'g' })
      press({ key: 'j' })
    })
    expect(h.onNextEvent).not.toHaveBeenCalled()
    // 前缀已被消费, 后续 j 恢复巡航语义
    withHook(h, () => press({ key: 'j' }))
    expect(h.onNextEvent).toHaveBeenCalledTimes(1)
  })
})
