import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronDown, ChevronRight, Pin, RefreshCcw, Shield, Sparkles } from 'lucide-react'

import type { ReportAgentConfig } from '@shared/api/types'
import type {
  Matter,
  MatterPatchInput,
  MatterResourceListItem,
  MatterRun,
  MatterStakeholder
} from '@shared/api/types/matter'
import { ScheduleBuilder } from '@shared/components/agents/schedule/ScheduleBuilder'
import { newScheduleValue } from '@shared/components/agents/schedule/migrate'
import { preview } from '@shared/components/agents/schedule/occurrences'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { DEFAULT_RULE, isScheduleValue } from '@shared/components/agents/schedule/types'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { cn } from '@shared/lib/cn'

import {
  DOC_PROVIDER_ICONS,
  RESOURCE_KIND_ICONS,
  groupMatterResources,
  isMatterResourceAvailable
} from './matterResource'
import { MatterSuggestedResourceActions } from './MatterSuggestedResourceActions'

interface MatterContextRailProps {
  resources: MatterResourceListItem[]
  stakeholders: MatterStakeholder[]
  onOpenResource(item: MatterResourceListItem): void
  onTogglePin(item: MatterResourceListItem): void
  onChanged(): void
  matter: Matter
  runs: MatterRun[]
  matterAgentEnabled: boolean
  onPatch(input: MatterPatchInput): void
  profiles: ReportAgentConfig[]
}

const BUILTIN_PROFILE_VALUE = '__builtin__'

