import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useMailApi } from '@shared/hooks/useMailApi'
import type { SkillDraftSummary } from '@shared/api/types'
import { toastError } from '@shared/state/toast'
import { Section } from '../parts/Section'
import { fetchSkillCreatorEnabled } from './shared'

export function SkillDraftsSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const [open, setOpen] = React.useState<string | null>(null)
  const [docs, setDocs] = React.useState<Record<string, string>>({})
  const [details, setDetails] = React.useState<Record<string, SkillDraftSummary>>({})
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>({})
  const { data: flag } = useQuery({ queryKey: ['chat-config', 'skillCreatorEnabled'], queryFn: fetchSkillCreatorEnabled })
  const { data: drafts = [] } = useQuery<SkillDraftSummary[]>({
    queryKey: ['skill-drafts'],
    queryFn: () => api.chat.listSkillDrafts(),
    enabled: flag === true
  })
  if (flag !== true) return null

  async function expand(draft: SkillDraftSummary): Promise<void> {
    if (open === draft.id) {
      setOpen(null)
      return
    }
    setOpen(draft.id)
    try {
      const detail = await api.chat.getSkillDraft(draft.id)
      setDetails((current) => ({ ...current, [draft.id]: detail }))
    } catch {
      // the row remains usable for discard even when detail refresh fails
    }
    if (!docs[draft.id] && draft.status !== 'discarded') {
      try {
        const content = await api.chat.readSkillDraftFile(draft.id, 'SKILL.md')
        setDocs((current) => ({ ...current, [draft.id]: content }))
      } catch {
        setDocs((current) => ({ ...current, [draft.id]: '' }))
      }
    }
  }

  async function publish(draft: SkillDraftSummary): Promise<void> {
    const isEnabled = enabled[draft.id] !== false
    if (!window.confirm(t('settings.skillDrafts.publishConfirm', { name: draft.name, enabled: isEnabled ? 'yes' : 'no' }))) return
    try {
      await api.chat.publishSkillDraft(draft.id, isEnabled)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['skill-drafts'] }),
        qc.invalidateQueries({ queryKey: ['skills'] })
      ])
    } catch (error) {
      toastError(t('settings.skillDrafts.title'), String(error))
    }
  }

  async function discard(draft: SkillDraftSummary): Promise<void> {
    if (!window.confirm(t('settings.skillDrafts.discardConfirm', { name: draft.name }))) return
    try {
      await api.chat.discardSkillDraft(draft.id)
      await qc.invalidateQueries({ queryKey: ['skill-drafts'] })
    } catch (error) {
      toastError(t('settings.skillDrafts.title'), String(error))
    }
  }

  return (
    <Section title={t('settings.skillDrafts.title')} helper={t('settings.skillDrafts.desc')}>
      {drafts.length === 0 ? <div className="px-4 py-3 text-aux text-ink-fg-3">{t('settings.skillDrafts.empty')}</div> : drafts.map((draft) => {
        const detail = details[draft.id] ?? draft
        return <div key={draft.id} className="border-b border-ink-border-soft px-4 py-3 last:border-b-0">
          <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => void expand(draft)}>
            {open === draft.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="font-medium">{draft.name}</span>
            <span className="rounded-full bg-ink-3 px-2 py-0.5 text-micro">{draft.status}</span>
          </button>
          {open === draft.id ? <div className="mt-3 space-y-2 text-meta text-ink-fg-2">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-ink-2 p-2">{docs[draft.id] || t('settings.skillDrafts.noSkillMd')}</pre>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-ink-2 p-2">{JSON.stringify(detail.validation, null, 2)}</pre>
            <div>{detail.files?.map((file) => file.path).join(' · ')}</div>
            {draft.status === 'valid' ? <label className="flex items-center gap-2">
              <input type="checkbox" checked={enabled[draft.id] !== false} onChange={(event) => setEnabled((current) => ({ ...current, [draft.id]: event.target.checked }))} />
              {t('settings.skillDrafts.enableAfterPublish')}
            </label> : null}
            <div className="flex gap-2">
              {draft.status === 'valid' ? <button type="button" onClick={() => void publish(draft)} className="rounded-md bg-coral px-3 py-1 text-white">{t('settings.skillDrafts.publish')}</button> : null}
              {!['published', 'discarded'].includes(draft.status) ? <button type="button" onClick={() => void discard(draft)} className="rounded-md border border-ink-border px-3 py-1">{t('settings.skillDrafts.discard')}</button> : null}
            </div>
          </div> : null}
        </div>
      })}
    </Section>
  )
}
