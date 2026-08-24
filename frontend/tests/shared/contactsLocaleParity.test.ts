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
})

// `agents.contactProfile` / `agents.contactGovernance` 是「事项」大 tab 下画像配置抽屉 /
// 治理配置抽屉的文案子树 —— 与上面的 `contacts` 子树是两棵不同的树（不同 tab、不同抽屉），
// 从没被上面那条测试覆盖过（task 08-24 收尾批，PRD §B-3 补的存量缺口）。
describe('agents.contactProfile / agents.contactGovernance locale parity', () => {
  test.each(['contactProfile', 'contactGovernance'] as const)(
    'zh-CN 与 en-US 的 agents.%s 子树 key 集合完全一致',
    (subtree) => {
      const zh = (zhCN as Record<string, unknown>).agents as Record<string, unknown> | undefined
      const en = (enUS as Record<string, unknown>).agents as Record<string, unknown> | undefined
      // canary：agents 顶层块或子树整个消失（改名/搬家）必须红，不许平凡绿。
      expect(zh, 'zh-CN 缺 agents 顶层块').toBeTruthy()
      expect(en, 'en-US 缺 agents 顶层块').toBeTruthy()
      expect(zh?.[subtree], `zh-CN 缺 agents.${subtree} 子树`).toBeTruthy()
      expect(en?.[subtree], `en-US 缺 agents.${subtree} 子树`).toBeTruthy()

      const zhKeys = new Set(flattenKeys(zh?.[subtree], `agents.${subtree}`))
      const enKeys = new Set(flattenKeys(en?.[subtree], `agents.${subtree}`))
      const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
      const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key))
      expect(missingInEn, 'en-US 缺 key（该语言会渲染裸 key）').toEqual([])
      expect(missingInZh, 'zh-CN 缺 key（该语言会渲染裸 key）').toEqual([])
    }
  )
})
