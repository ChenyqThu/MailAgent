// @vitest-environment happy-dom
//
// Popmenu（ui/Popmenu.tsx）—— 全 app 弹层基座（移植自 lab.moumen.dev 的
// unlimited-nested-menu）。这里钉的是**行为契约**，不是像素：面板栈的推/弹、
// a11y role/aria-checked、键盘导航、内容形态（menu / radio / 下钻 / 逃生舱）、
// 以及「关掉菜单必须清栈」那条（不清的话下次点触发器直接弹出二级面板，用户看到
// 的是「这颗钮有时候不是菜单」）。
//
// tests/setup.ts 全局强制 prefers-reduced-motion:reduce → 组件里 motion 的
// useReducedMotion 为真，imperative 的 morph 整段短路，断言看到的是最终 DOM。
//
// 🔴 退场语义：AnimatePresence 会把被弹掉的面板多留一会儿做淡出，所以「面板没了」
// 不能用 queryByTestId 判 —— 判据是**可及性树**（退场中的面板 aria-hidden + 无
// role），这也正是用户/读屏器感知到的那条线。

import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

import { Popmenu, type PopmenuItem } from '../../src/shared/components/ui/Popmenu'

beforeEach(() => {
  cleanup()
})

function items(overrides: { onToggle?: () => void; onSelect?: () => void } = {}): PopmenuItem[] {
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

function renderMenu(props: Partial<React.ComponentProps<typeof Popmenu>> = {}) {
  const onClose = vi.fn()
  const utils = render(
    <Popmenu open onClose={onClose} items={items()} ariaLabel="Filter mail" {...props} />
  )
  return { onClose, ...utils }
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-popmenu-row]'))
}

describe('Popmenu — 根面板', () => {
  test('open=false 时不渲染任何菜单', () => {
    render(<Popmenu open={false} onClose={() => {}} items={items()} ariaLabel="Filter mail" />)
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

  test('checkbox 点击回调触发；disabled 行不可点、也不进方向键序列', () => {
    const onToggle = vi.fn()
    render(<Popmenu open onClose={() => {}} items={items({ onToggle })} ariaLabel="Filter mail" />)
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Unread/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)

    // disabled 行按 ARIA APG 仍留在菜单里（读屏器能念到），只是不可激活、不可
    // tab、方向键跳过它 —— 见下方 ↑↓ 用例。
    const disabled = screen.getByRole('menuitemcheckbox', { name: /Addressed to me/ })
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    expect(disabled.getAttribute('tabindex')).toBe('-1')
  })

  test('计数、快捷键与 hint 渲染在行尾', () => {
    renderMenu()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('⇧⌘O')).toBeTruthy()
    expect(screen.getByText('2/5')).toBeTruthy()
  })

  test('roving tabindex —— 整块菜单只有一个 tab stop，且落在首个可聚焦行', () => {
    renderMenu()
    const tabbable = rows().filter((r) => r.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]!.textContent).toContain('Unread')
  })
})

describe('Popmenu — 下钻 / 返回', () => {
  test('点 submenu 行 → 子面板成为 role=menu，父面板降为不可及的背景层', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    expect(screen.getByRole('menu', { name: 'Priority' })).toBeTruthy()
    expect(screen.getByTestId('popmenu-panel-behind')).toBeTruthy()
    // 子面板里是 radio 组；父面板的行已降级成无 role 的纯展示 div。
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  })

  test('子面板的 radio 回调触发，且默认不关菜单（多选/连点场景）', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<Popmenu open onClose={onClose} items={items({ onSelect })} ariaLabel="Filter mail" />)
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Critical/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('点后方父面板 = 返回上一层', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    fireEvent.click(screen.getByTestId('popmenu-panel-behind'))
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    // 退场中的 Priority 面板已从可及性树摘掉 → 只剩根面板一个 menu。
    expect(screen.getAllByRole('menu')).toHaveLength(1)
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
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // Unread → Priority（跳过 disabled）
    fireEvent.keyDown(menu, { key: 'ArrowRight' })
    expect(screen.getByRole('menu', { name: 'Priority' })).toBeTruthy()
  })

  test('↑↓ 在当前面板内循环移动焦点，并跳过 disabled 行', () => {
    renderMenu()
    const menu = screen.getByRole('menu', { name: 'Filter mail' })
    const [unread, toMe, priority] = rows()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(priority) // 跳过 disabled 的 toMe
    expect(document.activeElement).not.toBe(toMe)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(unread)
    // 到顶再往上 → 绕回最后一个可聚焦行
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(priority)
  })
})

