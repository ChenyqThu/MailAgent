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
 *  config header so the two render identically. */
function SkillMeta({ skill }: { skill: SkillSummary }): React.ReactElement {
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
          <span className="flex items-center gap-2 mt-0.5">
            <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
              {t('settings.skills.toolCount', { n: skill.toolCount })}
            </span>
            {skill.scopes.length > 0 ? (
              <span className="text-micro text-ink-fg-3">
                {t('settings.skills.scopes')}: {skill.scopes.join(', ')}
              </span>
            ) : null}
          </span>
        </span>
      </div>
    </>
  )
}

export function SkillsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

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
      if (!ConfigPanel) {
        // Plain toggle row (unchanged) — no config panel for this skill.
        return (
          <Row key={skill.name} label={<SkillMeta skill={skill} />}>
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
                <SkillMeta skill={skill} />
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
            <ConfigPanel />
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
