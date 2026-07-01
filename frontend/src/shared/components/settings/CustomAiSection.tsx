// P3 (task 06-18-custom-ai-harness-agent Phase 3) — Settings "Custom AI" section.
//
// Sub-sections rendered inside the AI tab:
//   1. Skills toggle list  — react-query fetches the RESOLVED SkillSummary[] from the
//      backend (GET /api/agent/skills: manifest ⋈ agent_config.db enable overrides).
//      Toggling calls api.chat.setSkillEnabled (POST /api/agent/skills/{name}/enabled) +
//      invalidateConfig so the next chat turn sees the updated tool catalog + prompt
//      fragments. A one-time mount effect migrates any leftover localStorage overrides
//      to the backend (PR5 — enablement SSoT moved off per-surface localStorage).
//
// i18n keys are all called via t() — the parent i18n JSON defines them.
// No new dependencies. No `any`. Matches AiTab Section/Row patterns exactly.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  X
} from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useEnabledModels, FALLBACK_MODELS } from '@shared/hooks/useLlmModels'
import { useEnvStore } from '@shared/state/env'
import { readSkillOverrides, writeSkillOverrides } from '@shared/chat/skill_enablement'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  AgentProfileDoc,
  AgentProfileHistoryEntry,
  CompileUserMdResult,
  MailApi,
  SkillSummary
} from '@shared/api/types'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'

import { Section } from './parts/Section'
import { Row } from './parts/Row'
import { EnvField } from './parts/EnvField'

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
// MemoryCaptureModelSection — 记忆抽取模型（MEMORY_CAPTURE_MODEL，task 07-01 #1）
// ---------------------------------------------------------------------------
//
// auto-capture 每轮把持久事实合并进 memory.md 时用的 LLM 模型。这是 config.py 的 pydantic
// 字段（singleton，非热读）→ 改动写 .env 后需重启 serve-api 生效；EnvField 的 markRestartRequired
// 会拉起全局重启横幅（与 LLM_MODEL 同款机制）。.env 未设时后端默认 = claude-haiku-4-5（便宜快，
// 每被捕获的对话轮跑一次，成本敏感）。

const MEMORY_CAPTURE_DEFAULT_MODEL = 'claude-haiku-4-5'

function MemoryCaptureModelSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const { models: enabledModels } = useEnabledModels()
  const currentModel = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['MEMORY_CAPTURE_MODEL'] ?? '') : ''
  )
  // Gate on the SAME flag as the identity/memory doc editor (no new flag): the memory
  // capture model is part of the same advanced agent-config surface (task 07-01 step 3).
  // flag-off → return null (no DOM), like StandingDocsSection.
  const { data: editorEnabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'standingDocsEditorEnabled'],
    queryFn: fetchStandingDocsEditorEnabled,
    staleTime: 30_000,
    retry: false
  })

  const options = React.useMemo(() => {
    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
    // Always offer the recommended haiku default (it isn't in FALLBACK_MODELS), then append
    // the current .env value as an orphan if it's set and not already listed (mirrors AiTab
    // LLM_MODEL orphan handling so a narrowed enabled-list never blanks the select).
    const withDefault = base.includes(MEMORY_CAPTURE_DEFAULT_MODEL)
      ? base
      : [MEMORY_CAPTURE_DEFAULT_MODEL, ...base]
    const withOrphan =
      currentModel && !withDefault.includes(currentModel)
        ? [...withDefault, currentModel]
        : withDefault
    return withOrphan.map((id) => ({ value: id, label: id }))
  }, [enabledModels, currentModel])

  if (!editorEnabled) return null

  return (
    <Section
      title={t('settings.memoryCaptureModel.title')}
      helper={t('settings.memoryCaptureModel.desc')}
    >
      <EnvField
        envKey="MEMORY_CAPTURE_MODEL"
        control="select"
        label={t('settings.memoryCaptureModel.label')}
        helper={t('settings.memoryCaptureModel.helper')}
        options={options}
        placeholder={MEMORY_CAPTURE_DEFAULT_MODEL}
      />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// StandingDocsSection — Settings 身份文档编辑器（M-this task）
// ---------------------------------------------------------------------------
//
// 列出 4 个 Standing Context 文档（SOUL/AGENT/RULES/USER）。每个文档可折叠：
//   - 展开时显示当前全文 + 编辑按钮 + 版本历史/rollback 触发入口
//   - 编辑态：textarea + 保存 + 取消
//   - SOUL/AGENT/RULES 高危红样式 + floor 提示
//   - 保存失败（如 RULES 越权）→ toastError + 保持 textarea 内容（用户可修正）
//   - flag MAILAGENT_STANDING_DOCS_EDITOR 默认 ON；flag-off → return null（DOM 无此区块）

const HIGH_RISK_DOCS = new Set(['soul', 'agent', 'rules'])
const MEMORY_DOC = 'memory'
// Fallback budget if the backend omits budgetChars (config.memory_md_budget_chars default).
const MEMORY_DEFAULT_BUDGET = 5000

const DOC_LABELS: Record<string, string> = {
  soul: 'SOUL（身份）',
  agent: 'AGENT（操作笔记）',
  rules: 'RULES（硬约束）',
  user: 'USER（用户偏好）',
  memory: 'MEMORY（自动记忆）'
}

/** Fetch standingDocsEditorEnabled from serve-api /chat/config.
 *  Returns true when not configured or endpoint is unreachable (default-ON flag). */
async function fetchStandingDocsEditorEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return true // default ON: show section when config unavailable
    const body = (await resp.json()) as { data?: { standingDocsEditorEnabled?: unknown } }
    // Explicit false → hide. undefined/null/true → show (default ON).
    return body?.data?.standingDocsEditorEnabled !== false
  } catch {
    return true
  }
}

