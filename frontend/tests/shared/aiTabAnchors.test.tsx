// @vitest-environment happy-dom
//
// 设置-AI 锚点清单的一致性闸（08-01 PR4 · T2 lane）。
//
// 为什么需要闸：SectionAnchorNav 会把「目标元素不存在」的条目**静默过滤掉** —— 这是它
// 处理 flag 门控区块的正确行为，代价是「id 打错 / 新增区块忘了列进 items」这两类错误
// **不会报错**，只会安静地少一行导航。两条断言各钉一种：
//   1. id 值唯一 —— 撞车 = 两个 wrapper 同 DOM id，跳转落到先出现的那个（错的区块）。
//   2. items 的 id 集合 ≡ AI_TAB_ANCHOR_IDS 的值集合 —— 少列 = 导航缺一行；多列 =
//      一条永远被过滤的死条目。

import { describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import {
  AI_TAB_ANCHOR_IDS,
  useAiTabAnchorItems
} from '../../src/shared/components/settings/aiTabAnchors'

describe('aiTabAnchors', () => {
  test('锚点 id 两两不重复', () => {
    const values = Object.values(AI_TAB_ANCHOR_IDS)
    expect(new Set(values).size).toBe(values.length)
  })

  test('items 的 id 集合与 AI_TAB_ANCHOR_IDS 完全一致', () => {
    const { result } = renderHook(() => useAiTabAnchorItems())
    const itemIds = result.current.map((it) => it.id)
    expect(new Set(itemIds).size).toBe(itemIds.length)
    expect([...itemIds].sort()).toEqual([...Object.values(AI_TAB_ANCHOR_IDS)].sort())
  })

  test('每个 item 都有非空 label（i18n key 缺失 → 导航渲染空条目）', () => {
    const { result } = renderHook(() => useAiTabAnchorItems())
    for (const item of result.current) {
      expect(item.label.length).toBeGreaterThan(0)
    }
  })
})
