// @vitest-environment happy-dom

// Phase 0 基础设施回归 — useExitAnimation 的延迟卸载状态机。
//
// 这个 hook 是 GSAP 升级里复用最广的一块（7+ overlay 共用），它的核心契约不是
// "动画好不好看"（GSAP 自己保证），而是 shouldRender 状态机：
//   - isOpen=true  → 立刻挂载（播进场）
//   - isOpen=false → 保持挂载播退场，onComplete 后才真正卸载
//   - reduced-motion → 跳过动画，直接切换
// 必须挂载真实 DOM 节点（scopeRef 有 .current）退场分支才会跑，所以用 harness
// 组件而非裸 renderHook。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, act } from '@testing-library/react'

import { useExitAnimation } from '../../src/shared/hooks/useExitAnimation'

let reduceMatches = false

function mockMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('reduce') ? reduceMatches : false,
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

function Harness({ open }: { open: boolean }): React.ReactElement | null {
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open)
  if (!shouldRender) return null
  return <div ref={scopeRef} data-testid="overlay" />
}

beforeEach(() => {
  reduceMatches = false
  mockMatchMedia()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useExitAnimation — 延迟卸载状态机', () => {
  test('初始 open=false → 不渲染', () => {
    render(<Harness open={false} />)
    expect(screen.queryByTestId('overlay')).toBeNull()
  })

  test('初始 open=true → 渲染', () => {
    render(<Harness open={true} />)
    expect(screen.queryByTestId('overlay')).not.toBeNull()
  })

  test('open false→true 挂载', async () => {
    const { rerender } = render(<Harness open={false} />)
    expect(screen.queryByTestId('overlay')).toBeNull()
    rerender(<Harness open={true} />)
    await waitFor(() => expect(screen.queryByTestId('overlay')).not.toBeNull())
  })

  test('reduced-motion: open true→false 立即卸载（无退场动画）', async () => {
    reduceMatches = true
    const { rerender } = render(<Harness open={true} />)
    expect(screen.queryByTestId('overlay')).not.toBeNull()
    await act(async () => {
      rerender(<Harness open={false} />)
    })
    await waitFor(() => expect(screen.queryByTestId('overlay')).toBeNull())
  })

  test('正常退场: open true→false 先保持挂载再延迟卸载', async () => {
    const { rerender } = render(<Harness open={true} />)
    expect(screen.queryByTestId('overlay')).not.toBeNull()
    rerender(<Harness open={false} />)
    // 退场动画进行中仍在 DOM
    expect(screen.queryByTestId('overlay')).not.toBeNull()
    // 动画播完（DUR.fast=120ms）后才卸载
    await waitFor(() => expect(screen.queryByTestId('overlay')).toBeNull(), { timeout: 2000 })
  })
})
