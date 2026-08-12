import {
  Check,
  CheckCircle2,
  Edit3,
  Layers,
  Link,
  ListChecks,
  RefreshCcw,
  Shield,
  Sparkles,
  SquarePen,
  TriangleAlert,
  X,
  Zap
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MATTER_HEALTH_VALUES, MATTER_STATUSES } from '@shared/api/types/matter'
import type {
  Matter,
  MatterHealth,
  MatterProposalChange,
  MatterStatus,
  MatterUpdate
} from '@shared/api/types/matter'

// 逐项照设计原型 review.jsx 的 `CHANGE_KIND` 词表（icon + tone + label + hint 四件）。
// 🔴 改动前三处不符：action/resource 的 tone 用了 ai（稿子是 info）、两条 hint 是空的、
// 五项全都没有 icon；label/hint 还是**硬编码中文**，英文用户直接看到中文。
const kindMeta = {
  fact: { icon: CheckCircle2, tone: 'text-ok' }, // checkcircle / success
  inference: { icon: Zap, tone: 'text-warn' }, // zap / warn
  field: { icon: SquarePen, tone: 'text-fail' }, // edit / critical
  action: { icon: ListChecks, tone: 'text-info' }, // listcheck / info
  resource: { icon: Link, tone: 'text-info' } // link / info
} as const

const statusTone: Record<MatterStatus, string> = {
  inbox: 'bg-ink-4 text-ink-fg-2',
  planned: 'bg-info/10 text-info',
  active: 'bg-coral/10 text-coral',
  waiting: 'bg-warn/10 text-warn',
  blocked: 'bg-fail/10 text-fail',
  monitoring: 'bg-ai/10 text-ai',
  done: 'bg-ok/10 text-ok',
  canceled: 'bg-ink-4 text-ink-fg-2'
}

const healthTone: Record<MatterHealth, string> = {
  unknown: 'bg-ink-4 text-ink-fg-2',
  on_track: 'bg-ok/10 text-ok',
  at_risk: 'bg-warn/10 text-warn',
  off_track: 'bg-fail/10 text-fail'
}

export interface ReviewAcceptPayload {
  selectedIds: string[]
  editedSummary: string | null
  editedChanges: Array<{ change_id: string; after?: unknown; text?: string | null }>
}

interface MatterUpdateReviewProps {
  matter: Matter
  update: MatterUpdate
  busy?: boolean
  error?: string | null
  onClose(): void
  onAccept(payload: ReviewAcceptPayload): void
  onReject(reason: string): void
  onOpenResource?(resourceId: number): void
}

