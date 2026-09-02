// 实验室 i18n 闸（形态照 `groupChatLocaleParity`）。
//
// `settings.labs.*` 此前没有任何闸：漏一边的表现是那个语言下渲染裸 key（`settings.labs.werewolf.cta`
// 这样一串字直接出现在按钮上），没有任何类型错误会拦住它。狼人杀一键建局往这个子树里插了七个键，
// 顺手把整棵子树钉住。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'

/** 狼人杀入口用到的七个 key（组件逐个 t() 它们，缺一即裸 key）。 */
const WEREWOLF_KEYS = [
  'label',
  'helper',
  'cta',
  'creating',
  'created',
  'partial',
  'failed'
] as const

function flattenKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

function labsTree(locale: Record<string, unknown>): unknown {
  const settings = locale.settings as Record<string, unknown> | undefined
  return settings?.labs
}

const LOCALES = [
  ['zh-CN', zhCN as Record<string, unknown>],
  ['en-US', enUS as Record<string, unknown>]
] as const

describe('settings.labs locale parity', () => {
  test('zh-CN 与 en-US 的 settings.labs 子树 key 集合完全一致', () => {
    const zhTree = labsTree(zhCN as Record<string, unknown>)
    const enTree = labsTree(enUS as Record<string, unknown>)
    // canary：子树整个消失（改名 / 搬家）必须红，不许平凡绿。
    expect(zhTree, 'zh-CN 缺 settings.labs 子树').toBeTruthy()
    expect(enTree, 'en-US 缺 settings.labs 子树').toBeTruthy()

    const zhKeys = new Set(flattenKeys(zhTree, 'settings.labs'))
    const enKeys = new Set(flattenKeys(enTree, 'settings.labs'))
    expect(
      [...zhKeys].filter((k) => !enKeys.has(k)),
      'en-US 缺 key（那边渲染裸 key）'
    ).toEqual([])
    expect(
      [...enKeys].filter((k) => !zhKeys.has(k)),
      'zh-CN 缺 key（那边渲染裸 key）'
    ).toEqual([])
  })

  test('settings.labs.werewolf 七键两侧都非空', () => {
    for (const [name, locale] of LOCALES) {
      const tree = labsTree(locale) as Record<string, unknown> | undefined
      const werewolf = tree?.werewolf as Record<string, unknown> | undefined
      expect(werewolf, `${name} 缺 settings.labs.werewolf`).toBeTruthy()
      for (const key of WEREWOLF_KEYS) {
        const value = werewolf?.[key]
        expect(typeof value === 'string' && value.length > 0, `${name} 缺 werewolf.${key}`).toBe(
          true
        )
      }
    }
  })
})
