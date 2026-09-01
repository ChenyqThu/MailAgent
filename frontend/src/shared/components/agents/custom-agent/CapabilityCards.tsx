import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarDays,
  ChevronDown,
  FileText,
  Globe2,
  Mail,
  Network,
  Plug,
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
import {
  deriveHeadlessMode,
  type ConnectorGrantMap,
  type ConnectorGrantValue,
  type WebGrant
} from './shared'
import { DangerBlock } from './DangerBlock'

const CALENDAR_READ_TOOL_SET = new Set<string>(CUSTOM_AGENT_CAPABILITY_TOOL_SETS.calendar.read)
const CALENDAR_WRITE_TOOLS = CUSTOM_AGENT_CAPABILITY_TOOL_SETS.calendar.write.filter(
  (tool) => !CALENDAR_READ_TOOL_SET.has(tool)
)

// ---------------------------------------------------------------------------
// MCP connector PR4 T3 — 第七「外部服务」卡的档位模型。
//
// UI 三档（off/read/write）是**展示折叠**，不是存储值域：服务端 grant 值域为
// read|write|update（rank read<write<update，见 tests/config/test_connector_contract_parity）。
// display 向上取整（'write' 与 'update' 都显示「可写」，未知防御值也归「可写」——绝不低报
// 权限，同 deriveToolTier 的教训）；写入 canonical（点「可写」恒写 'update' 天花板）。
// 🔴 no-op 闸在 setConnectorTier：目标档 == 当前显示档不写 state —— 否则存量 'write' 会被
// 点一下就无声升成 'update'（PR3 抓过的同类静默改写）。
// ---------------------------------------------------------------------------

type ConnectorDisplayTier = 'off' | 'read' | 'write'
const CONNECTOR_DISPLAY_TIERS: readonly ConnectorDisplayTier[] = ['off', 'read', 'write']

function displayConnectorTier(value: ConnectorGrantValue | undefined): ConnectorDisplayTier {
  if (value === undefined) return 'off'
  if (value === 'read') return 'read'
  // 'write' | 'update' |（防御）未知值 → 可写：向上取整，绝不把已授的写权限显示成更低档。
  return 'write'
}

/** 卡内行 = 已连接的 connector ∪ 已配 grant 的 connector（后者哪怕已断开/registry 已消失也
 *  必须可见可改 —— 静默丢 grant 正是本卡要防的 bug 类）。 */
