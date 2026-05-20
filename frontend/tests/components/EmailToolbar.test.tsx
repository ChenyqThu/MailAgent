// @vitest-environment happy-dom
//
// Sprint 5 §2.2 — EmailToolbar write button wiring.
//
// Verifies:
//   - onCreateDraft fires on the coral CTA
//   - onLlmRun fires on AI 重跑
//   - onResync opens a confirm dialog; clicking "试跑" / "直接重传"
//     dispatches with the correct dryRun flag
//   - pending flag disables the button + shows spinner (Loader2 → role=img)
//   - isRead / isFlagged drives the label & `active` state

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { EmailToolbar } from '../../src/shared/components/email/EmailToolbar'

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  cleanup()
})

describe('EmailToolbar — write button wiring', () => {
  test('clicking 起草回复 fires onCreateDraft once', () => {
    const onCreateDraft = vi.fn()
    render(<EmailToolbar onCreateDraft={onCreateDraft} />)
    const btn = screen.getByRole('button', { name: /起草回复/ })
    fireEvent.click(btn)
    expect(onCreateDraft).toHaveBeenCalledTimes(1)
  })

  test('draft button disabled + label flips while pending', () => {
    const onCreateDraft = vi.fn()
    render(<EmailToolbar onCreateDraft={onCreateDraft} draftState={{ pending: true }} />)
    const btn = screen.getByRole('button', { name: /草稿创建中/ })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(btn)
    expect(onCreateDraft).not.toHaveBeenCalled()
  })

  test('clicking AI 重跑 fires onLlmRun once', () => {
    const onLlmRun = vi.fn()
    render(<EmailToolbar onLlmRun={onLlmRun} />)
    fireEvent.click(screen.getByRole('button', { name: /^AI 重跑$/ }))
    expect(onLlmRun).toHaveBeenCalledTimes(1)
  })

  test('clicking 重传 Notion opens confirm dialog, dry-run path dispatches with dryRun=true', () => {
    const onResync = vi.fn()
    render(<EmailToolbar onResync={onResync} />)
    fireEvent.click(screen.getByRole('button', { name: /^重传 Notion$/ }))
    // Dialog mounted; the "试跑" button is now in the DOM.
    const dryRunBtn = screen.getByRole('button', { name: '试跑' })
    fireEvent.click(dryRunBtn)
    expect(onResync).toHaveBeenCalledTimes(1)
    expect(onResync).toHaveBeenCalledWith({ dryRun: true })
  })

  test('confirm dialog "直接重传" path dispatches with dryRun=false', () => {
    const onResync = vi.fn()
    render(<EmailToolbar onResync={onResync} />)
    fireEvent.click(screen.getByRole('button', { name: /^重传 Notion$/ }))
    fireEvent.click(screen.getByRole('button', { name: '直接重传' }))
    expect(onResync).toHaveBeenCalledWith({ dryRun: false })
  })

  test('confirm dialog "取消" closes without dispatching', () => {
    const onResync = vi.fn()
    render(<EmailToolbar onResync={onResync} />)
    fireEvent.click(screen.getByRole('button', { name: /^重传 Notion$/ }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onResync).not.toHaveBeenCalled()
    // Dialog is gone.
    expect(screen.queryByRole('button', { name: '直接重传' })).toBeNull()
  })

  test('isRead drives the label between 已读 / 未读', () => {
    const onToggleRead = vi.fn()
    const { rerender } = render(<EmailToolbar onToggleRead={onToggleRead} isRead={false} />)
    expect(screen.getByRole('button', { name: /^已读$/ })).toBeTruthy()
    rerender(<EmailToolbar onToggleRead={onToggleRead} isRead={true} />)
    expect(screen.getByRole('button', { name: /^未读$/ })).toBeTruthy()
  })

  test('isFlagged toggles the Star fill class (active state)', () => {
    const onToggleFlag = vi.fn()
    render(<EmailToolbar onToggleFlag={onToggleFlag} isFlagged={true} />)
    const btn = screen.getByRole('button', { name: /^标旗$/ })
    // active=true gives text-urg per Ghost component.
    expect(btn.className).toContain('text-urg')
  })

  test('notionUrl renders a Notion button that opens in a new tab on click', () => {
    // Sprint 13 — aria-label changed from hardcoded "Notion" to translated
    // `toolbar.openNotion` ("在 Notion 打开") when EmailToolbar migrated to
    // the IconOnlyBtn primitive (single source: label drives both
    // aria-label and HoverTip text).
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<EmailToolbar notionUrl="https://notion.so/foo" />)
    fireEvent.click(screen.getByRole('button', { name: /在 Notion 打开/ }))
    expect(open).toHaveBeenCalledWith('https://notion.so/foo', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  test('Sprint 13 — Archive button is data-disabled + carries the blocked hint', () => {
    // Backend has no `mailagent email archive` CLI; the button stays in the
    // mockup layout but never fires. data-disabled + opacity-50 + aria-label
    // make the state visible to keyboard / screen-reader users.
    render(<EmailToolbar />)
    const archive = screen.getByRole('button', { name: /^归档$/ })
    expect((archive as HTMLButtonElement).disabled).toBe(true)
    expect(archive.getAttribute('data-disabled')).toBe('')
    expect(archive.tabIndex).toBe(-1)
  })

  test('Sprint 13 — isImportant=true surfaces the ❗ passive indicator', () => {
    render(<EmailToolbar isImportant={true} />)
    // The indicator is a `<span role="img">`, not a button — clicking it
    // does nothing because the backend has no email.markImportant write.
    const indicator = screen.getByRole('img', { name: /重要/ })
    expect(indicator).toBeTruthy()
    expect(indicator.getAttribute('data-disabled')).toBe('')
  })

  test('Sprint 13 — isImportant=false hides the ❗ indicator entirely', () => {
    render(<EmailToolbar isImportant={false} />)
    expect(screen.queryByRole('img', { name: /重要/ })).toBeNull()
  })
})
