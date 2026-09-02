// L4 群聊 UX 批 — groupPresentation 纯函数。
//
//   P1 relativeTimeLabel 五档；P2 mentionSegments 与 parseGroupMentions 同边界（@agent1x 不切）；
//   P3 @所有人 段 kind='all'；P4 plainPreview 去 markdown 符号与换行、截 80；P5 isPlainText；
//   P6 previewPrefix 三分支。

import { describe, expect, test } from 'vitest'

import {
  isPlainText,
  mentionSegments,
  plainPreview,
  previewPrefix,
  relativeTimeLabel
} from '../../../src/shared/components/agents/groups/groupPresentation'

const t = (key: string, options?: Record<string, unknown>): string =>
  options?.count != null ? `${key}:${String(options.count)}` : key

const MEMBERS = [
  { agentId: 'a1', title: 'agent1' },
  { agentId: 'a2', title: '跟进官' }
]

describe('groupPresentation', () => {
  test('P1 relativeTimeLabel 五档', () => {
    const now = new Date(2026, 8, 1, 14, 30).getTime()
    expect(relativeTimeLabel(now - 10_000, now, t)).toBe('groupChat.timeJustNow')
    expect(relativeTimeLabel(now - 5 * 60_000, now, t)).toBe('groupChat.timeMinutesAgo:5')
    expect(relativeTimeLabel(new Date(2026, 8, 1, 9, 5).getTime(), now, t)).toBe('09:05')
    expect(relativeTimeLabel(new Date(2026, 7, 31, 23, 59).getTime(), now, t)).toBe(
      'groupChat.dateYesterday 23:59'
    )
    expect(relativeTimeLabel(new Date(2026, 7, 20, 8, 0).getTime(), now, t)).toBe('8/20 08:00')
  })

  test('P2 mentionSegments 与 parseGroupMentions 同边界：@agent1x 不切，@agent1 切', () => {
    expect(mentionSegments('@agent1x 你好', MEMBERS)).toEqual([
      { kind: 'text', text: '@agent1x 你好' }
    ])
    expect(mentionSegments('请 @agent1 看下，@跟进官跟进', MEMBERS)).toEqual([
      { kind: 'text', text: '请 ' },
      { kind: 'mention', text: '@agent1', agentId: 'a1' },
      { kind: 'text', text: ' 看下，' },
      { kind: 'mention', text: '@跟进官', agentId: 'a2' },
      { kind: 'text', text: '跟进' }
    ])
  })

  test('P3 @所有人 / @all 段 kind=all；@allx 不切', () => {
    expect(mentionSegments('@所有人 开会', MEMBERS)).toEqual([
      { kind: 'all', text: '@所有人' },
      { kind: 'text', text: ' 开会' }
    ])
    expect(mentionSegments('@all now', MEMBERS)[0]).toEqual({ kind: 'all', text: '@all' })
    expect(mentionSegments('@allx', MEMBERS)).toEqual([{ kind: 'text', text: '@allx' }])
  })

  test('P4 plainPreview 去 markdown 符号与换行、截 80', () => {
    expect(plainPreview('# 标题\n- **要点** `code`\n> 引用')).toBe('标题 - 要点 code 引用')
    expect(plainPreview('x'.repeat(100))).toHaveLength(80)
  })

  test('P5 isPlainText：纯文本含换行 → true；含 ** / 行首 - / 反引号 → false', () => {
    expect(isPlainText('第一行\n第二行')).toBe(true)
    expect(isPlainText('有 **粗体**')).toBe(false)
    expect(isPlainText('清单：\n- 一\n- 二')).toBe(false)
    expect(isPlainText('1. 编号')).toBe(false)
    expect(isPlainText('用 `code`')).toBe(false)
  })

  test('P6 previewPrefix 三分支：via main_agent → 主助理；user → 你；assistant → 成员名', () => {
    const titleOf = (id: string): string => (id === 'a2' ? '跟进官' : id)
    expect(
      previewPrefix({ role: 'user', speaker_agent_id: null, via: 'main_agent' }, titleOf, t)
    ).toBe('groupChat.previewMainAgent')
    expect(previewPrefix({ role: 'user', speaker_agent_id: null, via: null }, titleOf, t)).toBe(
      'groupChat.previewYou'
    )
    expect(
      previewPrefix({ role: 'assistant', speaker_agent_id: 'a2', via: null }, titleOf, t)
    ).toBe('跟进官')
  })
})
