// Sprint 6 §2.2 — /settings full page.
//
// Six sections (mirrors the mockup spec in PROJECT-PLAN.md §2 Sprint 6):
//   1. Appearance — theme mode (light / system / dark) + accent 6 swatch
//   2. Inbox — poll interval (5 / 10 / 30 / off)
//   3. AI backends — Notion Agent binding (page_id + name) + Custom API
//      endpoint + the three secret slots (cli / llm / custom-api keys)
//   4. Storage — DB path + attachment root (folder picker via settings:pickFolder)
//   5. About — version + GitHub link
//
// Secrets are managed via the SettingsApi surface; the renderer NEVER sees
// the secret value. We render a "set" / "not set" pill + a write-only input
// that submits then clears so the textarea isn't a side-channel.
//
// Notion Agent binding writes to BOTH localStorage (so AIChatPanel's
// useSyncExternalStore subscription picks it up live, per Sprint 4 codex L
// carry-forward) AND settings:set (so a V2 web build can read it from the
// FastAPI). A custom event is dispatched after every write so already-
// mounted panels refresh without a remount.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Cog,
  Database,
  ExternalLink,
  FolderOpen,
  KeyRound,
  Loader2,
  Paintbrush,
  RefreshCw,
  Sparkles
} from 'lucide-react'

import type { PersistentSettings, SecretSlot, UpdaterStatus } from '@shared/api/types'
import { useAppearance, type AccentId, type ThemeMode } from '@shared/state/appearance'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useUpdaterStore, setUpdaterStatus } from '@shared/state/updater'
import { cn } from '@shared/lib/cn'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import {
  STORAGE_AGENT_ID,
  STORAGE_AGENT_NAME,
  dispatchAgentStorageEvent
} from '@shared/state/notion-agent-storage'
import { toastError, toastSuccess } from '@shared/state/toast'

const ACCENTS: AccentId[] = ['coral', 'cobalt', 'teal', 'rose', 'slate', 'olive']
// Swatch background gradients live in `index.css` (.swatch-<id>) so the
// .tsx file stays compliant with the `mailagent/no-raw-hex` lint rule
// (DESIGN.md §14 #1). Each AccentId maps to one className.
function accentSwatchClass(id: AccentId): string {
  return `swatch-${id}`
}

const POLL_OPTIONS: Array<{ value: 5 | 10 | 30 | 0; label: string }> = [
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 0, label: 'off' }
]

// ----- shared building blocks ----------------------------------------------

function SectionTitle({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <h2 className="text-lead text-ink-fg font-semibold flex items-center gap-2 mb-3">
      <span className="text-ink-fg-1">{icon}</span>
      {children}
    </h2>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-4 py-3 border-b border-ink-border-soft last:border-b-0">
      <div>
        <div className="text-aux text-ink-fg font-medium">{label}</div>
        {hint && <div className="text-meta text-ink-fg-3 mt-0.5 leading-snug">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function StatusPill({ set }: { set: boolean }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-meta font-mono',
        set ? 'bg-ok/15 text-ok' : 'bg-ink-3 text-ink-fg-2'
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', set ? 'bg-ok' : 'bg-ink-fg-3')} />
      {set ? t('settings.set') : t('settings.notSet')}
    </span>
  )
}

interface SecretInputProps {
  slot: SecretSlot
  isSet: boolean
  onSubmit: (value: string) => Promise<void>
  onClear: () => Promise<void>
  placeholder?: string
}

function SecretInput({
  slot,
  isSet,
  onSubmit,
  onClear,
  placeholder
}: SecretInputProps): React.ReactElement {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!value) return
    // Sprint 6 review (opus MEDIUM #2): capture + clear SYNCHRONOUSLY before
    // awaiting. The previous `setValue('')` AFTER `await onSubmit(value)` only
    // ran on success — on failure the typed secret stayed in React fiber state,
    // visible to DevTools / extension scrape / heap dump. Now the input is
    // wiped before the network call, regardless of outcome.
    const captured = value
    setValue('')
    setBusy(true)
    try {
      await onSubmit(captured)
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    try {
      await onClear()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <StatusPill set={isSet} />
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder ?? t('settings.secretPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          'flex-1 min-w-0 rounded-md bg-ink-2 border border-ink-border px-2.5 py-1.5',
          'text-aux text-ink-fg font-mono',
          'focus:outline-none focus:ring-2 focus:ring-coral/40 focus:border-coral/40',
          'disabled:opacity-60 disabled:cursor-not-allowed'
        )}
        disabled={busy}
        aria-label={`${slot} input`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value) void submit()
        }}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !value}
        className={cn(
          'px-3 py-1.5 rounded-md text-aux font-medium',
          'bg-coral/100 text-accent-fg hover:bg-coral-hover transition-colors duration-fast',
          'disabled:opacity-60 disabled:cursor-not-allowed'
        )}
      >
        {busy ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : t('settings.save')}
      </button>
      {isSet && (
        <button
          type="button"
          onClick={() => void clear()}
          disabled={busy}
          className={cn(
            'px-3 py-1.5 rounded-md text-aux text-ink-fg-1',
            'border border-ink-border hover:bg-ink-4 transition-colors duration-fast',
            'disabled:opacity-60 disabled:cursor-not-allowed'
          )}
        >
          {t('settings.clear')}
        </button>
      )}
    </div>
  )
}

