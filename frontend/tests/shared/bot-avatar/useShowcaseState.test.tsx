// @vitest-environment happy-dom
//
// useShowcaseState（0813 随机动作巡演）契约：
//   active + 非 reduce → 0ms 即换第一个动作、按节拍持续换、恒在 SHOWCASE_STATES 池内、
//   不连续重复；inactive → 恒 'idle'；reduced-motion（全局 setup 默认）→ 恒 'idle'
//   （列表静态纪律不被 showcase 绕过）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook, act } from '@testing-library/react'

import {
  SHOWCASE_INTERVAL_MS,
  SHOWCASE_STATES,
  useShowcaseState
} from '../../../src/shared/bot-avatar/useShowcaseState'

function stubNoReduceMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null
      }) as unknown as MediaQueryList
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useShowcaseState', () => {
  test('active：0ms 起换动作、按节拍轮换、恒在池内且不连续重复', () => {
    stubNoReduceMatchMedia()
    vi.useFakeTimers()
    const { result } = renderHook(() => useShowcaseState(true))
    expect(result.current).toBe('idle') // 首帧（timer 未跑）

    act(() => {
      vi.advanceTimersByTime(0)
    })
    const first = result.current
    expect(SHOWCASE_STATES).toContain(first)

    let prev = first
    for (let i = 0; i < 8; i++) {
      act(() => {
        vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS)
      })
      const current = result.current
      expect(SHOWCASE_STATES).toContain(current)
      expect(current).not.toBe(prev)
      prev = current
    }
  })

  test('inactive：恒 idle，零定时器', () => {
    stubNoReduceMatchMedia()
    vi.useFakeTimers()
    const { result } = renderHook(() => useShowcaseState(false))
    act(() => {
      vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS * 3)
    })
    expect(result.current).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('active → inactive：立即回 idle', () => {
    stubNoReduceMatchMedia()
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ active }) => useShowcaseState(active), {
      initialProps: { active: true }
    })
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(result.current).not.toBe('idle')
    rerender({ active: false })
    expect(result.current).toBe('idle')
  })

  test('reduced-motion（全局 setup 默认 reduce）：active 也恒 idle', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useShowcaseState(true))
    act(() => {
      vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS * 3)
    })
    expect(result.current).toBe('idle')
  })
})
