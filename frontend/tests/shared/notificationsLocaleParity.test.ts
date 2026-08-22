// 通知中心 i18n 闸（M2 批 B5，形态照 contactsLocaleParity）。两件事：
//   ① `notifications` 子树在 zh-CN 与 en-US 里逐 key 相等 —— 少一边 = 该语言渲染裸 key。
//   ② **每个 tab 都有文案**。tab 集是从 `NOTIFICATION_CATEGORY_VALUES` 派生的（见
//      notificationModel），加一个 category 时 tab 行自动多一格 —— 忘了补文案的表现就是
//      面板上多出一个写着 `notifications.tab.xxx` 的格子，而没有任何类型错误会拦住它。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'
import { NOTIFICATION_TAB_IDS } from '@shared/components/notifications/notificationModel'

function flattenKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

const zhTree = (zhCN as Record<string, unknown>).notifications
const enTree = (enUS as Record<string, unknown>).notifications

describe('notifications locale parity', () => {
  test('zh-CN 与 en-US 的 notifications 子树 key 集合完全一致', () => {
    // canary：子树整个消失（改名/搬家）必须红，不许平凡绿。
    expect(zhTree, 'zh-CN 缺 notifications 顶层块').toBeTruthy()
    expect(enTree, 'en-US 缺 notifications 顶层块').toBeTruthy()

    const zhKeys = new Set(flattenKeys(zhTree, 'notifications'))
    const enKeys = new Set(flattenKeys(enTree, 'notifications'))
    expect(
      [...zhKeys].filter((key) => !enKeys.has(key)),
      'en-US 缺 key（该语言会渲染裸 key）'
    ).toEqual([])
    expect(
      [...enKeys].filter((key) => !zhKeys.has(key)),
      'zh-CN 缺 key（该语言会渲染裸 key）'
    ).toEqual([])
  })

  test('每个 tab id 在两份 locale 里都有非空文案', () => {
    for (const tree of [zhTree, enTree]) {
      const tabs = (tree as { tab?: Record<string, unknown> }).tab
      expect(tabs, 'locale 缺 notifications.tab 块').toBeTruthy()
      for (const id of NOTIFICATION_TAB_IDS) {
        const label = tabs?.[id]
        expect(typeof label === 'string' && label.length > 0, `缺 tab 文案: ${id}`).toBe(true)
      }
    }
  })
})
