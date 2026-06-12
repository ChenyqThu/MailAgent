// @vitest-environment happy-dom
//
// v0.7.2 — unified SegmentedControl (ui/segmented.tsx) contract.
//
// Geometry (offsetLeft/offsetWidth) is 0 in happy-dom — these tests pin the
// DOM contract instead: roles/aria, onChange wiring, the measured indicator's
// presence, and the "no legacy `.on` class" rule (the indicator replaces the
// `.on` capsule; double-painting was the bug class this component prevents).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { SegmentedControl, type SegmentedOption } from '../../src/shared/components/ui/segmented'

afterEach(() => {
  cleanup()
})

type Cadence = 'all' | 'daily' | 'weekly'

const OPTIONS: ReadonlyArray<SegmentedOption<Cadence>> = [
  { value: 'all', label: 'All' },
  { value: 'daily', label: 'Daily' },
  // ReactNode label + explicit ariaLabel (BackendSelector's dot+text case).
  { value: 'weekly', label: <span data-testid="weekly-node">Weekly</span>, ariaLabel: 'Weekly' }
]

function renderSeg(
  value: Cadence = 'all',
  onChange: (next: Cadence) => void = () => {}
): ReturnType<typeof render> {
  return render(
    <SegmentedControl<Cadence>
      value={value}
      onChange={onChange}
      options={OPTIONS}
      ariaLabel="Cadence"
    />
  )
}

describe('SegmentedControl', () => {
  test('renders a labelled tablist with one tab per option', () => {
    const { container, getByTestId } = renderSeg()
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist).toBeTruthy()
    expect(tablist!.getAttribute('aria-label')).toBe('Cadence')
    expect(tablist!.classList.contains('seg')).toBe(true)

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(3)
    expect(tabs[0].textContent).toBe('All')
    // ReactNode label renders verbatim; its a11y name comes from ariaLabel.
    expect(getByTestId('weekly-node').textContent).toBe('Weekly')
    expect(tabs[2].getAttribute('aria-label')).toBe('Weekly')
  })

  test('aria-selected marks exactly the active tab', () => {
    const { container } = renderSeg('daily')
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
    expect(tabs.map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  test('clicking a tab fires onChange with its value', () => {
    const onChange = vi.fn()
    const { container } = renderSeg('all', onChange)
    const tabs = container.querySelectorAll('[role="tab"]')
    fireEvent.click(tabs[1])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('daily')
  })

  test('active tab uses seg-active, never the legacy .on capsule class', () => {
    const { container } = renderSeg('weekly')
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
    const active = tabs[2]
    expect(active.classList.contains('seg-active')).toBe(true)
    // `.on` paints its own background — together with the indicator that
    // would double-fill. The component must never emit it.
    for (const tab of tabs) {
      expect(tab.classList.contains('on')).toBe(false)
    }
    expect(tabs[0].classList.contains('seg-active')).toBe(false)
  })

  test('sliding indicator exists, is aria-hidden, and is not a tab', () => {
    const { container } = renderSeg()
    const indicator = container.querySelector('.seg-indicator')
    expect(indicator).toBeTruthy()
    expect(indicator!.getAttribute('aria-hidden')).toBe('true')
    expect(indicator!.getAttribute('role')).toBeNull()
  })

  test('fluid + size=md spread segments and bump height', () => {
    const { container } = render(
      <SegmentedControl<Cadence>
        value="all"
        onChange={() => {}}
        options={OPTIONS}
        ariaLabel="Cadence"
        fluid
        size="md"
        className="w-full"
      />
    )
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist!.classList.contains('w-full')).toBe(true)
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
    for (const tab of tabs) {
      expect(tab.classList.contains('flex-1')).toBe(true)
      expect(tab.classList.contains('h-8')).toBe(true)
    }
  })
})
