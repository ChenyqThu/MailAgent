// Skills toggle list — react-query fetches the RESOLVED SkillSummary[] from the
// backend (GET /api/agent/skills: manifest ⋈ agent_config.db enable overrides).
// Toggling calls api.chat.setSkillEnabled (POST /api/agent/skills/{name}/enabled);
// the gateway re-reads /chat/config on a 15s TTL so the next chat turn sees the
// updated tool catalog. A one-time mount effect migrates any leftover localStorage overrides
// to the backend (PR5 — enablement SSoT moved off per-surface localStorage).

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { readSkillOverrides, writeSkillOverrides } from '@shared/lib/skill_overrides'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'
import type { MailApi, SkillSummary } from '@shared/api/types'
import { Switch } from '@shared/components/ui/switch'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { NotionAgentSkillConfig } from './NotionAgentSkillConfig'
import { fetchSkillCreatorEnabled, useEnvFlagIntent } from './shared'

// task 07-21 — skills that carry an inline per-skill config panel in their row's expand area. Today
// only notion_agent (bind agent / default model / doctor, moved out of 设置-AI). A row NOT listed
// here renders as a plain toggle Row (unchanged).
const CONFIG_PANELS: Record<string, () => React.ReactElement> = {
  notion_agent: NotionAgentSkillConfig
}

// PR5 — one-time migration of leftover localStorage skill overrides to the backend
// agent_config.db. The runtime now reads backend overrides (localStorage is only a
// transitional fallback in buildEngine); push each leftover toggle to the backend, then
// clear localStorage so it stops shadowing. Best-effort per skill (an unknown/renamed
// skill is skipped); cleared unconditionally afterward to avoid a re-push loop.
async function migrateLocalSkillOverrides(
  api: MailApi,
  invalidateSkills: () => Promise<unknown>
): Promise<void> {
  const local = readSkillOverrides()
  const names = Object.keys(local)
  if (names.length === 0) return
  for (const name of names) {
    try {
      await api.chat.setSkillEnabled(name, local[name])
    } catch {
      /* unknown skill / transient — skip; the clear below prevents a re-push loop */
    }
  }
  writeSkillOverrides({})
  await invalidateSkills()
}

/** The label + helper cell content of a skill row — shared by the plain Row and the expandable
 *  config header so the two render identically. `extraNote` (task 07-22) carries a per-skill
 *  clarification line (calendar chat-tools scope / notion_agent master-flag off). */
function SkillMeta({
  skill,
  extraNote
}: {
  skill: SkillSummary
  extraNote?: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <>
      <div className="text-aux font-medium text-ink-fg">
        <span className={skill.available ? '' : 'opacity-60'}>{skill.title}</span>
      </div>
      <div className="text-meta text-ink-fg-2 mt-0.5">
        <span className="flex flex-col gap-0.5">
          <span>{skill.description}</span>
          {!skill.available && skill.unavailableReason ? (
            <span className="text-meta text-ink-fg-3 italic">
              {t('settings.skills.unavailable', { reason: skill.unavailableReason })}
            </span>
          ) : null}
          {extraNote ? <span className="text-meta text-ink-fg-3 italic">{extraNote}</span> : null}
          <span className="flex items-center gap-2 mt-0.5">
            <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
              {t('settings.skills.toolCount', { n: skill.toolCount })}
            </span>
            {skill.scopes.length > 0 ? (
              <span className="text-micro text-ink-fg-3">
                {t('settings.skills.scopes')}: {skill.scopes.join(', ')}
              </span>
            ) : null}
            <span className="rounded-full border border-ink-border px-1.5 py-0.5 text-micro">
              {skill.sourceType === 'builtin' ? t('settings.skills.sourceBuiltin') : skill.sourceType === 'user_created' ? t('settings.skills.sourceUserCreated') : t('settings.skills.sourceThirdParty')}
            </span>
            {skill.sourceType !== 'builtin' ? <span className="text-micro">{skill.trustState ?? 'none'}</span> : null}
          </span>
          {skill.lastError ? <span className="text-meta text-fail">{skill.lastError}</span> : null}
        </span>
      </div>
    </>
  )
}