export function MatterUpdateReview({
  matter,
  update,
  busy = false,
  error = null,
  onClose,
  onAccept,
  onReject,
  onOpenResource
}: MatterUpdateReviewProps): React.ReactElement {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(() => new Set(update.changes.map((change) => change.id)))
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState(update.summary ?? '')
  const [changes, setChanges] = useState(update.changes)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const editedChanges = useMemo(
    () =>
      changes.flatMap((change, index) => {
        const original = update.changes[index]
        if (change.after === original.after && change.text === original.text) return []
        return [{ change_id: change.id, after: change.after, text: change.text }]
      }),
    [changes, update.changes]
  )
  const editedSummary = summary !== (update.summary ?? '') ? summary : null
  const edited = editedSummary !== null || editedChanges.length > 0
  const allSelected = selected.size === changes.length

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('matters.review.title')}
        className="flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
      >
        <header className="flex items-start gap-3 border-b border-ink-border px-5 py-4">
          <span className="grid size-8 place-items-center rounded-lg bg-ai/12 text-ai">
            <Sparkles size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lead font-semibold">
              {t('matters.review.heading', { title: matter.title })}
            </h2>
            <p className="mt-1 text-meta text-ink-fg-2">
              <span className="font-mono">{matter.public_id}</span> ·{' '}
              {new Date(update.created_at).toLocaleString()} ·{' '}
              {t('matters.review.run', { id: update.agent_run_id ?? '—' })}
            </p>
            <div className="mt-2 flex gap-2">
              <span className="rounded-full bg-ai/10 px-2 py-1 text-meta text-ai">
                {t('matters.review.confidence', {
                  value: Math.round((update.confidence ?? 0) * 100)
                })}
              </span>
              {update.is_stale ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-fail/10 px-2 py-1 text-meta text-fail">
                  <TriangleAlert size={11} />
                  {t('matters.review.stale')}
                </span>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {error ? (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-fail/30 bg-fail/[0.07] p-3 text-aux text-fail"
            >
              <RefreshCcw size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="mb-4 flex items-center gap-2 rounded-lg border border-ink-border bg-ink-2 px-3 py-2 font-mono text-meta text-ink-fg-2">
            <Layers size={12} />
            {t('matters.review.watermark', {
              from: update.from_event_id ?? '—',
              to: update.to_event_id ?? '—'
            })}
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-meta font-semibold uppercase tracking-wide text-ink-fg-3">
              {t('matters.review.proposedSummary')}
            </h3>
            <button
              type="button"
              onClick={() => setEditing((value) => !value)}
              className="inline-flex items-center gap-1 text-aux text-ai"
            >
              {editing ? <Check size={12} /> : <Edit3 size={12} />}
              {editing ? t('matters.review.finishEdit') : t('matters.review.editAccept')}
            </button>
          </div>
          {editing ? (
            <textarea
              rows={6}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              className="mt-2 w-full rounded-[var(--r-ctl)] border border-ai/40 bg-ink-2 p-3 text-body outline-none"
            />
          ) : (
            <div className="mt-2 rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4 text-body leading-6">
              {summary}
            </div>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-aux text-ink-fg-2">
              {t('matters.review.compare')}
            </summary>
            <p className="mt-2 rounded-lg border border-dashed border-ink-border p-3 text-aux text-ink-fg-2">
              {matter.current_summary || '—'}
            </p>
          </details>

          <div className="mt-5 flex items-center justify-between">
            <h3 className="text-meta font-semibold uppercase tracking-wide text-ink-fg-3">
              {t('matters.review.changes', {
                selected: selected.size,
                total: changes.length
              })}
            </h3>
            <button
              type="button"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(changes.map((change) => change.id)))
              }
              className="text-aux text-ai"
            >
              {allSelected ? t('matters.review.clearAll') : t('matters.review.selectAll')}
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {changes.map((change, index) => (
              <ChangeRow
                key={change.id}
                change={change}
                selected={selected.has(change.id)}
                editing={editing}
                onToggle={() =>
                  setSelected((current) => {
                    const next = new Set(current)
                    if (next.has(change.id)) next.delete(change.id)
                    else next.add(change.id)
                    return next
                  })
                }
                onChange={(next) =>
                  setChanges((current) =>
                    current.map((item, itemIndex) => (itemIndex === index ? next : item))
                  )
                }
                onOpenResource={onOpenResource}
              />
            ))}
          </div>

          {update.original_proposal.open_questions?.length ? (
            <div className="mt-5">
              <h3 className="text-meta font-semibold uppercase tracking-wide text-ink-fg-3">
                {t('matters.review.questions')}
              </h3>
              {update.original_proposal.open_questions.map((question) => (
                <p
                  key={question}
                  className="mt-2 rounded-lg border border-warn/25 bg-warn/[0.06] p-3 text-aux"
                >
                  {question}
                </p>
              ))}
            </div>
          ) : null}
          {update.is_stale ? (
            <p className="mt-4 text-aux text-fail">{t('matters.review.staleHint')}</p>
          ) : null}

          {rejecting ? (
            <div className="mt-4 rounded-lg border border-fail/25 p-3">
              <label htmlFor="matter-update-reject-reason" className="text-aux font-medium">
                {t('matters.review.rejectReason')}
              </label>
              <textarea
                id="matter-update-reject-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="mt-2 w-full rounded-lg border border-ink-border bg-ink-2 p-2"
              />
              <button
                type="button"
                disabled={!reason.trim()}
                onClick={() => onReject(reason.trim())}
                className="mt-2 rounded-lg bg-fail px-3 py-2 text-aux text-white disabled:opacity-50"
              >
                {t('matters.review.confirmReject')}
              </button>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-ink-border bg-ink-2 px-5 py-3">
          <Shield size={13} className="text-ink-fg-3" />
          <span className="min-w-0 flex-1 text-meta text-ink-fg-2">
            {edited ? t('matters.review.editedArchive') : t('matters.review.rejectArchive')}
          </span>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            className="rounded-lg px-3 py-2 text-aux hover:bg-ink-3"
          >
            {t('matters.review.reject')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-border px-3 py-2 text-aux"
          >
            {t('matters.review.later')}
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0 || update.is_stale}
            onClick={() => onAccept({ selectedIds: [...selected], editedSummary, editedChanges })}
            className="rounded-lg bg-ai px-3 py-2 text-aux font-medium text-white disabled:opacity-50"
          >
            {allSelected
              ? t('matters.review.acceptAll')
              : t('matters.review.acceptSelected', { count: selected.size })}
          </button>
        </footer>
      </section>
    </div>
  )
}

function ChangeRow({
  change,
  selected,
  editing,
  onToggle,
  onChange,
  onOpenResource
}: {
  change: MatterProposalChange
  selected: boolean
  editing: boolean
  onToggle(): void
  onChange(change: MatterProposalChange): void
  onOpenResource?(resourceId: number): void
}): React.ReactElement {
  const { t } = useTranslation()
  const meta = kindMeta[change.kind]
  const confidence = change.confidence ?? change.conf
  const field = typeof change.target?.field === 'string' ? change.target.field : 'field'

  return (
    <article
      className={`rounded-lg border border-ink-border bg-ink-2 p-3 ${selected ? '' : 'opacity-60'}`}
    >
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full bg-ink-3 px-2 py-1 text-aux ${meta.tone}`}
            >
              <meta.icon size={11} />
              {t(`matters.review.changeKind.${change.kind}.label`, { defaultValue: change.kind })}
            </span>
            {confidence != null ? (
              <span className="text-aux text-ink-fg-3">{Math.round(confidence * 100)}%</span>
            ) : null}
            {(change.sources?.length ?? 0) === 0 && change.kind !== 'field' ? (
              <span className="rounded-full bg-warn/10 px-2 py-1 text-aux text-warn">
                无直接来源
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-aux text-ink-fg-3">
            {t(`matters.review.changeKind.${change.kind}.hint`, { defaultValue: '' })}
          </p>

          {change.kind === 'field' ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-body">
              <strong>{field}</strong>
              <FieldValue field={field} value={change.before} />
              <span>→</span>
              {editing ? (
                <input
                  value={String(change.after ?? '')}
                  onChange={(event) => onChange({ ...change, after: event.target.value })}
                  className="min-w-0 rounded border border-ai/35 bg-ink-1 px-2 py-1"
                />
              ) : (
                <FieldValue field={field} value={change.after} accent />
              )}
            </div>
          ) : editing ? (
            <textarea
              value={change.text ?? ''}
              onChange={(event) => onChange({ ...change, text: event.target.value })}
              className="mt-2 w-full rounded border border-ai/35 bg-ink-1 p-2"
            />
          ) : (
            <p className="mt-2 text-body">{change.text}</p>
          )}

          {change.reason ? (
            <p className="mt-2 text-aux text-ink-fg-2">理由：{change.reason}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {change.sources?.map((source) => (
              <button
                type="button"
                key={source.resource_id}
                onClick={() => onOpenResource?.(source.resource_id)}
                className="inline-flex items-center gap-1 rounded-full bg-ink-3 px-2 py-1 text-aux text-ai"
                aria-label={t('matters.review.openCitation', {
                  id: source.resource_id,
                  defaultValue: `打开证据 #${source.resource_id}`
                })}
              >
                <Link size={10} />#{source.resource_id}
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  )
}

function FieldValue({
  field,
  value,
  accent = false
}: {
  field: string
  value: unknown
  accent?: boolean
}): React.ReactElement {
  const text = String(value ?? '—')
  if (field === 'status' && MATTER_STATUSES.includes(text as MatterStatus)) {
    return <MatterStatusChip value={text as MatterStatus} />
  }
  if (field === 'health' && MATTER_HEALTH_VALUES.includes(text as MatterHealth)) {
    return <MatterHealthChip value={text as MatterHealth} />
  }
  return (
    <span className={`rounded px-2 py-1 ${accent ? 'bg-ai/10 text-ai' : 'bg-ink-3'}`}>{text}</span>
  )
}

export function MatterStatusChip({ value }: { value: MatterStatus }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span className={`rounded-[var(--r-pill)] px-2 py-1 text-aux ${statusTone[value]}`}>
      {t(`matters.status.${value}`)}
    </span>
  )
}

export function MatterHealthChip({ value }: { value: MatterHealth }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span className={`rounded-[var(--r-pill)] px-2 py-1 text-aux ${healthTone[value]}`}>
      {t(`matters.health.${value}`)}
    </span>
  )
}