// ----- main page ----------------------------------------------------------

// Outer page — loads queries, then hands a fully-resolved snapshot to the
// inner form. The inner form uses `useState` lazy initializers so the seed
// happens exactly once at mount; we no longer reach for a useEffect+setState
// pattern (which trips `react-hooks/set-state-in-effect`).
export function SettingsPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()

  const settingsQ = useQuery({
    queryKey: ['settings'],
    queryFn: () => mailApi.settings.get(),
    staleTime: Infinity
  })
  const secretsQ = useQuery({
    queryKey: ['settings', 'secrets'],
    queryFn: () => mailApi.settings.secretsStatus(),
    staleTime: Infinity
  })

  if (!settingsQ.data || !secretsQ.data) {
    return (
      <div className="px-6 py-5 space-y-6 max-w-[920px]">
        <h1 className="text-display text-ink-fg font-semibold">{t('settings.title')}</h1>
        <Skeleton rows={4} />
        <Skeleton rows={5} />
        <Skeleton rows={3} />
      </div>
    )
  }

  return <SettingsForm initialSettings={settingsQ.data} initialSecrets={secretsQ.data} />
}

interface SettingsFormProps {
  initialSettings: PersistentSettings
  initialSecrets: import('@shared/api/types').SecretsStatus
}

function SettingsForm({ initialSettings, initialSecrets }: SettingsFormProps): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const appearance = useAppearance()

  // Mirror the snapshot into local form state via lazy initializers — runs
  // exactly once at mount, never overwrites half-typed values on a stale
  // refetch. The query cache stays the canonical source for persisted
  // values that the form is not currently editing (dbPath / attachmentDir).
  const [pollInterval, setPollInterval] = useState<5 | 10 | 30 | 0>(
    () => initialSettings.pollIntervalSec
  )
  const [agentPageId, setAgentPageId] = useState(() => initialSettings.notionAgentPageId ?? '')
  const [agentName, setAgentName] = useState(() => initialSettings.notionAgentName ?? '')
  const [customApiEndpoint, setCustomApiEndpoint] = useState(
    () => initialSettings.customApiEndpoint ?? ''
  )

  // For the storage section we render straight from the query cache (no
  // text-input local mirror needed — picker writes flow through mutateAsync
  // then invalidate). Reading via `useQuery` here reuses the parent's
  // already-resolved cache entry (no extra IPC).
  const settingsQ = useQuery({
    queryKey: ['settings'],
    queryFn: () => mailApi.settings.get(),
    initialData: initialSettings,
    staleTime: Infinity
  })
  const secretsQ = useQuery({
    queryKey: ['settings', 'secrets'],
    queryFn: () => mailApi.settings.secretsStatus(),
    initialData: initialSecrets,
    staleTime: Infinity
  })
  const settings = settingsQ.data
  const secrets = secretsQ.data

  // Persist helper — patch + invalidate.
  const setMut = useMutation({
    mutationFn: (patch: Partial<PersistentSettings>) => mailApi.settings.set(patch),
    onSuccess: (next) => {
      qc.setQueryData(['settings'], next)
    },
    onError: (err: unknown) => {
      toastError(t('settings.saveFail'), err instanceof Error ? err.message : String(err))
    }
  })

  const persistAgent = useCallback(
    async (id: string, name: string) => {
      try {
        if (id) {
          localStorage.setItem(STORAGE_AGENT_ID, id)
          if (name) localStorage.setItem(STORAGE_AGENT_NAME, name)
          else localStorage.removeItem(STORAGE_AGENT_NAME)
        } else {
          localStorage.removeItem(STORAGE_AGENT_ID)
          localStorage.removeItem(STORAGE_AGENT_NAME)
        }
        dispatchAgentStorageEvent()
      } catch {
        // localStorage unavailable — main-process settings still get the value.
      }
      await setMut.mutateAsync({
        notionAgentPageId: id || null,
        notionAgentName: name || null
      })
    },
    [setMut]
  )

  // ----- secret callbacks ---------------------------------------------------
  const setSecret = useCallback(
    async (slot: SecretSlot, value: string): Promise<void> => {
      try {
        const next = await mailApi.settings.setSecret(slot, value)
        qc.setQueryData(['settings', 'secrets'], next)
        toastSuccess(t(`settings.${slot}.saved`))
      } catch (err) {
        toastError(t('settings.saveFail'), err instanceof Error ? err.message : String(err))
      }
    },
    [mailApi, qc, t]
  )
  const clearSecret = useCallback(
    async (slot: SecretSlot): Promise<void> => {
      try {
        const next = await mailApi.settings.clearSecret(slot)
        qc.setQueryData(['settings', 'secrets'], next)
        toastSuccess(t(`settings.${slot}.cleared`))
      } catch (err) {
        toastError(t('settings.saveFail'), err instanceof Error ? err.message : String(err))
      }
    },
    [mailApi, qc, t]
  )

  const pickFolder = useCallback(
    async (key: 'dbPath' | 'attachmentDir', title: string): Promise<void> => {
      const folder = await mailApi.settings.pickFolder(title)
      if (folder === null) return
      await setMut.mutateAsync({ [key]: folder })
      toastSuccess(t(`settings.${key}.saved`))
    },
    [mailApi, setMut, t]
  )

  // ----- LLM ping -----------------------------------------------------------
  const [llmPinging, setLlmPinging] = useState(false)
  const pingLlm = async (): Promise<void> => {
    setLlmPinging(true)
    try {
      const r = await mailApi.settings.testLlm()
      if (r.ok) toastSuccess(t('settings.llmApiKey.pingOk'), r.detail)
      else toastError(t('settings.llmApiKey.pingFail'), r.detail ?? r.code)
    } finally {
      setLlmPinging(false)
    }
  }

  return (
    <div className="px-6 py-5 space-y-8 min-h-full max-w-[920px]">
      <header className="flex items-center gap-2">
        <Cog size={20} strokeWidth={1.75} className="text-ink-fg-1" />
        <h1 className="text-display text-ink-fg font-semibold">{t('settings.title')}</h1>
      </header>

      {/* Appearance */}
      <section>
        <SectionTitle icon={<Paintbrush size={16} strokeWidth={1.75} />}>
          {t('settings.appearance')}
        </SectionTitle>
        <div className="rounded-md border border-ink-border bg-ink-2 px-4">
          <Row label={t('settings.themeMode')} hint={t('settings.themeModeHint')}>
            <div className="inline-flex rounded-md border border-ink-border bg-ink-3 p-0.5">
              {(['light', 'system', 'dark'] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => appearance.setThemeMode(m)}
                  className={cn(
                    'px-3 py-1 text-aux rounded transition-colors duration-fast',
                    appearance.themeMode === m
                      ? 'bg-coral/15 text-coral font-medium'
                      : 'text-ink-fg-1 hover:text-ink-fg'
                  )}
                >
                  {t(`settings.theme.${m}`)}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t('settings.accent')} hint={t('settings.accentHint')}>
            <div className="flex items-center gap-2">
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => appearance.setAccent(a)}
                  aria-label={`accent ${a}`}
                  className={cn(
                    'w-7 h-7 rounded-full transition-transform duration-fast',
                    'border-2 flex items-center justify-center',
                    accentSwatchClass(a),
                    appearance.accent === a
                      ? 'border-ink-fg scale-110'
                      : 'border-ink-border hover:border-ink-fg-2'
                  )}
                >
                  {appearance.accent === a && (
                    <Check size={14} strokeWidth={3} className="text-white" />
                  )}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </section>

      {/* Inbox */}
      <section>
        <SectionTitle icon={<Cog size={16} strokeWidth={1.75} />}>
          {t('settings.inbox')}
        </SectionTitle>
        <div className="rounded-md border border-ink-border bg-ink-2 px-4">
          <Row label={t('settings.pollInterval')} hint={t('settings.pollIntervalHint')}>
            <div className="inline-flex rounded-md border border-ink-border bg-ink-3 p-0.5">
              {POLL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setPollInterval(opt.value)
                    void setMut.mutateAsync({ pollIntervalSec: opt.value })
                  }}
                  className={cn(
                    'px-3 py-1 text-aux rounded transition-colors duration-fast',
                    opt.value === pollInterval
                      ? 'bg-coral/15 text-coral font-medium'
                      : 'text-ink-fg-1 hover:text-ink-fg'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </section>

      {/* AI backends */}
      <section>
        <SectionTitle icon={<Sparkles size={16} strokeWidth={1.75} />}>
          {t('settings.aiBackends')}
        </SectionTitle>
        <div className="rounded-md border border-ink-border bg-ink-2 px-4">
          <Row label={t('settings.notionAgent')} hint={t('settings.notionAgentHint')}>
            <div className="space-y-2">
              <input
                type="text"
                value={agentPageId}
                onChange={(e) => setAgentPageId(e.target.value)}
                placeholder={t('settings.notionAgentIdPlaceholder')}
                className={cn(
                  'w-full rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
                  'text-aux text-ink-fg font-mono',
                  'focus:outline-none focus:ring-2 focus:ring-coral/40 focus:border-coral/40'
                )}
              />
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={t('settings.notionAgentNamePlaceholder')}
                className={cn(
                  'w-full rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
                  'text-aux text-ink-fg',
                  'focus:outline-none focus:ring-2 focus:ring-coral/40 focus:border-coral/40'
                )}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void persistAgent(agentPageId.trim(), agentName.trim())}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-aux font-medium',
                    'bg-coral/100 text-accent-fg hover:bg-coral-hover transition-colors duration-fast'
                  )}
                >
                  {t('settings.save')}
                </button>
                {(agentPageId || agentName) && (
                  <button
                    type="button"
                    onClick={() => {
                      setAgentPageId('')
                      setAgentName('')
                      void persistAgent('', '')
                    }}
                    className={cn(
                      'px-3 py-1.5 rounded-md text-aux text-ink-fg-1',
                      'border border-ink-border hover:bg-ink-4 transition-colors duration-fast'
                    )}
                  >
                    {t('settings.clear')}
                  </button>
                )}
              </div>
            </div>
          </Row>
          <Row label={t('settings.customApiEndpoint')} hint={t('settings.customApiEndpointHint')}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customApiEndpoint}
                onChange={(e) => setCustomApiEndpoint(e.target.value)}
                placeholder="https://crs.example.com"
                className={cn(
                  'flex-1 min-w-0 rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
                  'text-aux text-ink-fg font-mono',
                  'focus:outline-none focus:ring-2 focus:ring-coral/40 focus:border-coral/40'
                )}
              />
              <button
                type="button"
                onClick={() =>
                  void setMut.mutateAsync({ customApiEndpoint: customApiEndpoint || null })
                }
                className={cn(
                  'px-3 py-1.5 rounded-md text-aux font-medium',
                  'bg-coral/100 text-accent-fg hover:bg-coral-hover transition-colors duration-fast'
                )}
              >
                {t('settings.save')}
              </button>
            </div>
          </Row>
        </div>
      </section>

      {/* Secrets */}
      <section>
        <SectionTitle icon={<KeyRound size={16} strokeWidth={1.75} />}>
          {t('settings.secrets')}
        </SectionTitle>
        <div className="rounded-md border border-ink-border bg-ink-2 px-4">
          <Row label={t('settings.cliApiKey.label')} hint={t('settings.cliApiKey.hint')}>
            <SecretInput
              slot="cliApiKey"
              isSet={secrets?.cliApiKey ?? false}
              onSubmit={(v) => setSecret('cliApiKey', v)}
              onClear={() => clearSecret('cliApiKey')}
            />
          </Row>
          <Row label={t('settings.llmApiKey.label')} hint={t('settings.llmApiKey.hint')}>
            <div className="space-y-2">
              <SecretInput
                slot="llmApiKey"
                isSet={secrets?.llmApiKey ?? false}
                onSubmit={(v) => setSecret('llmApiKey', v)}
                onClear={() => clearSecret('llmApiKey')}
              />
              <button
                type="button"
                onClick={() => void pingLlm()}
                disabled={llmPinging}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux',
                  'text-coral border border-coral/30 hover:bg-coral/10',
                  'transition-colors duration-fast',
                  'disabled:opacity-60 disabled:cursor-not-allowed'
                )}
              >
                {llmPinging ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : null}
                {t('settings.testPing')}
              </button>
            </div>
          </Row>
          <Row label={t('settings.customApiKey.label')} hint={t('settings.customApiKey.hint')}>
            <SecretInput
              slot="customApiKey"
              isSet={secrets?.customApiKey ?? false}
              onSubmit={(v) => setSecret('customApiKey', v)}
              onClear={() => clearSecret('customApiKey')}
            />
          </Row>
        </div>
      </section>

      {/* Storage */}
      <section>
        <SectionTitle icon={<Database size={16} strokeWidth={1.75} />}>
          {t('settings.storage')}
        </SectionTitle>
        <div className="rounded-md border border-ink-border bg-ink-2 px-4">
          <Row label={t('settings.dbPath.label')} hint={t('settings.dbPath.hint')}>
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex-1 min-w-0 rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
                  'text-aux text-ink-fg font-mono truncate'
                )}
                title={settings?.dbPath ?? ''}
              >
                {settings?.dbPath ?? t('settings.defaultUsed')}
              </div>
              <button
                type="button"
                onClick={() => void pickFolder('dbPath', t('settings.dbPath.pickerTitle'))}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux',
                  'text-ink-fg border border-ink-border hover:bg-ink-4 transition-colors duration-fast'
                )}
              >
                <FolderOpen size={13} strokeWidth={2} />
                {t('settings.choose')}
              </button>
            </div>
          </Row>
          <Row label={t('settings.attachmentDir.label')} hint={t('settings.attachmentDir.hint')}>
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex-1 min-w-0 rounded-md bg-ink-3 border border-ink-border px-2.5 py-1.5',
                  'text-aux text-ink-fg font-mono truncate'
                )}
                title={settings?.attachmentDir ?? ''}
              >
                {settings?.attachmentDir ?? t('settings.defaultUsed')}
              </div>
              <button
                type="button"
                onClick={() =>
                  void pickFolder('attachmentDir', t('settings.attachmentDir.pickerTitle'))
                }
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux',
                  'text-ink-fg border border-ink-border hover:bg-ink-4 transition-colors duration-fast'
                )}
              >
                <FolderOpen size={13} strokeWidth={2} />
                {t('settings.choose')}
              </button>
            </div>
          </Row>
        </div>
      </section>

      {/* Updates */}
      <UpdateSection />

      {/* About */}
      <AboutSection />
    </div>
  )
}

