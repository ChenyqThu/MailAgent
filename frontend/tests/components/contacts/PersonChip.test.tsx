// @vitest-environment happy-dom
//
// 通讯录 WP4 —— PersonChip 两态：
//   · 在库 = pill 按钮（Monogram + 姓名 + title「打开 {name} 的人物页」），点击回调带 id；
//   · 不在库 = 不可点 <span>（虚线态，title 明说不建占位记录）—— 没有 button 角色。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { PersonChip } from '@shared/components/contacts/PersonChip'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

const contact = {
  id: 7,
  displayName: 'Alice Chen',
  formalName: 'Alice',
  primaryEmail: 'alice@x.com',
  kind: 'person' as const
}

describe('PersonChip', () => {
  test('在库：pill 按钮显示姓名，title 用 contacts.chip.open 插值，点击回调带 contact id', () => {
    const onOpen = vi.fn()
    render(<PersonChip contact={contact} addr="alice@x.com" onOpen={onOpen} />)
    const button = screen.getByRole('button', { name: /Alice Chen/ })
    expect(button.getAttribute('title')).toBe('打开 Alice Chen 的人物页')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(7)
  })

  test('在库但无 display_name：姓名兜底 formal_name → primary_email → addr', () => {
    render(
      <PersonChip
        contact={{ ...contact, displayName: null, formalName: null }}
        addr="alice@x.com"
        onOpen={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /alice@x\.com/ })).toBeTruthy()
  })

  test('不在库：不可点 span 显示原地址，title 明说不建 stub，无 button 角色', () => {
    render(<PersonChip contact={null} addr="ops@partner-x.com" />)
    expect(screen.queryByRole('button')).toBeNull()
    const chip = screen.getByText('ops@partner-x.com')
    expect(chip.getAttribute('title')).toBe('这个地址不在通讯录里（不为它建占位记录）')
  })
})
