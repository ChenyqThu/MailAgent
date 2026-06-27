// Authored preview — EmailRow (the signature inbox row, Sprint 12). Reads a
// TanStack Query client (useTogglePin / pinned sync), so each cell is wrapped
// in DsPreviewProvider. Row visuals are data-attribute driven by index.css
// (.email-row [data-read]/[data-flag]/[data-priority]) — a realistic email
// object drives the unread / read / selected washes.
import type { ReactNode } from 'react'
import { EmailRow, DsPreviewProvider } from 'mailagent-frontend'

const base = {
  internal_id: 53421,
  message_id: '<demo-53421@omadanetworks.com>',
  thread_id: 'thread-saas-2026',
  subject: 'Re: AW Catch Up — SaaS 2026 Plan review',
  sender: 'sarah.kim@omadanetworks.com',
  sender_name: 'Sarah Kim',
  date_received: '2026-06-27T09:14:00+08:00',
  mailbox: '收件箱',
  is_read: false,
  is_flagged: true,
  sync_status: 'synced',
  notion_page_id: null,
  notion_url: null,
  snippet:
    'Thanks for the deck — a couple of notes before we lock the Q3 roadmap. Can we move the pricing review earlier in the agenda?',
  has_body: true,
  lang: 'en',
  ai_priority: 'urgent',
  ai_action: '回复',
  ai_category: '💼 产品管理',
  attach_count: 2,
  is_important: true,
  processing_status: null
} as const

function Frame({ children }: { children: ReactNode }) {
  return (
    <DsPreviewProvider>
      <div
        style={{
          width: 560,
          background: 'rgb(var(--ink-1))',
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid rgb(var(--ink-border) / 0.5)'
        }}
      >
        {children}
      </div>
    </DsPreviewProvider>
  )
}

export const Unread = () => (
  <Frame>
    <EmailRow email={base as never} selected={false} onSelect={() => {}} />
  </Frame>
)

export const Read = () => (
  <Frame>
    <EmailRow
      email={{ ...base, is_read: true, is_flagged: false, is_important: false, ai_priority: 'normal' } as never}
      selected={false}
      onSelect={() => {}}
    />
  </Frame>
)

export const Selected = () => (
  <Frame>
    <EmailRow email={base as never} selected onSelect={() => {}} />
  </Frame>
)
