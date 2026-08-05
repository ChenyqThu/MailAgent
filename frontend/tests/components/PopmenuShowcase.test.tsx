// @vitest-environment happy-dom
//
// Popmenu showcase（dev-only 审批物）的**冒烟**测试 —— 它替代不了视觉验收，只钉三件
// 「打开就炸」级别的事：整页能挂载、每个场地小节都在、以及两条最容易写错的路径
// （items 形态开一次 / children 逃生舱形态开一次 + combobox 焦点不被基座抢走）。
//
// 之所以给一段 dev-only 脚手架配测试：这页是给 owner 过目用的，一旦某个场景组件在
// 渲染期抛异常，整页白屏、而 dev-only 代码不在任何别的回归网里。
//
// tests/setup.ts 全局强制 prefers-reduced-motion:reduce → morph 短路，断言看最终 DOM。

import { describe, expect, test, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

import PopmenuShowcase from '../../src/shared/components/dev/popmenu-showcase'

beforeEach(() => {
  cleanup()
})

function open(): void {
  render(<PopmenuShowcase onClose={() => {}} />)
}

describe('PopmenuShowcase', () => {
  test('整页挂载，十个场地小节都在', () => {
    open()
    for (const title of [
      'TitleBar',
      'Sidebar',
      '邮件列表 / 邮件工具栏',
      'Composer',
      'Chat / AI 面板',
      'Chat 浮窗 Modal',
      'Agents 页',
      '日历',
      '设置页',
      '不建议直接迁 / 需专门适配'
    ]) {
      expect(screen.getByRole('heading', { name: title, level: 2 })).toBeTruthy()
    }
  })

  test('items 形态：点触发器开出 role=menu，下钻能进二级面板', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: '三级下钻' }))
    const menu = screen.getByRole('menu', { name: '多级下钻' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /时间范围/ }))
    expect(screen.getByRole('menu', { name: '时间范围' })).toBeTruthy()
  })

  test('children 逃生舱：基座不接管键盘，也不抢走 combobox 的焦点', () => {
    open()
    const input = screen.getByRole('combobox', { name: '' }) as HTMLInputElement
    input.focus()
    fireEvent.focus(input)
    // 列表张开后焦点必须还在 input 上（combobox 焦点模型），且 aria-activedescendant 指向首项。
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe('showcase-recipient-0')
    expect(screen.getByRole('listbox', { name: '收件人建议' })).toBeTruthy()
  })

  test('危险确认换 view：选「完全授权」原地换成确认面板，取消可回列表', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: /手动授权/ }))
    fireEvent.click(screen.getByRole('radio', { name: /完全授权/ }))
    expect(screen.getByText('切换到完全授权？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('radio', { name: /手动授权/ })).toBeTruthy()
  })
})
