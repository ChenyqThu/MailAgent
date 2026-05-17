// DESIGN.md §3.3 + §5 — 240px sidebar. Sprint 2 wires the MAILBOXES section
// to the live SQLite-direct IPC (`email:listMailboxes`); the other four
// section headers stay as placeholders until their respective sprints land
// (AI AGENTS Sprint 4, TOOLS Sprint 3/6, OPS Sprint 6).
//
// Selected mailbox: 3px coral left edge (matches DESIGN.md §2.2 "selected
// row" rule) + ink-3 bg + medium weight label. Unread count badge: coral
// pill when non-zero, dim otherwise.

import { useQuery } from '@tanstack/react-query'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useMailbox } from '@shared/state/mailbox'

import { SectionHeader } from './SectionHeader'

const PLACEHOLDER_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'ai-agents', label: 'AI Agents' },
  { id: 'tools', label: 'Tools' },
  { id: 'ops', label: 'Ops' }
]

export function Sidebar(): React.ReactElement {
  const mailApi = useMailApi()
  const active = useMailbox((s) => s.active)
  const setActive = useMailbox((s) => s.setActive)

  const { data, isLoading } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    // Mailbox shape changes rarely; refetch when the renderer mounts +
    // every 60s to catch a freshly-added Mail.app account.
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false
  })

  const mailboxes = data ?? []

  return (
    <nav
      aria-label="primary"
      className={cn(
        'w-60 shrink-0 bg-ink-1 border-r border-ink-border',
        'flex flex-col overflow-y-auto'
      )}
    >
      <section aria-labelledby="section-mailboxes">
        <SectionHeader label="Mailboxes" count={isLoading ? '…' : mailboxes.length} />
        <ul role="list" className="px-2 pb-2 text-aux text-ink-fg-2">
          {mailboxes.map((mb) => {
            const selected = mb.mailbox === active
            return (
              <li key={mb.mailbox}>
                <button
                  onClick={() => setActive(mb.mailbox)}
                  className={cn(
                    'relative w-full flex items-center justify-between px-2 py-1.5 rounded',
                    'text-aux text-left transition-colors duration-fast',
                    selected
                      ? 'bg-ink-3 text-ink-fg font-medium'
                      : 'text-ink-fg-1 hover:bg-ink-2 hover:text-ink-fg'
                  )}
                  aria-current={selected ? 'page' : undefined}
                >
                  {selected && (
                    <span
                      className="absolute left-0 top-1 bottom-1 w-[3px] bg-coral/100 rounded-r"
                      aria-hidden
                    />
                  )}
                  <span className="truncate pl-2">{mb.mailbox}</span>
                  <span
                    className={cn(
                      'shrink-0 ml-2 text-micro font-mono tabular-nums px-1.5 py-0.5 rounded',
                      mb.unread > 0 ? 'text-coral bg-coral/15' : 'text-ink-fg-3'
                    )}
                  >
                    {mb.unread > 0 ? mb.unread : mb.total}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {PLACEHOLDER_SECTIONS.map((section) => (
        <section key={section.id} aria-labelledby={`section-${section.id}`}>
          <SectionHeader label={section.label} />
          <ul role="list" className="px-2 pb-2 text-aux text-ink-fg-2"></ul>
        </section>
      ))}
    </nav>
  )
}