function SkillTrustPanel({ skill }: { skill: SkillSummary }): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const { data: enabled } = useQuery({ queryKey: ['chat-config', 'skillCreatorEnabled'], queryFn: fetchSkillCreatorEnabled })
  const { data: entrypoints = [] } = useQuery({ queryKey: ['skill-entrypoints'], queryFn: () => api.chat.listSkillEntrypoints(), enabled: enabled === true })
  const { data: trust } = useQuery({
    queryKey: ['skill-trust', skill.name],
    queryFn: () => api.chat.listSkillTrust(skill.name),
    enabled: enabled === true && skill.sourceType !== 'builtin'
  })
  const candidates = entrypoints.find((item) => item.name === skill.name)
  const [selected, setSelected] = React.useState('')
  const [argvPattern, setArgvPattern] = React.useState('')
  const [cwdScope, setCwdScope] = React.useState('')
  const [readScopes, setReadScopes] = React.useState('')
  const [writeScopes, setWriteScopes] = React.useState('')
  const [networkMode, setNetworkMode] = React.useState<'off' | 'gated'>('off')
  const [secretNames, setSecretNames] = React.useState('')
  if (enabled !== true || skill.sourceType === 'builtin') return null
  const entrypoint = selected || (candidates?.files[0] ? `${candidates.dir}/${candidates.files[0]}` : '')
  const parseList = (value: string): string[] => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
  async function grant(): Promise<void> {
    if (!entrypoint) return
    await api.chat.grantSkillTrust(skill.name, entrypoint, {
      argvPattern: parseList(argvPattern),
      cwdScope: parseList(cwdScope || candidates?.dir || ''),
      readScopes: parseList(readScopes),
      writeScopes: parseList(writeScopes),
      networkMode,
      secretNames: parseList(secretNames)
    })
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['skill-trust', skill.name] }),
      qc.invalidateQueries({ queryKey: qk.skills() })
    ])
  }
  async function revoke(trustId: string): Promise<void> {
    await api.chat.revokeSkillTrust(skill.name, trustId)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['skill-trust', skill.name] }),
      qc.invalidateQueries({ queryKey: qk.skills() })
    ])
  }
  return <div className="space-y-2 border-t border-ink-border-soft px-4 py-3 text-meta">
    <div>{t('settings.skills.currentHash')}: <code>{trust?.currentPackageHash?.slice(0, 12) ?? '—'}</code></div>
    <select value={entrypoint} onChange={(event) => setSelected(event.target.value)} className="w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1">
      {(candidates?.files ?? []).map((file) => {
        const value = `${candidates?.dir}/${file}`
        return <option key={value} value={value}>{file}</option>
      })}
    </select>
    <div className="grid gap-2 sm:grid-cols-2">
      <label>{t('settings.skills.argvPattern')}<textarea value={argvPattern} onChange={(event) => setArgvPattern(event.target.value)} className="mt-1 w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1" /></label>
      <label>{t('settings.skills.cwdScope')}<input value={cwdScope || candidates?.dir || ''} onChange={(event) => setCwdScope(event.target.value)} className="mt-1 w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1" /></label>
      <label>{t('settings.skills.readScopes')}<input value={readScopes} onChange={(event) => setReadScopes(event.target.value)} className="mt-1 w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1" /></label>
      <label>{t('settings.skills.writeScopes')}<input value={writeScopes} onChange={(event) => setWriteScopes(event.target.value)} className="mt-1 w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1" /></label>
      <label>{t('settings.skills.networkMode')}<select value={networkMode} onChange={(event) => setNetworkMode(event.target.value as 'off' | 'gated')} className="mt-1 w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1"><option value="off">off</option><option value="gated">gated</option></select></label>
      <label>{t('settings.skills.secretNames')}<input value={secretNames} onChange={(event) => setSecretNames(event.target.value)} className="mt-1 w-full rounded-md border border-ink-border bg-ink-1 px-2 py-1" /></label>
    </div>
    <button type="button" disabled={!entrypoint} onClick={() => void grant()} className="rounded-md border border-ink-border px-3 py-1 disabled:opacity-50">{t('settings.skills.trustVersion')}</button>
    {(trust?.trusts ?? []).map((item) => <div key={item.id} className="flex items-center justify-between gap-2 rounded-md bg-ink-2 p-2">
      <span>{item.state} · {item.packageHash.slice(0, 12)} · {item.entrypoint}</span>
      {item.revokedAt == null ? <button type="button" onClick={() => void revoke(item.id)}>{t('settings.skills.revokeTrust')}</button> : null}
    </div>)}
  </div>
}

