// T3 — 群行「要不要亮」的判据（群列表行 / rail 群聊格 / peek 三处共用）：群行自己的未读
// （isSessionUnread 单源）‖ 底下有未读话题（serve-api 派生列 has_unread_threads，`=== true` 判真）。

import { describe, expect, test } from 'vitest'

import { isGroupRowUnread } from '../../src/shared/lib/groupUnread'

describe('isGroupRowUnread', () => {
  test('群行自己有未读 → true（与 isSessionUnread 同口径）', () => {
    expect(isGroupRowUnread({ updated_at: 2000, last_read_at: 1000 })).toBe(true)
  })

  test('群行已读但底下有未读话题 → true（话题回复不 bump 父群行，没这一半群列表永远不亮）', () => {
    expect(
      isGroupRowUnread({ updated_at: 2000, last_read_at: 2000, has_unread_threads: true })
    ).toBe(true)
    // 群行从未打开过（NULL 水位）也一样：话题那一半独立成立。
    expect(isGroupRowUnread({ updated_at: 2000, has_unread_threads: true })).toBe(true)
  })

  test('两半都没有 → false；派生列缺省 / false / 非 true 值一律不亮', () => {
    expect(isGroupRowUnread({ updated_at: 2000, last_read_at: 2000 })).toBe(false)
    expect(
      isGroupRowUnread({ updated_at: 2000, last_read_at: 2000, has_unread_threads: false })
    ).toBe(false)
    expect(isGroupRowUnread({ updated_at: 2000, last_read_at: null })).toBe(false)
    expect(
      isGroupRowUnread({
        updated_at: 2000,
        last_read_at: 2000,
        has_unread_threads: 1 as unknown as boolean
      })
    ).toBe(false)
  })
})