export function MatterContextRail({
  resources,
  stakeholders,
  onOpenResource,
  onTogglePin,
  onChanged,
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
              <div
                key={stakeholder.id}
                className="flex items-center gap-2 rounded-[var(--r-ctl)] px-2 py-2 hover:bg-ink-3"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink-4 text-meta font-semibold text-ink-fg">
                  {(stakeholder.display_name || stakeholder.email_normalized || '?')
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-aux font-medium text-ink-fg">
                    {stakeholder.display_name ||
                      stakeholder.email_normalized ||
                      t('matters.context.unnamedStakeholder')}
                  </span>
                  <span className="block truncate text-meta text-ink-fg-3">
                    {[stakeholder.role, stakeholder.organization].filter(Boolean).join(' · ') ||
                      t('matters.context.noRole')}
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
          <p className="px-2 text-meta leading-5 text-ink-fg-3">
            {t('matters.context.noStakeholders')}
          </p>
        )}
      </RailSection>

      {pinned.length > 0 ? (
        <RailSection title={t('matters.context.pinnedResources')}>
          <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-1">
            {pinned.map((item) => (
              <ResourceRailRow
                key={item.link.id}
                item={item}
                matter={matter}
                onOpen={onOpenResource}
                onTogglePin={onTogglePin}
                onChanged={onChanged}
              />
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
                  onClick={() =>
                    setExpanded((value) => ({ ...value, [group.key]: !value[group.key] }))
                  }
                  className="flex w-full items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1.5 text-meta text-ink-fg-2 hover:bg-ink-3"
                >
                  {expanded[group.key] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>{t(`matters.context.groups.${group.key}`)}</span>
                  <span className="font-mono text-ink-fg-3">{group.items.length}</span>
                </button>
                {expanded[group.key]
                  ? group.items.map((item) => (
                      <ResourceRailRow
                        key={item.link.id}
                        item={item}
                        matter={matter}
                        onOpen={onOpenResource}
                        onTogglePin={onTogglePin}
                        onChanged={onChanged}
                        compact
                      />
                    ))
                  : null}
              </div>
            ) : null
          )}
          {resources.length === 0 ? (
            <p className="px-2 text-meta leading-5 text-ink-fg-3">
              {t('matters.context.noResourcesRail')}
            </p>
          ) : null}
        </div>
      </RailSection>

      <RailSection title={t('matters.context.followupAgent')}>
        <MatterAgentCard
          matter={matter}
          runs={runs}
          enabled={matterAgentEnabled}
          onPatch={onPatch}
          profiles={profiles}
        />
      </RailSection>
    </aside>
  )
}

export function MatterAgentCard({
  matter,
  runs,
  enabled,
  onPatch,
  profiles
}: {
  matter: Matter
  runs: MatterRun[]
  enabled: boolean
  onPatch(input: MatterPatchInput): void
  profiles: ReportAgentConfig[]
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [scheduleEditing, setScheduleEditing] = useState(false)
  const [profileId, setProfileId] = useState(matter.agent_profile_id ?? BUILTIN_PROFILE_VALUE)
  const [instructions, setInstructions] = useState(matter.matter_instructions ?? '')
  const persistedSchedule = parseSchedule(matter.schedule_json)
  const [schedule, setSchedule] = useState<ScheduleValue | null>(persistedSchedule)
  // 「下次运行」的基准时刻在挂载时冻结：render 期间调 Date.now() 会被 react-hooks/purity
  // 拒绝（重渲染时结果不稳定）。MatterFocus 用的是同一个惰性初始化模式。
  const [now] = useState(() => Date.now())
  const custom = profiles
  const profile = custom.find((item) => item.id === matter.agent_profile_id)
  const dangling = Boolean(matter.agent_profile_id) && !profile
  const latest = runs.find((run) => run.completed_at != null)
  const agentEnabled = matter.agent_enabled === true || matter.agent_enabled === 1
  if (!enabled)
    return (
      <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-3">
        <div className="mb-2 flex items-center gap-2 text-ai">
          <Bot size={14} />
        </div>
        <p className="text-aux leading-5 text-ink-fg-2">{t('matters.context.agentGuide')}</p>
      </div>
    )
  if (editing)
    return (
      <div className="rounded-[var(--r-card)] border border-ai/25 bg-ink-2 p-3">
        <div className="mb-2 flex items-center gap-2 text-ai">
          <Sparkles size={14} />
          <strong className="text-aux">{t('matters.agentBinding.title')}</strong>
        </div>
        <Select value={profileId} onValueChange={setProfileId}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BUILTIN_PROFILE_VALUE}>
              {t('matters.agentBinding.builtinOption')}
            </SelectItem>
            {custom.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {custom.length === 0 ? (
          <p className="mt-2 text-meta leading-5 text-ink-fg-3">
            {t('matters.agentBinding.empty')}
          </p>
        ) : null}
        <textarea
          maxLength={4000}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t('matters.agentBinding.instructions')}
          className="mt-2 w-full rounded-lg border border-ink-border bg-ink-1 p-2 text-aux"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={() => setEditing(false)} className="px-2 py-1 text-aux">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              onPatch({
                agent_profile_id: profileId === BUILTIN_PROFILE_VALUE ? null : profileId,
                agent_enabled: true,
                matter_instructions: instructions || null
              })
              setEditing(false)
            }}
            className="rounded-lg bg-ai px-3 py-1.5 text-aux text-white"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    )
  const next = schedule
    ? preview(schedule.rule, schedule.timezone, schedule.anchor, now, 1).find(
        (entry) => entry.kind === 'run'
      )
    : null
  const label = schedule
    ? sentenceText(t, i18n.language || 'zh-CN', schedule.rule)
    : t('matters.runs.manual')
  const recommended = (): void =>
    setSchedule(
      newScheduleValue({
        ...DEFAULT_RULE,
        freq: 'weekly',
        weekdays: [1, 2, 3, 4, 5],
        hour: 9,
        minute: 0
      })
    )
  return (
    <div className="rounded-[var(--r-card)] border border-ai/25 bg-ink-2 p-3">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-ai" />
        <strong className="min-w-0 flex-1 truncate text-aux">
          {profile?.title ?? matter.agent_profile_id ?? t('matters.agentBinding.title')}
        </strong>
        {!matter.agent_profile_id ? (
          <span className="rounded-[var(--r-pill)] bg-ai/10 px-1.5 py-0.5 text-[10px] text-ai">
            {t('matters.agentBinding.builtin')}
          </span>
        ) : null}
        <button
          type="button"
          role="switch"
          aria-checked={agentEnabled}
          onClick={() => onPatch({ agent_enabled: !agentEnabled })}
          className={`h-5 w-9 rounded-full p-0.5 ${matter.agent_enabled ? 'bg-ai' : 'bg-ink-4'}`}
        >
          <span
            className={`block size-4 rounded-full bg-white transition-transform ${matter.agent_enabled ? 'translate-x-4' : ''}`}
          />
        </button>
      </div>
      {dangling ? (
        <p className="mt-2 rounded bg-warn/10 px-2 py-1 text-meta text-warn">
          {t('matters.agentBinding.dangling')}
        </p>
      ) : null}
      <dl className="mt-3 space-y-2 text-aux">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-fg-3">{t('matters.agentBinding.plan')}</dt>
          <dd className="text-right">{label}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-fg-3">{t('matters.agentBinding.next')}</dt>
          <dd>{next && next.kind === 'run' ? new Date(next.utcMs).toLocaleString() : '—'}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-fg-3">{t('matters.agentBinding.last')}</dt>
          <dd>{latest?.completed_at ? new Date(latest.completed_at).toLocaleString() : '—'}</dd>
        </div>
      </dl>
      {scheduleEditing ? (
        <div className="mt-3 border-t border-ink-border pt-3">
          <button
            type="button"
            onClick={recommended}
            className="mb-3 rounded-lg bg-ai/10 px-2 py-1.5 text-meta text-ai"
          >
            {t('matters.agentBinding.recommended')}
          </button>
          {schedule ? (
            <ScheduleBuilder value={schedule} onChange={setSchedule} occurrences={3} />
          ) : (
            <button
              type="button"
              onClick={recommended}
              className="w-full rounded-lg border border-dashed border-ai/30 p-3 text-aux text-ai"
            >
              {t('matters.agentBinding.addSchedule')}
            </button>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setSchedule(persistedSchedule)
                setScheduleEditing(false)
              }}
              className="text-meta"
            >
              {t('common.cancel')}
            </button>
            {schedule ? (
              <button
                type="button"
                onClick={() => {
                  onPatch({ schedule_json: JSON.stringify(schedule) })
                  setScheduleEditing(false)
                }}
                className="rounded-lg bg-ai px-3 py-1.5 text-meta text-white"
              >
                {t('common.save')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="mt-3 flex items-start gap-2 border-t border-ink-border pt-3 text-meta leading-5 text-ink-fg-2">
        <Shield size={12} className="mt-0.5 shrink-0" />
        {t('matters.agentBinding.capability')}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setScheduleEditing((value) => !value)}
          className="text-meta text-ai"
        >
          {t('matters.agentBinding.scheduleEdit')}
        </button>
        <button
          type="button"
          onClick={() => {
            setProfileId(matter.agent_profile_id ?? BUILTIN_PROFILE_VALUE)
            setInstructions(matter.matter_instructions ?? '')
            setEditing(true)
          }}
          className="text-meta text-ai"
        >
          {matter.agent_profile_id ? t('common.edit') : t('matters.agentBinding.useCustomAgent')}
        </button>
        {matter.agent_profile_id ? (
          <button
            type="button"
            onClick={() => onPatch({ agent_profile_id: null, agent_enabled: false })}
            className="text-meta text-fail"
          >
            {t('matters.agentBinding.unbind')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function parseSchedule(raw: string | null | undefined): ScheduleValue | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isScheduleValue(value) ? value : null
  } catch {
    return null
  }
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
        {title}
        {count === undefined ? null : <span className="font-mono">· {count}</span>}
      </h2>
      {children}
    </section>
  )
}

function ResourceRailRow({
  item,
  matter,
  onOpen,
  onTogglePin,
  onChanged,
  compact = false
}: {
  item: MatterResourceListItem
  matter: Matter
  onOpen(item: MatterResourceListItem): void
  onTogglePin(item: MatterResourceListItem): void
  onChanged(): void
  compact?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon =
    (item.resource.kind === 'doc' && DOC_PROVIDER_ICONS[item.resource.provider.toLowerCase()]) ||
    RESOURCE_KIND_ICONS[item.resource.kind]
  const available = isMatterResourceAvailable(item)
  const suggested = item.link.confirmed_at === null
  return (
    <div className={cn('group rounded-[var(--r-ctl)] px-2 py-2 hover:bg-ink-3', suggested && 'border border-ai/20 bg-ai/[0.06]')}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-ink-4 text-ink-fg-2', suggested && 'bg-ai/15 text-ai')}>
            <Icon size={11} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                {item.resource.title || item.resource.external_key}
              </span>
              {suggested ? <Sparkles size={10} className="shrink-0 text-ai" aria-label={t('matters.resource.suggested')} /> : null}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-fg-3">
              <span className="truncate">{t(`matters.context.kind.${item.resource.kind}`)}</span>
              {item.link.sub_state !== 'none' ? (
                <RefreshCcw
                  size={10}
                  className={item.link.sub_state === 'paused' ? 'text-warn' : 'text-ok'}
                />
              ) : null}
              {!available ? (
                <span className="rounded-[var(--r-pill)] bg-fail/10 px-1 text-[10px] text-fail">
                  {t('matters.context.unavailable')}
                </span>
              ) : null}
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
      <MatterSuggestedResourceActions matter={matter} item={item} onChanged={onChanged} compact />
    </div>
  )
}
