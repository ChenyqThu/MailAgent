import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  Briefcase,
  Check,
  FileText,
  LoaderCircle,
  Mail,
  Sparkles,
  Users,
  X
} from 'lucide-react'

import { BUILTIN_MATTER_TYPES, MATTER_PRIORITIES } from '@shared/api/types/matter'
import type {
  BuiltinMatterType,
  MatterCreateDraftResource,
  MatterCreateDraftStakeholder,
  MatterCreateInput,
  MatterDuplicateCandidate,
  MatterLinkScope,
  MatterPriority
} from '@shared/api/types/matter'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { stripEmailSubjectPrefix } from './matterResource'

const TYPE_UNSET = '__matter_type_unset__'
const TYPE_CUSTOM = '__matter_type_custom__'
type MatterTypeSelection = BuiltinMatterType | typeof TYPE_UNSET | typeof TYPE_CUSTOM
type ResearchState = 'idle' | 'loading' | 'success' | 'error'

const RESEARCH_TIMEOUT_MS = 20_000

export interface MatterCreateSource {
  internalId: number
  threadId: string | null
  subject: string
  sender: string
  receivedAt: number | string | null
  threadCount: number
}

interface MatterCreateDialogProps {
  open: boolean
  busy?: boolean
  source?: MatterCreateSource | null
  onClose(): void
  onCreate(input: MatterCreateInput): void
  onUseExisting?(
    candidate: MatterDuplicateCandidate,
    linkScope: MatterLinkScope
  ): void | Promise<void>
}

