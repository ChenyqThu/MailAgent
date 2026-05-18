// DESIGN.md §3.3 + §5 — 240px sidebar. Five fixed sections with English
// UPPERCASE mono headers. Sprint 2 wires only MAILBOXES to live data
// (email:listMailboxes IPC); ACCOUNTS / AI AGENTS / TOOLS / OPS surface
// placeholder rows that visually match the mockup so the rail isn't bare.
//
// Selected mailbox: bg-ink-4 + 3px coral edge via .row-selected (CSS) for
// the mockup-faithful left-edge accent. Unread count: coral pill when > 0,
// dim mono otherwise.

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  BarChart3,
  CalendarDays,
  HelpCircle,
  History,
  Inbox,
  Languages,
  Lock,
  Mail,
  Search,
  Send,
  Settings,
  Sparkles,
  Star
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useMailbox } from '@shared/state/mailbox'
import { useEmailFilter } from '@shared/state/email-filter'
import { toggleAIChatPanel } from '@shared/state/ai-chat-panel'
import { openKeyboardHelp } from '@shared/state/keyboard-help'

interface SectionProps {
  label: string
  children: React.ReactNode
}

function Section({ label, children }: SectionProps): React.ReactElement {
  return (
    <>
      <div className="px-3 pb-1">
        <h2
          className={cn('text-micro font-mono uppercase text-ink-fg-2 px-2 py-1.5')}
          style={{ letterSpacing: '0.08em' }}
        >
          {label}
        </h2>
      </div>
      <nav className="px-2 space-y-px">{children}</nav>
    </>
  )
}

interface ItemProps {
  icon: React.ReactNode
  label: string
  selected?: boolean
  onClick?: () => void
  /** Right-side display: coral pill (unread > 0) or dim mono count, or any node. */
  right?: React.ReactNode
}

function Item({ icon, label, selected, onClick, right }: ItemProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'row relative w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md',
        'text-body text-left transition-colors duration-fast',
        selected
          ? 'row-selected bg-ink-4 text-ink-fg font-medium'
          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
      )}
    >
      <span className="shrink-0 grid place-items-center w-[15px] h-[15px] text-ink-fg-2">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {right && <span className="shrink-0">{right}</span>}
    </button>
  )
}

function UnreadPill({ count }: { count: number }): React.ReactElement {
  if (count === 0) {
    return <span className="text-meta font-mono text-ink-fg-3 tabular-nums">{count}</span>
  }
  return (
    <span
      className={cn(
        'text-micro font-mono tabular-nums px-1.5 py-0.5 rounded',
        'text-ink-fg bg-coral/15 border border-coral/30'
      )}
    >
      {count}
    </span>
  )
}

function TotalCount({ count }: { count: number }): React.ReactElement {
  return (
    <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
      {count.toLocaleString('en-US')}
    </span>
  )
}

const MAILBOX_ICON: Record<string, React.ReactNode> = {
  收件箱: <Inbox size={15} strokeWidth={1.75} />,
  发件箱: <Send size={15} strokeWidth={1.75} />
}

