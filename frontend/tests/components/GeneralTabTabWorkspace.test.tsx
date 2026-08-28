// @vitest-environment happy-dom
//
// 设置 · 通用 →「标签工作区」节（task 08-27-l4-tab-workspace P2 · Lane K）。
//
// 钉三件事：这一节真的渲染出来了（不是只加了 locale key）、加减真的落到
// `useTabWorkspace.setMaxTabs`、到了 4 / 12 两端按钮置灰。clamp 本身在
// tests/shared/tab-workspace.test.ts，这里只管「设置面接没接上」。

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'

import i18n from '@shared/i18n'
import { GeneralTab } from '@shared/components/settings/tabs/GeneralTab'
import { MAX_TABS_MAX, MAX_TABS_MIN, useTabWorkspace } from '@shared/state/tab-workspace'

await i18n.changeLanguage('zh-CN')

/** Stepper 那一行：label 文字 → 包着它的行容器（label 在 `.flex-1` 里，行是它的父）。 */
function limitRow(): HTMLElement {
  const label = screen.getByText('标签上限')
  const row = label.parentElement?.parentElement
  if (!row) throw new Error('标签上限 Stepper 行结构变了')
  return row
}

function button(row: HTMLElement, label: 'decrease' | 'increase'): HTMLButtonElement {
  return within(row).getByLabelText(label) as HTMLButtonElement
}

function renderTab(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <GeneralTab />
    </I18nextProvider>
  )
}

beforeEach(() => {
  useTabWorkspace.setState({ maxTabs: 8 })
})

afterEach(cleanup)

describe('设置 · 标签工作区', () => {
  test('显示当前上限，加减写回 store', () => {
    renderTab()
    // 节标题与可调区间（区间是 ICU 占位符渲染出来的，写错会显示成 `{min}-{max}`）。
    expect(screen.getByText('标签工作区')).toBeTruthy()
    expect(screen.getByText(`${MAX_TABS_MIN}-${MAX_TABS_MAX}`)).toBeTruthy()

    const row = limitRow()
    expect(within(row).getByText('8')).toBeTruthy()

    fireEvent.click(within(row).getByLabelText('increase'))
    expect(useTabWorkspace.getState().maxTabs).toBe(9)

    fireEvent.click(within(row).getByLabelText('decrease'))
    fireEvent.click(within(row).getByLabelText('decrease'))
    expect(useTabWorkspace.getState().maxTabs).toBe(7)
  })

  test('到下限 4 时减号置灰', () => {
    useTabWorkspace.setState({ maxTabs: MAX_TABS_MIN })
    renderTab()
    const row = limitRow()
    expect(button(row, 'decrease').disabled).toBe(true)
    expect(button(row, 'increase').disabled).toBe(false)
  })

  test('到上限 12 时加号置灰', () => {
    useTabWorkspace.setState({ maxTabs: MAX_TABS_MAX })
    renderTab()
    const row = limitRow()
    expect(button(row, 'increase').disabled).toBe(true)
    expect(button(row, 'decrease').disabled).toBe(false)
  })
})