interface DocEntryProps {
  doc: AgentProfileDoc
  onRefetch: () => Promise<unknown>
}

function DocEntry({ doc, onRefetch }: DocEntryProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()

  const [expanded, setExpanded] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(doc.content)
  const [saving, setSaving] = React.useState(false)
  const [showHistory, setShowHistory] = React.useState(false)
  const [history, setHistory] = React.useState<AgentProfileHistoryEntry[]>([])
  const [loadingHistory, setLoadingHistory] = React.useState(false)
  const [rollingBack, setRollingBack] = React.useState<string | null>(null)

  const isHighRisk = HIGH_RISK_DOCS.has(doc.docName.toLowerCase())
  const isMemory = doc.docName.toLowerCase() === MEMORY_DOC
  const label = DOC_LABELS[doc.docName.toLowerCase()] ?? doc.docName.toUpperCase()

  // memory.md — Hermes 式有界记忆：恒注入每轮 prompt，有硬字符预算。编辑时按 draft 实时计数，
  // 否则按已存内容；超预算时后端拒存 → 前端也 disable 保存并红色提示（显著显示长度/占比）。
  const budget = doc.budgetChars ?? MEMORY_DEFAULT_BUDGET
  const memoryLen = isMemory ? (editing ? draft.length : doc.content.length) : 0
  const overBudget = isMemory && memoryLen > budget
  const budgetPct = budget > 0 ? Math.min(100, Math.round((memoryLen / budget) * 100)) : 0

  // Sync draft from incoming doc.content (after parent refetch on save/rollback)
  // only if the user isn't actively editing — preserves unsaved edits otherwise.
  const prevContent = React.useRef(doc.content)
  React.useEffect(() => {
    if (doc.content !== prevContent.current) {
      prevContent.current = doc.content
      if (!editing) {
        // 合法的「按传入 prop 同步草稿」预填（仅非编辑态）；同本文件其他预填 effect 一致豁免。
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDraft(doc.content)
      }
    }
  }, [doc.content, editing])

  function handleEdit(): void {
    setDraft(doc.content)
    setEditing(true)
  }

  function handleCancelEdit(): void {
    setEditing(false)
    setDraft(doc.content)
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      await api.chat.setProfileDoc({
        name: doc.docName,
        content: draft,
        // 后端 set_profile_doc 白名单只认 ('user','agent_proposed')，非法值静默归一为 'user'。
        // Settings 手动编辑 = 'user'（与 rollbackProfileDoc 一致），落库 changedBy 才如实。
        updatedBy: 'user'
      })
      setEditing(false)
      await onRefetch()
      toastSuccess(t('settings.standingDocs.savedToast'))
    } catch (err: unknown) {
      // Keep editing=true so user can fix content (e.g. RULES validator rejection).
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('settings.standingDocs.saveError'), msg)
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleHistory(): Promise<void> {
    const next = !showHistory
    setShowHistory(next)
    if (next && history.length === 0) {
      setLoadingHistory(true)
      try {
        const h = await api.chat.listProfileHistory(doc.docName)
        setHistory(h)
      } catch {
        setHistory([])
      } finally {
        setLoadingHistory(false)
      }
    }
  }

  async function handleRollback(toHash: string): Promise<void> {
    setRollingBack(toHash)
    try {
      await api.chat.rollbackProfileDoc({ name: doc.docName, toHash })
      setHistory([])
      setShowHistory(false)
      setEditing(false)
      await onRefetch()
      toastSuccess(t('settings.standingDocs.rolledBackToast'))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('settings.standingDocs.rollbackError'), msg)
    } finally {
      setRollingBack(null)
    }
  }

  const updatedLabel = React.useMemo(() => {
    if (doc.updatedAt == null) return null
    // updatedAt is a Unix timestamp in seconds (Python time.time()).
    const d = new Date(doc.updatedAt * 1000)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }, [doc.updatedAt])

  return (
    <div className="border-b border-ink-border-soft last:border-b-0">
      {/* Collapse/expand header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-ink-fg/[0.025] transition-colors duration-fast"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-fg-2" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-fg-2" />
        )}
        <span className="flex-1 font-mono text-aux font-medium text-ink-fg truncate">{label}</span>
        {isHighRisk && (
          <span className="inline-flex items-center gap-1 rounded-full bg-fail/15 px-1.5 py-0.5 text-micro text-fail shrink-0">
            <AlertTriangle className="size-2.5" />
            {t('settings.standingDocs.highRiskBadge')}
          </span>
        )}
        {isMemory && (
          <span className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-2 shrink-0">
            <Sparkles className="size-2.5" />
            {t('settings.standingDocs.autoBadge')}
          </span>
        )}
        {isMemory && (
          <span
            className={[
              'text-micro font-mono shrink-0',
              overBudget ? 'text-fail' : 'text-ink-fg-3'
            ].join(' ')}
          >
            {memoryLen}/{budget}
          </span>
        )}
        {!isMemory && updatedLabel && !expanded && (
          <span className="text-micro text-ink-fg-3 shrink-0">{updatedLabel}</span>
        )}
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {isHighRisk && (
            <div className="rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-meta text-fail">
              {t('settings.standingDocs.floorNote')}
            </div>
          )}

          {/* memory.md is NOT an identity doc — it's auto-maintained (agent capture
              rewrites it) untrusted background memory. Distinct neutral note (not the
              red high-risk floor) + prominent length/budget so the user sees usage
              live while editing. */}
          {isMemory && (
            <div className="space-y-1.5">
              <div className="rounded-md border border-ink-border bg-ink-4/60 px-2.5 py-1.5 text-meta text-ink-fg-2">
                {t('settings.standingDocs.memoryNote')}
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-micro font-mono">
                  <span className="text-ink-fg-3">{t('settings.standingDocs.budgetUsage')}</span>
                  <span className={overBudget ? 'text-fail font-medium' : 'text-ink-fg-2'}>
                    {memoryLen} / {budget}
                    {overBudget ? ` · ${t('settings.standingDocs.overBudget')}` : ''}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-4">
                  <div
                    className={[
                      'h-full rounded-full transition-[width] duration-fast',
                      overBudget ? 'bg-fail' : 'bg-[rgb(var(--c-accent))]'
                    ].join(' ')}
                    style={{ width: `${budgetPct}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {editing ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                className={[
                  'w-full resize-y rounded-md border bg-ink-2 px-3 py-2',
                  'font-mono text-aux text-ink-fg placeholder:text-ink-fg-3',
                  'transition-colors duration-fast',
                  'focus:outline-none focus:ring-2 focus:ring-coral/70 focus:border-coral/60',
                  isHighRisk ? 'border-fail/50' : 'border-ink-border'
                ].join(' ')}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleSave()}
                  disabled={saving || overBudget}
                >
                  {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {saving ? t('settings.standingDocs.saving') : t('settings.standingDocs.save')}
                </Button>
                {overBudget && (
                  <span className="text-micro text-fail">
                    {t('settings.standingDocs.overBudgetHint', { budget })}
                  </span>
                )}
                <button
                  onClick={handleCancelEdit}
                  className="p-1 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
                  aria-label={t('settings.standingDocs.cancel')}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </>
          ) : (
            <>
              <pre className="text-meta text-ink-fg-2 whitespace-pre-wrap break-all font-mono leading-snug max-h-48 overflow-auto bg-ink-bg-2 rounded-md p-2 border border-ink-border-soft">
                {doc.content.trim() !== '' ? (
                  doc.content
                ) : (
                  <span className="italic text-ink-fg-3">{t('settings.standingDocs.empty')}</span>
                )}
              </pre>
              {doc.editable && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleEdit}
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-aux text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
                  >
                    <Pencil className="size-3.5" />
                    {t('settings.standingDocs.edit')}
                  </button>
                  <button
                    onClick={() => void handleToggleHistory()}
                    className="flex items-center gap-1.5 px-2 py-1 rounded text-aux text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
                  >
                    <History className="size-3.5" />
                    {t('settings.standingDocs.history')}
                  </button>
                </div>
              )}
            </>
          )}

          {/* Per-doc version history */}
          {showHistory && !editing && (
            <div className="rounded-md border border-ink-border-soft overflow-hidden">
              {loadingHistory ? (
                <div className="flex items-center gap-2 px-3 py-2 text-meta text-ink-fg-2">
                  <Loader2 className="size-3 animate-spin" />
                  {t('settings.standingDocs.loading')}
                </div>
              ) : history.length === 0 ? (
                <div className="px-3 py-2 text-meta text-ink-fg-3 italic">
                  {t('settings.standingDocs.emptyHistory')}
                </div>
              ) : (
                <div className="divide-y divide-ink-border-soft">
                  {history.map((entry) => {
                    // createdAt is a Unix timestamp in seconds (Python time.time()).
                    const d = new Date(entry.createdAt * 1000)
                    const dateLabel = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    const isThisRollingBack = rollingBack === entry.newHash
                    return (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between gap-3 px-3 py-1.5"
                      >
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-meta text-ink-fg-2">{dateLabel}</span>
                          <span className="text-micro text-ink-fg-3 font-mono truncate">
                            {t('settings.standingDocs.updatedBy')}: {entry.changedBy}
                          </span>
                        </div>
                        <button
                          onClick={() => void handleRollback(entry.newHash)}
                          disabled={rollingBack !== null}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-meta text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast disabled:opacity-50 shrink-0"
                        >
                          {isThisRollingBack ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3" />
                          )}
                          {isThisRollingBack
                            ? t('settings.standingDocs.rollingBack')
                            : t('settings.standingDocs.rollback')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Exported so the AI 邮件预处理 config drawer (AgentsTab) can inline-mount the
// same identity-doc editor — "同组件不同入口" (zero props, self-gating on the
// standingDocsEditorEnabled flag; renders null when off).
export function StandingDocsSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  // All hooks unconditional — flag check is data, not a conditional hook.
  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'standingDocsEditorEnabled'],
    queryFn: fetchStandingDocsEditorEnabled,
    staleTime: 30_000,
    retry: false
  })

  const { data: docs, isError } = useQuery<AgentProfileDoc[]>({
    queryKey: ['standingDocs', 'list'],
    queryFn: () => api.chat.listProfileDocs(),
    enabled: enabled === true,
    staleTime: 10_000
  })

  // flag-off (false / undefined) → byte-level no-render (DOM has no section).
  if (!enabled) return null

  const content: React.ReactNode = (() => {
    if (isError) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          {t('settings.standingDocs.loadError')}
        </div>
      )
    }
    if (!docs) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          {t('settings.standingDocs.loading')}
        </div>
      )
    }
    // Show all editable docs (SOUL/AGENT/RULES/USER + memory.md); skip the SKILLS projection.
    // memory.md (task 07-01) is editable=true from the backend → appears here with its own
    // auto-maintained + budget affordances (DocEntry branches on docName==='memory').
    const editable = docs.filter((d) => d.editable)
    if (editable.length === 0) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          {t('settings.standingDocs.loadError')}
        </div>
      )
    }
    return editable.map((doc) => (
      <DocEntry
        key={doc.docName}
        doc={doc}
        onRefetch={() => qc.invalidateQueries({ queryKey: ['standingDocs', 'list'] })}
      />
    ))
  })()

  return (
    <Section title={t('settings.standingDocs.title')} helper={t('settings.standingDocs.desc')}>
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
      <UserMdCompileSection />
      <MemoryCaptureModelSection />
      <StandingDocsSection />
    </>
  )
}
