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

// 通知中心 M2 批 B5 —— 同一个 store 上的第二条轴（治理队列抽屉）。ContactsWorkspace 的
// 两个 effect 各订阅一条，两条轴必须**互不干扰**：一条落地清掉另一条，就会出现
// 「点通知开了队列、却把用户点名要看的那个人吃掉」这种谁也复现不了的串味。
describe('useContactNavigation — 治理队列轴', () => {
  test('initial queueRequested is false', () => {
    expect(useContactNavigation.getState().queueRequested).toBe(false)
  })

  test('openQueue() 置位；clearQueue() 复位', () => {
    useContactNavigation.getState().openQueue()
    expect(useContactNavigation.getState().queueRequested).toBe(true)
    useContactNavigation.getState().clearQueue()
    expect(useContactNavigation.getState().queueRequested).toBe(false)
  })

  test('两条轴互不干扰：清一条不动另一条', () => {
    useContactNavigation.getState().open(11)
    useContactNavigation.getState().openQueue()

    useContactNavigation.getState().clearQueue()
    expect(useContactNavigation.getState().targetContactId).toBe(11)

    useContactNavigation.getState().openQueue()
    useContactNavigation.getState().clear()
    expect(useContactNavigation.getState().queueRequested).toBe(true)

    useContactNavigation.getState().clearQueue()
  })
})
