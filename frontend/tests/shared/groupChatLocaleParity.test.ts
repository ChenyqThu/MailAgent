// 群聊 i18n 闸（形态照 `todayLocaleParity` / `notificationsLocaleParity`）。三件事：
//
//   ① `groupChat` 子树在 zh-CN 与 en-US 里逐 key 相等 —— 少一边 = 该语言渲染裸 key。本批四条 lane
//      都往这个子树里插键（消息流 / composer / 列表 / 建群 / 详情面），谁漏一边这里就红。
//   ② 每个 turn outcome 在两份 locale 里都有非空文案。词表 `GROUP_TURN_OUTCOMES` 是 gateway 的
//      单源，加一个 outcome 而忘了补文案的表现是「近期唤醒」表里出现一行写着
//      `groupChat.outcome.xxx` 的字 —— 没有任何类型错误会拦住它。
//   ③ g1 的 `settings.*` 已整段迁到 `details.*`：迁移清单里的每个 key 必须**在新位置存在**、
//      且旧位置**不再存在**。迁一半（新 key 有了、组件还在读旧 key，或反过来）的表现同样是裸 key。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'
import { GROUP_TURN_OUTCOMES } from '../../src/ai-gateway/groupFloors'

/** g1 `groupChat.settings.*` → `groupChat.details.*` 的迁移清单（值不变，只换位置）。 */
const MIGRATED_KEYS = [
  'modes',
  'modesHelper',
  'modeRealtime',
  'modeMention',
  'modeAria',
  'judge',
  'judgeNone',
  'judgeHelper',
  'chainCap',
  'hourlyTurns',
  'hourlyTokens',
  'hourlyUsd',
  'save',
  'saving',
  'saved',
  'saveFailed',
  'cancel'
] as const

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

const LOCALES = [
  ['zh-CN', zhCN as Record<string, unknown>],
  ['en-US', enUS as Record<string, unknown>]
] as const

describe('groupChat locale parity', () => {
  test('zh-CN 与 en-US 的 groupChat 子树 key 集合完全一致', () => {
    const zhTree = (zhCN as Record<string, unknown>).groupChat
    const enTree = (enUS as Record<string, unknown>).groupChat
    // canary：子树整个消失（改名 / 搬家）必须红，不许平凡绿。
    expect(zhTree, 'zh-CN 缺 groupChat 顶层块').toBeTruthy()
    expect(enTree, 'en-US 缺 groupChat 顶层块').toBeTruthy()

    const zhKeys = new Set(flattenKeys(zhTree, 'groupChat'))
    const enKeys = new Set(flattenKeys(enTree, 'groupChat'))
    expect(
      [...zhKeys].filter((k) => !enKeys.has(k)),
      'en-US 缺 key（那边渲染裸 key）'
    ).toEqual([])
    expect(
      [...enKeys].filter((k) => !zhKeys.has(k)),
      'zh-CN 缺 key（那边渲染裸 key）'
    ).toEqual([])
  })

  test('每个 turn outcome 在两份 locale 里都有非空文案', () => {
    for (const [name, locale] of LOCALES) {
      for (const outcome of GROUP_TURN_OUTCOMES) {
        const label = lookup(locale, `groupChat.outcome.${outcome}`)
        expect(typeof label === 'string' && label.length > 0, `${name} 缺 ${outcome} 文案`).toBe(
          true
        )
      }
    }
  })

  test('settings.* 整段迁到 details.*：新位置齐、旧位置不留', () => {
    for (const [name, locale] of LOCALES) {
      expect(
        lookup(locale, 'groupChat.settings'),
        `${name} 还留着 groupChat.settings`
      ).toBeUndefined()
      for (const key of MIGRATED_KEYS) {
        const value = lookup(locale, `groupChat.details.${key}`)
        expect(typeof value === 'string' && value.length > 0, `${name} 缺 details.${key}`).toBe(
          true
        )
      }
    }
  })
})
