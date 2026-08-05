// @vitest-environment happy-dom
//
// DrillMenu（ui/DrillMenu.tsx）—— 下钻堆叠菜单原语。这里钉的是**行为契约**，
// 不是像素：面板栈的推/弹、a11y role/aria-checked、键盘导航、以及「关掉菜单必须
// 清栈」那条（不清的话下次点触发器直接弹出二级面板，用户看到的是「这颗钮有时候
// 不是菜单」）。
//
// tests/setup.ts 全局强制 prefers-reduced-motion:reduce → GSAP 走瞬切分支，
// 面板在 happy-dom 里直接可见（否则 timeline 不推进 rAF，元素停在隐藏态）。

import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

import { DrillMenu, type DrillMenuItem } from '../../src/shared/components/ui/DrillMenu'

beforeEach(() => {
  cleanup()
})

function items(overrides: { onToggle?: () => void; onSelect?: () => void } = {}): DrillMenuItem[] {
  return [
    { kind: 'label', id: 'head', label: 'FILTER BY' },
    {
      kind: 'checkbox',
      id: 'unread',
      label: 'Unread',
      checked: true,
      count: 7,
      shortcut: '⇧⌘O',
      onToggle: overrides.onToggle ?? (() => {})
    },
    {
      kind: 'checkbox',
      id: 'toMe',
      label: 'Addressed to me',
      checked: false,
      disabled: true,
      onToggle: () => {}
    },
    {
      kind: 'submenu',
      id: 'priority',
      label: 'Priority',
      hint: '2/5',
      items: [
        {
          kind: 'radio',
          id: 'critical',
          label: 'Critical',
          checked: true,
          onSelect: overrides.onSelect ?? (() => {})
        },
        { kind: 'radio', id: 'low', label: 'Low', checked: false, onSelect: () => {} }
      ]
    }
  ]
}

function renderMenu(props: Partial<React.ComponentProps<typeof DrillMenu>> = {}) {
  const onClose = vi.fn()
  const utils = render(
    <DrillMenu open onClose={onClose} items={items()} ariaLabel="Filter mail" {...props} />
  )
  return { onClose, ...utils }
}

describe('DrillMenu — 根面板', () => {
  test('open=false 时一个节点都不渲染', () => {
    render(<DrillMenu open={false} onClose={() => {}} items={items()} ariaLabel="Filter mail" />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('role=menu + 每类行的 role/aria-checked 都对', () => {
    renderMenu()
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    const unread = screen.getByRole('menuitemcheckbox', { name: /Unread/ })
    expect(unread.getAttribute('aria-checked')).toBe('true')
    const sub = screen.getByRole('menuitem', { name: /Priority/ })
    expect(sub.getAttribute('aria-haspopup')).toBe('menu')
  })

  test('checkbox 点击回调触发；disabled 行既不可点也不进 tab 序', () => {
    const onToggle = vi.fn()
    render(
      <DrillMenu open onClose={() => {}} items={items({ onToggle })} ariaLabel="Filter mail" />
    )
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Unread/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)

    const disabled = screen.getByRole('menuitemcheckbox', { name: /Addressed to me/ })
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    expect(disabled.hasAttribute('data-drill-row')).toBe(false)
  })

  test('计数与快捷键渲染在行尾', () => {
    renderMenu()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('⇧⌘O')).toBeTruthy()
    expect(screen.getByText('2/5')).toBeTruthy()
  })

  test('roving tabindex —— 整块菜单只有一个 tab stop', () => {
    renderMenu()
    const rows = Array.from(document.querySelectorAll('[data-drill-row]'))
    expect(rows.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)
  })
})

describe('DrillMenu — 下钻 / 返回', () => {
  test('点 submenu 行 → 子面板成为 role=menu，父面板降为 aria-hidden 背景', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    expect(screen.getByRole('menu', { name: 'Priority' })).toBeTruthy()
    expect(screen.getByTestId('drill-panel-back')).toBeTruthy()
    // 子面板里是 radio 组，根面板的 checkbox 行已不在可及性树里（父层 aria-hidden）。
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  })

  test('子面板的 radio 回调触发', () => {
    const onSelect = vi.fn()
    render(
      <DrillMenu open onClose={() => {}} items={items({ onSelect })} ariaLabel="Filter mail" />
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Critical/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  test('点后方父面板 = 返回上一层', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.click(screen.getByTestId('drill-panel-back'))
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    expect(screen.queryByTestId('drill-panel-back')).toBeNull()
  })

  test('← 返回上一层；根面板的 ← 什么也不做', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Priority' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Filter mail' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
  })

  test('→ / Enter 也能进子面板（键盘可达）', () => {
    renderMenu()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Priority/ }), { key: 'ArrowRight' })
    expect(screen.getByRole('menu', { name: 'Priority' })).toBeTruthy()
  })

  test('↑↓ 在当前面板内循环移动焦点', () => {
    renderMenu()
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-drill-row]'))
    rows[0]!.focus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[0])
    // 到顶再往上 → 绕回最后一项
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[rows.length - 1])
  })
})

describe('DrillMenu — 关闭语义', () => {
  test('Esc 在子面板 = 返回；在根面板 = onClose', () => {
    const { onClose } = renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('点外面 → onClose；点触发器不算「外面」（否则会关了又开）', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const triggerRef = { current: trigger }
    const onClose = vi.fn()
    render(
      <DrillMenu
        open
        onClose={onClose}
        items={items()}
        ariaLabel="Filter mail"
        triggerRef={triggerRef}
      />
    )
    fireEvent.mouseDown(trigger)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    trigger.remove()
  })

  test('🔴 关掉再打开必须回到根面板（不清栈 = 下次点触发器直接弹二级面板）', () => {
    const { rerender } = renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    expect(screen.getByRole('menu', { name: 'Priority' })).toBeTruthy()
    rerender(<DrillMenu open={false} onClose={() => {}} items={items()} ariaLabel="Filter mail" />)
    rerender(<DrillMenu open onClose={() => {}} items={items()} ariaLabel="Filter mail" />)
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    expect(screen.queryByTestId('drill-panel-back')).toBeNull()
  })
})
