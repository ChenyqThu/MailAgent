import {
  Check,
  CheckCircle2,
  Edit3,
  Layers,
  Link,
  ListChecks,
  Plus,
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
import { useEnterAnimation } from '@shared/hooks/useEnterAnimation'

import { diffGoalChecks } from './goalChecksDiff'
import { DOC_PROVIDER_ICONS, RESOURCE_KIND_ICONS } from './matterResource'

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
  /** 提案失效后的出口：跑一轮新的跟进。不传 = 不渲染按钮（上层没接线时不假装有出口）。 */
  onRerun?(): void
  rerunBusy?: boolean
}

export function MatterUpdateReview({
  matter,
  update,
  busy = false,
  error = null,
  onClose,
  onAccept,
  onReject,
  onOpenResource,
  onRerun,
  rerunBusy = false
}: MatterUpdateReviewProps): React.ReactElement {
  const { t } = useTranslation()
  // G-32 —— 遮罩 fadeIn + 卡片 popIn。只做进场：调用方是 `{reviewUpdate ? <Review …/> : null}`，
  // 关闭时 update 与挂载条件一起消失，接退场要先把父级数据保活改造一遍（见 useEnterAnimation
  // 头注）。
  const animRef = useEnterAnimation<HTMLDivElement>({
    card: '[data-anim-card]',
    backdrop: true
  })
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
    <div ref={animRef} className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4">
      <section
        data-anim-card
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
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-aux text-fail">{t('matters.review.staleHint')}</p>
              {onRerun ? (
                <button
                  type="button"
                  disabled={rerunBusy}
                  onClick={onRerun}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux disabled:opacity-50"
                >
                  <RefreshCcw size={12} className={rerunBusy ? 'animate-spin' : undefined} />
                  {t('matters.review.staleRerun')}
                </button>
              ) : null}
            </div>
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
                {t('matters.review.noDirectSource')}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-aux text-ink-fg-3">
            {t(`matters.review.changeKind.${change.kind}.hint`, { defaultValue: '' })}
          </p>

          {change.kind === 'field' && field === 'goal_checks' ? (
            // S3 —— 完成标志是**清单**：一行「旧 → 新」会渲染成 [object Object]，
            // 而 owner 需要看到的是「加了哪几条 / 少了哪几条 / 勾掉了哪几条」。
            // 这条 change 不提供行内编辑（整表编辑在事项详情的 GoalCard 里，
            // 这里只做「接受 / 不接受」的判断）。
            <GoalChecksDiff before={change.before} after={change.after} />
          ) : change.kind === 'field' && field === 'description' ? (
            // S3 —— 背景与目标是长文本：挤进一行读不了，单行 input 也编辑不了。
            <div className="mt-2 space-y-2 text-body">
              <div className="text-aux text-ink-fg-3">{t('matters.eventField.description')}</div>
              <p className="whitespace-pre-wrap rounded bg-ink-3 p-2 text-ink-fg-2">
                {String(change.before ?? '—')}
              </p>
              {editing ? (
                <textarea
                  value={String(change.after ?? '')}
                  onChange={(event) => onChange({ ...change, after: event.target.value })}
                  className="min-h-[6rem] w-full rounded border border-ai/35 bg-ink-1 p-2"
                />
              ) : (
                <p className="whitespace-pre-wrap rounded bg-ai/10 p-2 text-ai">
                  {String(change.after ?? '—')}
                </p>
              )}
            </div>
          ) : change.kind === 'field' ? (
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

          {change.resource ? <NewResourceCard resource={change.resource} /> : null}

          {change.reason ? (
            <p className="mt-2 text-aux text-ink-fg-2">
              {t('matters.review.changeReason', { reason: change.reason })}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {change.sources?.map((source) =>
              source.resource_id != null ? (
                <button
                  type="button"
                  key={`res-${source.resource_id}`}
                  onClick={() => onOpenResource?.(source.resource_id as number)}
                  className="inline-flex items-center gap-1 rounded-full bg-ink-3 px-2 py-1 text-aux text-ai"
                  aria-label={t('matters.review.openCitation', { id: source.resource_id })}
                >
                  <Link size={10} />#{source.resource_id}
                </button>
              ) : (
                // 同提案里正在新建的资料：还没有 resource_id，点不开也不该假装能点开。
                <span
                  key={`chg-${source.change_id}`}
                  className="inline-flex items-center gap-1 rounded-full bg-ink-3 px-2 py-1 text-aux text-ink-fg-2"
                >
                  <Link size={10} />
                  {t('matters.review.pendingCitation')}
                </span>
              )
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

/** 「将新建关联」的资料卡。owner 是在这个界面上按下接受的 —— 看不清 provider / 标题 /
 *  链接就等于盲签，所以这三样必须在场，且明说"接受后才会关联进来"。
 *
 *  V3-26：再加一段**内容摘要**（H3§6.2「建议卡片上要显示这段摘要，并标注它是『沿用邮件
 *  自带』还是『Agent 已生成』」）。🔴 来源标注按 provider/kind 判，不另立字段：邮件与会话的
 *  摘要由服务端从那封信自己的 ai_summary 带入（模型写的在归一层就丢了，`summary` 恒 null），
 *  其余 provider 的 `summary` 就是 Agent 写的。两者都没有 = 空态，说实话说"还没有摘要"。 */
function NewResourceCard({
  resource
}: {
  resource: NonNullable<MatterProposalChange['resource']>
}): React.ReactElement {
  const { t } = useTranslation()
  const fromMail =
    resource.provider === 'mailagent' && (resource.kind === 'email' || resource.kind === 'thread')
  const summary = resource.summary?.trim() || ''
  // 🔴 成员索引而非查表函数：react-hooks/static-components 不接受 `const C = fn(...)`
  //（见 matterResource.ts 文末的说明）。与抽屉 / 上下文 tab 同一套图标单源。
  const Icon =
    (resource.kind === 'doc' && DOC_PROVIDER_ICONS[resource.provider.toLowerCase()]) ||
    RESOURCE_KIND_ICONS[resource.kind]
  return (
    <div className="mt-2 rounded-[var(--r-ctl)] border border-info/30 bg-info/[0.06] p-2.5">
      <p className="flex items-center gap-1.5 text-meta font-medium text-info">
        <Plus size={11} />
        {t('matters.review.newResource.badge')}
      </p>
      <div className="mt-1.5 flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0 text-ink-fg-2" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body">
            {resource.title || t('matters.review.newResource.untitled')}
          </p>
          <p className="mt-0.5 truncate font-mono text-meta text-ink-fg-3">
            {resource.provider} · {resource.external_key}
          </p>
          {resource.canonical_url ? (
            <p className="mt-0.5 truncate text-meta text-ink-fg-2">{resource.canonical_url}</p>
          ) : null}
          {summary ? <p className="mt-1.5 text-aux leading-5 text-ink-fg-2">{summary}</p> : null}
          <p className="mt-1 text-meta text-ink-fg-3">
            {t(
              summary
                ? 'matters.review.newResource.summaryByAgent'
                : fromMail
                  ? 'matters.review.newResource.summaryFromMail'
                  : 'matters.review.newResource.summaryPending'
            )}
          </p>
        </div>
      </div>
      <p className="mt-1.5 text-meta text-ink-fg-3">{t('matters.review.newResource.hint')}</p>
    </div>
  )
}

/** S3 —— 完成标志提案的可读 diff（新增 / 删除 / 勾选翻转），判据是文本不是下标。 */
function GoalChecksDiff({
  before,
  after
}: {
  before: unknown
  after: unknown
}): React.ReactElement {
  const { t } = useTranslation()
  const diff = diffGoalChecks(before, after)
  const rows = [
    ...diff.added.map((check) => ({ key: `a:${check.t}`, sign: '+', tone: 'text-ok', check })),
    ...diff.removed.map((check) => ({ key: `r:${check.t}`, sign: '−', tone: 'text-fail', check })),
    ...diff.toggled.map((check) => ({
      key: `t:${check.t}`,
      sign: check.done ? '✓' : '↺',
      tone: 'text-ai',
      check
    }))
  ]

  return (
    <div className="mt-2 space-y-1.5 text-body">
      <div className="text-aux text-ink-fg-3">{t('matters.state.goalChecks')}</div>
      {rows.length === 0 ? (
        <p className="text-ink-fg-3">{t('matters.review.goalChecksNoChange')}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.key} className="flex items-start gap-2">
              <span className={`font-mono ${row.tone}`}>{row.sign}</span>
              <span className={row.sign === '−' ? 'text-ink-fg-3 line-through' : ''}>
                {row.check.t}
              </span>
            </li>
          ))}
        </ul>
      )}
      {diff.unchanged > 0 ? (
        <p className="text-aux text-ink-fg-3">
          {t('matters.review.goalChecksUnchanged', { count: diff.unchanged })}
        </p>
      ) : null}
    </div>
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
    <span className={`rounded-full px-2 py-1 text-aux ${statusTone[value]}`}>
      {t(`matters.status.${value}`)}
    </span>
  )
}

export function MatterHealthChip({ value }: { value: MatterHealth }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span className={`rounded-full px-2 py-1 text-aux ${healthTone[value]}`}>
      {t(`matters.health.${value}`)}
    </span>
  )
}
