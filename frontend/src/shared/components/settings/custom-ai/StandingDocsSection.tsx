// StandingDocsSection — Settings 身份文档编辑器
//
// 列出 4 个 Standing Context 文档（SOUL/AGENT/RULES/USER）。每个文档可折叠：
//   - 展开时显示当前全文 + 编辑按钮 + 版本历史/rollback 触发入口
//   - 编辑态：textarea + 保存 + 取消
//   - SOUL/AGENT/RULES 高危红样式 + floor 提示
//   - 保存失败（如 RULES 越权）→ toastError + 保持 textarea 内容（用户可修正）
//   - flag MAILAGENT_STANDING_DOCS_EDITOR 默认 ON；flag-off → return null（DOM 无此区块）

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
import { toastError, toastSuccess } from '@shared/state/toast'
import type { AgentProfileDoc, AgentProfileHistoryEntry } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'

import { Section } from '../parts/Section'
import { fetchStandingDocsEditorEnabled } from './shared'

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
