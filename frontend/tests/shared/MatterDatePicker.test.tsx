// @vitest-environment happy-dom
//
// 事项截止时间的日历 popover（0813 dogfood #21）。钉的是行为契约：
//   • 默认落**当月**、今天有标记、已有值时高亮且直接落在值所在的月；
//   • 快捷按钮（今天/本周/下周/本月）写出去的是**本地零点毫秒** ——
//     服务端 `_require_epoch_ms` 拒秒级，写错量级是静默 422；
//   • 清除写 null；翻月只动视图不写值。
//
// tests/setup.ts 全局强制 reduced-motion，Popmenu 的 morph 短路，断言看到的是最终 DOM。

import { useRef } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import { MatterDatePicker } from '../../src/shared/components/matters/MatterDatePicker'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
})

/** 2026-08-13 是**周四** —— 本周日 = 08-16，下周日 = 08-23，本月末 = 08-31。 */
const NOW = new Date(2026, 7, 13, 14, 22, 9, 500).getTime()
const midnight = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day).getTime()

function Harness({
  value = null,
  onSelect = vi.fn(),
  now = NOW
}: {
  value?: number | null
  onSelect?: (value: number | null) => void
  now?: number
}): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={triggerRef} type="button">
        trigger
      </button>
      <MatterDatePicker
        open
        onClose={vi.fn()}
        value={value}
        now={now}
        triggerRef={triggerRef}
        ariaLabel="选择截止时间"
        onSelect={onSelect}
      />
    </div>
  )
}

test('opens on the current month and marks today when no value is set', () => {
  const view = render(<Harness />)

  expect(
    view.getByText(new Date(2026, 7, 1).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long'
    }))
  ).toBeTruthy()

  const today = view.container.querySelector('[data-today="true"]')
  expect(today).toBeTruthy()
  expect(today?.getAttribute('aria-current')).toBe('date')
  expect(today?.textContent).toBe('13')
  // 没设值 ⇒ 没有任何一格是「已选」。
  expect(view.container.querySelector('[aria-pressed="true"]')).toBeNull()
})

test('opens on the month of an existing value and marks it selected', () => {
  const view = render(<Harness value={midnight(2026, 11, 5)} />)

  expect(
    view.getByText(new Date(2026, 10, 1).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long'
    }))
  ).toBeTruthy()
  const selected = view.container.querySelector('[aria-pressed="true"]')
  expect(selected?.textContent).toBe('5')
  expect(selected?.getAttribute('data-day')).toBe(String(midnight(2026, 11, 5)))
  // 11 月视图里不该出现今天（8 月）的标记。
  expect(view.container.querySelector('[data-today="true"]')).toBeNull()
})

test('clicking a day writes that day local midnight in epoch ms', () => {
  const onSelect = vi.fn()
  const view = render(<Harness onSelect={onSelect} />)

  fireEvent.click(view.container.querySelector(`[data-day="${midnight(2026, 8, 20)}"]`)!)

  expect(onSelect).toHaveBeenCalledTimes(1)
  const written = onSelect.mock.calls[0]![0] as number
  expect(written).toBe(midnight(2026, 8, 20))
  expect(new Date(written).getHours()).toBe(0)
  expect(String(written).length).toBe(13) // 毫秒量级，不是秒
})

test.each([
  ['今天', midnight(2026, 8, 13)],
  ['本周', midnight(2026, 8, 16)],
  ['下周', midnight(2026, 8, 23)],
  ['本月', midnight(2026, 8, 31)]
])('preset %s writes the mapped local midnight', (label, expected) => {
  const onSelect = vi.fn()
  const view = render(<Harness onSelect={onSelect} />)

  fireEvent.click(view.getByRole('button', { name: label as string }))

  expect(onSelect).toHaveBeenCalledWith(expected)
})

test('clear writes null, and is absent when there is nothing to clear', () => {
  const onSelect = vi.fn()
  const view = render(<Harness value={midnight(2026, 8, 20)} onSelect={onSelect} />)

  fireEvent.click(view.getByRole('button', { name: '清除' }))
  expect(onSelect).toHaveBeenCalledWith(null)

  cleanup()
  const empty = render(<Harness value={null} onSelect={onSelect} />)
  expect(empty.queryByRole('button', { name: '清除' })).toBeNull()
})

test('month navigation moves the view without writing a value', () => {
  const onSelect = vi.fn()
  const view = render(<Harness onSelect={onSelect} />)

  fireEvent.click(view.getByRole('button', { name: '下个月' }))
  expect(
    view.getByText(new Date(2026, 8, 1).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long'
    }))
  ).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: '上个月' }))
  fireEvent.click(view.getByRole('button', { name: '上个月' }))
  expect(
    view.getByText(new Date(2026, 6, 1).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long'
    }))
  ).toBeTruthy()

  expect(onSelect).not.toHaveBeenCalled()
})

test('arrow keys move the day cursor and pull the view across the month boundary', async () => {
  const view = render(<Harness value={midnight(2026, 8, 31)} />)

  const cursor = (): Element | null => view.container.querySelector('[data-day-focused="true"]')
  expect(cursor()?.getAttribute('data-day')).toBe(String(midnight(2026, 8, 31)))

  fireEvent.keyDown(cursor()!, { key: 'ArrowRight' })
  await waitFor(() =>
    expect(cursor()?.getAttribute('data-day')).toBe(String(midnight(2026, 9, 1)))
  )
  // 越过月末 ⇒ 视图跟着翻到 9 月。
  expect(
    view.getByText(new Date(2026, 8, 1).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long'
    }))
  ).toBeTruthy()

  fireEvent.keyDown(cursor()!, { key: 'ArrowDown' })
  await waitFor(() =>
    expect(cursor()?.getAttribute('data-day')).toBe(String(midnight(2026, 9, 8)))
  )
  fireEvent.keyDown(cursor()!, { key: 'ArrowUp' })
  await waitFor(() =>
    expect(cursor()?.getAttribute('data-day')).toBe(String(midnight(2026, 9, 1)))
  )
})
