// task 07-12 P3 & Magpie Workbench Upgrade — per-provider 模型管理面板。
//
// 保留 ProviderModelsPanel.test.tsx 核心契约：
//   - 元数据来自 composeComposerModelOption（DB 行 > models.dev 目录 > 裸 id）
//   - maxOutput / contextWindow 的目录值只进 placeholder，value 在 DB 为 null 时保持 ''
//   - aria-label 保持 settings.providers.models.{maxOutputAria,contextWindowAria}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'

import { formatTokens } from '@shared/assistant/components/modelDetailCard.lib'
import { inferModelFamily } from '@shared/components/providers/modelSelect.lib'
import { composeComposerModelOption } from '@shared/hooks/useComposerModels'
import { useModelCatalogRevision } from '@shared/modelCatalog/useModelCatalog'
import {
  batchUpdateLlmProviderModels,
  deleteLlmProviderModel,
  refreshLlmProviderModels,
  upsertLlmProviderModel,
  useLlmProviderModels,
  type LlmModelCapabilities,
  type LlmProviderModel,
  type LlmProviderProtocol
} from '@shared/hooks/useLlmProviders'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Input } from '@shared/components/ui/input'

type ModelFilter = 'all' | 'enabled' | 'reasoning' | 'vision'

function mergeWithCatalog(
  providerId: string,
  protocol: LlmProviderProtocol | null,
  model: LlmProviderModel
): ReturnType<typeof composeComposerModelOption> {
  return composeComposerModelOption({
    ref: `${providerId}:${model.id}`,
    providerId,
    providerLabel: null,
    protocol,
    modelId: model.id,
    rowDisplayName: model.displayName,
    rowCapabilities: model.capabilities,
    rowMaxOutput: model.maxOutput,
    rowContextWindow: model.contextWindow
  })
}

function hasAnyActiveCapability(capabilities: LlmModelCapabilities | null): boolean {
  if (!capabilities) return false
  return Boolean(capabilities.tools || capabilities.vision || capabilities.reasoning)
}

/** capabilities 标签：仅显式 true 的能力位渲染 chip；null（未标注）→ 整块不渲染。 */
function CapabilityTags({
  capabilities
}: {
  capabilities: LlmModelCapabilities | null
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (capabilities === null) return null
  const entries: Array<[string, string, string]> = [
    ['tools', t('settings.providers.models.cap.tools'), 'bg-ok/12 text-ok'],
    ['vision', t('settings.providers.models.cap.vision'), 'bg-info/12 text-info'],
    ['reasoning', t('settings.providers.models.cap.reasoning'), 'bg-ai/12 text-ai']
  ]
  const active = entries.filter(([k]) => (capabilities as Record<string, unknown>)[k] === true)
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {active.map(([k, label, cls]) => (
        <span
          key={k}
          className={cn('shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-aux leading-none', cls)}
        >
          {label}
        </span>
      ))}
    </span>
  )
}

