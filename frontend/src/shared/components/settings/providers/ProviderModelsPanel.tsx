// task 07-12 P3 — per-provider 模型管理面板（prd §4.5.3）。
//
// 「拉取模型列表」→ POST /{id}/models/refresh（批 2 review HIGH-2 后独立写端点，
// verify_local_token；上游 merge，失败恒 200 + 可读 error，中转不透传 /models 时走
// 手动添加兜底）；启用勾选 / maxOutput 编辑 → PUT model 行（后端 merge 语义，只动
// 传的键）；手动添加默认 enabled。capabilities 为 null = 上游未标注 → 不渲染标签
// （勿当 false 渲染，prd §4.3b 注记②）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, RefreshCw, X } from 'lucide-react'

import {
  deleteLlmProviderModel,
  refreshLlmProviderModels,
  upsertLlmProviderModel,
  useLlmProviderModels,
  type LlmProviderModel
} from '@shared/hooks/useLlmProviders'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Input } from '@shared/components/ui/input'

/** capabilities 标签：仅显式 true 的能力位渲染 chip；null（未标注）→ 整块不渲染。 */
function CapabilityTags({ model }: { model: LlmProviderModel }): React.ReactElement | null {
  const { t } = useTranslation()
  if (model.capabilities === null) return null
  const entries: Array<[string, string]> = [
    ['tools', t('settings.providers.models.cap.tools')],
    ['vision', t('settings.providers.models.cap.vision')],
    ['reasoning', t('settings.providers.models.cap.reasoning')]
  ]
  const active = entries.filter(
    ([k]) => (model.capabilities as Record<string, unknown>)[k] === true
  )
  if (active.length === 0) return null
  return (
    <span className="flex items-center gap-1">
      {active.map(([k, label]) => (
        <span key={k} className="rounded bg-ink-3 px-1 py-0.5 text-meta text-ink-fg-2">
          {label}
        </span>
      ))}
    </span>
  )
}