export interface ConnectorCardOption {
  id: string
  label: string
  status: string
}

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
  subsetLabel,
  subsetHint,
  danger = false,
  children
}: {
  icon: React.ReactNode
  title: string
  description: string
  customized?: boolean
  /** Badge shown when the atomic selection is a strict subset of the displayed tier. The tier is
   *  rounded UP (deriveToolTier), so it states the upper bound of granted power — never less than
   *  what is actually enabled. Without this badge the card would read as "exactly this tier". */
  subsetLabel?: string
  subsetHint?: string
  danger?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section
      className={cn(
        // 能力卡如今嵌在「能碰什么」分区卡里：面色必须比分区卡低一档（ink-1 控件层），
        // 否则两层同色只剩一条描边分界，读成一团。
        'flex min-h-[178px] flex-col rounded-[var(--r-card)] border p-3.5',
        danger ? 'border-fail/30 bg-fail/5' : 'border-ink-border bg-ink-1/50'
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
              <span
                title={subsetHint}
                className="rounded-md border border-warn/25 bg-warn/8 px-1.5 py-0.5 text-micro font-medium text-warn"
              >
                {subsetLabel ?? 'ADV'}
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
  toolOptions,
  connectorOptions,
  grantConnectors,
  onGrantConnectorsChange
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
  connectorOptions: ConnectorCardOption[]
  /** 🔴 服务端原始值（含 'write'）——展示层折叠成三档，但这份 map 必须无损往返。 */
  grantConnectors: ConnectorGrantMap
  onGrantConnectorsChange: (next: ConnectorGrantMap) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [execConfirming, setExecConfirming] = useState(false)
  const toolsDisabled = toolOptions.tools.length === 0
  const webDisabled = flags.webToolsEnabled === false
  const execDisabled = flags.execToolsEnabled === false
  const connectorsDisabled = flags.connectorToolsEnabled === false
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

  // 第七卡行集合：已连接的 connector（按 options 序）∪ 已配 grant 但不在前者的 id（断开/
  // registry 已消失的行标「未连接」仍可见可改）。
  const connectorRows: Array<{ id: string; label: string; connected: boolean }> = []
  {
    const seen = new Set<string>()
    for (const opt of connectorOptions) {
      const connected = opt.status === 'connected'
      if (!connected && grantConnectors[opt.id] === undefined) continue
      seen.add(opt.id)
      connectorRows.push({ id: opt.id, label: opt.label, connected })
    }
    for (const id of Object.keys(grantConnectors)) {
      if (!seen.has(id)) connectorRows.push({ id, label: id, connected: false })
    }
  }
  // danger 判据用**展示档**（'write'/'update'/未知都算可写）——与显示口径一致，不低报。
  const connectorWriteActive = Object.values(grantConnectors).some(
    (value) => displayConnectorTier(value) === 'write'
  )

  const setConnectorTier = (id: string, tier: ConnectorDisplayTier): void => {
    // 🔴 no-op 闸：目标档 == 当前显示档不写 state。少了它，存量 'write'（显示「可写」）被
    // 再点一下「可写」就会走 canonical 写入变成 'update' —— 静默升权。
    if (tier === displayConnectorTier(grantConnectors[id])) return
    const next: ConnectorGrantMap = { ...grantConnectors }
    if (tier === 'off') delete next[id]
    else next[id] = tier === 'read' ? 'read' : 'update'
    onGrantConnectorsChange(next)
  }

  /** The displayed tier is rounded UP, so a `customized` capability means "enabled ⊊ this tier".
   *  Say that on the badge — an unlabelled "ADV" left the card reading as an exact tier match. */
  const subsetProps = (
    capability: 'email' | 'calendar' | 'knowledge' | 'reports'
  ): { customized: boolean; subsetLabel: string; subsetHint: string } => ({
    customized: derived.customized.includes(capability),
    subsetLabel: t('agents.custom.capabilityCards.subsetBadge'),
    subsetHint: t('agents.custom.capabilityCards.subsetHint', {
      tier: t(`agents.custom.capabilityCards.${capability}.tier.${derived.profile[capability]}`)
    })
  })

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
          {...subsetProps('email')}
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
          {...subsetProps('calendar')}
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
          {...subsetProps('knowledge')}
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
          {...subsetProps('reports')}
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

        {/* MCP connector PR4 T3 — 第七卡：connector 级 grant（关/只读/可写）。可写档不做 files
            式二次确认：connector 写有 per-connector 粒度 + 对话路径有审批卡反查，摩擦对齐 web
            'open' 档（danger 变体 + warn 文案）而非 exec —— 终报注明供 owner 复核。 */}
        <CapabilityCard
          icon={<Plug size={16} />}
          title={t('agents.custom.capabilityCards.connectors.title')}
          description={t('agents.custom.capabilityCards.connectors.description')}
          danger={connectorWriteActive}
        >
          {connectorRows.length === 0 ? (
            <p className="rounded-lg border border-ink-border-soft bg-ink-1/50 px-3 py-2.5 text-meta text-ink-fg-3">
              {t('agents.custom.capabilityCards.connectors.empty')}
            </p>
          ) : (
            <div className="space-y-2">
              {connectorRows.map((row) => (
                <div key={row.id} className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-meta font-medium text-ink-fg-1">{row.label}</div>
                    {!row.connected && (
                      <div className="text-micro text-warn">
                        {t('agents.custom.capabilityCards.connectors.notConnected')}
                      </div>
                    )}
                  </div>
                  <div className="w-44 shrink-0">
                    <TierButtons
                      tiers={CONNECTOR_DISPLAY_TIERS}
                      value={displayConnectorTier(grantConnectors[row.id])}
                      disabled={connectorsDisabled}
                      groupLabel={row.label}
                      label={(tier) => t(`agents.custom.capabilityCards.connectors.tier.${tier}`)}
                      onChange={(tier) => setConnectorTier(row.id, tier)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          {connectorsDisabled && (
            <Guidance>{t('agents.custom.capabilityCards.connectors.disabledHint')}</Guidance>
          )}
          {connectorWriteActive && (
            <Guidance danger>{t('agents.custom.capabilityCards.connectors.warn')}</Guidance>
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
