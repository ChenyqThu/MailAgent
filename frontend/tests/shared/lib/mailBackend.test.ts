// 邮件 backend 平台过滤单源（mailBackend.ts）行为闸。
//
// 背景（task 08-12-win-mailagentwin-backend-eval，owner 2026-08-13 拍板）：
// Windows 版引入第三 backend `outlook_com`，值域三值化 + 按平台过滤显示 ——
// mac 只显示 applescript/davmail，win 只显示 outlook_com/davmail（首项 = 主推卡/
// 默认序）；日历 UI 在 win 恒隐藏（不论 backend）。onboarding StepBackend、
// AccountsTab SegmentedControl、Sidebar/deeplink/帮助面板的日历门全部消费本单源，
// 本测试钉死矩阵，防有人回头在消费点各写一份字面量表。
//
// 🔴 跨语言一致性闸（BackendKind ↔ config.py MAILAGENT_BACKEND 值域）不在本文件 ——
// config.py 由并发批次在改，闸由后续统一批建（见 mailBackend.ts 头注释）。
import { afterEach, describe, expect, test } from 'vitest'

import {
  MAIL_BACKEND_KINDS,
  availableBackendsForPlatform,
  calendarUiEnabled,
  coerceMailBackendForPlatform,
  detectUiPlatform,
  type MailBackendKind,
  type UiPlatform
} from '../../../src/shared/lib/mailBackend'

const ALL_PLATFORMS: readonly UiPlatform[] = ['darwin', 'win32', 'other']

describe('MAIL_BACKEND_KINDS 值域', () => {
  test('恰为三值且含 outlook_com', () => {
    expect([...MAIL_BACKEND_KINDS].sort()).toEqual(['applescript', 'davmail', 'outlook_com'])
  })
})

describe('availableBackendsForPlatform — 平台 × 可见性矩阵', () => {
  test('darwin = applescript 主推 + davmail（无 outlook_com）', () => {
    expect(availableBackendsForPlatform('darwin')).toEqual(['applescript', 'davmail'])
  })

  test('win32 = outlook_com 主推 + davmail（无 applescript）', () => {
    expect(availableBackendsForPlatform('win32')).toEqual(['outlook_com', 'davmail'])
  })

  test('other（探测失败兜底）按 mac 侧规则 —— 三值化前现状零回归', () => {
    expect(availableBackendsForPlatform('other')).toEqual(['applescript', 'davmail'])
  })

  test('每平台列表成员都在值域内且无重复', () => {
    for (const platform of ALL_PLATFORMS) {
      const avail = availableBackendsForPlatform(platform)
      expect(new Set(avail).size).toBe(avail.length)
      for (const kind of avail) expect(MAIL_BACKEND_KINDS).toContain(kind)
    }
  })
})

describe('coerceMailBackendForPlatform — 选中态收敛', () => {
  test('合法且平台可用 → 原值', () => {
    expect(coerceMailBackendForPlatform('davmail', 'darwin')).toBe('davmail')
    expect(coerceMailBackendForPlatform('davmail', 'win32')).toBe('davmail')
    expect(coerceMailBackendForPlatform('applescript', 'darwin')).toBe('applescript')
    expect(coerceMailBackendForPlatform('outlook_com', 'win32')).toBe('outlook_com')
  })

  test('平台不可用值 → 收敛到平台首选（win 残留 applescript 是核心场景）', () => {
    // win 上 .env 残留 applescript → 不能让 SegmentedControl 选中一个不存在的段。
    expect(coerceMailBackendForPlatform('applescript', 'win32')).toBe('outlook_com')
    // mac 上出现 outlook_com（手改 .env）→ 收敛回 applescript。
    expect(coerceMailBackendForPlatform('outlook_com', 'darwin')).toBe('applescript')
  })

  test('空/野值 → 平台首选', () => {
    for (const raw of [undefined, null, '', 'imap', 'graph'] as const) {
      expect(coerceMailBackendForPlatform(raw, 'darwin')).toBe('applescript')
      expect(coerceMailBackendForPlatform(raw, 'win32')).toBe('outlook_com')
      expect(coerceMailBackendForPlatform(raw, 'other')).toBe('applescript')
    }
  })

  test('返回值恒在该平台可用列表内（全矩阵）', () => {
    const probes = [...MAIL_BACKEND_KINDS, undefined, null, 'junk'] as const
    for (const platform of ALL_PLATFORMS) {
      const avail = availableBackendsForPlatform(platform)
      for (const raw of probes) {
        expect(avail).toContain(coerceMailBackendForPlatform(raw, platform) as MailBackendKind)
      }
    }
  })
})

describe('calendarUiEnabled — 日历隐藏判定（平台判定，不看 backend）', () => {
  test('win32 恒 false；darwin/other 恒 true', () => {
    expect(calendarUiEnabled('win32')).toBe(false)
    expect(calendarUiEnabled('darwin')).toBe(true)
    expect(calendarUiEnabled('other')).toBe(true)
  })
})

describe('detectUiPlatform — preload 探测与兜底', () => {
  // node 环境无 window；用 globalThis 塞/清一个假 window 覆盖三种形态。
  const g = globalThis as { window?: unknown }

  afterEach(() => {
    delete g.window
  })

  test('window 缺席（node/纯浏览器 SSR）→ other，不抛', () => {
    delete g.window
    expect(detectUiPlatform()).toBe('other')
  })

  test('preload 暴露 darwin / win32 → 如实返回', () => {
    g.window = { electron: { process: { platform: 'darwin' } } }
    expect(detectUiPlatform()).toBe('darwin')
    g.window = { electron: { process: { platform: 'win32' } } }
    expect(detectUiPlatform()).toBe('win32')
  })

  test('preload 缺席或 platform 野值（linux 等）→ other（按 mac 侧规则，宁多显示不误砍）', () => {
    g.window = {}
    expect(detectUiPlatform()).toBe('other')
    g.window = { electron: { process: { platform: 'linux' } } }
    expect(detectUiPlatform()).toBe('other')
  })
})
