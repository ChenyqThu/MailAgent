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

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'

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

export function SkillsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: skills, isLoading } = useQuery<SkillSummary[]>({
    queryKey: qk.skills(),
    queryFn: () => api.chat.listSkills()
    // graceful: listSkills() degrades to [] when the backend is unreachable
  })

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
    return skills.map((skill) => (
      <Row
        key={skill.name}
        label={<span className={skill.available ? '' : 'opacity-60'}>{skill.title}</span>}
        helper={
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
        }
      >
        <Switch
          checked={skill.enabled}
          onCheckedChange={(next) => void handleToggle(skill, next)}
          aria-label={t('settings.skills.enabled')}
        />
      </Row>
    ))
  })()

  return (
    <Section title={t('settings.skills.title')} helper={t('settings.skills.desc')}>
      {rows}
    </Section>
  )
}
