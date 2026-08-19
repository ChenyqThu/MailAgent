// @vitest-environment happy-dom
//
// 通讯录行「…」菜单的**挂载点**契约（task 08-18-contacts-row-menu-align）。
//
// 0818 owner 报「popup 是个半透明的背景，根本看不见」。根因不是颜色：列表是
// react-window 虚拟滚动，每行是 `position:absolute` 且**没有 z-index** 的兄弟节点，
// 定位元素无 z-index 时按 DOM 顺序绘制 ⇒ 排在后面的行全部画在行内 absolute 的菜单
// 上面（头像 / 姓名 / TwoWayBar 糊一脸），贴底的行还会被滚动容器裁掉。
// 复现与修复截图：`.trellis/tasks/08-18-contacts-row-menu-align/shots/`。
//
// 修法是让这份菜单走 Popmenu 的 portal 档（原型 `contacts/cui.jsx::Menu` 从一开始
// 就是 createPortal + fixed）。这里钉住那个「必须逃出行子树」的事实 —— 有人日后把
// `portal` 删掉图省事，行为会静默退回 owner 报的那个样子，肉眼在单测里看不出来。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

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
  onCompose: vi.fn(),
  onComposeCc: vi.fn(),
  onSetKind: vi.fn(),
  onToggleSelf: vi.fn(),
  onToggleHidden: vi.fn(),
  onEnterSelection: vi.fn(),
  onToggleCheck: vi.fn()
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
    ...overrides
  }
}

function renderRow(item: ContactRowDto, menuOpenId: number | null) {
  const rowProps: ContactRowsProps = {
    rows: [{ type: 'contact', key: `c${item.id}`, item }],
    density: 'compact',
    selectedId: null,
    selectionMode: false,
    checkedIds: new Set(),
    menuOpenId,
    onMenuOpenChange: vi.fn(),
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

afterEach(() => cleanup())

describe('通讯录行菜单 · 挂载点', () => {
  test('菜单打开时逃出行子树、挂到 document.body（portal 档）', () => {
    const { container } = renderRow(contact(), 7)
    const menu = screen.getByRole('menu', { name: '更多操作' })
    const root = menu.closest('[data-popmenu-portal="true"]')

    // 🔴 判据是「不在行里」而不是「渲染出来了」—— 旧实现同样渲染得出菜单，
    // 它只是被后面的行画在了上面。
    expect(root).not.toBeNull()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(root!.parentElement).toBe(document.body)
  })

  test('menuOpenId 不是本行时不渲染菜单', () => {
    renderRow(contact(), null)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('「隐藏」是危险项、「取消隐藏」不是（原型 capp.jsx::menuItems 同款）', () => {
    renderRow(contact(), 7)
    expect(screen.getByRole('menuitem', { name: '隐藏' }).className).toContain('text-destructive')

    cleanup()
    renderRow(contact({ hidden_at: 1_700_000_000 }), 7)
    expect(screen.getByRole('menuitem', { name: '取消隐藏' }).className).not.toContain(
      'text-destructive'
    )
  })
})
