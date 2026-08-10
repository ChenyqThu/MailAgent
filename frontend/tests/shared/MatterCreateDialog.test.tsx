// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import { MatterCreateDialog } from '../../src/shared/components/matters/MatterCreateDialog'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

describe('MatterCreateDialog email source scope', () => {
  test('does not render link scope without an email source', () => {
    const view = render(<MatterCreateDialog open onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(view.queryByRole('tablist', { name: '关联范围' })).toBeNull()
  })

  test('defaults to the whole thread when thread id is available', async () => {
    const view = render(
      <MatterCreateDialog
        open
        source={source({ threadId: 'thread-1', threadCount: 4 })}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    )
    await waitFor(() => expect(view.getByDisplayValue('Vendor launch')).toBeTruthy())
    expect(view.getByRole('tab', { name: '整条会话 · 4 封' }).getAttribute('aria-selected')).toBe('true')
  })

  test('disables thread scope and submits single when thread id is unavailable', async () => {
    const onCreate = vi.fn()
    const view = render(
      <MatterCreateDialog
        open
        source={source({ threadId: null })}
        onClose={vi.fn()}
        onCreate={onCreate}
      />
    )
    await waitFor(() => expect(view.getByDisplayValue('Vendor launch')).toBeTruthy())
    expect((view.getByRole('tab', { name: /整条会话/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('这封邮件没有可用会话，只能关联当前邮件')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      source_resource: expect.objectContaining({ link_scope: 'single', internal_id: 42856 })
    }))
  })
})

function source(overrides: Partial<React.ComponentProps<typeof MatterCreateDialog>['source'] & object> = {}) {
  return {
    internalId: 42856,
    threadId: 'thread-1',
    subject: '[External] Vendor launch',
    sender: 'Alex',
    receivedAt: '2026-08-09T10:00:00-07:00',
    threadCount: 3,
    ...overrides
  }
}
