import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Link2,
  Mail,
  Pin,
  RefreshCcw,
  Users
} from 'lucide-react'

import type { MatterResourceListItem, MatterStakeholder } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'

import { groupMatterResources, isMatterResourceAvailable } from './matterResource'

interface MatterContextRailProps {
  resources: MatterResourceListItem[]
  stakeholders: MatterStakeholder[]
  onOpenResource(item: MatterResourceListItem): void
  onTogglePin(item: MatterResourceListItem): void
}

const RESOURCE_ICONS = {
  email: Mail,
  thread: Mail,
  event: Users,
  doc: FileText,
  file: File,
  url: Link2
} as const

export function MatterContextRail({
  resources,
  stakeholders,
  onOpenResource,
  onTogglePin
}: MatterContextRailProps): React.ReactElement {
  const { t } = useTranslation()
  const groups = useMemo(() => groupMatterResources(resources), [resources])
  const pinned = resources.filter((item) => item.link.pinned)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    mail: true,
    meetings: true,
    documents: true,
    attachments: true
  })

  return (
    <aside className="h-full w-72 shrink-0 overflow-y-auto border-l border-ink-border bg-ink-1/45 px-3 py-4 scrollbar-thin">
      <RailSection title={t('matters.context.stakeholders')} count={stakeholders.length}>
        {stakeholders.length > 0 ? (
          <div className="space-y-1">
            {stakeholders.slice(0, 6).map((stakeholder) => (
              <div key={stakeholder.id} className="flex items-center gap-2 rounded-[var(--r-ctl)] px-2 py-2 hover:bg-ink-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink-4 text-meta font-semibold text-ink-fg">
                  {(stakeholder.display_name || stakeholder.email_normalized || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-aux font-medium text-ink-fg">
                    {stakeholder.display_name || stakeholder.email_normalized || t('matters.context.unnamedStakeholder')}
                  </span>
                  <span className="block truncate text-meta text-ink-fg-3">
                    {[stakeholder.role, stakeholder.organization].filter(Boolean).join(' · ') || t('matters.context.noRole')}
                  </span>
                </span>
                {stakeholder.is_waiting_on ? (
                  <span className="rounded-[var(--r-pill)] bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">
                    {t('matters.context.waiting')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-2 text-meta leading-5 text-ink-fg-3">{t('matters.context.noStakeholders')}</p>
        )}
      </RailSection>

      {pinned.length > 0 ? (
        <RailSection title={t('matters.context.pinnedResources')}>
          <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-1">
            {pinned.map((item) => (
              <ResourceRailRow key={item.link.id} item={item} onOpen={onOpenResource} onTogglePin={onTogglePin} />
            ))}
          </div>
        </RailSection>
      ) : null}

      <RailSection title={t('matters.context.linkedResources')} count={resources.length}>
        <div className="space-y-1">
          {groups.map((group) =>
            group.items.length > 0 ? (
              <div key={group.key}>
                <button
                  type="button"
                  onClick={() => setExpanded((value) => ({ ...value, [group.key]: !value[group.key] }))}
                  className="flex w-full items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1.5 text-meta text-ink-fg-2 hover:bg-ink-3"
                >
                  {expanded[group.key] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{t(`matters.context.groups.${group.key}`)}</span>
                  <span className="font-mono text-ink-fg-3">{group.items.length}</span>
                </button>
                {expanded[group.key]
                  ? group.items.map((item) => (
                      <ResourceRailRow key={item.link.id} item={item} onOpen={onOpenResource} onTogglePin={onTogglePin} compact />
                    ))
                  : null}
              </div>
            ) : null
          )}
          {resources.length === 0 ? (
            <p className="px-2 text-meta leading-5 text-ink-fg-3">{t('matters.context.noResourcesRail')}</p>
          ) : null}
        </div>
      </RailSection>

      <RailSection title={t('matters.context.followupAgent')}>
        <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3">
          <div className="mb-2 flex items-center gap-2 text-ai"><Bot size={14} /></div>
          <p className="text-aux leading-5 text-ink-fg-2">{t('matters.context.agentGuide')}</p>
        </div>
      </RailSection>
    </aside>
  )
}

function RailSection({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-1 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-fg-3">
        {title}{count === undefined ? null : <span className="font-mono">· {count}</span>}
      </h2>
      {children}
    </section>
  )
}

function ResourceRailRow({
  item,
  onOpen,
  onTogglePin,
  compact = false
}: {
  item: MatterResourceListItem
  onOpen(item: MatterResourceListItem): void
  onTogglePin(item: MatterResourceListItem): void
  compact?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon = RESOURCE_ICONS[item.resource.kind]
  const available = isMatterResourceAvailable(item)
  return (
    <div className="group flex items-start gap-2 rounded-[var(--r-ctl)] px-2 py-2 hover:bg-ink-3">
      <button type="button" onClick={() => onOpen(item)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-ink-4 text-ink-fg-2"><Icon size={11} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-aux text-ink-fg">{item.resource.title || item.resource.external_key}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-fg-3">
            <span className="truncate">{t(`matters.context.kind.${item.resource.kind}`)}</span>
            {item.link.sub_state !== 'none' ? <RefreshCcw size={10} className={item.link.sub_state === 'paused' ? 'text-warn' : 'text-ok'} /> : null}
            {!available ? <span className="rounded-[var(--r-pill)] bg-fail/10 px-1 text-[10px] text-fail">{t('matters.context.unavailable')}</span> : null}
          </span>
        </span>
      </button>
      <button
        type="button"
        title={t(item.link.pinned ? 'matters.context.unpin' : 'matters.context.pin')}
        onClick={() => onTogglePin(item)}
        className={cn(
          'mt-0.5 rounded p-1 text-ink-fg-3 opacity-0 hover:bg-ink-4 hover:text-ink-fg group-hover:opacity-100',
          item.link.pinned && 'text-coral opacity-100',
          compact && 'mt-0'
        )}
      >
        <Pin size={12} />
      </button>
    </div>
  )
}
