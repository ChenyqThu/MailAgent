// DESIGN.md §3.3 + §5 — 240px sidebar. Five fixed sections with English
// UPPERCASE mono headers. Sprint 2 wires only MAILBOXES to live data
// (email:listMailboxes IPC); ACCOUNTS / AI AGENTS / TOOLS / OPS surface
// placeholder rows that visually match the mockup so the rail isn't bare.
//
// Selected mailbox: bg-ink-4 + 3px coral edge via .row-selected (CSS) for
// the mockup-faithful left-edge accent. Unread count: coral pill when > 0,
// dim mono otherwise.

import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
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
  const mailApi = useMailApi()
  const active = useMailbox((s) => s.active)
  const setActive = useMailbox((s) => s.setActive)

  const { data } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false
  })
  const mailboxes = data ?? []

  // Compose visible nav. Always show "已标旗" + "所有邮件" virtual entries
  // matching the mockup; both Sprint 3+ wire-up.
  const allTotal = mailboxes.reduce((sum, mb) => sum + mb.total, 0)

  return (
    <aside
      aria-label="primary"
      className={cn('w-60 shrink-0 bg-ink-1 border-r border-ink-border flex flex-col')}
    >
      <div className="flex-1 overflow-y-auto scrollbar-thin py-2.5">
        <Section label="Mailboxes">
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
              label="已标旗"
              right={<TotalCount count={0} />}
            />
          )}
          {mailboxes.length > 0 && (
            <Item
              icon={<Mail size={15} strokeWidth={1.75} />}
              label="所有邮件"
              right={<TotalCount count={allTotal} />}
            />
          )}
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label="AI Agents">
          <Item
            icon={<Sparkles size={15} strokeWidth={1.75} />}
            label="Notion Agent"
            right={<span className="w-1.5 h-1.5 rounded-full bg-ok" title="online" />}
          />
          <Item
            icon={<Lock size={15} strokeWidth={1.75} />}
            label="Custom API"
            right={<TotalCount count={3} />}
          />
          <Item
            icon={<History size={15} strokeWidth={1.75} />}
            label="AI 会话历史"
            right={<TotalCount count={0} />}
          />
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label="Accounts">
          <Item
            icon={<span className="w-2 h-2 rounded-full bg-coral/100" />}
            label="chenge.ink"
            right={<TotalCount count={allTotal} />}
          />
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label="Tools">
          <Item
            icon={<Search size={15} strokeWidth={1.75} />}
            label="全文搜索"
            right={<kbd>⌘K</kbd>}
          />
          <Item
            icon={<Languages size={15} strokeWidth={1.75} />}
            label="一键翻译"
            right={<kbd>⌥T</kbd>}
          />
        </Section>

        <div className="my-3 mx-4 border-t border-ink-border-soft" />

        <Section label="Ops">
          <Item
            icon={<Activity size={15} strokeWidth={1.75} />}
            label="LLM Dashboard"
            right={<span className="w-1.5 h-1.5 rounded-full bg-warn" title="cache hit 偏低" />}
          />
          <Item icon={<BarChart3 size={15} strokeWidth={1.75} />} label="看板 Admin" />
        </Section>
      </div>

      {/* Bottom · Settings + Help (Sprint 6 / Sprint 7) */}
      <div className="border-t border-ink-border-soft p-2 space-y-px">
        <Item icon={<Settings size={15} strokeWidth={1.75} />} label="设置" right={<kbd>⌘,</kbd>} />
        <Item
          icon={<HelpCircle size={15} strokeWidth={1.75} />}
          label="快捷键"
          right={<kbd>?</kbd>}
        />
      </div>
    </aside>
  )
}
