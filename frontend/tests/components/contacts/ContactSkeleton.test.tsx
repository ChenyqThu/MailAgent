// @vitest-environment happy-dom
//
// 通讯录骨架屏（v2 任务 ③）。两件真会出错的事：
//   ① **行数按可视高度算**，不是固定 8 —— 原型 NOTES 裁量 7 的落地提醒：高窗口下固定 8 行
//      会被读成「这个库只有 8 个人」；
//   ② 行高随密度档走（compact 52 / comfortable 68），几何对不上就是白闪一下再跳版。
//
// 🔴 骨架条挂的是 `.contact-skel .shimmer` 两个类：`.shimmer` 出动效，`.contact-skel` 是本模块
// 自己的 reduced-motion 关停钩子（全局 `.shimmer` 有十几处别的消费方，本批不动它）。少挂
// `.contact-skel` = reduced-motion 下满屏还在闪，而这件事**用眼睛看不出来**（要开系统开关），
// 所以在这里钉住。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import {
  ContactDetailSkeleton,
  ContactListSkeleton
} from '@shared/components/contacts/ContactSkeleton'

afterEach(cleanup)

/** happy-dom 的 `clientHeight` 恒 0（布局引擎不跑）。骨架在 layout effect 里量高度，所以要在
 *  **render 之前**把原型上的 getter 换掉，render 之后再补装是量不到的。 */
function withViewportHeight(height: number, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => height
  })
  try {
    body()
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  }
}

function rows(): HTMLElement[] {
  const host = screen.getByTestId('contact-list-skeleton')
  return Array.from(host.children) as HTMLElement[]
}

describe('ContactListSkeleton', () => {
  test('量不到可视高度（首帧 / happy-dom）→ 回落 8 行，不是 0 行', () => {
    render(<ContactListSkeleton density="compact" />)
    expect(rows()).toHaveLength(8)
  })

  test('🔴 行数按可视高度算：624px / 52 = 12 行，不是固定 8', () => {
    withViewportHeight(624, () => {
      render(<ContactListSkeleton density="compact" />)
      expect(rows()).toHaveLength(12)
    })
  })

  test('🔴 comfortable 档行高 68（走 contactRowHeight；rowHeightFor(undefined,…) 恒回 52 是坑）', () => {
    render(<ContactListSkeleton density="comfortable" />)
    expect(rows()[0]?.style.height).toBe('68px')
  })

  test('compact 档行高 52', () => {
    render(<ContactListSkeleton density="compact" />)
    expect(rows()[0]?.style.height).toBe('52px')
  })

  test('🔴 同一可视高度下 comfortable 比 compact 少画几行（行高真的进了算式）', () => {
    withViewportHeight(624, () => {
      render(<ContactListSkeleton density="comfortable" />)
      // ceil(624 / 68) = 10
      expect(rows()).toHaveLength(10)
    })
  })

  test('🔴 每根骨架条都挂 .contact-skel（reduced-motion 关停钩子）与 .shimmer', () => {
    const { container } = render(<ContactListSkeleton density="compact" />)
    const shimmering = Array.from(container.querySelectorAll('.shimmer'))
    // canary：确实画出了骨架条，下面那条断言不是在空集合上恒真。
    expect(shimmering.length).toBeGreaterThan(0)
    expect(shimmering.every((node) => node.classList.contains('contact-skel'))).toBe(true)
  })
})

describe('ContactDetailSkeleton', () => {
  test('每根骨架条同样挂 .contact-skel', () => {
    const { container } = render(<ContactDetailSkeleton />)
    const shimmering = Array.from(container.querySelectorAll('.shimmer'))
    expect(shimmering.length).toBeGreaterThan(0)
    expect(shimmering.every((node) => node.classList.contains('contact-skel'))).toBe(true)
  })
})