/** task 07-22 — per-skill clarification note (null for skills without one):
 *  · calendar: the toggle governs the outward Skill Delivery API + advertisedSkills only; the 5
 *    chat calendar tools are controlled by the calendar env flag (系统能力 区), NOT this toggle.
 *  · notion_agent: when the master flag MAILAGENT_NOTION_AGENT_TOOL is off, the gateway won't
 *    register notion_agent_chat even if the skill toggle is on (灭活标注). */
function useSkillExtraNote(): (skill: SkillSummary) => React.ReactNode {
  const { t } = useTranslation()
  const notionMasterEnabled = useEnvFlagIntent('MAILAGENT_NOTION_AGENT_TOOL', true)
  return (skill: SkillSummary): React.ReactNode => {
    if (skill.name === 'calendar') return t('settings.skills.calendarChatNote')
    if (skill.name === 'notion_agent' && !notionMasterEnabled)
      return t('settings.skills.notionAgentMasterOff')
    return null
  }
}

export function SkillsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const extraNoteFor = useSkillExtraNote()

  const { data: skills, isLoading } = useQuery<SkillSummary[]>({
    queryKey: qk.skills(),
    queryFn: () => api.chat.listSkills()
    // graceful: listSkills() degrades to [] when the backend is unreachable
  })

  // task 07-21 — which config-panel rows are expanded (only rows in CONFIG_PANELS get a chevron).
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())

  // Run the one-time localStorage→backend override migration once on mount.
  React.useEffect(() => {
    void migrateLocalSkillOverrides(api, () => qc.invalidateQueries({ queryKey: qk.skills() }))
  }, [api, qc])

  async function handleToggle(skill: SkillSummary, next: boolean): Promise<void> {
    try {
      await api.chat.setSkillEnabled(skill.name, next)
      // S3 — the gateway re-reads /chat/config on a 15s TTL, so the toggle reaches the
      // tool catalog without any client-side engine invalidation; just refetch the list.
      await qc.invalidateQueries({ queryKey: qk.skills() })
    } catch (err) {
      toastError(t('settings.skills.title'), errorMessage(err))
    }
  }

  function toggleExpanded(name: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const rows: React.ReactNode = (() => {
    if (isLoading) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          {t('settings.skills.loading')}
        </div>
      )
    }
    if (!skills || skills.length === 0) {
      return <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.skills.empty')}</div>
    }
    return skills.map((skill) => {
      const ConfigPanel = CONFIG_PANELS[skill.name]
      const extraNote = extraNoteFor(skill)
      const hasDetails = Boolean(ConfigPanel) || skill.sourceType !== 'builtin' || Boolean(skill.lastError)
      if (!hasDetails) {
        // Plain toggle row (unchanged) — no config panel for this skill.
        return (
          <Row key={skill.name} label={<SkillMeta skill={skill} extraNote={extraNote} />}>
            <Switch
              checked={skill.enabled}
              onCheckedChange={(next) => void handleToggle(skill, next)}
              aria-label={t('settings.skills.enabled')}
            />
          </Row>
        )
      }
      // Expandable row: a chevron-toggle header (label/helper) + the Switch, with the per-skill
      // config panel in the collapsible body. The header's label area is the toggle button; the
      // Switch stays a sibling (never nested inside the button).
      const isOpen = expanded.has(skill.name)
      const bodyId = `skill-config-${skill.name}`
      return (
        <div key={skill.name}>
          <div className="flex items-center gap-3 px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
            <button
              type="button"
              onClick={() => toggleExpanded(skill.name)}
              aria-expanded={isOpen}
              aria-controls={bodyId}
              className="flex flex-1 min-w-0 items-start gap-2 text-left -my-1 py-1 rounded transition-colors duration-fast hover:bg-ink-fg/[0.025]"
            >
              <CollapseChevron expanded={isOpen} size={16} className="mt-0.5 text-ink-fg-2" />
              <span className="flex-1 min-w-0">
                <SkillMeta skill={skill} extraNote={extraNote} />
              </span>
            </button>
            <div className="shrink-0">
              <Switch
                checked={skill.enabled}
                onCheckedChange={(next) => void handleToggle(skill, next)}
                aria-label={t('settings.skills.enabled')}
              />
            </div>
          </div>
          <CollapsibleRegion expanded={isOpen} id={bodyId}>
            {ConfigPanel ? <ConfigPanel /> : null}
            <SkillTrustPanel skill={skill} />
          </CollapsibleRegion>
        </div>
      )
    })
  })()

  return (
    <Section title={t('settings.skills.title')} helper={t('settings.skills.desc')}>
      {rows}
    </Section>
  )
}
