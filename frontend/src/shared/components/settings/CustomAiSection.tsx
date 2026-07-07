// P3 (task 06-18-custom-ai-harness-agent Phase 3) — Settings "Custom AI" section.
//
// Sub-sections rendered inside the AI tab:
//   1. Skills toggle list  — react-query fetches the RESOLVED SkillSummary[] from the
//      backend (GET /api/agent/skills: manifest ⋈ agent_config.db enable overrides).
//      Toggling calls api.chat.setSkillEnabled (POST /api/agent/skills/{name}/enabled);
//      the gateway re-reads /chat/config on a 15s TTL so the next chat turn sees the
//      updated tool catalog. A one-time mount effect migrates any leftover localStorage overrides
//      to the backend (PR5 — enablement SSoT moved off per-surface localStorage).
//
// i18n keys are all called via t() — the parent i18n JSON defines them.
// No new dependencies. No `any`. Matches AiTab Section/Row patterns exactly.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  Globe,
  History,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  Package,
  Pencil,
  RotateCcw,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  UserCog,
  X
} from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useEnabledModels, FALLBACK_MODELS } from '@shared/hooks/useLlmModels'
import { useOpennessFlags, useCustomAgentsEnabled } from '@shared/components/agents/hooks'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { readSkillOverrides, writeSkillOverrides } from '@shared/lib/skill_overrides'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  AgentProfileDoc,
  AgentProfileHistoryEntry,
  CompileUserMdResult,
  MailApi,
  SkillPackPreview,
  SkillSecretMeta,
  SkillSummary
} from '@shared/api/types'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

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
      // S3 — the gateway re-reads /chat/config on a 15s TTL, so the toggle reaches the
      // tool catalog without any client-side engine invalidation; just refetch the list.
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

// ---------------------------------------------------------------------------
// S2 W1 — 自动化策略 (exec whitelist rules) subsection
// ---------------------------------------------------------------------------

/** Fetch execPolicyEnabled from serve-api /chat/config. Returns false (hide) when not configured
 *  or unreachable — this flag is default-OFF (unlike standingDocs), so absence means "not enabled". */
async function fetchExecPolicyEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { execPolicyEnabled?: unknown } }
    return body?.data?.execPolicyEnabled === true
  } catch {
    return false
  }
}

/** Human-readable one-line summary of a structured matcher (read-only display; the model can't
 *  create rules, and narrowing = delete + recreate — so no editable form here). */
function formatMatcher(capability: string, matcher: Record<string, unknown>): string {
  if (capability === 'exec') {
    const argv0 = typeof matcher.argv0_realpath === 'string' ? matcher.argv0_realpath : '?'
    const tmpl = Array.isArray(matcher.argv_template) ? matcher.argv_template : []
    const args = tmpl
      .map((it) => {
        const o = it as { pin?: unknown; any?: unknown }
        return o?.any === true ? '<任意>' : typeof o?.pin === 'string' ? o.pin : '?'
      })
      .join(' ')
    const cwd = typeof matcher.cwd_scope === 'string' ? `（目录 ${matcher.cwd_scope}）` : ''
    return `${argv0}${args ? ' ' + args : ''}${cwd}`
  }
  if (capability === 'file_read' || capability === 'file_write') {
    return typeof matcher.realpath_prefix === 'string' ? matcher.realpath_prefix : '?'
  }
  if (capability === 'web') {
    return typeof matcher.origin === 'string' ? matcher.origin : '?'
  }
  return JSON.stringify(matcher)
}

const CAPABILITY_LABELS: Record<string, string> = {
  exec: '运行命令',
  file_read: '读文件',
  file_write: '写文件',
  web: '联网'
}

/** The 自动化策略 management page: list / enable-disable / delete the exec whitelist rules the owner
 *  created via the approval card's "总是允许". Self-gates on execPolicyEnabled (default OFF → null). */
