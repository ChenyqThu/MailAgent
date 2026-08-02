import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarDays,
  ChevronDown,
  FileText,
  Globe2,
  Mail,
  Network,
  SlidersHorizontal,
  TerminalSquare
} from 'lucide-react'

import type { AgentRunToolOptions, ChatOpennessFlags } from '@shared/api/types'
import {
  CUSTOM_AGENT_CAPABILITY_TOOL_SETS,
  CUSTOM_AGENT_CAPABILITY_TIERS,
  applyCustomAgentCapabilityPatch,
  deriveCustomAgentCapabilities,
  type CustomAgentCapabilityPatch
} from '@shared/lib/customAgentCapabilities'
import { cn } from '@shared/lib/cn'
import { groupToolOptions } from '../toolGroups'
import { DangerBlock, deriveHeadlessMode, type WebGrant } from './shared'

const CALENDAR_READ_TOOL_SET = new Set<string>(CUSTOM_AGENT_CAPABILITY_TOOL_SETS.calendar.read)
const CALENDAR_WRITE_TOOLS = CUSTOM_AGENT_CAPABILITY_TOOL_SETS.calendar.write.filter(
  (tool) => !CALENDAR_READ_TOOL_SET.has(tool)
)

function TierButtons<T extends string>({
  tiers,
  value,
  disabled = false,
  groupLabel,
  label,
  onChange
}: {
  tiers: readonly T[]
  value: T
  disabled?: boolean
  groupLabel: string
  label: (tier: T) => string
  onChange: (tier: T) => void
}): React.ReactElement {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-ink-1/70 p-1">
      {tiers.map((tier) => {
        const active = tier === value
        return (
          <button
            key={tier}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            aria-label={`${groupLabel}: ${label(tier)}`}
            onClick={() => onChange(tier)}
            className={cn(
              'min-h-8 rounded-md border px-2 text-meta font-medium transition-colors duration-fast motion-reduce:transition-none',
              active
                ? 'border-coral/50 bg-coral/12 text-coral'
                : 'border-transparent text-ink-fg-2 hover:border-ink-border hover:bg-ink-3',
              disabled && 'cursor-not-allowed opacity-55'
            )}
          >
            {label(tier)}
          </button>
        )
      })}
    </div>
  )
}