export function ProviderModelsPanel({
  providerId,
  readOnly
}: {
  providerId: string
  readOnly: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { models, isLoading } = useLlmProviderModels(providerId, true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [manualId, setManualId] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  // maxOutput 输入的本地草稿（blur 提交）；key = model id。
  const [maxOutputDraft, setMaxOutputDraft] = React.useState<Record<string, string>>({})
  const [contextWindowDraft, setContextWindowDraft] = React.useState<Record<string, string>>({})

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: qk.llm.providerModels(providerId) })
    // 启停/增删模型改变聚合 enabledModels → chat picker 与功能位选择器同步。
    await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    setFetchError(null)
    try {
      const data = await refreshLlmProviderModels(providerId)
      setFetchError(data.error)
      await invalidate()
    } catch (err) {
      setFetchError(errorMessage(err))
    } finally {
      setRefreshing(false)
    }
  }

  async function handleToggle(modelId: string, enabled: boolean): Promise<void> {
    try {
      await upsertLlmProviderModel(providerId, { id: modelId, enabled })
      await invalidate()
    } catch (err) {
      toastError(t('settings.providers.models.title'), errorMessage(err))
    }
  }

  async function handleMaxOutputBlur(model: LlmProviderModel, raw: string): Promise<void> {
    const trimmed = raw.trim()
    const next = trimmed === '' ? null : Number.parseInt(trimmed, 10)
    if (next !== null && (!Number.isFinite(next) || next <= 0)) {
      setMaxOutputDraft((d) => ({ ...d, [model.id]: model.maxOutput?.toString() ?? '' }))
      return
    }
    if (next === (model.maxOutput ?? null)) return
    try {
      await upsertLlmProviderModel(providerId, { id: model.id, maxOutput: next })
      await invalidate()
    } catch (err) {
      toastError(t('settings.providers.models.title'), errorMessage(err))
      setMaxOutputDraft((d) => ({ ...d, [model.id]: model.maxOutput?.toString() ?? '' }))
    }
  }

  async function handleContextWindowBlur(model: LlmProviderModel, raw: string): Promise<void> {
    const trimmed = raw.trim()
    const next = trimmed === '' ? null : Number.parseInt(trimmed, 10)
    if (next !== null && (!Number.isFinite(next) || next <= 0)) {
      setContextWindowDraft((draft) => ({
        ...draft,
        [model.id]: model.contextWindow?.toString() ?? ''
      }))
      return
    }
    if (next === (model.contextWindow ?? null)) return
    try {
      await upsertLlmProviderModel(providerId, { id: model.id, contextWindow: next })
      await invalidate()
    } catch (err) {
      toastError(t('settings.providers.models.title'), errorMessage(err))
      setContextWindowDraft((draft) => ({
        ...draft,
        [model.id]: model.contextWindow?.toString() ?? ''
      }))
    }
  }

  async function handleManualAdd(): Promise<void> {
    const id = manualId.trim()
    if (!id) return
    setAdding(true)
    try {
      await upsertLlmProviderModel(providerId, { id, enabled: true })
      setManualId('')
      await invalidate()
    } catch (err) {
      toastError(t('settings.providers.models.title'), errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(modelId: string): Promise<void> {
    try {
      await deleteLlmProviderModel(providerId, modelId)
      await invalidate()
    } catch (err) {
      toastError(t('settings.providers.models.title'), errorMessage(err))
    }
  }

  return (
    <div className="pt-2">
      <div className="flex items-center justify-between pb-2">
        <span className="text-meta font-mono uppercase tracking-wider text-ink-fg-2">
          {t('settings.providers.models.title')}
        </span>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing || readOnly}
          className="flex items-center gap-1 text-xs text-ink-fg-2 transition-colors hover:text-ink-fg disabled:opacity-40"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {refreshing
            ? t('settings.providers.models.refreshing')
            : t('settings.providers.models.refresh')}
        </button>
      </div>
      {fetchError && (
        <div className="mb-2 rounded bg-fail/10 px-2 py-1.5 text-aux text-fail">{fetchError}</div>
      )}
      {isLoading ? (
        <div className="flex items-center gap-2 py-2 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.providers.models.loading')}
        </div>
      ) : models.length === 0 ? (
        <div className="py-2 text-aux text-ink-fg-3">{t('settings.providers.models.empty')}</div>
      ) : (
        <div className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
          {models.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-ink-3">
              <Checkbox
                disabled={readOnly}
                checked={m.enabled}
                onCheckedChange={(checked) => void handleToggle(m.id, checked === true)}
                aria-label={m.id}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-fg">
                {m.id}
              </span>
              <CapabilityTags model={m} />
              {m.source === 'manual' && (
                <span className="rounded bg-ink-3 px-1 py-0.5 text-meta text-ink-fg-3">
                  {t('settings.providers.models.manualBadge')}
                </span>
              )}
              <Input
                type="number"
                disabled={readOnly}
                value={maxOutputDraft[m.id] ?? m.maxOutput?.toString() ?? ''}
                placeholder={t('settings.providers.models.maxOutputPlaceholder')}
                onChange={(e) => setMaxOutputDraft((d) => ({ ...d, [m.id]: e.target.value }))}
                onBlur={(e) => void handleMaxOutputBlur(m, e.target.value)}
                className="h-6 w-[92px] px-1.5 text-[11px]"
                aria-label={t('settings.providers.models.maxOutputAria', { model: m.id })}
              />
              <Input
                type="number"
                disabled={readOnly}
                value={contextWindowDraft[m.id] ?? m.contextWindow?.toString() ?? ''}
                placeholder={t('settings.providers.models.contextWindowPlaceholder')}
                onChange={(e) =>
                  setContextWindowDraft((draft) => ({ ...draft, [m.id]: e.target.value }))
                }
                onBlur={(e) => void handleContextWindowBlur(m, e.target.value)}
                className="h-6 w-[92px] px-1.5 text-[11px]"
                aria-label={t('settings.providers.models.contextWindowAria', { model: m.id })}
              />
              {!readOnly && (
                <button
                  onClick={() => void handleDelete(m.id)}
                  aria-label={t('settings.providers.models.deleteAria', { model: m.id })}
                  className="rounded p-0.5 text-ink-fg-3 transition-colors hover:bg-ink-3 hover:text-ink-fg"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {/* 手动添加（中转不透传 /models 时的兜底，source='manual'） */}
      <div className="mt-2 flex items-center gap-2">
        <Input
          disabled={readOnly || adding}
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleManualAdd()
          }}
          placeholder={t('settings.providers.models.manualPlaceholder')}
          className="h-7 flex-1 font-mono text-[12px]"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={readOnly || adding || manualId.trim().length === 0}
          onClick={() => void handleManualAdd()}
        >
          {adding ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          {t('settings.providers.models.manualAdd')}
        </Button>
      </div>
    </div>
  )
}
