// 通讯录 WP4 —— 人物页直达通道 store（镜像 matters/navigation 的形状）。
// 消费方（ContactsWorkspace effect）依赖「open 落 target → 消费即 clear」这条
// 时序契约；这里钉纯 store 逻辑。

import { describe, expect, test } from 'vitest'

import { useContactNavigation } from '../../src/shared/components/contacts/navigation'

describe('useContactNavigation', () => {
  test('initial target is null', () => {
    expect(useContactNavigation.getState().targetContactId).toBeNull()
  })

  test('open(id) stamps the target; clear() resets', () => {
    useContactNavigation.getState().open(42)
    expect(useContactNavigation.getState().targetContactId).toBe(42)
    useContactNavigation.getState().clear()
    expect(useContactNavigation.getState().targetContactId).toBeNull()
  })

  test('successive open() calls keep the latest target', () => {
    useContactNavigation.getState().open(1)
    useContactNavigation.getState().open(7)
    expect(useContactNavigation.getState().targetContactId).toBe(7)
    useContactNavigation.getState().clear()
  })
})
