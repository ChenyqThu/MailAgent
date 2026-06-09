// @vitest-environment happy-dom
//
// Sprint 19 PR-1d.2 — ConfirmToolDialog renderer tests.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfirmToolDialog } from '../../src/shared/components/chat/ConfirmToolDialog'
import type { PendingConfirmation } from '../../src/shared/hooks/useEmailChat'

// React-i18next reads its config from a runtime provider. The dialog uses
// useTranslation only for fallback-string lookup (every t() call provides
// a defaultValue), so an identity mock is the simplest setup that mirrors
// the production rendering.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key
  })
}))

afterEach(() => {
  cleanup()
})

function makePending(overrides: Partial<PendingConfirmation> = {}): PendingConfirmation {
  return {
    sessionId: 1,
    messageId: 10,
    toolUseId: 'toolu_test',
    toolName: 'email_flag',
    input: { internal_id: 42, is_read: true },
    preview: 'Mark email 42 as read',
    tier: 'preview',
    ...overrides
  }
}

describe('ConfirmToolDialog — preview tier', () => {
  test('renders tool name + preview banner; JSON dump is collapsed until "View details"', () => {
    render(<ConfirmToolDialog pending={makePending()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/email_flag/i)).toBeTruthy()
    expect(screen.getByText('Mark email 42 as read')).toBeTruthy()
    // task 06-08-chat PR D §4.2 — preview-tier input JSON now starts collapsed
    // behind a "View details" toggle, so the <pre> is display:hidden initially.
    const toggle = screen.getByRole('button', { name: /view details/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The <pre> exists in the DOM but is hidden (display switch, §7).
    expect(screen.getByText(/internal_id/).closest('pre')?.className).toContain('hidden')
    // Clicking the toggle reveals it.
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/internal_id/).closest('pre')?.className).toContain('block')
  })

  test('renders the tier badge ("Write" for preview / write-class tools)', () => {
    render(<ConfirmToolDialog pending={makePending()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Write')).toBeTruthy()
  })

  test('Confirm click fires onConfirm with undefined (no edits in preview tier)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={makePending()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  test('Cancel click fires onCancel', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={makePending()} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  // task 06-08-chat Bug 4 — the card is now inline (not a fixed overlay) and
  // its keydown listener is scoped to the card element, NOT window, so an
  // inline card can't steal the Composer's Escape / Cmd+Return. The shortcuts
  // fire when focus is inside the card (a button / textarea is auto-focused on
  // mount); the tests fire on the card root (role="group").
  test('Escape key on the card triggers onCancel', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={makePending()} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' })
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  test('Cmd+Enter on the card triggers onConfirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={makePending()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Enter', metaKey: true })
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  test('Escape on window does NOT trigger onCancel (inline card scopes keys)', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={makePending()} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    // No await-waitFor success path; assert it stayed un-called after a tick.
    await Promise.resolve()
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('ConfirmToolDialog — edit tier (email_draft_reply)', () => {
  function draftPending(): PendingConfirmation {
    return makePending({
      toolName: 'email_draft_reply',
      tier: 'edit',
      input: { internal_id: 7, body_markdown: 'See you Tuesday.' },
      preview: 'Reply to email 7'
    })
  }

  test('renders editable textarea seeded with body_markdown', () => {
    render(<ConfirmToolDialog pending={draftPending()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.value).toBe('See you Tuesday.')
  })

  test('renders the "Edit" tier badge and no "View details" toggle', () => {
    render(<ConfirmToolDialog pending={draftPending()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Edit')).toBeTruthy()
    // The textarea is the main surface — no collapsed-JSON toggle in edit tier.
    expect(screen.queryByRole('button', { name: /view details/i })).toBeNull()
  })

  test('Confirm without edits passes undefined (no userEdited flag)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={draftPending()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  test('Confirm with edits passes merged input + edited body_markdown', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<ConfirmToolDialog pending={draftPending()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'See you Wednesday — Tuesday no good.' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledWith({
      internal_id: 7,
      body_markdown: 'See you Wednesday — Tuesday no good.'
    })
  })
})

describe('ConfirmToolDialog — resolved banner (§4.3)', () => {
  test('confirmed → renders the decided-OK banner, hides the action footer', () => {
    render(
      <ConfirmToolDialog
        pending={makePending({ resolved: 'confirmed' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/callback received, executing/i)).toBeTruthy()
    // Action buttons are gone once decided.
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  test('rejected → renders the decided-NO banner', () => {
    render(
      <ConfirmToolDialog
        pending={makePending({ resolved: 'rejected' })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/no changes made to your mailbox/i)).toBeTruthy()
  })

  test('keyboard shortcuts are inert once resolved (decision already made)', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined)
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <ConfirmToolDialog
        pending={makePending({ resolved: 'confirmed' })}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Enter', metaKey: true })
    await Promise.resolve()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('ConfirmToolDialog — busy state', () => {
  test('disables buttons while onConfirm is pending', async () => {
    let resolveConfirm: () => void = () => undefined
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        })
    )
    render(<ConfirmToolDialog pending={makePending()} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    // While pending, the buttons should disable.
    await vi.waitFor(() => {
      const btn = screen.getByRole('button', { name: /confirming/i })
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    })
    resolveConfirm()
  })
})