describe('Popmenu — 关闭语义', () => {
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
      <Popmenu
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

  test('action 行默认点完就关；keepOpen 的留在原地', () => {
    const onClose = vi.fn()
    const run = vi.fn()
    const { rerender } = render(
      <Popmenu
        open
        onClose={onClose}
        ariaLabel="Actions"
        items={[{ kind: 'action', id: 'a', label: 'Do it', onSelect: run }]}
      />
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Do it' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <Popmenu
        open
        onClose={onClose}
        ariaLabel="Actions"
        items={[{ kind: 'action', id: 'a', label: 'Select all', keepOpen: true, onSelect: run }]}
      />
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select all' }))
    expect(run).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(1) // 没有再关一次
  })

  test('🔴 关掉再打开必须回到根面板（不清栈 = 下次点触发器直接弹二级面板）', () => {
    const { rerender } = renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority/ }))
    expect(screen.getByRole('menu', { name: 'Priority' })).toBeTruthy()
    rerender(<Popmenu open={false} onClose={() => {}} items={items()} ariaLabel="Filter mail" />)
    rerender(<Popmenu open onClose={() => {}} items={items()} ariaLabel="Filter mail" />)
    expect(screen.getByRole('menu', { name: 'Filter mail' })).toBeTruthy()
    expect(screen.queryByTestId('popmenu-panel-behind')).toBeNull()
  })
})

describe('Popmenu — 通用弹层形态（下游 showcase 的四种内容）', () => {
  test('title 给了就渲染根面板标题栏，不给就没有 header', () => {
    const { rerender } = render(
      <Popmenu open onClose={() => {}} ariaLabel="A" title="Text style" items={[]} />
    )
    expect(screen.getByRole('menu', { name: 'Text style' })).toBeTruthy()
    rerender(<Popmenu open onClose={() => {}} ariaLabel="A" items={[]} />)
    expect(screen.getByRole('menu', { name: 'A' })).toBeTruthy()
  })

  test('separator / label 是纯装饰，不进 menuitem 序列', () => {
    render(
      <Popmenu
        open
        onClose={() => {}}
        ariaLabel="A"
        items={[
          { kind: 'label', id: 'l', label: 'SIZE' },
          { kind: 'separator', id: 's' },
          { kind: 'action', id: 'a', label: 'Only one', onSelect: () => {} }
        ]}
      />
    )
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  test('custom 行把任意 React 内容嵌进列表（逃生舱）', () => {
    render(
      <Popmenu
        open
        onClose={() => {}}
        ariaLabel="A"
        items={[
          { kind: 'custom', id: 'slider', content: <input type="range" aria-label="Size" /> }
        ]}
      />
    )
    expect(screen.getByRole('slider', { name: 'Size' })).toBeTruthy()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  test('children 接管整个根面板（非菜单形态 → 不是 role=menu）', () => {
    render(
      <Popmenu open onClose={() => {}} ariaLabel="Compose settings">
        <label htmlFor="lh">Line height</label>
        <input id="lh" defaultValue="1.5" />
      </Popmenu>
    )
    expect(screen.getByRole('group', { name: 'Compose settings' })).toBeTruthy()
    expect(screen.getByLabelText('Line height')).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
