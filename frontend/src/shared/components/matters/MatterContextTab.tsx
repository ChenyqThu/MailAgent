import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Edit3,
  Link2,
  Plus,
  RefreshCcw,
  Shield,
  Trash2,
  Users,
  X
} from 'lucide-react'

import type {
  Matter,
  MatterItem,
  MatterResourceListItem,
  MatterStakeholder,
  MatterStakeholderCreateInput
} from '@shared/api/types/matter'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

import { groupMatterResources, isMatterResourceAvailable } from './matterResource'
import { useMattersApi } from './hooks'
import { MatterSuggestedResourceActions } from './MatterSuggestedResourceActions'

interface MatterContextTabProps {
  matter: Matter
  items: MatterItem[]
  resources: MatterResourceListItem[]
  stakeholders: MatterStakeholder[]
  onOpenResource(item: MatterResourceListItem): void
  onChanged(): void
}

export function MatterContextTab({
  matter,
  items,
  resources,
  stakeholders,
  onOpenResource,
  onChanged
}: MatterContextTabProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const groups = useMemo(() => groupMatterResources(resources), [resources])
  const [editor, setEditor] = useState<MatterStakeholder | 'new' | null>(null)

  const remove = useMutation({
    mutationFn: (stakeholderId: number) => api.deleteStakeholder(matter.public_id, stakeholderId, {
      expectedVersion: matter.version,
      reason: 'user_removed_stakeholder'
    }),
    onSuccess: onChanged,
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const openItems = items.filter((item) => item.deleted_at === null && item.status !== 'done' && item.status !== 'canceled').length
  const pinnedResources = resources.filter((item) => item.link.pinned).length
  const suggestedResources = resources.filter((item) => item.link.confirmed_at === null).length

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader title={t('matters.context.stakeholders')} count={stakeholders.length}>
          <button type="button" onClick={() => setEditor('new')} className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3">
            <Plus size={13} />{t('matters.context.addStakeholder')}
          </button>
        </SectionHeader>
        {stakeholders.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {stakeholders.map((stakeholder) => (
              <article key={stakeholder.id} className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-4 text-body font-semibold text-ink-fg">
                    {(stakeholder.display_name || stakeholder.email_normalized || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-body font-semibold text-ink-fg">{stakeholder.display_name || stakeholder.email_normalized || t('matters.context.unnamedStakeholder')}</h3>
                      {stakeholder.is_waiting_on ? <Pip tone="warn">{t('matters.context.waiting')}</Pip> : null}
                      {stakeholder.role ? <Pip>{stakeholder.role}</Pip> : null}
                    </div>
                    <p className="mt-1 truncate text-meta text-ink-fg-3">{[stakeholder.role, stakeholder.organization].filter(Boolean).join(' · ') || t('matters.context.noRole')}</p>
                  </div>
                </div>
                <div className="mt-3 text-meta text-ink-fg-3">
                  {t('matters.context.lastContact')} {stakeholder.last_contact_at ? new Date(stakeholder.last_contact_at).toLocaleDateString() : '—'}
                </div>
                <div className="mt-3 flex justify-end gap-1 border-t border-ink-border pt-2">
                  <button type="button" onClick={() => setEditor(stakeholder)} className="rounded-[var(--r-ctl)] p-1.5 text-ink-fg-2 hover:bg-ink-3"><Edit3 size={13} /></button>
                  <button type="button" onClick={() => remove.mutate(stakeholder.id)} className="rounded-[var(--r-ctl)] p-1.5 text-fail hover:bg-fail/10"><Trash2 size={13} /></button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Users size={22} />} title={t('matters.context.noStakeholdersTitle')} hint={t('matters.context.noStakeholdersHint')} />
        )}
      </section>

      <section>
        <SectionHeader title={t('matters.context.linkedResources')} count={resources.length}>
          {suggestedResources > 0 ? <Pip tone="ai">{t('matters.resource.suggestedCount', { count: suggestedResources })}</Pip> : null}
        </SectionHeader>
        {resources.length > 0 ? (
          <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-2">
            {groups.map((group) => group.items.length > 0 ? (
              <div key={group.key} className="border-b border-ink-border last:border-b-0">
                <div className="flex items-center gap-2 bg-ink-3/70 px-4 py-2 text-meta font-medium text-ink-fg-2">
                  <span>{t(`matters.context.groups.${group.key}`)}</span><span className="font-mono text-ink-fg-3">{group.items.length}</span>
                </div>
                {group.items.map((item) => {
                  const suggested = item.link.confirmed_at === null
                  return (
                    <div key={item.link.id} className={`border-t border-ink-border px-4 py-3 first:border-t-0 ${suggested ? 'bg-ai/[0.06]' : ''}`}>
                      <button type="button" onClick={() => onOpenResource(item)} className="flex w-full items-center gap-3 text-left hover:opacity-80">
                        <span className={`grid size-7 shrink-0 place-items-center rounded ${suggested ? 'bg-ai/15 text-ai' : 'bg-ink-4 text-ink-fg-2'}`}><Link2 size={13} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-body text-ink-fg">{item.resource.title || item.resource.external_key}</span>
                            {suggested ? <Pip tone="ai">{t('matters.resource.suggested')}</Pip> : null}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-ink-fg-3">
                            <span>{t(suggested ? 'matters.resource.agentSuggested' : 'matters.resource.manualLink')}</span>
                            {item.link.sub_state !== 'none' ? <Pip tone={item.link.sub_state === 'paused' ? 'warn' : 'ok'}><RefreshCcw size={10} />{t(item.link.sub_state === 'paused' ? 'matters.resource.subscriptionPaused' : 'matters.resource.subscriptionActive')}</Pip> : null}
                            {!isMatterResourceAvailable(item) ? <Pip tone="fail">{t('matters.context.unavailable')}</Pip> : null}
                          </span>
                        </span>
                      </button>
                      <MatterSuggestedResourceActions matter={matter} item={item} onChanged={onChanged} />
                    </div>
                  )
                })}
              </div>
            ) : null)}
          </div>
        ) : (
          <EmptyState icon={<Link2 size={22} />} title={t('matters.context.noResourcesTitle')} hint={t('matters.context.noResourcesHint')} />
        )}
      </section>

      <section>
        <SectionHeader title={t('matters.context.injectionTitle')} />
        <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
          <div className="flex flex-wrap gap-2">
            <Pip>{t('matters.context.injection.acceptedState')}</Pip>
            <Pip>{t('matters.context.injection.openItems', { count: openItems })}</Pip>
            <Pip>{t('matters.context.injection.stakeholderCount', { count: stakeholders.length })}</Pip>
            <Pip>{t('matters.context.injection.pinnedCount', { count: pinnedResources })}</Pip>
            <Pip>{t('matters.context.injection.changes')}</Pip>
          </div>
          <p className="mt-4 text-aux leading-6 text-ink-fg-2">{t('matters.context.injection.description')}</p>
          <div className="mt-4 flex items-start gap-2 border-t border-ink-border pt-4 text-meta leading-5 text-ink-fg-2">
            <Shield size={14} className="mt-0.5 shrink-0 text-ok" />
            <span>{t('matters.context.injection.shield')}</span>
          </div>
        </div>
      </section>

      <StakeholderModal
        matter={matter}
        stakeholder={editor === 'new' ? null : editor}
        open={editor !== null}
        onClose={() => setEditor(null)}
        onChanged={() => {
          setEditor(null)
          onChanged()
        }}
      />
    </div>
  )
}

function StakeholderModal({
  matter,
  stakeholder,
  open,
  onClose,
  onChanged
}: {
  matter: Matter
  stakeholder: MatterStakeholder | null
  open: boolean
  onClose(): void
  onChanged(): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const [form, setForm] = useState<MatterStakeholderCreateInput>(() => stakeholderToInput(stakeholder))
  const [formFor, setFormFor] = useState<number | 'new'>(stakeholder?.id ?? 'new')
  const nextFormFor = stakeholder?.id ?? 'new'
  if (formFor !== nextFormFor) {
    setFormFor(nextFormFor)
    setForm(stakeholderToInput(stakeholder))
  }

  const save = useMutation({
    mutationFn: () => stakeholder
      ? api.patchStakeholder(matter.public_id, stakeholder.id, form, { expectedVersion: matter.version })
      : api.createStakeholder(matter.public_id, form, { expectedVersion: matter.version }),
    onSuccess: onChanged,
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/45 p-4" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="matter-stakeholder-title" className="w-full max-w-md rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md">
        <header className="flex items-center justify-between border-b border-ink-border px-5 py-4">
          <h2 id="matter-stakeholder-title" className="text-lead font-semibold">{t(stakeholder ? 'matters.context.editStakeholder' : 'matters.context.addStakeholder')}</h2>
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3"><X size={16} /></button>
        </header>
        <div className="grid gap-3 p-5">
          <Field label={t('matters.context.fields.name')} value={form.display_name ?? ''} onChange={(value) => setForm((current) => ({ ...current, display_name: value || null }))} />
          <Field label={t('matters.context.fields.email')} value={form.email ?? ''} onChange={(value) => setForm((current) => ({ ...current, email: value || null }))} type="email" />
          <Field label={t('matters.context.fields.role')} value={form.role ?? ''} onChange={(value) => setForm((current) => ({ ...current, role: value || null }))} />
          <Field label={t('matters.context.fields.organization')} value={form.organization ?? ''} onChange={(value) => setForm((current) => ({ ...current, organization: value || null }))} />
          <label className="flex items-center justify-between rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-aux">
            <span>{t('matters.context.fields.waiting')}</span>
            <input type="checkbox" checked={form.is_waiting_on === true} onChange={(event) => setForm((current) => ({ ...current, is_waiting_on: event.target.checked }))} />
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-ink-border px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] px-3 py-2 text-aux hover:bg-ink-3">{t('common.cancel')}</button>
          <button type="button" disabled={save.isPending || (!form.display_name && !form.email)} onClick={() => save.mutate()} className="rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50">{t('common.save')}</button>
        </footer>
      </section>
    </div>
  )
}

function stakeholderToInput(stakeholder: MatterStakeholder | null): MatterStakeholderCreateInput {
  return {
    display_name: stakeholder?.display_name ?? '',
    email: stakeholder?.email_normalized ?? '',
    role: stakeholder?.role ?? '',
    organization: stakeholder?.organization ?? '',
    is_waiting_on: stakeholder?.is_waiting_on ?? false
  }
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange(value: string): void; type?: string }): React.ReactElement {
  return <label className="grid gap-1.5 text-aux text-ink-fg-1"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 outline-none focus:border-coral/60" /></label>
}

function SectionHeader({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }): React.ReactElement {
  return <div className="mb-3 flex items-center gap-2"><h2 className="text-body font-semibold text-ink-fg">{title}{count === undefined ? null : <span className="ml-1 font-mono text-meta text-ink-fg-3">· {count}</span>}</h2><div className="ml-auto">{children}</div></div>
}

function Pip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' | 'ok' | 'fail' | 'ai' }): React.ReactElement {
  const tones = { neutral: 'bg-ink-4 text-ink-fg-2', warn: 'bg-warn/10 text-warn', ok: 'bg-ok/10 text-ok', fail: 'bg-fail/10 text-fail', ai: 'bg-ai/10 text-ai' }
  return <span className={`inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2 py-1 text-meta ${tones[tone]}`}>{children}</span>
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }): React.ReactElement {
  return <div className="rounded-[var(--r-card)] border border-dashed border-ink-border p-8 text-center"><div className="mx-auto mb-2 grid size-9 place-items-center rounded-full bg-ink-3 text-ink-fg-3">{icon}</div><h3 className="text-body font-medium text-ink-fg">{title}</h3><p className="mx-auto mt-1 max-w-lg text-aux leading-5 text-ink-fg-3">{hint}</p></div>
}