export function ExecPolicySection(): React.ReactElement | null {
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'execPolicyEnabled'],
    queryFn: fetchExecPolicyEnabled,
    staleTime: 30_000,
    retry: false
  })

  const { data: rules, isError } = useQuery<import('@shared/api/types').ExecPolicyRule[]>({
    queryKey: ['execPolicy', 'rules'],
    queryFn: () => api.chat.listPolicyRules(),
    enabled: enabled === true,
    staleTime: 10_000
  })

  // flag-off (false / undefined) → byte-level no-render (DOM has no section).
  if (!enabled) return null

  const refetch = (): void => {
    void qc.invalidateQueries({ queryKey: ['execPolicy', 'rules'] })
  }

  const onToggle = async (id: number, next: boolean): Promise<void> => {
    try {
      await api.chat.setPolicyRuleEnabled(id, next)
      refetch()
    } catch (err) {
      toastError('自动化策略', (err as Error).message)
    }
  }
  const onDelete = async (id: number): Promise<void> => {
    try {
      await api.chat.deletePolicyRule(id)
      toastSuccess('已删除该策略')
      refetch()
    } catch (err) {
      toastError('自动化策略', (err as Error).message)
    }
  }

  const content: React.ReactNode = (() => {
    if (isError) {
      return <div className="px-4 py-3.5 text-aux text-ink-fg-3">加载策略失败。</div>
    }
    if (!rules) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          加载中…
        </div>
      )
    }
    if (rules.length === 0) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          还没有自动化策略。在助手请求运行命令 /
          读写文件时，勾选「总是允许」即可为该精确操作创建一条白名单，命中后免审批直接执行。
        </div>
      )
    }
    return (
      <div className="divide-y divide-ink-border-soft">
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-ink-3 px-1.5 py-0.5 text-aux text-ink-fg-2">
                  {CAPABILITY_LABELS[rule.capability] ?? rule.capability}
                </span>
                {rule.dangerous && (
                  <span className="inline-flex items-center gap-1 rounded bg-fail/15 px-1.5 py-0.5 text-aux font-medium text-fail">
                    <AlertTriangle size={12} strokeWidth={2.5} />
                    高危 · 非沙箱
                  </span>
                )}
              </div>
              <div className="mt-1 break-all font-mono text-meta text-ink-fg">
                {formatMatcher(rule.capability, rule.matcher)}
              </div>
              <div className="mt-0.5 text-aux text-ink-fg-3">
                {`命中 ${rule.useCount} 次`}
                {rule.lastUsedAt ? ` · 最近 ${rule.lastUsedAt}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                checked={rule.enabled}
                onCheckedChange={(v: boolean) => void onToggle(rule.id, v)}
                aria-label="启用/停用该策略"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete(rule.id)}
                aria-label="删除该策略"
              >
                <X size={13} strokeWidth={2.5} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    )
  })()

  return (
    <Section
      title="自动化策略"
      helper="助手运行命令 / 读写文件默认每次都需你审批。这里是你经「总是允许」为精确操作建立的白名单：命中的操作免审批直接执行，其余仍每次询问。放宽某条规则请删除后重新创建（不支持原地编辑，避免悄悄变宽）。"
    >
      {content}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// S2 W4b — Skill 安装（skill pack supply chain）subsection
// ---------------------------------------------------------------------------
//
// Two-phase install UI over the W2 Python endpoints: fetch → server-rendered
// preview (quarantine facts) → owner confirm (echoes packageHash + files; the
// backend re-hashes and 409s on TOCTOU). Per-pack management: write-only
// secrets (W3) + plaintext config.json + full-cleanup uninstall. Self-gates on
// /chat/config.skillInstallEnabled (MAILAGENT_OPENNESS_SKILL_INSTALL, default
// OFF) — flag-off renders nothing and the builtin SkillsSection is unchanged.

/** Fetch skillInstallEnabled from serve-api /chat/config. Returns false (hide) when not
 *  configured or unreachable — default-OFF flag (same posture as fetchExecPolicyEnabled). */
async function fetchSkillInstallEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { skillInstallEnabled?: unknown } }
    return body?.data?.skillInstallEnabled === true
  } catch {
    return false
  }
}

/** Supply-chain confirm only ever writes these source types (URL/zip → 'skill_pack',
 *  local dir import → 'local_folder'); builtin / document / mcp rows are NOT packs. */
const PACK_SOURCE_TYPES = new Set(['skill_pack', 'local_folder'])

const PACK_SOURCE_LABELS: Record<string, string> = {
  skill_pack: 'skill 包',
  local_folder: '本地目录'
}

/** Structured ApiError → user-facing one-liner（code + message + hint）。 */
function apiErrText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; hint?: unknown }
  const code = typeof e?.code === 'string' ? e.code : null
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  const base = code ? `${code}: ${msg}` : msg
  return typeof e?.hint === 'string' && e.hint ? `${base}（${e.hint}）` : base
}

/** confirm 的 TOCTOU 拒绝（quarantine 内容在预览后被改动）→ 专用明示文案而非裸 toast。 */
function isHashMismatch(err: unknown): boolean {
  const e = err as { code?: unknown; httpStatus?: unknown }
  return e?.code === 'E_PACK_HASH_MISMATCH' || e?.httpStatus === 409
}

function formatIsoShort(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** 安装对话框：输入步（URL / 本地路径二选一）→ 预览步（服务端事实渲染）→ 确认安装。 */
function SkillInstallDialog({
  open,
  onOpenChange,
  onInstalled
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled: () => void
}): React.ReactElement {
  const api = useMailApi()

  const [source, setSource] = React.useState<'url' | 'local'>('url')
  const [inputValue, setInputValue] = React.useState('')
  const [fetching, setFetching] = React.useState(false)
  const [preview, setPreview] = React.useState<SkillPackPreview | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [staleError, setStaleError] = React.useState(false)

  function reset(): void {
    setSource('url')
    setInputValue('')
    setFetching(false)
    setPreview(null)
    setConfirming(false)
    setStaleError(false)
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleFetch(): Promise<void> {
    const value = inputValue.trim()
    if (!value) return
    setFetching(true)
    setStaleError(false)
    try {
      const p = await api.chat.fetchSkillPack(
        source === 'url' ? { sourceUrl: value } : { localPath: value }
      )
      setPreview(p)
    } catch (err) {
      toastError('获取预览失败', apiErrText(err))
    } finally {
      setFetching(false)
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!preview) return
    setConfirming(true)
    try {
      // 透传 preview 的 packageHash + files（owner 批准的事实）；后端重算 hash 比对，
      // 预览后被改动 → 409 E_PACK_HASH_MISMATCH（下面明示并要求重新 fetch）。
      const result = await api.chat.confirmSkillPack({
        quarantineId: preview.quarantineId,
        expectedPackageHash: preview.packageHash,
        expectedFiles: preview.files
      })
      toastSuccess(
        `已安装 ${result.name}`,
        preview.secretNames.length > 0
          ? `该 skill 声明了 ${preview.secretNames.length} 个密钥（${preview.secretNames.join('、')}），请在其「配置」里设置。`
          : undefined
      )
      onInstalled()
      handleOpenChange(false)
    } catch (err) {
      if (isHashMismatch(err)) {
        // TOCTOU：quarantine 在预览→确认之间被改动。丢弃旧预览，要求重新 fetch。
        setStaleError(true)
        setPreview(null)
      } else {
        toastError('安装失败', apiErrText(err))
      }
    } finally {
      setConfirming(false)
    }
  }

  const fileEntries = preview ? Object.entries(preview.files) : []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>安装 Skill</DialogTitle>
          <DialogDescription>
            两段式安装：先获取包预览，人工审阅文件清单、密钥声明与 SKILL.md
            节选，确认无误后再安装。第三方内容未经验签，请谨慎审阅。
          </DialogDescription>
        </DialogHeader>

        {staleError && (
          <div className="rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-aux text-fail">
            包内容在预览后被改动，已拒绝安装。请重新获取预览并再次审阅。
          </div>
        )}

        {!preview ? (
          <div className="space-y-3">
            <div className="flex items-center gap-1 rounded-md border border-ink-border-soft p-0.5 w-fit">
              {(
                [
                  ['url', 'URL'],
                  ['local', '本地路径']
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSource(key)}
                  className={[
                    'px-2.5 py-1 rounded text-aux transition-colors duration-fast',
                    source === key
                      ? 'bg-ink-3 text-ink-fg font-medium'
                      : 'text-ink-fg-2 hover:text-ink-fg'
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                source === 'url'
                  ? 'https://example.com/skill.zip'
                  : '/path/to/skill.zip 或 skill 目录'
              }
              spellCheck={false}
            />
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleFetch()}
                disabled={fetching || inputValue.trim() === ''}
              >
                {fetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {fetching ? '获取中…' : '获取预览'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-ink-border-soft divide-y divide-ink-border-soft text-aux">
              <div className="px-3 py-2 flex items-center gap-2">
                <Package className="size-3.5 shrink-0 text-ink-fg-2" />
                <span className="font-medium text-ink-fg">
                  {preview.manifest.title ?? preview.manifest.name ?? '（未命名）'}
                </span>
                <span className="font-mono text-micro text-ink-fg-3">
                  {preview.manifest.name}
                  {preview.manifest.version ? ` · v${preview.manifest.version}` : ''}
                  {preview.manifest.type ? ` · ${preview.manifest.type}` : ''}
                </span>
              </div>
              {preview.manifest.description ? (
                <div className="px-3 py-2 text-ink-fg-2">{preview.manifest.description}</div>
              ) : null}
              <div className="px-3 py-2 space-y-1 text-aux">
                <div className="text-ink-fg-3">
                  来源：
                  <span className="font-mono break-all text-ink-fg-2">
                    {preview.sourceUri ?? '—'}
                  </span>
                </div>
                <div className="text-ink-fg-3">
                  包 hash：
                  <span className="font-mono break-all text-ink-fg-2" title={preview.packageHash}>
                    {preview.packageHash}
                  </span>
                </div>
                {preview.manifest.entryHint ? (
                  <div className="text-ink-fg-3">
                    入口提示：
                    <span className="font-mono text-ink-fg-2">{preview.manifest.entryHint}</span>
                  </div>
                ) : null}
              </div>
              <div className="px-3 py-2">
                <div className="text-aux text-ink-fg-3 mb-1">文件（{fileEntries.length} 个）</div>
                <div className="max-h-28 overflow-auto rounded bg-ink-bg-2 p-1.5 font-mono text-micro text-ink-fg-2 space-y-0.5">
                  {fileEntries.map(([path, sha]) => (
                    <div key={path} className="flex justify-between gap-3">
                      <span className="break-all">{path}</span>
                      <span className="text-ink-fg-3 shrink-0" title={sha}>
                        {sha.slice(0, 12)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-3 py-2">
                <div className="text-aux text-ink-fg-3 mb-1">声明密钥</div>
                {preview.secretNames.length === 0 ? (
                  <span className="text-aux text-ink-fg-3 italic">无</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {preview.secretNames.map((n) => (
                      <span
                        key={n}
                        className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 font-mono text-micro text-ink-fg-2"
                      >
                        <KeyRound className="size-2.5" />
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-3 py-2">
                <div className="text-aux text-ink-fg-3 mb-1">SKILL.md 节选（原文，未渲染）</div>
                {/* 第三方 untrusted 文本：纯文本 <pre> 展示，绝不渲染 markdown/HTML。
                    节选可能含 CJK → text-aux（no-cjk-in-mono-size 铁律）。 */}
                <pre className="max-h-40 overflow-auto rounded bg-ink-bg-2 p-2 font-mono text-aux text-ink-fg-2 whitespace-pre-wrap break-all leading-snug">
                  {preview.skillMdExcerpt.trim() !== '' ? (
                    preview.skillMdExcerpt
                  ) : (
                    <span className="italic text-ink-fg-3">（空）</span>
                  )}
                </pre>
              </div>
            </div>
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPreview(null)}
                disabled={confirming}
              >
                返回
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleConfirm()}
                disabled={confirming}
              >
                {confirming ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {confirming ? '安装中…' : '确认安装'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** config.json 简单 JSON 文本编辑器（挂载时以 initial 一次性初始化，免同步 effect）。 */
function SkillConfigEditor({
  name,
  initial,
  onSaved
}: {
  name: string
  initial: string
  onSaved: () => void
}): React.ReactElement {
  const api = useMailApi()
  const [draft, setDraft] = React.useState(initial)
  const [jsonError, setJsonError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  async function handleSave(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (err) {
      setJsonError(`JSON 解析失败：${(err as Error).message}`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setJsonError('必须是 JSON 对象（{ … }）')
      return
    }
    setJsonError(null)
    setSaving(true)
    try {
      await api.chat.putSkillConfig(name, parsed as Record<string, unknown>)
      toastSuccess('已保存配置')
      onSaved()
    } catch (err) {
      toastError('保存配置失败', apiErrText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        spellCheck={false}
        className={[
          'w-full resize-y rounded-md border bg-ink-2 px-3 py-2',
          'font-mono text-aux text-ink-fg placeholder:text-ink-fg-3',
          'transition-colors duration-fast',
          'focus:outline-none focus:ring-2 focus:ring-coral/70 focus:border-coral/60',
          jsonError ? 'border-fail/50' : 'border-ink-border'
        ].join(' ')}
      />
      {jsonError && <div className="text-aux text-fail">{jsonError}</div>}
      <Button size="sm" variant="outline" onClick={() => void handleSave()} disabled={saving}>
        {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        {saving ? '保存中…' : '保存配置'}
      </Button>
    </div>
  )
}

/** 单条已存密钥行：名 + 更新时间 + write-only 替换输入（PUT 后清空，永不回显值）+ 删除。 */
function SkillSecretRow({
  skillName,
  secret,
  onChanged
}: {
  skillName: string
  secret: SkillSecretMeta
  onChanged: () => void
}): React.ReactElement {
  const api = useMailApi()
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function handleReplace(): Promise<void> {
    if (value === '') return
    setBusy(true)
    try {
      await api.chat.putSkillSecret(skillName, secret.name, value)
      setValue('') // write-only：保存即清空输入，永不回显
      toastSuccess(`已更新密钥 ${secret.name}`)
      onChanged()
    } catch (err) {
      toastError('更新密钥失败', apiErrText(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy(true)
    try {
      await api.chat.deleteSkillSecret(skillName, secret.name)
      toastSuccess(`已删除密钥 ${secret.name}`)
      onChanged()
    } catch (err) {
      toastError('删除密钥失败', apiErrText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-micro text-ink-fg break-all">{secret.name}</div>
        <div className="text-aux text-ink-fg-3">已设置 {formatIsoShort(secret.updatedAt)}</div>
      </div>
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="输入新值以替换"
        autoComplete="new-password"
        spellCheck={false}
        className="h-7 w-40 text-aux"
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleReplace()}
        disabled={busy || value === ''}
      >
        保存
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleDelete()}
        disabled={busy}
        aria-label={`删除密钥 ${secret.name}`}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

/** 一个已安装 pack 行：标题 + 来源 badge + 「配置」抽屉（密钥 write-only + config.json）+ 卸载确认。 */
function PackRow({
  skill,
  onChanged
}: {
  skill: SkillSummary
  onChanged: () => void
}): React.ReactElement {
  const api = useMailApi()
  const qc = useQueryClient()

  const [panel, setPanel] = React.useState<'none' | 'config' | 'uninstall'>('none')
  const [newName, setNewName] = React.useState('')
  const [newValue, setNewValue] = React.useState('')
  const [addingSecret, setAddingSecret] = React.useState(false)
  const [uninstalling, setUninstalling] = React.useState(false)

  // 配置抽屉与卸载确认共用：已存密钥 meta（只名 + 时间，永无值）。
  const { data: secrets } = useQuery<SkillSecretMeta[]>({
    queryKey: ['skillSecrets', skill.name],
    queryFn: () => api.chat.listSkillSecretMeta(skill.name),
    enabled: panel !== 'none'
  })

  const { data: config, isLoading: configLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['skillConfig', skill.name],
    queryFn: () => api.chat.getSkillConfig(skill.name),
    enabled: panel === 'config',
    retry: false
  })

  const refetchSecrets = (): void => {
    void qc.invalidateQueries({ queryKey: ['skillSecrets', skill.name] })
  }

  async function handleAddSecret(): Promise<void> {
    const name = newName.trim()
    if (name === '' || newValue === '') return
    setAddingSecret(true)
    try {
      // secret 名合法性（env-regex + reserved deny）由后端校验；非法名 → E_INVALID_ARG toast。
      await api.chat.putSkillSecret(skill.name, name, newValue)
      setNewName('')
      setNewValue('') // write-only：保存即清空
      toastSuccess(`已设置密钥 ${name}`)
      refetchSecrets()
    } catch (err) {
      toastError('设置密钥失败', apiErrText(err))
    } finally {
      setAddingSecret(false)
    }
  }

  async function handleUninstall(): Promise<void> {
    setUninstalling(true)
    try {
      // 全清端点（行 + 目录 + 密钥），绝不走旧 DELETE /agent/skills/{name}。
      await api.chat.uninstallSkillPack(skill.name)
      toastSuccess(`已卸载 ${skill.name}`)
      onChanged()
    } catch (err) {
      toastError('卸载失败', apiErrText(err))
    } finally {
      setUninstalling(false)
    }
  }

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Package className="size-3.5 shrink-0 text-ink-fg-2" />
        <div className="min-w-0 flex-1">
          <span className="text-aux font-medium text-ink-fg">{skill.title}</span>
          <span className="ml-2 font-mono text-micro text-ink-fg-3">{skill.name}</span>
        </div>
        <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-2 shrink-0">
          {PACK_SOURCE_LABELS[skill.sourceType] ?? skill.sourceType}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === 'config' ? 'none' : 'config')}
          aria-label={`配置 ${skill.name}`}
        >
          <Settings2 className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === 'uninstall' ? 'none' : 'uninstall')}
          aria-label={`卸载 ${skill.name}`}
        >
          <Trash2 className="size-3.5 text-fail" />
        </Button>
      </div>

      {panel === 'uninstall' && (
        <div className="rounded-md border border-fail/30 bg-fail/10 px-3 py-2 space-y-2">
          <div className="text-aux text-fail">
            将删除该 skill 的落盘目录、注册行，并清除其全部已存密钥。此操作不可撤销。
          </div>
          <div className="text-aux text-ink-fg-2">
            {secrets == null ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" />
                正在载入密钥清单…
              </span>
            ) : secrets.length === 0 ? (
              '（无已存密钥）'
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                将删除密钥：
                {secrets.map((s) => (
                  <span
                    key={s.name}
                    className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 font-mono text-micro text-ink-fg-2"
                  >
                    <KeyRound className="size-2.5" />
                    {s.name}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-fail/50 text-fail hover:bg-fail/10"
              onClick={() => void handleUninstall()}
              disabled={uninstalling}
            >
              {uninstalling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {uninstalling ? '卸载中…' : '确认卸载'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanel('none')}
              disabled={uninstalling}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {panel === 'config' && (
        <div className="rounded-md border border-ink-border-soft px-3 py-2 space-y-3">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-aux text-ink-fg">
              <KeyRound className="size-3.5 text-ink-fg-2" />
              密钥
            </div>
            <div className="text-aux text-ink-fg-3">
              密钥只写不读：保存后不回显值，仅显示名称与更新时间。值加密存储，脚本执行时注入环境变量。
            </div>
            {secrets == null ? (
              <div className="flex items-center gap-2 text-aux text-ink-fg-2">
                <Loader2 className="size-3 animate-spin" />
                加载中…
              </div>
            ) : secrets.length === 0 ? (
              <div className="text-aux text-ink-fg-3 italic">尚无已存密钥。</div>
            ) : (
              <div className="space-y-2">
                {secrets.map((s) => (
                  <SkillSecretRow
                    key={s.name}
                    skillName={skill.name}
                    secret={s}
                    onChanged={refetchSecrets}
                  />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="密钥名（如 MY_API_KEY）"
                spellCheck={false}
                className="h-7 w-44 font-mono text-aux"
              />
              <Input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="值"
                autoComplete="new-password"
                spellCheck={false}
                className="h-7 flex-1 text-aux"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleAddSecret()}
                disabled={addingSecret || newName.trim() === '' || newValue === ''}
              >
                {addingSecret ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                添加
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-aux text-ink-fg">config.json（非敏感配置，明文，与脚本共读）</div>
            {configLoading || config == null ? (
              <div className="flex items-center gap-2 text-aux text-ink-fg-2">
                <Loader2 className="size-3 animate-spin" />
                加载中…
              </div>
            ) : (
              <SkillConfigEditor
                name={skill.name}
                initial={JSON.stringify(config, null, 2)}
                onSaved={() => void qc.invalidateQueries({ queryKey: ['skillConfig', skill.name] })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Skill 安装（supply chain）管理区。self-gates on skillInstallEnabled（default OFF → null，
 *  字节级不渲染；builtin SkillsSection 在 flag off 时行为零变化）。 */
export function SkillPacksSection(): React.ReactElement | null {
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'skillInstallEnabled'],
    queryFn: fetchSkillInstallEnabled,
    staleTime: 30_000,
    retry: false
  })

  // 与 SkillsSection 共享 ['skills'] 缓存（同一 resolved 列表），此处只筛 pack 安装行。
  const { data: skills } = useQuery<SkillSummary[]>({
    queryKey: ['skills'],
    queryFn: () => api.chat.listSkills(),
    enabled: enabled === true
  })

  const [installOpen, setInstallOpen] = React.useState(false)

  // flag-off (false / undefined) → byte-level no-render (DOM has no section).
  if (!enabled) return null

  const packs = (skills ?? []).filter((s) => PACK_SOURCE_TYPES.has(s.sourceType))

  const onChanged = (): void => {
    void qc.invalidateQueries({ queryKey: ['skills'] })
  }

  return (
    <Section
      title="Skill 安装"
      helper="从 URL 或本地路径安装第三方 skill 包。两段式：先获取预览、人工审阅包内容与声明，再确认安装。已安装的 skill 会出现在上方技能列表（启用/停用），密钥与配置在下方逐项管理。"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-aux text-ink-fg-2">
          {packs.length === 0 ? '还没有安装的 skill 包。' : `已安装 ${packs.length} 个 skill 包。`}
        </span>
        <Button size="sm" variant="outline" onClick={() => setInstallOpen(true)}>
          <Download className="mr-1.5 size-3.5" />
          安装 skill
        </Button>
      </div>
      {packs.map((skill) => (
        <PackRow key={skill.name} skill={skill} onChanged={onChanged} />
      ))}
      <SkillInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={onChanged}
      />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// SystemCapabilitiesSection — R4 (task 07-05) 内置系统能力只读区
// ---------------------------------------------------------------------------
//
// 技能面板此前只列 skill 对象（email/search/report + 已装 pack），看不到 S1/S2/S5 的
// 开放性能力族。这些能力由 main-env-only flag 驱动，此区把它们呈现为三类：
//   A. 只读锁定族（无独立管理面 + flag 运行时不可切）→ 只读能力卡：锁定态 pill +
//      「视觉 on / disabled」Switch，绝无 onCheckedChange。flag === true 才渲染：
//        · 会话检索 chat_session_*                 (sessionToolsEnabled)
//        · Agent 自配置 agent_profile_*/agent_memory_update (configToolsEnabled)
//   A'. 联网（web_fetch + web_search）→ **可写例外**（task 07-07 R4）：真开关写
//      MAILAGENT_OPENNESS_WEB_TOOLS（restart-required，gateway 启动读一次）+ 恒渲染
//      （OFF 也在，好再开）；开关 ON 时卡下联动显示 Tavily key（EnvField，写 .env 受管密钥）。
//      开关 checked 反映 .env 意图值（读 useEnvStore，非 gateway 运行态 —— restart 前 gateway
//      未变但 .env 已变）。见 WebCapabilityRow。
//   B. 已有管理面三族 → 交叉引用行（跳到对应管理面，不造新卡）：
//        · 命令执行/文件读写 → 同页 ExecPolicySection  (execToolsEnabled)
//        · 技能包管理        → 同页 SkillPacksSection  (skillInstallEnabled)
//        · 自定义 Agent      → /agents 路由            (customAgentsEnabled)
//
// 红线：除「联网」卡（A'，写 MAILAGENT_OPENNESS_WEB_TOOLS + Tavily key）外纯只读展示、零后端
// 写调用；不动 skill_gating 的 GATEWAY_SKILL_TOOLS/CORE_UNGATED；不往 resolved_skills()/
// build_manifest()/skill registry 塞假 skill 行。

// 同页交叉引用滚动锚点（CustomAiSection 里 SkillPacksSection / ExecPolicySection 各裹一个 id div）。
const SYSTEM_CAP_SCROLL_TARGETS = {
  exec: 'settings-exec-policy',
  skillPacks: 'settings-skill-packs'
} as const

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 锁定态卡右侧控件：不可关的 pill + 视觉 on / disabled 的 Switch（无任何 onCheckedChange —
 *  它是「有意锁定」而非「坏掉的开关」，disabled 阻断交互、pill + tooltip 说明由环境变量控制）。 */
function LockedCapabilityControl(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1 rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro text-ink-fg-2"
        title={t('settings.systemCapabilities.lockedTip')}
      >
        <Lock className="size-2.5" />
        {t('settings.systemCapabilities.lockedBadge')}
      </span>
      <Switch checked disabled aria-label={t('settings.systemCapabilities.lockedBadge')} />
    </div>
  )
}

/** 「联网」能力卡（task 07-07 R4）—— A' 可写例外。真开关写 MAILAGENT_OPENNESS_WEB_TOOLS
 *  （restart-required）+ 恒渲染 + ON 时联动 Tavily key。
 *
 *  开关 checked 反映 **.env 意图值**（读 useEnvStore snapshot，非 /chat/config 的 gateway
 *  运行态）——flag 是 gateway 启动 envBool 读一次的 restart-required 值，翻它后 .env 立即变但
 *  gateway 未变；开关跟随 .env 意图 + markRestartRequired 拉起全局重启横幅即可。envBool 语义镜像
 *  （ai_gateway_lifecycle.ts:86）：未设（'') → 默认 true（E3 cutover）；否则 lowercased ∈ {1,true}。 */
export function WebCapabilityRow(): React.ReactElement {
  const { t } = useTranslation()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const envState = useEnvStore((s) => s.state)
  const [submitting, setSubmitting] = React.useState(false)

  // 远程 web（HttpApi）只读：env:set 是 notImplemented → 开关禁用（镜像 EnvField 的 isWeb 探针）。
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  const ready = envState.status === 'ready'
  const raw = ready ? (envState.snapshot.values['MAILAGENT_OPENNESS_WEB_TOOLS'] ?? '') : ''
  // envBool 镜像：未设 → 默认 ON；显式值 lowercased ∈ {1,true} → ON。未 ready → 乐观按默认 ON
  // 展示但禁用交互（避免 env store 未加载时误写）。
  const checked = ready ? raw === '' || ['1', 'true'].includes(raw.trim().toLowerCase()) : true

  async function onToggle(next: boolean): Promise<void> {
    setSubmitting(true)
    try {
      const result = await applyEnvPatch({ MAILAGENT_OPENNESS_WEB_TOOLS: next ? 'true' : 'false' })
      if (result.ok) {
        // restart-required：gateway 启动读一次 → 拉起全局重启横幅（同 EnvField.persist）。
        if (result.changedKeys.length > 0) markRestartRequired(result.changedKeys)
        toastSuccess(t('settings.systemCapabilities.web.title'))
      } else {
        toastError(
          t('settings.systemCapabilities.web.title'),
          `${result.error.code}: ${result.error.message}`
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Row
        label={
          <span className="flex items-center gap-2">
            <Globe className="size-3.5 shrink-0 text-ink-fg-2" />
            {t('settings.systemCapabilities.web.title')}
          </span>
        }
        helper={
          <span className="flex flex-col gap-0.5">
            <span>{t('settings.systemCapabilities.web.desc')}</span>
            <span className="text-ink-fg-3">
              {t('settings.systemCapabilities.web.restartHint')}
            </span>
            <span className="mt-0.5">
              <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
                {t('settings.skills.toolCount', { n: 2 })}
              </span>
            </span>
          </span>
        }
      >
        <Switch
          checked={checked}
          disabled={!ready || isWeb || submitting}
          onCheckedChange={onToggle}
          aria-label={t('settings.systemCapabilities.web.switchLabel')}
        />
      </Row>
      {checked && (
        <EnvField
          envKey="TAVILY_API_KEY"
          control="password"
          label={t('settings.systemCapabilities.web.tavily.label')}
          helper={t('settings.systemCapabilities.web.tavily.helper')}
          placeholder={t('settings.systemCapabilities.web.tavily.placeholder')}
        />
      )}
    </>
  )
}

export function SystemCapabilitiesSection(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const flags = useOpennessFlags(true)
  const customAgentsEnabled = useCustomAgentsEnabled()

  // 技能包管理面可见性（与 SkillPacksSection 共享同一 query cache，去重）。
  const { data: skillInstallEnabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'skillInstallEnabled'],
    queryFn: fetchSkillInstallEnabled,
    staleTime: 30_000,
    retry: false
  })

  // A. 只读锁定族（session/config）：flag === true 才渲染锁定卡。联网（web）不在此列 —— 它是
  // A' 可写例外，由 WebCapabilityRow 恒渲染（见下）。
  const capabilityCards: Array<{
    key: string
    icon: React.ReactNode
    title: string
    desc: string
    toolCount: number
  }> = []
  if (flags.sessionToolsEnabled === true) {
    capabilityCards.push({
      key: 'session',
      icon: <MessageSquare className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.session.title'),
      desc: t('settings.systemCapabilities.session.desc'),
      toolCount: 3
    })
  }
  if (flags.configToolsEnabled === true) {
    capabilityCards.push({
      key: 'config',
      icon: <UserCog className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.config.title'),
      desc: t('settings.systemCapabilities.config.desc'),
      toolCount: 4
    })
  }

  // B. 已有管理面三族：交叉引用行（点击跳对应管理面）。
  const crossRefs: Array<{
    key: string
    icon: React.ReactNode
    title: string
    desc: string
    action: string
    onGo: () => void
  }> = []
  if (flags.execToolsEnabled === true) {
    crossRefs.push({
      key: 'exec',
      icon: <Terminal className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.exec.title'),
      desc: t('settings.systemCapabilities.crossRef.exec.desc'),
      action: t('settings.systemCapabilities.crossRef.exec.action'),
      onGo: () => scrollToSection(SYSTEM_CAP_SCROLL_TARGETS.exec)
    })
  }
  if (skillInstallEnabled === true) {
    crossRefs.push({
      key: 'skillPacks',
      icon: <Package className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.skillPacks.title'),
      desc: t('settings.systemCapabilities.crossRef.skillPacks.desc'),
      action: t('settings.systemCapabilities.crossRef.skillPacks.action'),
      onGo: () => scrollToSection(SYSTEM_CAP_SCROLL_TARGETS.skillPacks)
    })
  }
  if (customAgentsEnabled) {
    crossRefs.push({
      key: 'customAgents',
      icon: <Bot className="size-3.5 shrink-0 text-ink-fg-2" />,
      title: t('settings.systemCapabilities.crossRef.customAgents.title'),
      desc: t('settings.systemCapabilities.crossRef.customAgents.desc'),
      action: t('settings.systemCapabilities.crossRef.customAgents.action'),
      onGo: () => void navigate({ to: '/agents', search: { tab: 'agents' } })
    })
  }

  // 联网卡（A'）恒渲染 → 本区永远至少有一行，故不再 return null（web 卡 OFF 也要在，好再开）。

  // 只读锁定族（session/config）未全开 → 尾部一行提示「其余系统能力由环境变量控制」。联网已是
  // 真开关，不计入「由环境变量控制」的隐藏族。
  const showMoreNote = flags.sessionToolsEnabled !== true || flags.configToolsEnabled !== true

  return (
    <Section
      title={t('settings.systemCapabilities.title')}
      helper={t('settings.systemCapabilities.desc')}
    >
      {capabilityCards.map((cap) => (
        <Row
          key={cap.key}
          label={
            <span className="flex items-center gap-2">
              {cap.icon}
              {cap.title}
            </span>
          }
          helper={
            <span className="flex flex-col gap-0.5">
              <span>{cap.desc}</span>
              <span className="mt-0.5">
                <span className="inline-flex items-center rounded-full bg-ink-4 border border-ink-border px-1.5 py-0.5 text-micro font-mono text-ink-fg-2">
                  {t('settings.skills.toolCount', { n: cap.toolCount })}
                </span>
              </span>
            </span>
          }
        >
          <LockedCapabilityControl />
        </Row>
      ))}

      {/* A' 联网可写例外：恒渲染真开关（写 MAILAGENT_OPENNESS_WEB_TOOLS）+ ON 时联动 Tavily key。 */}
      <WebCapabilityRow />

      {crossRefs.map((ref) => (
        <Row
          key={ref.key}
          label={
            <span className="flex items-center gap-2">
              {ref.icon}
              {ref.title}
            </span>
          }
          helper={<span>{ref.desc}</span>}
        >
          <Button size="sm" variant="ghost" onClick={ref.onGo}>
            {ref.action}
            <ArrowUpRight className="ml-1 size-3.5" />
          </Button>
        </Row>
      ))}

      {showMoreNote && (
        <div className="px-4 py-2.5 text-aux text-ink-fg-3">
          {t('settings.systemCapabilities.moreNote')}
        </div>
      )}
    </Section>
  )
}

export function CustomAiSection(): React.ReactElement {
  return (
    <>
      <SkillsSection />
      <SystemCapabilitiesSection />
      <div id={SYSTEM_CAP_SCROLL_TARGETS.skillPacks}>
        <SkillPacksSection />
      </div>
      <UserMdCompileSection />
      <MemoryCaptureModelSection />
      <StandingDocsSection />
      <div id={SYSTEM_CAP_SCROLL_TARGETS.exec}>
        <ExecPolicySection />
      </div>
    </>
  )
}
