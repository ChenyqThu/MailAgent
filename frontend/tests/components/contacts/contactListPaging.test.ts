// 通讯录列表 keyset 续拉的触发阈值（task 08-20 后端分页批）。
// 逻辑挂在 react-window 的 onRowsRendered 上，但判据本身是纯函数 —— 这里测的就是它。

import { describe, expect, test } from 'vitest'

import { shouldFetchNextContactPage } from '@shared/components/contacts/contactListModel'

describe('shouldFetchNextContactPage', () => {
  test('空列表不续拉（否则冷启动那一帧就会白发一次请求）', () => {
    expect(shouldFetchNextContactPage(0, 0)).toBe(false)
  })

  test('长列表按 70% 触发', () => {
    // 200 行 → min(floor(140), 192) = 140
    expect(shouldFetchNextContactPage(139, 200)).toBe(false)
    expect(shouldFetchNextContactPage(140, 200)).toBe(true)
  })

  test('短列表按「距底 8 行」触发（70% 那档在这里反而更晚）', () => {
    // 20 行 → min(floor(14), 12) = 12
    expect(shouldFetchNextContactPage(11, 20)).toBe(false)
    expect(shouldFetchNextContactPage(12, 20)).toBe(true)
  })

  test('列表短到不足 8 行时首屏就该续拉（阈值可为负，不能卡死在「永远不触发」）', () => {
    expect(shouldFetchNextContactPage(0, 3)).toBe(true)
  })
})
