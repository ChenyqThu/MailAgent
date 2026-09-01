// L4 群聊 — 发送框 @ 提及解析契约（验收 ⑤）。
//
// 钉三件事：无 @ → []（调用方按「全员各回一轮」）；@显示名 → 点名成员（输出恒按成员序，
// 与 members_json 序一致 = 回复顺序）；未知名 / 名字被字母数字续接（@agent1x ≠ @agent1）不算。

import { describe, expect, test } from 'vitest'

import {
  detectMentionDraft,
  parseGroupMentions
} from '../../src/shared/components/agents/groups/mentions'

const MEMBERS = [
  { agentId: 'a', title: '调研员' },
  { agentId: 'b', title: '跟进官' },
  { agentId: 'c', title: 'agent1' }
] as const

describe('parseGroupMentions', () => {
  test('无 @ → []（全员各回一轮由调用方兜底）', () => {
    expect(parseGroupMentions('大家汇报下进展', MEMBERS)).toEqual([])
    expect(parseGroupMentions('', MEMBERS)).toEqual([])
  })

  test('单点名 / 多点名 — 输出恒按成员序、去重', () => {
    expect(parseGroupMentions('@跟进官 说说', MEMBERS)).toEqual(['b'])
    // 文本序是 跟进官 → 调研员，输出仍按成员序 a → b。
    expect(parseGroupMentions('@跟进官 然后 @调研员 补充', MEMBERS)).toEqual(['a', 'b'])
    expect(parseGroupMentions('@跟进官 @跟进官', MEMBERS)).toEqual(['b'])
  })

  test('未知名不算；名字被字母数字续接不算（@agent1x ≠ @agent1）', () => {
    expect(parseGroupMentions('@路人甲 你怎么看', MEMBERS)).toEqual([])
    expect(parseGroupMentions('@agent1x 你好', MEMBERS)).toEqual([])
    expect(parseGroupMentions('@agent1 你好', MEMBERS)).toEqual(['c'])
    // 中文名后直接跟正文/标点是边界（合法提及）。
    expect(parseGroupMentions('@调研员，麻烦看下', MEMBERS)).toEqual(['a'])
  })
})

describe('detectMentionDraft（补全弹层触发）', () => {
  test('光标前未完成的 @ 片段 → {query, start}；片段含空白 → null', () => {
    expect(detectMentionDraft('hello @跟', 8)).toEqual({ query: '跟', start: 6 })
    expect(detectMentionDraft('hello @', 7)).toEqual({ query: '', start: 6 })
    expect(detectMentionDraft('hello @跟进官 done', 12)).toBeNull()
    expect(detectMentionDraft('no mention', 5)).toBeNull()
  })
})