export function Sidebar(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const active = useMailbox((s) => s.active)
  const setActive = useMailbox((s) => s.setActive)
  const currentFilter = useEmailFilter((s) => s.filter)
  const setFilter = useEmailFilter((s) => s.setFilter)

  const { data } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false
  })
  const mailboxes = data ?? []

  // Sprint 10 user-acceptance — sum across all mailboxes so the virtual
  // "已标旗 / 所有邮件" entries surface real numbers (previously hardcoded 0
  // for the flagged row). listMailboxes excludes `skipped` rows so these
  // counts match what the email list actually renders.
  const allTotal = mailboxes.reduce((sum, mb) => sum + mb.total, 0)
  const flaggedTotal = mailboxes.reduce((sum, mb) => sum + (mb.flagged ?? 0), 0)

  const handleFlaggedClick = (): void => {
    setFilter('flagged')
    void navigate({ to: '/' })
  }
  const handleAllMailClick = (): void => {
    setFilter('all')
    void navigate({ to: '/' })
  }

  return (
    <aside
      aria-label="primary"
      className={cn('w-60 shrink-0 bg-ink-1 border-r border-ink-border flex flex-col')}
    >
      <div className="flex-1 overflow-y-auto scrollbar-thin py-2.5">
        <Section label={t('sidebar.section.mailboxes')}>
          {mailboxes.map((mb) => (
            <Item
              key={mb.mailbox}
              icon={MAILBOX_ICON[mb.mailbox] ?? <Mail size={15} strokeWidth={1.75} />}
              label={mb.mailbox}
              selected={mb.mailbox === active}
              onClick={() => setActive(mb.mailbox)}
              right={<UnreadPill count={mb.unread} />}
            />
          ))}
          {mailboxes.length > 0 && (
            <Item
              icon={<Star size={15} strokeWidth={1.75} />}
              label={t('sidebar.flagged')}
              selected={currentFilter === 'flagged'}
              onClick={handleFlaggedClick}
              right={
                flaggedTotal > 0 ? (
                  <UnreadPill count={flaggedTotal} />
                ) : (
                  <TotalCount count={flaggedTotal} />
                )
              }
            />
          )}
          {mailboxes.length > 0 && (
            <Item
              icon={<Mail size={15} strokeWidth={1.75} />}
              label={t('sidebar.allMail')}
              selected={currentFilter === 'all'}
              onClick={handleAllMailClick}
              right={<TotalCount count={allTotal} />}
            />
          )}
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label={t('sidebar.section.aiAgents')}>
          {/* Sprint 10 user-acceptance — AI Agents entries used to be
              presentational only ("根本点不了" per user feedback). Now they
              open the AI Chat panel (where backend selection lives) or jump
              to Settings → AI backends for configuration. */}
          <Item
            icon={<Sparkles size={15} strokeWidth={1.75} />}
            label="Notion Agent"
            onClick={toggleAIChatPanel}
            right={<span className="w-1.5 h-1.5 rounded-full bg-ok" title={t('sidebar.online')} />}
          />
          <Item
            icon={<Lock size={15} strokeWidth={1.75} />}
            label="Custom API"
            onClick={toggleAIChatPanel}
          />
          <Item
            icon={<History size={15} strokeWidth={1.75} />}
            label={t('sidebar.aiHistory')}
            onClick={() => void navigate({ to: '/settings' })}
          />
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label={t('sidebar.section.accounts')}>
          <Item
            icon={<span className="w-2 h-2 rounded-full bg-coral/100" />}
            label="chenge.ink"
            right={<TotalCount count={allTotal} />}
          />
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label={t('sidebar.section.tools')}>
          <Item
            icon={<Search size={15} strokeWidth={1.75} />}
            label={t('sidebar.search')}
            right={<kbd>⌘K</kbd>}
            onClick={() => navigate({ to: '/search' })}
          />
          <Item
            icon={<Languages size={15} strokeWidth={1.75} />}
            label={t('sidebar.translate')}
            right={<kbd>⌥T</kbd>}
          />
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label={t('sidebar.section.ops')}>
          <Item
            icon={<Activity size={15} strokeWidth={1.75} />}
            label={t('sidebar.llmDashboard')}
            right={
              <span className="w-1.5 h-1.5 rounded-full bg-warn" title={t('sidebar.cacheWarn')} />
            }
            onClick={() => navigate({ to: '/llm' })}
          />
          <Item
            icon={<BarChart3 size={15} strokeWidth={1.75} />}
            label={t('sidebar.admin')}
            onClick={() => navigate({ to: '/admin' })}
          />
          <Item
            icon={<CalendarDays size={15} strokeWidth={1.75} />}
            label={t('sidebar.calendar')}
            onClick={() => navigate({ to: '/calendar' })}
          />
        </Section>
      </div>

      {/* Bottom · Settings + Help (Sprint 6 / Sprint 7) */}
      <div className="border-t border-ink-border-soft p-2 space-y-px">
        <Item
          icon={<Settings size={15} strokeWidth={1.75} />}
          label={t('sidebar.settings')}
          right={<kbd>⌘,</kbd>}
          onClick={() => navigate({ to: '/settings' })}
        />
        <Item
          icon={<HelpCircle size={15} strokeWidth={1.75} />}
          label={t('sidebar.shortcuts')}
          right={<kbd>?</kbd>}
          onClick={() => {
            // Sprint 7 D2 — open the keyboard help modal via the shared
            // helper (mounted at root in `App.tsx`). The helper guards
            // SSR / pre-mount calls.
            openKeyboardHelp()
          }}
        />
      </div>
    </aside>
  )
}
