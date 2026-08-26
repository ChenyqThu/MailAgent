// 例外面 i18n 闸（L4 批次 2，形态照 `notificationsLocaleParity` / `contactsLocaleParity`）。
// 三件事：
//   ① `today` 子树在 zh-CN 与 en-US 里逐 key 相等 —— 少一边 = 该语言渲染裸 key。
//   ② **每个分组都有组头文案**。组集派生自 `TODAY_GROUP_IDS`，加一组时页面自动多一段，
//      忘了补文案的表现就是屏幕上多出一行写着 `today.group.xxx` 的组头，没有任何类型错误
//      会拦住它。
//   ③ 信号 triage 菜单的三条文案**指向事项域既有的 key** 且两个 locale 都解得出来 ——
//      那三个词有语义后果（`attention.py` 的抑制律），复用而不是另写一套。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'
import { MATTER_ITEM_DISPATCH_STATES } from '@shared/api/types/matter'
import { MATTER_EXEC_PROFILE_OPTIONS } from '@shared/components/matters/matterDispatchVocab'
import { TODAY_GROUP_IDS } from '@shared/components/today/todayGroups'
import { TODAY_SIGNAL_ACTION_LABEL_KEY } from '@shared/components/today/todayVocab'

function flattenKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

function lookup(locale: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (node === null || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, locale)
}

const zhTree = (zhCN as Record<string, unknown>).today
const enTree = (enUS as Record<string, unknown>).today

describe('today locale parity', () => {
  test('zh-CN 与 en-US 的 today 子树 key 集合完全一致', () => {
    // canary：子树整个消失（改名/搬家）必须红，不许平凡绿。
    expect(zhTree, 'zh-CN 缺 today 顶层块').toBeTruthy()
    expect(enTree, 'en-US 缺 today 顶层块').toBeTruthy()

    const zhKeys = new Set(flattenKeys(zhTree, 'today'))
    const enKeys = new Set(flattenKeys(enTree, 'today'))
    expect(
      [...zhKeys].filter((key) => !enKeys.has(key)),
      'en-US 缺 key（该语言会渲染裸 key）'
    ).toEqual([])
    expect(
      [...enKeys].filter((key) => !zhKeys.has(key)),
      'zh-CN 缺 key（该语言会渲染裸 key）'
    ).toEqual([])
  })

  test('每个分组 id 在两份 locale 里都有非空组头文案', () => {
    for (const tree of [zhTree, enTree]) {
      const groups = (tree as { group?: Record<string, unknown> }).group
      expect(groups, 'locale 缺 today.group 块').toBeTruthy()
      for (const id of TODAY_GROUP_IDS) {
        const label = groups?.[id]
        expect(typeof label === 'string' && label.length > 0, `缺分组文案: ${id}`).toBe(true)
      }
    }
  })

  test('信号 triage 菜单复用事项域既有文案 key（两个 locale 都解得出来）', () => {
    for (const [name, locale] of [
      ['zh-CN', zhCN as Record<string, unknown>],
      ['en-US', enUS as Record<string, unknown>]
    ] as const) {
      for (const key of Object.values(TODAY_SIGNAL_ACTION_LABEL_KEY)) {
        expect(key.startsWith('matters.attention.'), `不是事项域的 key: ${key}`).toBe(true)
        expect(lookup(locale, key), `${name} 缺 ${key}`).toBeTruthy()
      }
    }
  })
})

// ───────────── L4 批次3 · 派发（第四源 + 详情页执行契约面） ─────────────
//
// 两条闸：
//   ① 执行态词表的每个值在两份 locale 里都有徽标文案 —— 词表在后端 canonical、TS 只是镜像，
//      加一个态而忘了补文案的表现是屏幕上出现一颗写着 `matters.dispatch.state.xxx` 的徽标，
//      没有任何类型错误会拦住它（`MATTER_DISPATCH_STATE_TONES` 只逼你补色，不逼你补词）。
//   ② UI 上真的会渲染的执行档（`MATTER_EXEC_PROFILE_OPTIONS`，两档）标题 + 说明都在场。
//      🔴 断言用的是**那张 UI 表**而不是完整词表：`edit_with_approval` 有意不上 UI。

describe('派发 locale', () => {
  test('每个执行态在两份 locale 里都有徽标文案', () => {
    for (const [name, locale] of [
      ['zh-CN', zhCN as Record<string, unknown>],
      ['en-US', enUS as Record<string, unknown>]
    ] as const) {
      for (const state of MATTER_ITEM_DISPATCH_STATES) {
        const label = lookup(locale, `matters.dispatch.state.${state}`)
        expect(typeof label === 'string' && label.length > 0, `${name} 缺 ${state} 文案`).toBe(true)
      }
    }
  })

  test('上 UI 的两档执行档有标题与说明；edit_with_approval 不在 UI 表里', () => {
    expect([...MATTER_EXEC_PROFILE_OPTIONS]).not.toContain('edit_with_approval')
    for (const [name, locale] of [
      ['zh-CN', zhCN as Record<string, unknown>],
      ['en-US', enUS as Record<string, unknown>]
    ] as const) {
      for (const option of MATTER_EXEC_PROFILE_OPTIONS) {
        expect(
          lookup(locale, `matters.dispatch.profiles.${option}`),
          `${name} 缺 ${option}`
        ).toBeTruthy()
        expect(
          lookup(locale, `matters.dispatch.profileHints.${option}`),
          `${name} 缺 ${option} 说明`
        ).toBeTruthy()
      }
    }
  })
})
