// 工具中文名叶子表 ↔ renderer i18n 的一致性闸。
//
// `TOOL_DISPLAY_NAMES_ZH`（shared/assistant/toolDisplayNames）是 zh-CN `chat.toolTitle.*` 的
// 手抄镜像 —— gateway 是纯 TS，不吃 i18n runtime，只能自带一份（CLAUDE.md「跨边界手抄常量必建
// 一致性闸」）。失败形态是静默的：改了 i18n 里的名字，chat 卡片上换了词，模型看到的 description
// 里还是旧词，两边各说各话。
//
// 🔴 抽取失败必须红：两张表任一为空 / 变小到不像话（文件搬走、JSON 结构改了）都要 fail，
//    不能让 toEqual 因为「两边都空」而平凡通过。

import { describe, expect, test } from 'vitest'

import { TOOL_DISPLAY_NAMES_ZH } from '../../src/shared/assistant/toolDisplayNames'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'

const zhTitles = (zhCommon as { chat: { toolTitle: Record<string, string> } }).chat.toolTitle

describe('TOOL_DISPLAY_NAMES_ZH ↔ zh-CN chat.toolTitle', () => {
  test('canary — 两份来源都拿到了非平凡的表', () => {
    expect(Object.keys(TOOL_DISPLAY_NAMES_ZH).length).toBeGreaterThan(40)
    expect(Object.keys(zhTitles).length).toBeGreaterThan(40)
  })

  test('键集完全一致（叶子表不许有幽灵条目，也不许漏工具）', () => {
    const leaf = Object.keys(TOOL_DISPLAY_NAMES_ZH)
    const i18n = Object.keys(zhTitles)
    expect(
      leaf.filter((k) => !(k in zhTitles)),
      '叶子表里有 i18n 没有的名字（幽灵条目）'
    ).toEqual([])
    expect(
      i18n.filter((k) => !(k in TOOL_DISPLAY_NAMES_ZH)),
      '这些工具在 chat 里有中文标题，但模型看到的 description 没有中文名。补进 toolDisplayNames.ts'
    ).toEqual([])
  })

  test('每条的值也一致（改名只改一半 = 两边各说各话）', () => {
    expect(TOOL_DISPLAY_NAMES_ZH).toEqual(zhTitles)
  })
})