function CapabilityCard({
  icon,
  title,
  description,
  customized = false,
  danger = false,
  children
}: {
  icon: React.ReactNode
  title: string
  description: string
  customized?: boolean
  danger?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section
      className={cn(
        'flex min-h-[178px] flex-col rounded-[var(--r-card)] border p-3.5',
        danger ? 'border-fail/30 bg-fail/5' : 'border-ink-border bg-ink-2/55'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-lg border',
            danger
              ? 'border-fail/25 bg-fail/10 text-fail'
              : 'border-ink-border-soft bg-ink-1/75 text-ink-fg-1'
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={cn('text-body font-semibold', danger ? 'text-fail' : 'text-ink-fg')}>
              {title}
            </h3>
            {customized && (
              <span className="rounded-md border border-warn/25 bg-warn/8 px-1.5 py-0.5 text-micro font-medium text-warn">
                ADV
              </span>
            )}
          </div>
          <p className="mt-0.5 text-meta leading-relaxed text-ink-fg-3">{description}</p>
        </div>
      </div>
      <div className="mt-auto pt-3">{children}</div>
    </section>
  )
}

function Guidance({
  children,
  danger = false
}: {
  children: React.ReactNode
  danger?: boolean
}): React.ReactElement {
  return (
    <p className={cn('mt-2 text-meta leading-relaxed', danger ? 'text-fail' : 'text-warn')}>
      {children}
    </p>
  )
}

export function CapabilityCards({
  selectedTools,
  onSelectedToolsChange,
  grantWeb,
  onGrantWebChange,
  grantExec,
  onGrantExecChange,
  agentTitle,
  triggerKind,
  flags,
  toolOptions
}: {
  selectedTools: string[]
  onSelectedToolsChange: React.Dispatch<React.SetStateAction<string[]>>
  grantWeb: WebGrant
  onGrantWebChange: (next: WebGrant) => void
  grantExec: boolean
  onGrantExecChange: (next: boolean) => void
  agentTitle: string
  triggerKind: string | null
  flags: ChatOpennessFlags
  toolOptions: AgentRunToolOptions
}): React.ReactElement {
  const { t } = useTranslation()
  const [execConfirming, setExecConfirming] = useState(false)
  const toolsDisabled = toolOptions.tools.length === 0
  const webDisabled = flags.webToolsEnabled === false
  const execDisabled = flags.execToolsEnabled === false
  const untrustedTrigger = deriveHeadlessMode(triggerKind) === 'untrusted_trigger'
  const derived = useMemo(
    () =>
      deriveCustomAgentCapabilities({
        allowedTools: selectedTools,
        grantWeb,
        grantExec
      }),
    [selectedTools, grantWeb, grantExec]
  )

  const update = (patch: CustomAgentCapabilityPatch): void => {
    if (
      patch.email !== undefined ||
      patch.calendar !== undefined ||
      patch.knowledge !== undefined ||
      patch.reports !== undefined
    ) {
      onSelectedToolsChange(
        (currentTools) =>
          applyCustomAgentCapabilityPatch(
            { allowedTools: currentTools, grantWeb, grantExec },
            patch
          ).allowedTools
      )
    }
    if (patch.web !== undefined && patch.web !== grantWeb) onGrantWebChange(patch.web)
    if (patch.files !== undefined && (patch.files === 'on') !== grantExec) {
      onGrantExecChange(patch.files === 'on')
    }
  }

  const hasEmailWrite = toolOptions.tools.some(
    (tool) =>
      tool.class === 'domain_write' &&
      tool.name.startsWith('email_') &&
      selectedTools.includes(tool.name)
  )
  const hasCalendarWrite = CALENDAR_WRITE_TOOLS.some((tool) => selectedTools.includes(tool))

  const toggleTool = (name: string): void => {
    onSelectedToolsChange((currentTools) =>
      currentTools.includes(name)
        ? currentTools.filter((tool) => tool !== name)
        : [...currentTools, name]
    )
  }

  const setGroupTools = (names: string[], on: boolean): void => {
    onSelectedToolsChange((currentTools) =>
      on
        ? [...currentTools, ...names.filter((name) => !currentTools.includes(name))]
        : currentTools.filter((name) => !names.includes(name))
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <label className="text-body font-medium text-ink-fg">
          {t('agents.custom.capabilityCards.label')}
        </label>
        <span className="text-meta text-ink-fg-3">{t('agents.custom.capabilityCards.hint')}</span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <CapabilityCard
          icon={<Mail size={16} />}
          title={t('agents.custom.capabilityCards.email.title')}
          description={t('agents.custom.capabilityCards.email.description')}
          customized={derived.customized.includes('email')}
        >
          <TierButtons
            tiers={CUSTOM_AGENT_CAPABILITY_TIERS.email}
            value={derived.profile.email}
            disabled={toolsDisabled}
            groupLabel={t('agents.custom.capabilityCards.email.title')}
            label={(tier) => t(`agents.custom.capabilityCards.email.tier.${tier}`)}
            onChange={(email) => update({ email })}
          />
          {hasEmailWrite && <Guidance>{t('agents.custom.capabilityCards.writeRuleHint')}</Guidance>}
        </CapabilityCard>

        <CapabilityCard
          icon={<CalendarDays size={16} />}
          title={t('agents.custom.capabilityCards.calendar.title')}
          description={t('agents.custom.capabilityCards.calendar.description')}
          customized={derived.customized.includes('calendar')}
        >
          <TierButtons
            tiers={CUSTOM_AGENT_CAPABILITY_TIERS.calendar}
            value={derived.profile.calendar}
            disabled={toolsDisabled}
            groupLabel={t('agents.custom.capabilityCards.calendar.title')}
            label={(tier) => t(`agents.custom.capabilityCards.calendar.tier.${tier}`)}
            onChange={(calendar) => update({ calendar })}
          />
          {hasCalendarWrite && (
            <Guidance danger>{t('agents.custom.capabilityCards.calendar.hitl')}</Guidance>
          )}
        </CapabilityCard>

        <CapabilityCard
          icon={<Network size={16} />}
          title={t('agents.custom.capabilityCards.knowledge.title')}
          description={t('agents.custom.capabilityCards.knowledge.description')}
          customized={derived.customized.includes('knowledge')}
        >
          <TierButtons
            tiers={CUSTOM_AGENT_CAPABILITY_TIERS.knowledge}
            value={derived.profile.knowledge}
            disabled={toolsDisabled}
            groupLabel={t('agents.custom.capabilityCards.knowledge.title')}
            label={(tier) => t(`agents.custom.capabilityCards.knowledge.tier.${tier}`)}
            onChange={(knowledge) => update({ knowledge })}
          />
        </CapabilityCard>

        <CapabilityCard
          icon={<FileText size={16} />}
          title={t('agents.custom.capabilityCards.reports.title')}
          description={t('agents.custom.capabilityCards.reports.description')}
          customized={derived.customized.includes('reports')}
        >
          <TierButtons
            tiers={CUSTOM_AGENT_CAPABILITY_TIERS.reports}
            value={derived.profile.reports}
            disabled={toolsDisabled}
            groupLabel={t('agents.custom.capabilityCards.reports.title')}
            label={(tier) => t(`agents.custom.capabilityCards.reports.tier.${tier}`)}
            onChange={(reports) => update({ reports })}
          />
          {derived.profile.reports === 'produce' && (
            <p className="mt-2 text-meta leading-relaxed text-ink-fg-3">
              {t('agents.custom.capabilityCards.reports.produceHint')}
            </p>
          )}
        </CapabilityCard>

        <CapabilityCard
          icon={<Globe2 size={16} />}
          title={t('agents.custom.capabilityCards.web.title')}
          description={t('agents.custom.capabilityCards.web.description')}
          danger={grantWeb === 'open'}
        >
          <TierButtons
            tiers={CUSTOM_AGENT_CAPABILITY_TIERS.web}
            value={derived.profile.web}
            disabled={webDisabled}
            groupLabel={t('agents.custom.capabilityCards.web.title')}
            label={(tier) => t(`agents.custom.capabilityCards.web.tier.${tier}`)}
            onChange={(web) => update({ web })}
          />
          {webDisabled && <Guidance>{t('agents.custom.capabilities.webDisabled')}</Guidance>}
          {grantWeb !== 'off' && (
            <Guidance danger={grantWeb === 'open'}>
              {t('agents.custom.policy.web.searchWarn')}
              {grantWeb === 'open' ? ` ${t('agents.custom.policy.web.openWarn')}` : ''}
              {grantWeb === 'open' && untrustedTrigger
                ? ` ${t('agents.custom.policy.web.untrustedOpenWarn')}`
                : ''}
            </Guidance>
          )}
        </CapabilityCard>

        <CapabilityCard
          icon={<TerminalSquare size={16} />}
          title={t('agents.custom.capabilityCards.files.title')}
          description={t('agents.custom.capabilityCards.files.description')}
          danger={grantExec}
        >
          <TierButtons
            tiers={CUSTOM_AGENT_CAPABILITY_TIERS.files}
            value={derived.profile.files}
            disabled={execDisabled}
            groupLabel={t('agents.custom.capabilityCards.files.title')}
            label={(tier) => t(`agents.custom.capabilityCards.files.tier.${tier}`)}
            onChange={(files) => {
              if (files === 'on' && !grantExec) {
                setExecConfirming(true)
                return
              }
              setExecConfirming(false)
              update({ files })
            }}
          />
          {execDisabled && <Guidance>{t('agents.custom.capabilities.execDisabled')}</Guidance>}
          {execConfirming && !grantExec && (
            <div className="mt-2 space-y-2">
              <DangerBlock>
                {t('agents.custom.policy.grant.warn', { agent: agentTitle })}
              </DangerBlock>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="h-8 rounded-md border border-ink-border px-3 text-meta text-ink-fg-2 hover:bg-ink-3"
                  onClick={() => setExecConfirming(false)}
                >
                  {t('agents.custom.policy.cancel')}
                </button>
                <button
                  type="button"
                  className="h-8 rounded-md border border-fail/40 bg-fail/10 px-3 text-meta font-medium text-fail hover:bg-fail/15"
                  onClick={() => {
                    setExecConfirming(false)
                    update({ files: 'on' })
                  }}
                >
                  {t('agents.custom.policy.grant.confirm')}
                </button>
              </div>
            </div>
          )}
          {grantExec && (
            <Guidance danger>{t('agents.custom.capabilityCards.files.ruleHint')}</Guidance>
          )}
        </CapabilityCard>
      </div>

      <details className="group mt-3 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1/45">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-body font-medium text-ink-fg-1">
          <SlidersHorizontal size={14} />
          {t('agents.custom.capabilityCards.advanced')}
          <span className="text-meta font-normal text-ink-fg-3">
            {t('agents.custom.capabilityCards.advancedHint')}
          </span>
          <ChevronDown
            className="ml-auto transition-transform duration-fast group-open:rotate-180 motion-reduce:transition-none"
            size={14}
          />
        </summary>
        <div className="border-t border-ink-border-soft px-3 py-3">
          {toolOptions.tools.length === 0 ? (
            <div>
              <p className="rounded-lg border border-ink-border-soft bg-ink-1/50 px-3 py-2.5 text-meta text-ink-fg-3">
                {t('agents.custom.tools.unavailable')}
              </p>
              {selectedTools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {selectedTools.map((name) => (
                    <span
                      key={name}
                      className="rounded-md border border-ink-border bg-ink-1/50 px-2 py-1 font-mono text-meta text-ink-fg-2"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3.5">
              {groupToolOptions(toolOptions.tools).map((group) => {
                const names = group.tools.map((tool) => tool.name)
                const selectedCount = names.filter((name) => selectedTools.includes(name)).length
                return (
                  <div key={group.id}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-meta font-medium text-ink-fg-2">
                        {t(`agents.custom.tools.group.${group.id}`)}
                      </span>
                      <span className="text-micro text-ink-fg-3">
                        {selectedCount}/{names.length}
                      </span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => setGroupTools(names, true)}
                        className="rounded-md border border-ink-border px-2 py-0.5 text-meta text-ink-fg-2 hover:bg-ink-3"
                      >
                        {t('agents.custom.tools.groupSelectAll')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setGroupTools(names, false)}
                        className="rounded-md border border-ink-border px-2 py-0.5 text-meta text-ink-fg-2 hover:bg-ink-3"
                      >
                        {t('agents.custom.tools.groupClearAll')}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {group.tools.map((tool) => {
                        const active = selectedTools.includes(tool.name)
                        const write = tool.class === 'domain_write'
                        return (
                          <button
                            key={tool.name}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleTool(tool.name)}
                            title={write ? t('agents.custom.tools.writeTag') : undefined}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-meta transition-colors duration-fast motion-reduce:transition-none',
                              active
                                ? 'border-coral/60 bg-coral/12 text-coral'
                                : 'border-ink-border bg-ink-1/50 text-ink-fg-2 hover:bg-ink-3'
                            )}
                          >
                            {tool.name}
                            {write && (
                              <span className="font-sans text-micro text-warn">
                                {t('agents.custom.tools.writeBadge')}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}