// ----- About + Updates -----------------------------------------------------
//
// Sprint 8 §2.2 — auto-updater integration. The About block now reads the
// real `app.getVersion()` (via `updater:status` IPC) and exposes a
// "Check for updates" CTA that drives the autoUpdater state machine.
// Subscribing to `updater:event` lets the UI update while the user reads
// the page (download progress, etc.) without re-mounting.

function AboutSection(): React.ReactElement {
  const { t } = useTranslation()
  const version = useUpdaterStore((s) => s.status.currentVersion)
  return (
    <section>
      <SectionTitle icon={<ExternalLink size={16} strokeWidth={1.75} />}>
        {t('settings.about')}
      </SectionTitle>
      <div className="rounded-md border border-ink-border bg-ink-2 p-4 text-aux text-ink-fg-1 leading-relaxed space-y-2">
        <div>
          <span className="text-ink-fg font-medium">MailAgent</span>
          <span className="text-ink-fg-3 ml-2 font-mono">v{version}</span>
        </div>
        <a
          href="https://github.com/chenyqthu/MailAgent"
          target="_blank"
          rel="noopener noreferrer"
          className="text-coral hover:underline inline-flex items-center gap-1"
        >
          github.com/chenyqthu/MailAgent
          <ExternalLink size={11} strokeWidth={2} />
        </a>
      </div>
    </section>
  )
}

