// P3 (task 06-18-custom-ai-harness-agent Phase 3) — Settings "Custom AI" section.
//
// Two sub-sections rendered inside the AI tab:
//   1. Skills toggle list  — react-query fetches SkillSummary[], zustand
//      useSkillEnablement overlays user overrides; toggling calls setEnabled +
//      invalidateConfig so the next chat turn sees the updated tool catalog +
//      prompt fragments.
//   2. Memory manager      — react-query fetches AgentMemoryEntry[] for scope
//      'user'; each entry is view/edit/delete (agent writes, user manages).
//
// i18n keys are all called via t() — the parent i18n JSON defines them.
// No new dependencies. No `any`. Matches AiTab Section/Row patterns exactly.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Trash2, Pencil, X, Check } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useSkillEnablement } from '@shared/state/skill-enablement'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { AgentMemoryEntry, SkillSummary, WriteMemoryInput } from '@shared/api/types'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'

import { Section } from './parts/Section'
import { Row } from './parts/Row'

// ---------------------------------------------------------------------------
// Skills subsection
// ---------------------------------------------------------------------------

function SkillsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const { overrides, setEnabled } = useSkillEnablement()

  const { data: skills, isLoading } = useQuery<SkillSummary[]>({
    queryKey: ['skills'],
    queryFn: () => api.chat.listSkills()
    // graceful: listSkills() already degrades to [] on manifest unreachable
  })

  function handleToggle(skill: SkillSummary, next: boolean): void {
    setEnabled(skill.name, next)
    // Drop the cached chat engine so the next chat.start() rebuilds with the
    // updated tool catalog + prompt fragments (effectiveEnabled && available).
    api.chat.invalidateConfig()
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
      const effectiveEnabled = overrides[skill.name] ?? skill.defaultEnabled
      return (
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
            checked={effectiveEnabled}
            onCheckedChange={(next) => handleToggle(skill, next)}
            aria-label={t('settings.skills.enabled')}
          />
        </Row>
      )
    })
  })()

  return (
    <Section title={t('settings.skills.title')} helper={t('settings.skills.desc')}>
      {rows}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Memory subsection — per-entry inline editor
// ---------------------------------------------------------------------------

interface MemoryEntryRowProps {
  entry: AgentMemoryEntry
  onSaved: () => void
  onDeleted: () => void
}

function MemoryEntryRow({ entry, onSaved, onDeleted }: MemoryEntryRowProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(entry.value_json)
  const [saving, setSaving] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  // Pretty-print JSON if parseable, else show raw.
  const displayValue = React.useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(entry.value_json), null, 2)
    } catch {
      return entry.value_json
    }
  }, [entry.value_json])

  function handleEdit(): void {
    setDraft(entry.value_json)
    setEditing(true)
    setConfirmDelete(false)
  }

  function handleCancelEdit(): void {
    setEditing(false)
    setDraft(entry.value_json)
  }

  async function handleSave(): Promise<void> {
    if (!draft.trim()) {
      toastError(t('settings.memory.emptyValue'))
      return
    }
    setSaving(true)
    try {
      const input: WriteMemoryInput = {
        scope: entry.scope,
        key: entry.key,
        valueJson: draft.trim()
      }
      await api.chat.writeMemory(input)
      api.chat.invalidateConfig()
      await qc.invalidateQueries({ queryKey: ['memory', 'user'] })
      setEditing(false)
      toastSuccess(t('settings.memory.savedToast'))
      onSaved()
    } catch (err) {
      toastError(t('settings.memory.savedToast'), (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(): Promise<void> {
    try {
      await api.chat.deleteMemory(entry.scope, entry.key)
      api.chat.invalidateConfig()
      await qc.invalidateQueries({ queryKey: ['memory', 'user'] })
      toastSuccess(t('settings.memory.deletedToast'))
      onDeleted()
    } catch (err) {
      toastError(t('settings.memory.deletedToast'), (err as Error).message)
    }
  }

  const updatedLabel = React.useMemo(() => {
    const d = new Date(entry.updated_at)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }, [entry.updated_at])

  return (
    <div className="px-4 py-3 flex flex-col gap-1.5 border-b border-ink-border-soft last:border-b-0">
      {/* key row */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-aux text-ink-fg truncate">{entry.key}</span>
        <div className="flex items-center gap-1 shrink-0">
          {!editing && (
            <>
              <button
                onClick={handleEdit}
                className="p-1 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
                aria-label={t('settings.memory.edit')}
              >
                <Pencil className="size-3.5" />
              </button>
              {confirmDelete ? (
                <>
                  <button
                    onClick={() => void handleDelete()}
                    className="px-2 py-0.5 rounded text-meta bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors duration-fast"
                  >
                    {t('settings.memory.deleteConfirm')}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="p-1 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
                  >
                    <X className="size-3.5" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="p-1 rounded text-ink-fg-2 hover:text-red-400 hover:bg-ink-3 transition-colors duration-fast"
                  aria-label={t('settings.memory.delete')}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </>
          )}
          {editing && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Check className="size-3" />
                )}
                {t('settings.memory.save')}
              </Button>
              <button
                onClick={handleCancelEdit}
                className="p-1 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
                aria-label={t('settings.memory.cancel')}
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* value */}
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          className={[
            'w-full resize-y rounded-md border border-ink-border bg-ink-2 px-3 py-2',
            'font-mono text-aux text-ink-fg placeholder:text-ink-fg-3',
            'transition-colors duration-fast',
            'focus:outline-none focus:ring-2 focus:ring-coral/70 focus:border-coral/60'
          ].join(' ')}
        />
      ) : (
        <pre className="text-meta text-ink-fg-2 whitespace-pre-wrap break-all font-mono leading-snug line-clamp-4">
          {displayValue}
        </pre>
      )}

      {/* meta */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-ink-fg-3">
        <span>
          {t('settings.memory.updated')}: {updatedLabel}
        </span>
        {entry.source_wiki_path ? (
          <span>{t('settings.memory.source', { source: entry.source_wiki_path })}</span>
        ) : null}
      </div>
    </div>
  )
}

function MemorySection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: entries, isError } = useQuery<AgentMemoryEntry[]>({
    queryKey: ['memory', 'user'],
    queryFn: () => api.chat.listMemory('user')
  })

  // Stable no-op callbacks — the query invalidation inside each row already
  // refreshes the list; these exist so MemoryEntryRow can signal completion
  // without needing direct query client access.
  const noop = React.useCallback(() => {
    // The row already called qc.invalidateQueries; nothing extra needed here.
    void qc
  }, [qc])

  const content: React.ReactNode = (() => {
    if (isError) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.memory.loadError')}</div>
      )
    }
    if (!entries || entries.length === 0) {
      return <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.memory.empty')}</div>
    }
    return (
      <div className="divide-y divide-ink-border-soft">
        {entries.map((entry) => (
          <MemoryEntryRow
            key={`${entry.scope}/${entry.key}`}
            entry={entry}
            onSaved={noop}
            onDeleted={noop}
          />
        ))}
      </div>
    )
  })()

  return (
    <Section title={t('settings.memory.title')} helper={t('settings.memory.desc')}>
      {content}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Public export — mounted near the bottom of AiTab
// ---------------------------------------------------------------------------

export function CustomAiSection(): React.ReactElement {
  return (
    <>
      <SkillsSection />
      <MemorySection />
    </>
  )
}
