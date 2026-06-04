// @vitest-environment happy-dom

// DESIGN.md §5.1 + REVIEW-LOG C-08 Sprint 1 spot-check carry-over: EmailRow
// is one of the five core components that need a light/dark visual sanity
// check. We snapshot 8 combinations (dark × light × selected × unread ×
// failed) so a regression to any token swap is caught in CI.
//
// Sprint 12.5 — EmailRow now uses `useQueryClient` for invalidating the
// list after flag/archive writes, so every render needs a
// QueryClientProvider in the tree.

import { describe, expect, test, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { EmailRow } from '../../src/shared/components/email/EmailRow'
import type { EnrichedEmailMeta } from '../../src/shared/api/types'

// EmailRow renders i18n aria-labels (emailRow.toggleFlag/togglePin/important/
// archive/…) + the NEW chip. The stored combo snapshots + the isNew assertion
// are en-US ("Toggle flag" / "NEW"). Init i18n to en-US so t() returns real
// strings instead of raw keys (same pattern as EmailDetail/ChatSidebar tests,
// which call i18n.changeLanguage at module top-level). Without this every
// aria-label renders as its key and the 8 snapshots + NEW chip mismatch.
await i18n.changeLanguage('en-US')

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
    // v9 — 邮件原生 Importance 头部归一化。默认 true 保留 base fixture 的
    // 「critical priority + ❗ 重要」语义；测试要 cover 非重要场景就 override。
    is_important: true,
    ...over
  }
}

function renderRow(props: {
  email: EnrichedEmailMeta
  selected: boolean
  isNew?: boolean
}): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  return render(
    <QueryClientProvider client={qc}>
      <EmailRow {...props} onSelect={() => {}} />
    </QueryClientProvider>
  )
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
        const { container } = renderRow({ email, selected: v.selected })
        // Drill past the wrapper div + QueryClientProvider so the snapshot
        // is just the <article>.
        const article = container.querySelector('article.email-row')
        expect(article).not.toBeNull()
        expect(article).toMatchSnapshot()
      })
    }
  }
})

describe('EmailRow — semantic behaviour', () => {
  test('ai-strip surfaces the Chinese action label (mockup-inbox.html row pattern)', () => {
    // Sprint 12 — row's `ai-strip` is a mono single-line signal row that
    // shows the Chinese action label verbatim ("需要回复"), NOT an ASCII
    // shortcode. The original Sprint 2 `mapActionLabel` (REPLY/READ/…)
    // chip was retired with the visual rework.
    const email = makeEmail({ ai_action: '需要回复' })
    const { container } = renderRow({ email, selected: false })
    expect(container.textContent).toContain('需要回复')
    const aiBit = container.querySelector('[title="需要回复"]')
    expect(aiBit).not.toBeNull()
  })

  test('lang=zh suppresses the EN pip; lang=en shows it', () => {
    const enRow = renderRow({ email: makeEmail({ lang: 'en' }), selected: false })
    expect(enRow.container.textContent).toContain('EN')
    cleanup()
    const zhRow = renderRow({ email: makeEmail({ lang: 'zh' }), selected: false })
    expect(zhRow.container.textContent).not.toContain('EN')
  })

  test('isNew adds a NEW chip in the ai-strip', () => {
    // Sprint 12 — NEW now lives at the end of the .ai-strip (mono mockup
    // line), so it still reads as a chip but inside the priority row.
    const withBadge = renderRow({ email: makeEmail(), selected: false, isNew: true })
    expect(withBadge.container.textContent).toContain('NEW')
    cleanup()
    const without = renderRow({ email: makeEmail(), selected: false })
    expect(without.container.textContent).not.toContain('NEW')
  })

  test('sender_name absent → falls back to local-part of address', () => {
    const email = makeEmail({ sender_name: null, sender: 'bob.smith@corp.com' })
    const { container } = renderRow({ email, selected: false })
    expect(container.textContent).toContain('bob.smith')
  })

  test('attach_count=0 omits the .ricon-attach indicator', () => {
    const email = makeEmail({ attach_count: 0 })
    const { container } = renderRow({ email, selected: false })
    expect(container.querySelector('.ricon-attach')).toBeNull()
    cleanup()
    const withAttach = renderRow({ email: makeEmail({ attach_count: 2 }), selected: false })
    expect(withAttach.container.querySelector('.ricon-attach')).not.toBeNull()
  })

  test('data-* attributes drive CSS state (read / flag / priority)', () => {
    // Sprint 12 — row state is data-attribute driven so authored CSS can
    // handle the read/flag/priority washes without per-state JSX branches.
    const { container } = renderRow({
      email: makeEmail({
        is_read: false,
        is_flagged: true,
        ai_priority: 'urgent'
      }),
      selected: false
    })
    const article = container.querySelector('article.email-row')
    expect(article?.getAttribute('data-read')).toBe('false')
    expect(article?.getAttribute('data-flag')).toBe('flagged')
    expect(article?.getAttribute('data-priority')).toBe('urg')
  })
})