export function MatterCreateDialog({
  open,
  busy = false,
  source = null,
  onClose,
  onCreate,
  onUseExisting
}: MatterCreateDialogProps): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const [title, setTitle] = useState('')
  const [matterTypeSelection, setMatterTypeSelection] = useState<MatterTypeSelection>(TYPE_UNSET)
  const [customMatterType, setCustomMatterType] = useState('')
  const [priority, setPriority] = useState<MatterPriority>('p1')
  // v61：背景与目标是两个独立字段，创建面也照拆 —— 详情页能分开写、创建页只能合着写
  // 的话，第一版内容永远落在错误的那一列。
  const [background, setBackground] = useState('')
  const [goal, setGoal] = useState('')
  const [linkScope, setLinkScope] = useState<MatterLinkScope>(
    source?.threadId ? 'thread' : 'single'
  )
  const [duplicateCandidates, setDuplicateCandidates] = useState<MatterDuplicateCandidate[]>([])
  const [duplicatesLoading, setDuplicatesLoading] = useState(false)
  const [usingExistingId, setUsingExistingId] = useState<string | null>(null)
  const [researchState, setResearchState] = useState<ResearchState>('idle')
  const [researchStep, setResearchStep] = useState(0)
  const [researchError, setResearchError] = useState('')
  const [researchSummary, setResearchSummary] = useState<{
    threadEmailCount: number
    relatedEmailCount: number
    notionStatus: 'disabled' | 'searched' | 'failed'
    warningCount: number
  } | null>(null)
  const [suggestedResources, setSuggestedResources] = useState<MatterCreateDraftResource[]>([])
  const [suggestedStakeholders, setSuggestedStakeholders] = useState<
    MatterCreateDraftStakeholder[]
  >([])
  const researchAbortRef = useRef<AbortController | null>(null)
  const researchRequestRef = useRef(0)

  useEffect(() => {
    if (!open) {
      researchRequestRef.current += 1
      researchAbortRef.current?.abort()
      researchAbortRef.current = null
      return
    }
    setTitle(source ? stripEmailSubjectPrefix(source.subject) : '')
    setMatterTypeSelection(TYPE_UNSET)
    setCustomMatterType('')
    setPriority('p1')
    setBackground('')
    setGoal('')
    setLinkScope(source?.threadId ? 'thread' : 'single')
    setDuplicateCandidates([])
    setDuplicatesLoading(false)
    setUsingExistingId(null)
    setResearchState('idle')
    setResearchStep(0)
    setResearchError('')
    setResearchSummary(null)
    setSuggestedResources([])
    setSuggestedStakeholders([])
  }, [open, source])

  useEffect(() => {
    if (researchState !== 'loading') return
    const timers = [
      window.setTimeout(() => setResearchStep(1), 1_200),
      window.setTimeout(() => setResearchStep(2), 3_000)
    ]
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [researchState])

  useEffect(
    () => () => {
      researchAbortRef.current?.abort()
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const trimmedTitle = title.trim()
    if (trimmedTitle.length < 3 && source === null) {
      setDuplicateCandidates([])
      setDuplicatesLoading(false)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setDuplicatesLoading(true)
      const sourceResource = source
        ? {
            provider: 'mailagent',
            kind: source.threadId && linkScope === 'thread' ? 'thread' : 'email',
            external_key:
              source.threadId && linkScope === 'thread'
                ? `thread:${source.threadId}`
                : `email:${source.internalId}`
          }
        : null
      void api
        .duplicateCandidates({
          title: trimmedTitle,
          background,
          goal,
          resources: sourceResource ? [sourceResource] : undefined
        })
        .then((items) => {
          if (active) setDuplicateCandidates(items)
        })
        .catch(() => {
          // Duplicate lookup is advisory and must never block matter creation.
          if (active) setDuplicateCandidates([])
        })
        .finally(() => {
          if (active) setDuplicatesLoading(false)
        })
    }, 300)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, background, goal, linkScope, open, source, title])

  // G-32 —— 入场遮罩 fadeIn + 卡片 popIn，走仓库统一动效通道（reduced-motion 内置短路）。
  // 关闭期间表单字段不会被清（上面那个 effect 的 `!open` 分支只中止调研请求），退场动画
  // 期间内容不塌。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]'
  })

  if (!shouldRender) return null

  const submit = (): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    const matterType =
      matterTypeSelection === TYPE_UNSET
        ? null
        : matterTypeSelection === TYPE_CUSTOM
          ? customMatterType.trim() || null
          : matterTypeSelection
    onCreate({
      title: trimmedTitle,
      matter_type: matterType,
      priority,
      background,
      goal,
      source_resource: source
        ? {
            provider: 'mailagent',
            kind: 'email',
            internal_id: source.internalId,
            link_scope: source.threadId ? linkScope : 'single'
          }
        : undefined
    })
  }

  // 不叫 `useExisting`：`use` 前缀会让 react-hooks/rules-of-hooks 把它当 Hook，
  // 在 onClick 回调里调用即报错（eslint 红，运行时其实无碍）。
  const linkToExisting = (candidate: MatterDuplicateCandidate): void => {
    if (!onUseExisting || usingExistingId !== null) return
    setUsingExistingId(candidate.matter.public_id)
    void Promise.resolve(onUseExisting(candidate, source?.threadId ? linkScope : 'single'))
      .catch((error) => toastError(t('matters.toast.saveFailed'), errorMessage(error)))
      .finally(() => setUsingExistingId(null))
  }

  const researchAndPrefill = async (): Promise<void> => {
    if (!source || researchState === 'loading') return
    researchAbortRef.current?.abort()
    const controller = new AbortController()
    const requestId = researchRequestRef.current + 1
    researchRequestRef.current = requestId
    researchAbortRef.current = controller
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, RESEARCH_TIMEOUT_MS)

    setResearchState('loading')
    setResearchStep(0)
    setResearchError('')
    try {
      const result = await api.createDraft(
        {
          internal_id: source.internalId,
          thread_id: source.threadId,
          link_scope: source.threadId ? linkScope : 'single',
          title: title.trim() || undefined,
          matter_type:
            matterTypeSelection !== TYPE_UNSET && matterTypeSelection !== TYPE_CUSTOM
              ? matterTypeSelection
              : undefined,
          background: background.trim() || undefined,
          goal: goal.trim() || undefined
        },
        controller.signal
      )
      if (researchRequestRef.current !== requestId) return
      setTitle(result.draft.title)
      setMatterTypeSelection(result.draft.matter_type ?? TYPE_UNSET)
      setCustomMatterType('')
      setBackground(result.draft.background)
      setGoal(result.draft.goal)
      setLinkScope(result.source.link_scope)
      setSuggestedResources(result.draft.resources)
      setSuggestedStakeholders(result.draft.stakeholders)
      setDuplicateCandidates(result.draft.duplicate_candidates)
      setResearchSummary({
        threadEmailCount: result.research.thread_email_count,
        relatedEmailCount: result.research.related_email_count,
        notionStatus: result.research.notion_status,
        warningCount: result.research.warnings.length
      })
      setResearchState('success')
    } catch (error) {
      if (researchRequestRef.current !== requestId) return
      setResearchError(timedOut ? t('matters.create.research.timeout') : errorMessage(error))
      setResearchState('error')
    } finally {
      window.clearTimeout(timeout)
      if (researchRequestRef.current === requestId) researchAbortRef.current = null
    }
  }

  const removeSuggestedResource = (externalKey: string): void => {
    setSuggestedResources((items) => items.filter((item) => item.external_key !== externalKey))
  }

  const removeSuggestedStakeholder = (email: string): void => {
    setSuggestedStakeholders((items) => items.filter((item) => item.email !== email))
  }

  return (
    <div
      ref={scopeRef}
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
      role="presentation"
    >
      <section
        data-anim-card
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-create-title"
        /* 🔴 高度必须钳在视口内并让**内容区**滚动，不能让整个对话框长高：调研回填会灌进
           摘要 + 干系人 + 资料列表，内容一长，外层 `place-items-center` 会把 footer 顶出
           视口 —— 按钮既看不见也点不到（0812 dogfood 实测）。范式同 MatterGlobalAgentModal。 */
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-border px-5 py-4">
          {/* 设计 create.jsx:47 `ModalHead icon="briefcase"` —— 实现此前弹窗头无 icon。 */}
          <h2
            id="matter-create-title"
            className="flex items-center gap-2 text-lead font-semibold text-ink-fg"
          >
            <Briefcase size={15} className="shrink-0 text-coral" />
            {t(source ? 'matters.create.fromEmailTitle' : 'matters.create.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--r-ctl)] p-1.5 hover:bg-ink-3"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {source ? (
            <div className="space-y-3 rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-3 py-3">
              <div className="flex gap-3">
                <Mail size={15} className="mt-0.5 shrink-0 text-coral" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-aux font-medium text-ink-fg">{source.subject}</div>
                  <div className="mt-1 truncate text-meta text-ink-fg-3">
                    {t('matters.create.sourceMeta', {
                      sender: source.sender,
                      time: source.receivedAt ? new Date(source.receivedAt).toLocaleString() : '—',
                      count: source.threadCount
                    })}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-ink-border/70 pt-3">
                <p className="text-meta leading-5 text-ink-fg-3">
                  {t('matters.create.research.helper')}
                </p>
                <button
                  type="button"
                  disabled={researchState === 'loading'}
                  onClick={() => void researchAndPrefill()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ai/30 bg-ai/[0.08] px-3 py-2 text-aux font-medium text-ai hover:bg-ai/[0.13] disabled:opacity-60"
                >
                  {researchState === 'loading' ? (
                    <LoaderCircle size={14} className="animate-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {t(
                    researchState === 'success'
                      ? 'matters.create.research.retry'
                      : 'matters.create.research.action'
                  )}
                </button>
              </div>
            </div>
          ) : null}
          {researchState === 'loading' ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] px-3 py-3"
            >
              <div className="flex items-center gap-2 text-aux font-medium text-ink-fg">
                <LoaderCircle size={14} className="animate-spin text-ai" />
                {t(`matters.create.research.progress.${researchStep}`)}
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-3">
                <div
                  className="h-full rounded-full bg-ai transition-[width] duration-500"
                  style={{ width: `${(researchStep + 1) * 33}%` }}
                />
              </div>
            </div>
          ) : null}
          {researchState === 'error' ? (
            <div
              role="alert"
              className="rounded-[var(--r-card)] border border-coral/25 bg-coral/[0.06] p-3"
            >
              <p className="text-aux font-medium text-ink-fg">
                {t('matters.create.research.failedTitle')}
              </p>
              <p className="mt-1 text-meta leading-5 text-ink-fg-3">
                {t('matters.create.research.failedHint', { error: researchError })}
              </p>
            </div>
          ) : null}
          {researchState === 'success' && researchSummary ? (
            <section className="space-y-3 rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] p-3">
              <div className="flex items-start gap-2">
                <Sparkles size={14} className="mt-0.5 shrink-0 text-ai" />
                <div>
                  <h3 className="text-aux font-semibold text-ink-fg">
                    {t('matters.create.research.readyTitle')}
                  </h3>
                  <p className="mt-0.5 text-meta leading-5 text-ink-fg-3">
                    {t('matters.create.research.readyHint', {
                      threadCount: researchSummary.threadEmailCount,
                      relatedCount: researchSummary.relatedEmailCount
                    })}
                  </p>
                  <p className="mt-1 text-meta text-ink-fg-3">
                    {t(`matters.create.research.notion.${researchSummary.notionStatus}`)}
                  </p>
                  {researchSummary.warningCount > 0 ? (
                    <p className="mt-1 text-meta text-coral">
                      {t('matters.create.research.partialWarning')}
                    </p>
                  ) : null}
                </div>
              </div>
              <p className="text-meta text-ink-fg-2">
                {t('matters.create.research.editableNotice')}
              </p>
              {suggestedResources.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-aux font-medium text-ink-fg-1">
                    <FileText size={13} />
                    {t('matters.create.research.resources', { count: suggestedResources.length })}
                  </div>
                  <div className="space-y-1.5">
                    {suggestedResources.map((resource) => (
                      <div
                        key={resource.external_key}
                        className="flex items-start justify-between gap-3 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-aux text-ink-fg">{resource.title}</div>
                          <div className="mt-0.5 text-meta text-ink-fg-3">
                            {resource.reason.label}
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={t('matters.create.research.removeResource', {
                            title: resource.title
                          })}
                          onClick={() => removeSuggestedResource(resource.external_key)}
                          className="shrink-0 rounded-[var(--r-ctl)] p-1 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {suggestedStakeholders.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-aux font-medium text-ink-fg-1">
                    <Users size={13} />
                    {t('matters.create.research.stakeholders', {
                      count: suggestedStakeholders.length
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestedStakeholders.map((stakeholder) => (
                      <span
                        key={stakeholder.email}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-ink-border bg-ink-1 py-1 pl-2.5 pr-1 text-meta text-ink-fg-2"
                      >
                        <span className="truncate">
                          {stakeholder.display_name
                            ? `${stakeholder.display_name} · ${stakeholder.email}`
                            : stakeholder.email}
                        </span>
                        <button
                          type="button"
                          aria-label={t('matters.create.research.removeStakeholder', {
                            email: stakeholder.email
                          })}
                          onClick={() => removeSuggestedStakeholder(stakeholder.email)}
                          className="rounded-full p-0.5 hover:bg-ink-3 hover:text-ink-fg"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.name')}</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
            />
          </label>
          {duplicatesLoading || duplicateCandidates.length > 0 ? (
            <section
              className="rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] p-3"
              aria-label={t('matters.create.duplicates.title')}
            >
              <div className="flex items-start gap-2">
                <Sparkles size={14} className="mt-0.5 shrink-0 text-ai" />
                <div>
                  <h3 className="text-aux font-semibold text-ink-fg">
                    {t('matters.create.duplicates.title')}
                  </h3>
                  <p className="mt-0.5 text-meta leading-5 text-ink-fg-3">
                    {t('matters.create.duplicates.hint')}
                  </p>
                </div>
              </div>
              {duplicatesLoading ? (
                <p className="mt-3 text-meta text-ink-fg-3">
                  {t('matters.create.duplicates.loading')}
                </p>
              ) : null}
              <div className="mt-2 space-y-2">
                {duplicateCandidates.map((candidate) => (
                  <article
                    key={candidate.matter.public_id}
                    className="rounded-[var(--r-ctl)] border border-ink-border bg-ink-1/70 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-body font-medium text-ink-fg">
                            {candidate.matter.title}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-ink-fg-3">
                            {candidate.matter.public_id}
                          </span>
                        </div>
                        <div className="mt-1 text-meta font-medium text-ai">
                          {t('matters.create.duplicates.confidence', {
                            value: Math.round(candidate.confidence * 100)
                          })}
                        </div>
                      </div>
                      {onUseExisting ? (
                        <button
                          type="button"
                          disabled={usingExistingId !== null}
                          onClick={() => linkToExisting(candidate)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] border border-ai/30 px-2 py-1 text-meta font-medium text-ai hover:bg-ai/10 disabled:opacity-50"
                        >
                          {t(
                            source
                              ? 'matters.create.duplicates.addExisting'
                              : 'matters.create.duplicates.openExisting'
                          )}
                          <ArrowRight size={11} />
                        </button>
                      ) : null}
                    </div>
                    <ul className="mt-2 space-y-1 text-meta leading-5 text-ink-fg-2">
                      {candidate.reasons.map((reason) => (
                        <li key={`${reason.kind}:${reason.evidence.join('|')}`}>
                          <span className="font-medium text-ink-fg-1">{reason.label}</span>
                          {reason.evidence.length > 0 ? (
                            <span> · {reason.evidence.join('、')}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
              <p className="mt-2 text-meta text-ink-fg-3">
                {t('matters.create.duplicates.nonBlocking')}
              </p>
            </section>
          ) : null}
          <div className="space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.type')}</span>
            <Select
              value={matterTypeSelection}
              onValueChange={(value) => setMatterTypeSelection(value as MatterTypeSelection)}
            >
              <SelectTrigger aria-label={t('matters.create.type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TYPE_UNSET}>{t('matters.create.typeUnset')}</SelectItem>
                {BUILTIN_MATTER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
                <SelectItem value={TYPE_CUSTOM}>{t('matters.create.typeCustom')}</SelectItem>
              </SelectContent>
            </Select>
            {matterTypeSelection === TYPE_CUSTOM ? (
              <input
                autoFocus
                value={customMatterType}
                onChange={(event) => setCustomMatterType(event.target.value)}
                placeholder={t('matters.create.typeCustomPlaceholder')}
                aria-label={t('matters.create.typeCustom')}
                className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none focus:border-coral/60"
              />
            ) : null}
          </div>
          <div className="space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.create.priority')}</span>
            <SegmentedControl<MatterPriority>
              value={priority}
              onChange={setPriority}
              options={MATTER_PRIORITIES.map((value) => ({ value, label: value.toUpperCase() }))}
              ariaLabel={t('matters.create.priority')}
            />
          </div>
          {source ? (
            <div className="space-y-1.5">
              <span className="text-aux text-ink-fg-1">{t('matters.create.linkScope')}</span>
              <div role="tablist" aria-label={t('matters.create.linkScope')} className="seg">
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkScope === 'thread'}
                  disabled={!source.threadId}
                  onClick={() => setLinkScope('thread')}
                  className={linkScope === 'thread' ? 'seg-active' : undefined}
                >
                  {t('matters.create.scopeThread', { count: source.threadCount })}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkScope === 'single'}
                  onClick={() => setLinkScope('single')}
                  className={linkScope === 'single' ? 'seg-active' : undefined}
                >
                  {t('matters.create.scopeSingle')}
                </button>
              </div>
              <p className="text-meta text-ink-fg-3">
                {t(
                  source.threadId ? 'matters.create.scopeHint' : 'matters.create.threadUnavailable'
                )}
              </p>
            </div>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.state.backgroundLabel')}</span>
            <textarea
              rows={4}
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              placeholder={t('matters.state.backgroundPlaceholder')}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none placeholder:text-ink-fg-3 focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-aux text-ink-fg-1">{t('matters.state.goalLabel')}</span>
            <textarea
              rows={3}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={t('matters.state.goalPlaceholder')}
              className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 text-body outline-none placeholder:text-ink-fg-3 focus:border-coral/60"
            />
          </label>
          {/* 提示对两个框都成立，所以放在 label **外面** —— 塞进 label 会被算进
            textarea 的 accessible name（「目标 你写的这两段…」），按名字取控件就废了。 */}
          <p className="text-meta text-ink-fg-2">{t('matters.create.descriptionHint')}</p>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-ink-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--r-ctl)] px-3 py-2 text-body hover:bg-ink-3"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!title.trim() || busy || usingExistingId !== null}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-body font-medium text-accent-fg disabled:opacity-50"
          >
            {/* 设计 create.jsx:100 `Btn kind="primary" icon="check"`。 */}
            <Check size={14} className="shrink-0" />
            {busy ? t('matters.create.creating') : t('matters.create.submit')}
          </button>
        </footer>
      </section>
    </div>
  )
}