function UpdateSection(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const status = useUpdaterStore((s) => s.status)
  const [busy, setBusy] = useState(false)

  // Hydrate from main + subscribe to live events. We pull once on mount via
  // `updater.status()` to avoid showing the zustand initial (0.0.0) seed,
  // then keep the store fresh through the broadcast channel. Unsubscribe
  // on unmount so a navigation away doesn't hold a stale listener.
  useEffect(() => {
    let cancelled = false
    void mailApi.updater
      .status()
      .then((s) => {
        if (!cancelled) setUpdaterStatus(s)
      })
      .catch(() => {
        /* HttpApi V2 stub throws; renderer keeps initial state. */
      })
    const unsubscribe = mailApi.updater.onEvent((next: UpdaterStatus) => {
      setUpdaterStatus(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [mailApi])

  const isDev = status.state === 'dev-disabled'
  const isChecking = status.state === 'checking'
  const isDownloading = status.state === 'downloading'
  const isDownloaded = status.state === 'downloaded'
  const hasUpdate = status.state === 'available'

  const handleCheck = useCallback(async (): Promise<void> => {
    if (isDev || busy) return
    setBusy(true)
    try {
      await mailApi.updater.check()
    } catch (err) {
      toastError(
        t('settings.update.heading'),
        err instanceof Error ? err.message : String(err)
      )
    } finally {
      setBusy(false)
    }
  }, [isDev, busy, mailApi, t])

  const handleDownload = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await mailApi.updater.download()
    } catch (err) {
      toastError(
        t('settings.update.heading'),
        err instanceof Error ? err.message : String(err)
      )
    } finally {
      setBusy(false)
    }
  }, [mailApi, t])

  const handleRestart = useCallback((): void => {
    // Fire-and-forget. The app quits before this promise resolves so any
    // .catch wouldn't run anyway.
    void mailApi.updater.quitAndInstall()
    toastSuccess(t('settings.update.restartCta'))
  }, [mailApi, t])

  // Resolve the status message body for the current state. Keep this as a
  // single switch so a new state is impossible to forget.
  let statusMessage: string
  switch (status.state) {
    case 'idle':
      statusMessage = t('settings.update.currentVersion') + ' v' + status.currentVersion
      break
    case 'checking':
      statusMessage = t('settings.update.checking')
      break
    case 'available':
      statusMessage = t('settings.update.available', {
        version: status.latestVersion ?? '?'
      })
      break
    case 'not-available':
      statusMessage = t('settings.update.upToDate')
      break
    case 'downloading':
      statusMessage = t('settings.update.downloading', {
        percent: status.downloadPercent ?? 0
      })
      break
    case 'downloaded':
      statusMessage = t('settings.update.readyToInstall', {
        version: status.latestVersion ?? '?'
      })
      break
    case 'error':
      statusMessage = t('settings.update.error', { message: status.message ?? '' })
      break
    case 'dev-disabled':
      statusMessage = t('settings.update.devDisabled')
      break
  }

  return (
    <section>
      <SectionTitle icon={<RefreshCw size={16} strokeWidth={1.75} />}>
        {t('settings.update.heading')}
      </SectionTitle>
      <div className="rounded-md border border-ink-border bg-ink-2 px-4">
        <Row label={t('settings.update.currentVersion')} hint={t('settings.update.channel')}>
          <div className="text-aux text-ink-fg font-mono">v{status.currentVersion}</div>
        </Row>
        <Row label={statusMessage} hint={undefined}>
          <div className="flex items-center gap-2">
            {!isDownloaded && (
              <button
                type="button"
                onClick={() => void handleCheck()}
                disabled={isDev || busy || isChecking || isDownloading}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-aux',
                  'text-coral border border-coral/30 hover:bg-coral/10',
                  'transition-colors duration-fast',
                  'disabled:opacity-60 disabled:cursor-not-allowed'
                )}
              >
                {isChecking || busy ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} strokeWidth={2} />
                )}
                {isChecking ? t('settings.update.checking') : t('settings.update.checkNow')}
              </button>
            )}
            {hasUpdate && (
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={busy}
                className={cn(
                  'px-3 py-1.5 rounded-md text-aux font-medium',
                  'bg-coral/100 text-accent-fg hover:bg-coral-hover transition-colors duration-fast',
                  'disabled:opacity-60 disabled:cursor-not-allowed'
                )}
              >
                {t('settings.update.downloadCta')}
              </button>
            )}
            {isDownloaded && (
              <button
                type="button"
                onClick={handleRestart}
                className={cn(
                  'px-3 py-1.5 rounded-md text-aux font-medium',
                  'bg-coral/100 text-accent-fg hover:bg-coral-hover transition-colors duration-fast'
                )}
              >
                {t('settings.update.restartCta')}
              </button>
            )}
          </div>
        </Row>
      </div>
    </section>
  )
}
