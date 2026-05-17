// DESIGN.md §3.3 + §5 — sidebar 240px. Sprint 1 lays out the 5 fixed section
// headers (English UPPERCASE mono 11px); the entries inside each section
// land in later sprints as their data sources come online:
//   - MAILBOXES   → Sprint 2 (`mailagent debug mail-structure` + unread count)
//   - ACCOUNTS    → Sprint 2 (same source, grouped by account)
//   - AI AGENTS   → Sprint 4 (backend list / Notion agent IDs)
//   - TOOLS       → Sprint 3 (search) / Sprint 6 (admin, llm dashboard)
//   - OPS         → Sprint 6 (dead-letter, cleanup commands)

import { cn } from '@shared/lib/cn'
import { SectionHeader } from './SectionHeader'

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'mailboxes', label: 'Mailboxes' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'ai-agents', label: 'AI Agents' },
  { id: 'tools', label: 'Tools' },
  { id: 'ops', label: 'Ops' }
]

export function Sidebar(): React.ReactElement {
  return (
    <nav
      aria-label="primary"
      className={cn(
        'w-60 shrink-0 bg-ink-1 border-r border-ink-border',
        'flex flex-col overflow-y-auto'
      )}
    >
      {SECTIONS.map((section) => (
        <section key={section.id} aria-labelledby={`section-${section.id}`}>
          <SectionHeader label={section.label} />
          {/* Entries arrive in later sprints; the empty space here is on
              purpose so spot-checks see the spacing rhythm DESIGN.md §3 calls
              for, not a forced "Coming soon" pseudo-row. */}
          <ul role="list" className="px-2 pb-2 text-aux text-ink-fg-2"></ul>
        </section>
      ))}
    </nav>
  )
}
