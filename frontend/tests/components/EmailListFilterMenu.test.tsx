// @vitest-environment happy-dom
//
// EmailListHeader 的筛选/排序菜单接线 —— 2026-08 Outlook 结构重做。
//
// 这里验的是「store ↔ 菜单项」这一层（DrillMenu 自身的行为在 DrillMenu.test.tsx）：
// 六条筛选项 + 两个下钻子面板 + 排序/方向两组单选都在、勾选态跟 store 走、点了真写
// store、方向文案随排序键切换、以及「清除筛选」只在真有筛选时出现。

import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import { ALL_CATEGORIES, ALL_PRIORITIES, useEmailFilter } from '@shared/state/email-filter'
import { EmailListHeader } from '../../src/shared/components/email/EmailListHeader'

await i18n.changeLanguage('en-US')

const COUNTS = { all: 12, unread: 3, flagged: 2, done: 1, toMe: 5, hasAttach: 4, failed: 0 }

function renderHeader(userEmail: string | null = 'me@example.test') {
  return render(
    <EmailListHeader
      counts={COUNTS}
      categoryCounts={Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0])) as never}
      priorityCounts={Object.fromEntries(ALL_PRIORITIES.map((p) => [p, 0])) as never}
      userEmail={userEmail}
    />
  )
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Filter mail' }))
}

beforeEach(() => {
  useEmailFilter.setState({
    unread: false,
    flagMark: null,
    toMe: false,
    hasAttach: false,
    failed: false,
    view: 'inbox',
    customMailbox: null,
    customMailboxPath: [],
    sortKey: 'date',
    sortDir: 'desc',
    selectedPriorities: new Set(ALL_PRIORITIES),
    selectedCategories: new Set(ALL_CATEGORIES)
  })
})
afterEach(cleanup)

describe('筛选菜单 — 结构', () => {
  test('六条筛选项齐全（未读/标记/收件人是我/具有附件/优先级/分类/同步失败）', () => {
    renderHeader()
    openMenu()
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Unread/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /Marked/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Addressed to me/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Has attachments/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /Priority/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /Category/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Sync failed/ })).toBeTruthy()
  })

  test('行尾展示各轴计数与快捷键（快捷键在菜单关着时也生效，这里只验标注）', () => {
    renderHeader()
    openMenu()
    const unread = screen.getByRole('menuitemcheckbox', { name: /Unread/ })
    expect(unread.textContent).toContain('3')
    expect(unread.textContent).toContain('⇧⌘O')
    expect(screen.getByRole('menuitemcheckbox', { name: /Has attachments/ }).textContent).toContain(
      '⇧⌘A'
    )
  })

  test('USER_EMAIL 未知 → 「收件人是我」置灰且不显计数（判据取不到，不给假开关）', () => {
    renderHeader(null)
    openMenu()
    const row = screen.getByRole('menuitemcheckbox', { name: /Addressed to me/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).not.toContain('5')
  })
})

describe('筛选菜单 — 写 store', () => {
  test('点「未读」翻转对应轴，勾选态跟着 store', () => {
    renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Unread/ }))
    expect(useEmailFilter.getState().unread).toBe(true)
    expect(
      screen.getByRole('menuitemcheckbox', { name: /Unread/ }).getAttribute('aria-checked')
    ).toBe('true')
  })

  test('「标记」下钻后是两档互斥单选（已标记 / 已完成）', () => {
    renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Marked/ }))
    const sub = screen.getByRole('menu', { name: 'Marked' })
    fireEvent.click(within(sub).getByRole('menuitemradio', { name: /Flagged/ }))
    expect(useEmailFilter.getState().flagMark).toBe('flagged')
    fireEvent.click(within(sub).getByRole('menuitemradio', { name: /Done/ }))
    expect(useEmailFilter.getState().flagMark).toBe('done')
  })

  test('优先级子面板里的 5 档多选沿用既有 store（去掉一档 → hint 出现 4/5）', () => {
    renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Low/ }))
    expect(useEmailFilter.getState().selectedPriorities.has('low')).toBe(false)
    // 返回根面板后，submenu 行尾出现收窄提示。
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Priority' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('menuitem', { name: /Priority/ }).textContent).toContain('4/5')
  })
})

describe('排序菜单', () => {
  test('四个排序键 + 默认勾在「日期」', () => {
    renderHeader()
    openMenu()
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    for (const label of ['Date', 'Sender', 'Subject', 'Importance']) {
      expect(within(menu).getByRole('menuitemradio', { name: label })).toBeTruthy()
    }
    expect(
      within(menu).getByRole('menuitemradio', { name: 'Date' }).getAttribute('aria-checked')
    ).toBe('true')
  })

  test('选排序键写 store', () => {
    renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sender' }))
    expect(useEmailFilter.getState().sortKey).toBe('sender')
  })

  test('🔴 方向文案随排序键切换（「按发件人 · 由新到旧」是自相矛盾的组合）', () => {
    renderHeader()
    openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sender' }))
    expect(screen.queryByRole('menuitemradio', { name: 'Newest first' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'Z → A' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Importance' }))
    expect(screen.getByRole('menuitemradio', { name: 'Highest first' })).toBeTruthy()
  })

  test('选方向写 store；默认是 desc', () => {
    renderHeader()
    openMenu()
    expect(useEmailFilter.getState().sortDir).toBe('desc')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Oldest first' }))
    expect(useEmailFilter.getState().sortDir).toBe('asc')
  })
})

describe('清除筛选 / 激活指示', () => {
  test('无筛选时既没有「清除筛选」行、过滤钮也不亮；有了就都出现', () => {
    renderHeader()
    const btn = screen.getByRole('button', { name: 'Filter mail' })
    expect(btn.getAttribute('data-active')).toBe('false')
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Clear filters' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Has attachments/ }))
    expect(btn.getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'Clear filters' })).toBeTruthy()
  })

  test('🔴 只换排序不算「有筛选」（否则激活点常亮）', () => {
    renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Subject' }))
    expect(screen.getByRole('button', { name: 'Filter mail' }).getAttribute('data-active')).toBe(
      'false'
    )
    expect(screen.queryByRole('menuitem', { name: 'Clear filters' })).toBeNull()
  })

  test('点「清除筛选」把所有轴归零', () => {
    renderHeader()
    openMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Unread/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear filters' }))
    expect(useEmailFilter.getState().unread).toBe(false)
    expect(useEmailFilter.getState().hasActiveFilter()).toBe(false)
  })
})

describe('快捷键（菜单关着也生效）', () => {
  test('⇧⌘O 未读 / ⌥⌘O 已标记 / ⇧⌘A 具有附件', () => {
    renderHeader()
    fireEvent.keyDown(document, { key: 'o', metaKey: true, shiftKey: true })
    expect(useEmailFilter.getState().unread).toBe(true)
    fireEvent.keyDown(document, { key: 'o', metaKey: true, altKey: true })
    expect(useEmailFilter.getState().flagMark).toBe('flagged')
    fireEvent.keyDown(document, { key: 'a', metaKey: true, shiftKey: true })
    expect(useEmailFilter.getState().hasAttach).toBe(true)
    // 再按一次 = 取消（都是 toggle）。
    fireEvent.keyDown(document, { key: 'o', metaKey: true, altKey: true })
    expect(useEmailFilter.getState().flagMark).toBeNull()
  })
})
