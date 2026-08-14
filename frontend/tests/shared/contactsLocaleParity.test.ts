// 通讯录 i18n 两 locale 的 key 集合一致性闸（task 08-13 WP2，参照
// matterEventLocale 的形态）：`contacts` 子树在 zh-CN 与 en-US 里必须逐 key 相等
// —— 少一边 = 该语言下渲染出裸 key。设计规格 §5 的 key 表照单全收（含 merge/
// picker/profile 等后续 WP 的 key，一次加齐），两边只准一起演进。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'

function flattenKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

describe('contacts locale parity', () => {
  test('zh-CN 与 en-US 的 contacts 子树 key 集合完全一致', () => {
    const zh = (zhCN as Record<string, unknown>).contacts
    const en = (enUS as Record<string, unknown>).contacts
    // canary：子树整个消失（改名/搬家）必须红，不许平凡绿。
    expect(zh, 'zh-CN 缺 contacts 顶层块').toBeTruthy()
    expect(en, 'en-US 缺 contacts 顶层块').toBeTruthy()

    const zhKeys = new Set(flattenKeys(zh, 'contacts'))
    const enKeys = new Set(flattenKeys(en, 'contacts'))
    const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
    const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key))
    expect(missingInEn, 'en-US 缺 key（该语言会渲染裸 key）').toEqual([])
    expect(missingInZh, 'zh-CN 缺 key（该语言会渲染裸 key）').toEqual([])
  })

  test('settings.labs.contacts 三键两侧齐全', () => {
    for (const locale of [zhCN, enUS] as Array<Record<string, unknown>>) {
      const labs = (
        ((locale.settings as Record<string, unknown>)?.labs ?? {}) as Record<string, unknown>
      ).contacts as Record<string, unknown> | undefined
      expect(labs, 'settings.labs.contacts 缺块').toBeTruthy()
      for (const key of ['label', 'helper', 'restartHint']) {
        expect(typeof labs?.[key], `settings.labs.contacts.${key}`).toBe('string')
      }
    }
  })
})