export function ProviderModelsPanel({
  providerId,
  protocol,
  readOnly
}: {
  providerId: string
  protocol: LlmProviderProtocol | null
  readOnly: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { models, isLoading } = useLlmProviderModels(providerId, true)
  useModelCatalogRevision()
  const [refreshing, setRefreshing] = React.useState(false)
  const [batchBusy, setBatchBusy] = React.useState(false)
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [manualId, setManualId] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState<ModelFilter>('all')
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({})
  const [maxOutputDraft, setMaxOutputDraft] = React.useState<Record<string, string>>({})
  const [contextWindowDraft, setContextWindowDraft] = React.useState<Record<string, string>>({})

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: qk.llm.providerModels(providerId) })
    await qc.invalidateQueries({ queryKey: qk.llm.providers() })
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

  const enriched = React.useMemo(
    () =>
      models.map((m) => ({
        model: m,
        merged: mergeWithCatalog(providerId, protocol, m)
      })),
    [models, providerId, protocol]
  )

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return enriched.filter(({ model, merged }) => {
      if (filter === 'enabled' && !model.enabled) return false
      if (filter === 'reasoning' && merged.capabilities?.reasoning !== true) return false
      if (filter === 'vision' && merged.capabilities?.vision !== true) return false
      if (!q) return true
      return (
        model.id.toLowerCase().includes(q) || merged.displayName.toLowerCase().includes(q)
      )
    })
  }, [enriched, filter, search])

  const hasUnenabledFetched = React.useMemo(
    () => models.some((m) => !m.enabled && m.source === 'fetched'),
    [models]
  )

  async function runBatch(
    action: 'enable' | 'disable' | 'clear_unenabled_fetched',
    modelIds?: string[]
  ): Promise<void> {
    setBatchBusy(true)
    try {
      const res = await batchUpdateLlmProviderModels(providerId, { action, modelIds })
      toastSuccess(t('settings.providers.models.batch.updated', { count: res.affected }))
      await invalidate()
    } catch (err) {
      toastError(t('settings.providers.models.title'), errorMessage(err))
    } finally {
      setBatchBusy(false)
    }
  }

  const useGroups = filtered.length > 12 && !search.trim() && filter === 'all'
  const grouped = React.useMemo(() => {
    if (!useGroups) return []
    const otherLabel = t('settings.providers.models.groupOther')
    const map = new Map<string, typeof filtered>()
    for (const item of filtered) {
      const family = inferModelFamily(item.model.id, item.model.groupName) || otherLabel
      const list = map.get(family) ?? []
      list.push(item)
      map.set(family, list)
    }
    return [...map.entries()].map(([group, items]) => ({ group, items }))
  }, [useGroups, filtered, t])

  const renderRow = ({ model: m, merged }: (typeof filtered)[number]): React.ReactElement => {
    const showHumanTitle = Boolean(
      merged.displayName && merged.displayName.toLowerCase() !== m.id.toLowerCase()
    )
    const showMetaLine =
      showHumanTitle || hasAnyActiveCapability(merged.capabilities) || m.source === 'manual'

    return (
      <div
        key={m.id}
        className="grid grid-cols-[20px_minmax(0,1fr)_88px_88px_28px] items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-ink-2/75"
      >
        <Checkbox
          disabled={readOnly}
          checked={m.enabled}
          onCheckedChange={(checked) => void handleToggle(m.id, checked === true)}
          aria-label={m.id}
        />
        <div className="min-w-0">
          <div className="truncate font-mono text-aux font-medium text-ink-fg" title={m.id}>
            {m.id}
          </div>
          {showMetaLine && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {showHumanTitle && (
                <span className="truncate text-aux text-ink-fg-2">{merged.displayName}</span>
              )}
              <CapabilityTags capabilities={merged.capabilities} />
              {m.source === 'manual' && (
                <span className="shrink-0 whitespace-nowrap rounded bg-ink-3 px-1.5 py-0.5 text-aux leading-none text-ink-fg-2">
                  {t('settings.providers.models.manualBadge')}
                </span>
              )}
            </div>
          )}
        </div>
        <Input
          type="number"
          disabled={readOnly}
          value={maxOutputDraft[m.id] ?? m.maxOutput?.toString() ?? ''}
          placeholder={
            merged.maxOutput !== null
              ? formatTokens(merged.maxOutput)
              : t('settings.providers.models.maxOutputPlaceholder')
          }
          onChange={(e) => setMaxOutputDraft((d) => ({ ...d, [m.id]: e.target.value }))}
          onBlur={(e) => void handleMaxOutputBlur(m, e.target.value)}
          className="h-7 w-[88px] px-2 text-right font-mono text-meta tabular-nums"
          aria-label={t('settings.providers.models.maxOutputAria', { model: m.id })}
        />
        <Input
          type="number"
          disabled={readOnly}
          value={contextWindowDraft[m.id] ?? m.contextWindow?.toString() ?? ''}
          placeholder={
            merged.contextWindow !== null
              ? formatTokens(merged.contextWindow)
              : t('settings.providers.models.contextWindowPlaceholder')
          }
          onChange={(e) =>
            setContextWindowDraft((draft) => ({ ...draft, [m.id]: e.target.value }))
          }
          onBlur={(e) => void handleContextWindowBlur(m, e.target.value)}
          className="h-7 w-[88px] px-2 text-right font-mono text-meta tabular-nums"
          aria-label={t('settings.providers.models.contextWindowAria', { model: m.id })}
        />
        {!readOnly ? (
          <button
            type="button"
            onClick={() => void handleDelete(m.id)}
            aria-label={t('settings.providers.models.deleteAria', { model: m.id })}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-fg-3 transition-colors hover:bg-fail/10 hover:text-fail"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    )
  }

  return (
    <div>
      {/* Header row: 模型计数 + 拉取模型主按钮 */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-aux font-semibold text-ink-fg">
            {t('settings.providers.models.title')}
          </span>
          {models.length > 0 && (
            <span className="rounded bg-ink-2 px-2 py-0.5 font-mono text-meta tabular-nums text-ink-fg-2">
              {models.filter((m) => m.enabled).length}/{models.length}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refreshing || readOnly}
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {refreshing
            ? t('settings.providers.models.refreshing')
            : t('settings.providers.models.refresh')}
        </Button>
      </div>

      {/* Filter & search toolbar + 独立批量操作按钮组 */}
      {models.length > 1 && (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-fg-3" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('settings.providers.models.searchPlaceholder')}
                className="h-8 pl-8 text-aux"
              />
            </div>
            <div className="inline-flex rounded-lg border border-ink-border-soft bg-ink-2 p-0.5">
              {(['all', 'enabled', 'reasoning', 'vision'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-aux transition-colors',
                    filter === key
                      ? 'bg-ink-4 font-medium text-ink-fg shadow-sm'
                      : 'text-ink-fg-2 hover:text-ink-fg'
                  )}
                >
                  {t(`settings.providers.models.filter.${key}`)}
                </button>
              ))}
            </div>
          </div>

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={batchBusy}
                onClick={() =>
                  void runBatch(
                    'enable',
                    filtered.map((item) => item.model.id)
                  )
                }
                className="rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1 text-aux text-ink-fg-2 transition-colors hover:bg-ink-2 hover:text-ink-fg disabled:opacity-40"
              >
                {t('settings.providers.models.batch.enableFiltered')}
              </button>
              <button
                type="button"
                disabled={batchBusy}
                onClick={() => void runBatch('disable')}
                className="rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1 text-aux text-ink-fg-2 transition-colors hover:bg-ink-2 hover:text-ink-fg disabled:opacity-40"
              >
                {t('settings.providers.models.batch.disableAll')}
              </button>
              {hasUnenabledFetched && (
                <button
                  type="button"
                  disabled={batchBusy}
                  onClick={() => void runBatch('clear_unenabled_fetched')}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-1 text-aux text-ink-fg-2 transition-colors hover:border-fail/40 hover:bg-fail/10 hover:text-fail disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" />
                  {t('settings.providers.models.batch.clearUnenabled')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {fetchError && (
        <div className="mb-2 rounded-md bg-fail/10 px-2.5 py-1.5 text-aux text-fail">
          {fetchError}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.providers.models.loading')}
        </div>
      ) : models.length === 0 ? (
        <div className="py-3 text-aux text-ink-fg-3">{t('settings.providers.models.empty')}</div>
      ) : filtered.length === 0 ? (
        <div className="py-3 text-aux text-ink-fg-3">{t('settings.providers.models.noMatch')}</div>
      ) : (
        <div className="rounded-lg border border-ink-border-soft bg-ink-2/25 p-1.5">
          <div className="grid grid-cols-[20px_minmax(0,1fr)_88px_88px_28px] items-center gap-2.5 border-b border-ink-border-soft px-2.5 pb-1.5 pt-1 text-aux text-ink-fg-3">
            <span className="col-span-2 min-w-0">{t('settings.providers.models.colModel')}</span>
            <span className="text-right">{t('settings.providers.models.colMaxOutput')}</span>
            <span className="text-right">{t('settings.providers.models.colContextWindow')}</span>
            <span aria-hidden="true" />
          </div>
          <div className="scrollbar-thin mt-1 flex max-h-[460px] flex-col gap-0.5 overflow-y-auto pr-0.5">
            {useGroups
              ? grouped.map(({ group, items }) => {
                  const isCollapsed = collapsedGroups[group] === true
                  return (
                    <div key={group} className="mb-1">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }))
                        }
                        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-aux font-medium text-ink-fg-2 hover:bg-ink-3"
                      >
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 transition-transform',
                            isCollapsed && '-rotate-90'
                          )}
                        />
                        <span>{group}</span>
                        <span className="font-mono text-meta text-ink-fg-3">{items.length}</span>
                      </button>
                      {!isCollapsed && items.map(renderRow)}
                    </div>
                  )
                })
              : filtered.map(renderRow)}
          </div>
        </div>
      )}

      {/* 手动添加（中转不透传 /models 时的兜底，source='manual'） */}
      <div className="mt-2.5 flex items-center gap-2">
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
