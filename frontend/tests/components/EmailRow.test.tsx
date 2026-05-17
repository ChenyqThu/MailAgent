// @vitest-environment happy-dom

// DESIGN.md §5.1 + REVIEW-LOG C-08 Sprint 1 spot-check carry-over: EmailRow
// is one of the five core components that need a light/dark visual sanity
// check. We snapshot 8 combinations (dark × light × selected × unread ×
// failed) so a regression to any token swap is caught in CI.

import { describe, expect, test, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

import { EmailRow } from '../../src/shared/components/email/EmailRow'
import type { EnrichedEmailMeta } from '../../src/shared/api/types'

function makeEmail(over: Partial<EnrichedEmailMeta> = {}): EnrichedEmailMeta {
  return {
    internal_id: 101,
    message_id: '<msg-101@example.com>',
    thread_id: 'thread-A',
    subject: 'redis timeout debug session',
    sender: 'alice@example.com',
    sender_name: 'Alice',
    date_received: '2026-05-15T09:00:00+08:00',
    mailbox: '收件箱',
    is_read: true,
    is_flagged: false,
    sync_status: 'synced',
    notion_page_id: null,
    notion_url: null,
    snippet: 'Hey, the redis client keeps timing out after 5s.',
    lang: 'en',
    ai_priority: 'critical',
    ai_action: '需要回复',
    attach_count: 2,
    ...over
  }
}

function applyTheme(theme: 'dark' | 'light'): void {
  const html = document.documentElement
  html.setAttribute('data-theme', theme)
  html.classList.toggle('dark', theme === 'dark')
}

beforeEach(() => {
  cleanup()
  applyTheme('dark')
})

describe('EmailRow — 8 combo render snapshots (DESIGN.md §5.1)', () => {
  const themes = ['dark', 'light'] as const
  const variants: Array<{ name: string; selected: boolean; unread: boolean; failed: boolean }> = [
    { name: 'selected-unread-normal', selected: true, unread: true, failed: false },
    { name: 'selected-read-normal', selected: true, unread: false, failed: false },
    { name: 'unselected-unread-failed', selected: false, unread: true, failed: true },
    { name: 'unselected-read-normal', selected: false, unread: false, failed: false }
  ]

  for (const theme of themes) {
    for (const v of variants) {
      test(`${theme} · ${v.name}`, () => {
        applyTheme(theme)
        const email = makeEmail({
          is_read: !v.unread,
          sync_status: v.failed ? 'failed' : 'synced'
        })
        const { container } = render(
          <EmailRow email={email} selected={v.selected} onSelect={() => {}} />
        )
        // Use the outer <article> only — strips React 19's render wrapper
        // div noise so the snapshot stays stable across React minor bumps.
        expect(container.firstChild).toMatchSnapshot()
      })
    }
  }
})

describe('EmailRow — semantic behaviour', () => {
  test('chip renders English short code, not the Chinese verbatim (lint §14 #2)', () => {
    const email = makeEmail({ ai_action: '需要回复' })
    const { container } = render(<EmailRow email={email} selected={false} onSelect={() => {}} />)
    // The chip text should be the ASCII shortcode.
    expect(container.textContent).toContain('REPLY')
    // The full Chinese stays on the title= attribute for hover-reveal.
    const chip = container.querySelector('[title="需要回复"]')
    expect(chip).not.toBeNull()
  })

  test('lang=zh suppresses the EN pip; lang=en shows it', () => {
    const enRow = render(
      <EmailRow email={makeEmail({ lang: 'en' })} selected={false} onSelect={() => {}} />
    )
    expect(enRow.container.textContent).toContain('EN')
    cleanup()
    const zhRow = render(
      <EmailRow email={makeEmail({ lang: 'zh' })} selected={false} onSelect={() => {}} />
    )
    expect(zhRow.container.textContent).not.toContain('EN')
  })

  test('isNew adds a NEW pill that disappears when prop is undefined', () => {
    const withBadge = render(
      <EmailRow email={makeEmail()} selected={false} isNew onSelect={() => {}} />
    )
    expect(withBadge.container.textContent).toContain('NEW')
    cleanup()
    const without = render(<EmailRow email={makeEmail()} selected={false} onSelect={() => {}} />)
    expect(without.container.textContent).not.toContain('NEW')
  })

  test('sender_name absent → falls back to local-part of address', () => {
    const email = makeEmail({ sender_name: null, sender: 'bob.smith@corp.com' })
    const { container } = render(<EmailRow email={email} selected={false} onSelect={() => {}} />)
    expect(container.textContent).toContain('bob.smith')
  })

  test('attach_count=0 omits the paperclip', () => {
    const email = makeEmail({ attach_count: 0 })
    const { container } = render(<EmailRow email={email} selected={false} onSelect={() => {}} />)
    // The `lucide-react` Paperclip renders an <svg>; we assert by class hook.
    expect(container.querySelector('svg')).toBeNull()
  })
})
