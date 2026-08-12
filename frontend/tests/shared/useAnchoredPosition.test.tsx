// @vitest-environment happy-dom
//
// 0812 codex #7 —— 浮层打开期间锚点被响应式布局换掉 / 卸载了。
//
// 旧实现里 `measure()` 量不到锚点就直接 `return false`，**上一次算出来的坐标原样留着** ——
// 浮层连同它那层全屏遮罩就停在一个已经不存在的按钮旁边（还挡着底下的点击）。修复后：测不到
// 就把位置收成 null，调用方据此不渲染。

import { afterEach, describe, expect, test } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'

import { useAnchoredPosition } from '@shared/hooks/useAnchoredPosition'

afterEach(cleanup)

function anchorRefWith(node: HTMLElement | null): React.RefObject<HTMLElement | null> {
  const ref = createRef<HTMLElement | null>() as React.RefObject<HTMLElement | null>
  ref.current = node
  return ref
}

describe('useAnchoredPosition', () => {
  test('锚点在 → 算出位置；锚点消失后一次视口变化 → 收成 null（不停在旧坐标）', () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const ref = anchorRefWith(anchor)

    const { result } = renderHook(() => useAnchoredPosition(ref, true, { width: 200 }))
    expect(result.current).not.toBeNull()

    // 锚点被卸载（响应式布局换掉了那颗触发按钮）。
    anchor.remove()
    ref.current = null
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBeNull()
  })

  test('active=false → 位置恒 null（不挂监听、不留残影）', () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const { result } = renderHook(() =>
      useAnchoredPosition(anchorRefWith(anchor), false, { width: 200 })
    )
    expect(result.current).toBeNull()
  })
})
