// P3 (task 06-18-custom-ai-harness-agent Phase 3) — Settings "Custom AI" section.
//
// Two sub-sections rendered inside the AI tab:
//   1. Skills toggle list  — react-query fetches the RESOLVED SkillSummary[] from the
//      backend (GET /api/agent/skills: manifest ⋈ agent_config.db enable overrides).
//      Toggling calls api.chat.setSkillEnabled (POST /api/agent/skills/{name}/enabled) +
//      invalidateConfig so the next chat turn sees the updated tool catalog + prompt
//      fragments. A one-time mount effect migrates any leftover localStorage overrides
//      to the backend (PR5 — enablement SSoT moved off per-surface localStorage).
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
import { readSkillOverrides, writeSkillOverrides } from '@shared/chat/skill_enablement'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  AgentMemoryEntry,
  CompileUserMdResult,
  MailApi,
  SkillSummary,
  WriteMemoryInput
} from '@shared/api/types'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'

import { Section } from './parts/Section'
import { Row } from './parts/Row'

// ---------------------------------------------------------------------------
// Skills subsection
// ---------------------------------------------------------------------------

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
  api.chat.invalidateConfig()
  await invalidateSkills()
}

function SkillsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: skills, isLoading } = useQuery<SkillSummary[]>({
    queryKey: ['skills'],
    queryFn: () => api.chat.listSkills()
    // graceful: listSkills() degrades to [] when the backend is unreachable
  })

  // Run the one-time localStorage→backend override migration once on mount.
  React.useEffect(() => {
    void migrateLocalSkillOverrides(api, () => qc.invalidateQueries({ queryKey: ['skills'] }))
  }, [api, qc])

  async function handleToggle(skill: SkillSummary, next: boolean): Promise<void> {
    try {
      await api.chat.setSkillEnabled(skill.name, next)
      // Drop the cached chat engine so the next chat.start() rebuilds with the
      // updated tool catalog + prompt fragments, then refetch the resolved list.
      api.chat.invalidateConfig()
      await qc.invalidateQueries({ queryKey: ['skills'] })
    } catch (err) {
      toastError(t('settings.skills.title'), (err as Error).message)
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

// ---------------------------------------------------------------------------
// Memory subsection — per-entry inline editor
// ---------------------------------------------------------------------------

interface MemoryEntryRowProps {
  entry: AgentMemoryEntry
}

// The row owns its own refresh (qc.invalidateQueries on save/delete) — no parent
// onSaved/onDeleted indirection (review LOW: it was a noop).
function MemoryEntryRow({ entry }: MemoryEntryRowProps): React.ReactElement {
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
    } catch (err) {
      toastError(t('settings.memory.saveError'), (err as Error).message)
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
    } catch (err) {
      toastError(t('settings.memory.deleteError'), (err as Error).message)
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
                    className="px-2 py-0.5 rounded text-meta bg-fail/15 text-fail hover:bg-fail/25 transition-colors duration-fast"
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
                  className="p-1 rounded text-ink-fg-2 hover:text-fail hover:bg-ink-3 transition-colors duration-fast"
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

  const { data: entries, isError } = useQuery<AgentMemoryEntry[]>({
    queryKey: ['memory', 'user'],
    queryFn: () => api.chat.listMemory('user')
  })

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
          <MemoryEntryRow key={`${entry.scope}/${entry.key}`} entry={entry} />
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
// UserMdCompileSection — M3c 偏好编译触发面
// ---------------------------------------------------------------------------

// Resolve serve-api base URL for direct fetch calls (mirrors useLlmModels.ts resolveApiBaseUrl;
// intentionally duplicated to avoid circular imports with the chat runtime).
function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}

/** Fetch userMdCompileEnabled from serve-api /chat/config (runtime flag, not vite define).
 *  Returns false when not configured or the endpoint is unreachable. */
async function fetchUserMdCompileEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { userMdCompileEnabled?: unknown } }
    return body?.data?.userMdCompileEnabled === true
  } catch {
    return false
  }
}

function UserMdCompileSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()

  // All hooks must run unconditionally before any early return.
  const [compiling, setCompiling] = React.useState(false)
  const [result, setResult] = React.useState<CompileUserMdResult | null>(null)
  const [rollingBack, setRollingBack] = React.useState(false)

  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'userMdCompileEnabled'],
    queryFn: fetchUserMdCompileEnabled,
    staleTime: 30_000,
    retry: false
  })

  // flag-off（false / undefined）→ 字节级不渲染（DOM 无此区块）。
  if (!enabled) return null

  async function handleCompile(): Promise<void> {
    setCompiling(true)
    setResult(null)
    try {
      const r = await api.chat.compileUserMd()
      setResult(r)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('settings.userMdCompile.compileError'), msg)
    } finally {
      setCompiling(false)
    }
  }

  async function handleRollback(): Promise<void> {
    if (!result) return
    setRollingBack(true)
    try {
      await api.chat.rollbackProfileDoc({ name: 'user', toHash: result.beforeHash })
      setResult(null)
      toastSuccess(t('settings.userMdCompile.rolledBackToast'))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('settings.userMdCompile.rollbackError'), msg)
    } finally {
      setRollingBack(false)
    }
  }

  return (
    <Section title={t('settings.userMdCompile.title')} helper={t('settings.userMdCompile.desc')}>
      <div className="px-4 py-3.5 space-y-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleCompile()}
          disabled={compiling || rollingBack}
        >
          {compiling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {compiling ? t('settings.userMdCompile.compiling') : t('settings.userMdCompile.button')}
        </Button>

        {result && !result.changed ? (
          <p className="text-aux text-ink-fg-3">{t('settings.userMdCompile.noChange')}</p>
        ) : null}

        {result && result.changed ? (
          <div className="space-y-2">
            <p className="text-micro text-ink-fg-3">{t('settings.userMdCompile.diffLabel')}</p>
            <pre className="text-micro text-ink-fg-2 whitespace-pre-wrap break-all font-mono leading-snug bg-ink-bg-2 rounded p-2 max-h-32 overflow-auto">
              {result.before.trim()}
            </pre>
            <pre className="text-micro text-ink-fg-1 whitespace-pre-wrap break-all font-mono leading-snug bg-ink-bg-2 rounded p-2 max-h-32 overflow-auto">
              {result.after.trim()}
            </pre>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleRollback()}
              disabled={rollingBack}
            >
              {rollingBack ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {rollingBack
                ? t('settings.userMdCompile.rollingBack')
                : t('settings.userMdCompile.rollback')}
            </Button>
          </div>
        ) : null}
      </div>
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
      <UserMdCompileSection />
    </>
  )
}
