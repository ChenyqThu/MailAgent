// AI Chat 标签面的 i18n 闸（09-02 对话域拆分，形态照 `todayLocaleParity` / `groupChatLocaleParity`）。
// 三件事：
//   ① `chat.tabs` 子树在 zh-CN 与 en-US 里逐 key 相等 —— 少一边 = 该语言渲染裸 key。
//   ② 标签面消费到的每个 key 都有**非空**文案。这两句都出现在没有别的字的位置（新会话标签的
//      标题、会话已删时整个详情区），拿不到文案的表现是一个空白标签 / 一片空白，没有任何
//      类型错误会拦住它 —— `chat.tabs.newChat` 还会经 `openNewChatTab` 落进标签快照，
//      缺文案时**连持久化下来的标题都是空**。
//   ③ 「AI｜群聊」分段退役后三个 `groupChat.segment*` 键不许留：分段控件已删，留着的键
//      只会让下一个人以为还有那个控件（i18n 里没有「未使用」的编译期信号）。

import { describe, expect, test } from 'vitest'

import zhCN from '../../src/shared/i18n/locales/zh-CN/common.json'
import enUS from '../../src/shared/i18n/locales/en-US/common.json'

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

/** 标签面的消费点：`active-chat.openNewChatTab`（新标签标题）与 `AgentViewLayout.ChatTabHost`
 *  （会话已删空态 + 空 mountKey 的手动入口）。 */
const CHAT_TAB_KEYS = ['chat.tabs.newChat', 'chat.tabs.missing'] as const

/** 分段控件随拆域退役（`AgentViewLayout` 的 segmentControl + `AgentThreadList.headerSlot`）。 */
const RETIRED_SEGMENT_KEYS = [
  'groupChat.segmentAi',
  'groupChat.segmentGroups',
  'groupChat.segmentAria'
] as const

const LOCALES = [
  ['zh-CN', zhCN as Record<string, unknown>],
  ['en-US', enUS as Record<string, unknown>]
] as const

describe('chat.tabs locale parity', () => {
  test('zh-CN 与 en-US 的 chat.tabs 子树 key 集合完全一致', () => {
    const zhTree = lookup(zhCN as Record<string, unknown>, 'chat.tabs')
    const enTree = lookup(enUS as Record<string, unknown>, 'chat.tabs')
    // canary：子树整个消失（改名 / 搬家）必须红，不许平凡绿。
    expect(zhTree, 'zh-CN 缺 chat.tabs 块').toBeTruthy()
    expect(enTree, 'en-US 缺 chat.tabs 块').toBeTruthy()

    const zhKeys = new Set(flattenKeys(zhTree, 'chat.tabs'))
    const enKeys = new Set(flattenKeys(enTree, 'chat.tabs'))
    expect(
      [...zhKeys].filter((k) => !enKeys.has(k)),
      'en-US 缺 key（那边渲染裸 key）'
    ).toEqual([])
    expect(
      [...enKeys].filter((k) => !zhKeys.has(k)),
      'zh-CN 缺 key（那边渲染裸 key）'
    ).toEqual([])
  })

  test('标签面的每个 key 在两份 locale 都有非空文案', () => {
    for (const [name, locale] of LOCALES) {
      for (const key of CHAT_TAB_KEYS) {
        const value = lookup(locale, key)
        expect(typeof value === 'string' && value.length > 0, `${name} 缺 ${key}`).toBe(true)
      }
    }
  })

  test('分段控件退役：三个 groupChat.segment* 键不留在任何一份 locale 里', () => {
    for (const [name, locale] of LOCALES) {
      for (const key of RETIRED_SEGMENT_KEYS) {
        expect(lookup(locale, key), `${name} 还留着 ${key}`).toBeUndefined()
      }
    }
  })
})
