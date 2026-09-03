// @vitest-environment happy-dom
//
// 通讯录列表行的**无操作控件**契约 + 名字后的性别小图标。
//
// 行上原先有一颗 hover「…」钮（右键同一菜单）与多选态 checkbox；09-02 起两者都删了 ——
// 点行只做一件事：打开人物页。治理与写邮件全部走档案页右上角「更多操作」。这里钉住
// 「行里不再有任何按钮 / 菜单」，把它加回来（或者恢复右键菜单）必须先改这份测试。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { ContactRowDto } from '@shared/api/types/contact'
import {
  ContactVirtualRow,
  type ContactRowActions,
  type ContactRowsProps
} from '@shared/components/contacts/ContactRow'

await i18n.changeLanguage('zh-CN')

const actions: ContactRowActions = {
  onOpen: vi.fn(),
  onSetKind: vi.fn(),
  onToggleSelf: vi.fn(),
  onToggleHidden: vi.fn()
}

function contact(overrides: Partial<ContactRowDto> = {}): ContactRowDto {
  return {
    id: 7,
    display_name: '张伟',
    formal_name: null,
    organization: 'Omada Networks',
    department: null,
    role_title: '架构师',
    function: null,
    seniority: null,
    kind: 'person',
    hidden_at: null,
    is_self: false,
    mail_count: 12,
    sent_to_count: 3,
    first_seen_at: null,
    last_seen_at: null,
    email_count: 1,
    primary_email: 'zhang@example.com',
    manager_contact_id: null,
    manager_display_name: null,
    profile_summary: null,
    profile_min: 50,
    profile_eligible: false,
    gender: null,
    ...overrides
  }
}

function renderRow(item: ContactRowDto) {
  const rowProps: ContactRowsProps = {
    rows: [{ type: 'contact', key: `c${item.id}`, item }],
    density: 'compact',
    selectedId: null,
    onToggleGroup: vi.fn(),
    ...actions
  }
  return render(
    <div data-testid="virtual-row-host">
      <ContactVirtualRow
        index={0}
        style={{}}
        ariaAttributes={{ 'aria-posinset': 1, 'aria-setsize': 1, role: 'listitem' }}
        {...rowProps}
      />
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('通讯录行 · 行上没有操作控件', () => {
  test('行里没有按钮，也没有 portal 菜单', () => {
    renderRow(contact())

    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.querySelector('[data-popmenu-portal="true"]')).toBeNull()
  })

  test('右键不再开菜单（点行本身仍是打开人物页）', () => {
    const { container } = renderRow(contact())
    const row = container.querySelector('[data-contact-id="7"]') as HTMLElement

    fireEvent.contextMenu(row)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(row)
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
  })

  // 🔴 ⌘/Ctrl 点行原先是「进入多选」的显式入口之一 —— 多选整体删掉之后它必须与
  // 普通点击一样只打开人物页（留着旧分支 = 按住 ⌘ 点人什么也不发生）。
  test('⌘/Ctrl 点行也是打开人物页', () => {
    const { container } = renderRow(contact())
    const row = container.querySelector('[data-contact-id="7"]') as HTMLElement

    fireEvent.click(row, { metaKey: true })
    fireEvent.click(row, { ctrlKey: true })
    expect(actions.onOpen).toHaveBeenCalledTimes(2)
  })
})

// 名字后的性别小图标。🔴 判据是「只有 male/female 才渲染」——「没填」不该在每行占位。
describe('通讯录行 · 性别小图标', () => {
  test('male / female 渲染带 title 的图标，未知与缺字段都不渲染', () => {
    renderRow(contact({ gender: 'male' }))
    expect(screen.getByTitle('男')).toBeTruthy()
    expect(screen.queryByTitle('女')).toBeNull()

    cleanup()
    renderRow(contact({ gender: 'female' }))
    expect(screen.getByTitle('女')).toBeTruthy()

    // 🔴 判据是「一个性别图标都没渲染」，不是「没有『男』这个字」—— 值不合法时
    // `t()` 会退回原样的 key（`contacts.gender.undefined`），按文案断言抓不到。
    cleanup()
    renderRow(contact({ gender: null }))
    expect(screen.queryByRole('img')).toBeNull()

    // 老后端 / 老缓存整个键都没有 —— 与 null 一样不渲染，不能漏出个瞎选的图标。
    cleanup()
    const { gender: _omit, ...withoutGender } = contact()
    void _omit
    renderRow(withoutGender as ContactRowDto)
    expect(screen.queryByRole('img')).toBeNull()
  })

  test('图标只作弱标注：不占文本宽度，姓名行文本里没有「男」「女」字样', () => {
    const { container } = renderRow(contact({ gender: 'male' }))
    expect(screen.getByTitle('男').textContent).toBe('')
    expect(container.textContent).not.toContain('男')
  })
})
