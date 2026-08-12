import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, Loader2, Sparkles, X, XCircle } from 'lucide-react'

import type {
  Matter,
  MatterResourceListItem,
  MatterSuggestionBulkAction
} from '@shared/api/types/matter'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'

interface MatterSuggestedResourceActionsProps {
  matter: Matter
  item: MatterResourceListItem
  onChanged(): void
  compact?: boolean
}

export function MatterSuggestedResourceActions({
  matter,
  item,
  onChanged,
  compact = false
}: MatterSuggestedResourceActionsProps): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const suggested = item.link.confirmed_at === null
  const reason = suggestionReason(item)
  const confidence = item.link.confidence

  const confirm = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: () =>
      api.patchResource(
        matter.public_id,
        item.resource.id,
        { confirmed: true },
        { expectedVersion: matter.version, reason: 'user_confirmed_resource_suggestion' }
      ),
    onSuccess: onChanged,
    onError: (error) =>
      toastError(t('matters.resource.suggestionActionFailed'), errorMessage(error))
  })
  const reject = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: () =>
      api.rejectResourceSuggestion(matter.public_id, item.resource.id, {
        expectedVersion: matter.version,
        reason: 'user_marked_resource_suggestion_irrelevant'
      }),
    onSuccess: onChanged,
    onError: (error) =>
      toastError(t('matters.resource.suggestionActionFailed'), errorMessage(error))
  })

  if (!suggested) return null
  const pending = confirm.isPending || reject.isPending

  return (
    <div
      data-testid={`matter-resource-suggestion-${item.resource.id}`}
      className={compact ? 'mt-1.5' : 'mt-2'}
    >
      <div className="flex items-start gap-1.5 text-meta leading-5 text-ai">
        <Sparkles size={11} className="mt-1 shrink-0" />
        <span className="min-w-0 flex-1">
          {reason}
          {confidence === null ? null : (
            <span className="ml-1 whitespace-nowrap text-ink-fg-3">
              ·{' '}
              {t('matters.resource.suggestionConfidence', { value: Math.round(confidence * 100) })}
            </span>
          )}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            confirm.mutate()
          }}
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] bg-ai px-2 py-1 text-meta font-medium text-white disabled:opacity-50"
        >
          <Check size={11} />
          {t('matters.resource.confirmSuggestion')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            reject.mutate()
          }}
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2 py-1 text-meta text-ink-fg-2 hover:bg-ink-3 disabled:opacity-50"
        >
          <X size={11} />
          {t('matters.resource.rejectSuggestion')}
        </button>
      </div>
    </div>
  )
}

interface MatterSuggestedResourceBulkActionsProps {
  matter: Matter
  resources: readonly MatterResourceListItem[]
  onChanged(): void
}

/**
 * 「全部确认」/「全部忽略」。
 *
 * 0812 dogfood 的第二条 P0：「用事项对话 agent 创建的一大堆关联，只能一个一个关联」——
 * 逐条口是一份建议一次版本推进，Agent 一轮挂十几份就等于把版本号推十几格，中间任何一次
 * 错位都撞乐观锁。整批口是**一次校验一次推进**，两个问题同一个病根。
 *
 * 逐条钮**保留**（用户要挑着来），这里只收「全要 / 全不要」这两种最常见的整批处置。
 */
export function MatterSuggestedResourceBulkActions({
  matter,
  resources,
  onChanged
}: MatterSuggestedResourceBulkActionsProps): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const suggestedIds = resources
    .filter((item) => item.link.confirmed_at === null)
    .map((item) => item.resource.id)

  const bulk = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: (action: MatterSuggestionBulkAction) =>
      api.bulkResolveResourceSuggestions(
        matter.public_id,
        { action, resourceIds: suggestedIds },
        {
          expectedVersion: matter.version,
          reason:
            action === 'confirm'
              ? 'user_bulk_confirmed_resource_suggestions'
              : 'user_bulk_rejected_resource_suggestions'
        }
      ),
    onSuccess: (result) => {
      // 「跳过 M 条」不是错误，但也不能不说 —— 建议列表是异步刷新的，用户点的时候手里那份
      // 必然可能带上刚被别处处置掉的条目。
      toastSuccess(
        t(
          result.action === 'confirm'
            ? 'matters.resource.bulkConfirmDone'
            : 'matters.resource.bulkRejectDone',
          { applied: result.counts.applied, skipped: result.counts.skipped }
        )
      )
      onChanged()
    },
    onError: (error) =>
      toastError(t('matters.resource.suggestionActionFailed'), errorMessage(error))
  })

  if (suggestedIds.length === 0) return null
  const busy = bulk.isPending
  const runningAction = busy ? bulk.variables : null

  return (
    <div
      data-testid="matter-resource-suggestion-bulk"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] px-3 py-2"
    >
      <Sparkles size={13} className="shrink-0 text-ai" />
      <span className="min-w-0 flex-1 text-meta text-ink-fg-1">
        {t('matters.resource.bulkPrompt', { count: suggestedIds.length })}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => bulk.mutate('confirm')}
        className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] bg-ai px-2.5 py-1 text-meta font-medium text-white disabled:opacity-50"
      >
        {runningAction === 'confirm' ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <CheckCheck size={11} />
        )}
        {t('matters.resource.bulkConfirm')}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => bulk.mutate('reject')}
        className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 text-meta text-ink-fg-2 hover:bg-ink-3 disabled:opacity-50"
      >
        {runningAction === 'reject' ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <XCircle size={11} />
        )}
        {t('matters.resource.bulkReject')}
      </button>
    </div>
  )
}

function suggestionReason(item: MatterResourceListItem): string {
  const reason = item.link.provenance.reason
  return typeof reason === 'string' && reason.trim()
    ? reason
    : item.resource.title || item.resource.external_key
}
