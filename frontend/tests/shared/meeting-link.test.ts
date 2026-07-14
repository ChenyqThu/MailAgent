// 阶段2·2.5 — meeting-link 提取 util: Teams/Zoom/Meet 变体矩阵 + 字段优先级 +
// deeplink 派生. 纯函数, node env.

import { describe, expect, test } from 'vitest'

import { extractMeetingLink } from '../../src/shared/components/calendar/lib/meeting-link'

const TEAMS_CLASSIC =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123%40thread.v2/0?context=%7b%22Tid%22%3a%22t-1%22%7d'
const TEAMS_SHORT = 'https://teams.microsoft.com/meet/2661234567890?p=abcDEFghi'
const TEAMS_LIVE = 'https://teams.live.com/meet/9312345678901'
const ZOOM_J = 'https://zoom.us/j/1234567890?pwd=Zm9v'
const ZOOM_SUB = 'https://us02web.zoom.us/j/98765432101'
const ZOOM_MY = 'https://company.zoom.us/my/dev.room'
const MEET = 'https://meet.google.com/abc-defg-hij'

describe('extractMeetingLink — provider 变体', () => {
  test('Teams 经典 meetup-join → msteams deeplink + https 原样', () => {
    const link = extractMeetingLink({ url: TEAMS_CLASSIC })
    expect(link).not.toBeNull()
    expect(link!.provider).toBe('teams')
    expect(link!.httpsUrl).toBe(TEAMS_CLASSIC)
    expect(link!.deeplinkUrl).toBe('msteams://' + TEAMS_CLASSIC.slice('https://'.length))
  })

  test('Teams 新式 /meet 短链 + teams.live.com 个人版', () => {
    expect(extractMeetingLink({ url: TEAMS_SHORT })?.provider).toBe('teams')
    expect(extractMeetingLink({ url: TEAMS_LIVE })?.provider).toBe('teams')
  })

  test('Zoom /j + 企业/区域子域 + /my 个人会议室 — deeplink 恒 https', () => {
    for (const u of [ZOOM_J, ZOOM_SUB, ZOOM_MY]) {
      const link = extractMeetingLink({ url: u })
      expect(link?.provider).toBe('zoom')
      expect(link?.deeplinkUrl).toBe(u)
    }
  })

  test('Google Meet 房间码', () => {
    const link = extractMeetingLink({ url: MEET })
    expect(link?.provider).toBe('meet')
    expect(link?.httpsUrl).toBe(MEET)
  })

  test('非会议链接 / 域名相似但路径不符 → null', () => {
    expect(extractMeetingLink({ url: 'https://example.com/meeting' })).toBeNull()
    expect(extractMeetingLink({ url: 'https://teams.microsoft.com/downloads' })).toBeNull()
    expect(extractMeetingLink({ url: 'https://zoom.us/pricing' })).toBeNull()
    expect(extractMeetingLink({ url: 'https://meet.google.com/' })).toBeNull()
    expect(extractMeetingLink({})).toBeNull()
    expect(extractMeetingLink({ url: '', location: null, description: undefined })).toBeNull()
  })
})

describe('extractMeetingLink — 字段优先级 + 文本内提取', () => {
  test('url > location > description 按序取第一个可识别链接', () => {
    expect(
      extractMeetingLink({ url: ZOOM_J, location: TEAMS_CLASSIC, description: MEET })?.provider
    ).toBe('zoom')
    expect(
      extractMeetingLink({ url: '', location: TEAMS_CLASSIC, description: MEET })?.provider
    ).toBe('teams')
    expect(extractMeetingLink({ description: MEET })?.provider).toBe('meet')
  })

  test('description 纯文本包裹 (尖括号/句尾标点/前后杂文) 仍可提取', () => {
    const desc = `Microsoft Teams 会议\n加入会议: <${TEAMS_CLASSIC}>\n会议 ID: 123`
    expect(extractMeetingLink({ description: desc })?.httpsUrl).toBe(TEAMS_CLASSIC)

    const trailing = `请点击 ${MEET}.`
    expect(extractMeetingLink({ description: trailing })?.httpsUrl).toBe(MEET)
  })

  test('同字段多 URL 时跳过不可识别的取第一个命中', () => {
    const desc = `议程: https://example.com/agenda 入会: ${ZOOM_SUB}`
    expect(extractMeetingLink({ description: desc })?.httpsUrl).toBe(ZOOM_SUB)
  })
})
