import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Sparkles, X } from 'lucide-react'

import type { Matter, MatterResourceListItem } from '@shared/api/types/matter'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

import { useMattersApi } from './hooks'

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

  const confirm = useMutation({
    mutationFn: () =>
      api.patchResource(
        matter.public_id,
        item.resource.id,
        { confirmed: true },
        { expectedVersion: matter.version, reason: 'user_confirmed_resource_suggestion' }
      ),
    onSuccess: onChanged,
    onError: (error) => toastError(t('matters.resource.suggestionActionFailed'), errorMessage(error))
  })
  const reject = useMutation({
    mutationFn: () =>
      api.rejectResourceSuggestion(matter.public_id, item.resource.id, {
        expectedVersion: matter.version,
        reason: 'user_marked_resource_suggestion_irrelevant'
      }),
    onSuccess: onChanged,
    onError: (error) => toastError(t('matters.resource.suggestionActionFailed'), errorMessage(error))
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
              · {t('matters.resource.suggestionConfidence', { value: Math.round(confidence * 100) })}
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

function suggestionReason(item: MatterResourceListItem): string {
  const reason = item.link.provenance.reason
  return typeof reason === 'string' && reason.trim() ? reason : item.resource.title || item.resource.external_key
}
