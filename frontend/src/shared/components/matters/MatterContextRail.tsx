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
  Shield, Sparkles, Users
} from 'lucide-react'

import type { ReportAgentConfig } from '@shared/api/types'
import type { Matter, MatterPatchInput, MatterResourceListItem, MatterRun, MatterStakeholder } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'

import { groupMatterResources, isMatterResourceAvailable } from './matterResource'

interface MatterContextRailProps {
  resources: MatterResourceListItem[]
  stakeholders: MatterStakeholder[]
  onOpenResource(item: MatterResourceListItem): void
  onTogglePin(item: MatterResourceListItem): void
  matter: Matter
  runs: MatterRun[]
  matterAgentEnabled: boolean
  onPatch(input: MatterPatchInput): void
  profiles: ReportAgentConfig[]
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
  onTogglePin,
  matter,
  runs,
  matterAgentEnabled,
  onPatch,
  profiles
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
        <MatterAgentCard matter={matter} runs={runs} enabled={matterAgentEnabled} onPatch={onPatch} profiles={profiles}/>
      </RailSection>
    </aside>
  )
}

export function MatterAgentCard({ matter, runs, enabled, onPatch, profiles }: { matter: Matter; runs: MatterRun[]; enabled: boolean; onPatch(input: MatterPatchInput): void; profiles: ReportAgentConfig[] }): React.ReactElement {
  const { t } = useTranslation(); const [editing, setEditing] = useState(false); const [profileId, setProfileId] = useState(matter.agent_profile_id ?? ''); const [instructions, setInstructions] = useState(matter.matter_instructions ?? '')
  const custom = profiles
  const profile = custom.find((item) => item.id === matter.agent_profile_id)
  const dangling = Boolean(matter.agent_profile_id) && !profile
  const latest = runs.find((run) => run.completed_at != null)
  const agentEnabled = matter.agent_enabled === true || matter.agent_enabled === 1
  if (!enabled) return <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3"><div className="mb-2 flex items-center gap-2 text-ai"><Bot size={14}/></div><p className="text-aux leading-5 text-ink-fg-2">{t('matters.context.agentGuide')}</p></div>
  if (!matter.agent_profile_id || editing) return <div className="rounded-[var(--r-card)] border border-ai/25 bg-ink-2 p-3"><div className="mb-2 flex items-center gap-2 text-ai"><Sparkles size={14}/><strong className="text-aux">{t('matters.agentBinding.title', { defaultValue: '绑定跟进 Agent' })}</strong></div>{custom.length === 0 ? <p className="text-aux text-ink-fg-2">{t('matters.agentBinding.empty', { defaultValue: '先在 Custom AI 创建一个 Agent' })}</p> : <select value={profileId} onChange={(event) => setProfileId(event.target.value)} className="w-full rounded-lg border border-ink-border bg-ink-1 px-2 py-2 text-aux"><option value="">—</option>{custom.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}<textarea maxLength={4000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={t('matters.agentBinding.instructions', { defaultValue: '事项专属指令（可选）' })} className="mt-2 w-full rounded-lg border border-ink-border bg-ink-1 p-2 text-aux"/><div className="mt-2 flex justify-end gap-2">{matter.agent_profile_id ? <button type="button" onClick={() => setEditing(false)} className="px-2 py-1 text-aux">{t('common.cancel')}</button> : null}<button type="button" disabled={!profileId} onClick={() => { onPatch({ agent_profile_id: profileId || null, agent_enabled: true, matter_instructions: instructions || null }); setEditing(false) }} className="rounded-lg bg-ai px-3 py-1.5 text-aux text-white disabled:opacity-50">{t('common.save')}</button></div></div>
  return <div className="rounded-[var(--r-card)] border border-ai/25 bg-ink-2 p-3"><div className="flex items-center gap-2"><Sparkles size={14} className="text-ai"/><strong className="min-w-0 flex-1 truncate text-aux">{profile?.title ?? matter.agent_profile_id}</strong><button type="button" role="switch" aria-checked={agentEnabled} onClick={() => onPatch({ agent_enabled: !agentEnabled })} className={`h-5 w-9 rounded-full p-0.5 ${matter.agent_enabled ? 'bg-ai' : 'bg-ink-4'}`}><span className={`block size-4 rounded-full bg-white transition-transform ${matter.agent_enabled ? 'translate-x-4' : ''}`}/></button></div>{dangling ? <p className="mt-2 rounded bg-warn/10 px-2 py-1 text-meta text-warn">{t('matters.agentBinding.dangling', { defaultValue: '绑定的 Agent 已不存在' })}</p> : null}<dl className="mt-3 space-y-2 text-aux"><div className="flex justify-between"><dt className="text-ink-fg-3">{t('matters.agentBinding.plan', { defaultValue: '计划' })}</dt><dd>{t('matters.runs.manual', { defaultValue: '手动' })}</dd></div><div className="flex justify-between"><dt className="text-ink-fg-3">{t('matters.agentBinding.next', { defaultValue: '下次' })}</dt><dd>—</dd></div><div className="flex justify-between"><dt className="text-ink-fg-3">{t('matters.agentBinding.last', { defaultValue: '上次' })}</dt><dd>{latest?.completed_at ? new Date(latest.completed_at).toLocaleString() : '—'}</dd></div></dl><p className="mt-3 flex items-start gap-2 border-t border-ink-border pt-3 text-meta leading-5 text-ink-fg-2"><Shield size={12} className="mt-0.5 shrink-0"/>{t('matters.agentBinding.capability', { defaultValue: '能力上限 观察 + 建议，不能对外发信或改写外部文档' })}</p><div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => setEditing(true)} className="text-meta text-ai">{t('common.edit', { defaultValue: '编辑' })}</button><button type="button" onClick={() => onPatch({ agent_profile_id: null, agent_enabled: false })} className="text-meta text-fail">{t('matters.agentBinding.unbind', { defaultValue: '解绑' })}</button></div></div>
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
