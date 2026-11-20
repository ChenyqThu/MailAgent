// task 07-12 P3 & Magpie Workbench Upgrade — Settings「模型服务」纵向服务商列表 + 配置弹窗。
//
// 仅在 /chat/config.providerRegistryEnabled=true 时由 AiTab 渲染（flag off → 旧「LLM 网关」
// 字节级不变）。远程 web 全区只读渲染（写端点 verify_local_token → 远程 403，双保险）。
//
// 布局：
//   - 纵向紧凑可拖拽列表（@dnd-kit/sortable）：品牌图标 + 名称/协议/默认 + 健康状态/模型计数 +
//     行内启停开关 + 「配置」按钮（不撑高页面，下方全局模型与翻译区块一屏可见）。
//   - 点击任意行或「配置」弹出 820px 宽弹窗，内部「模型列表 / 连接与安全」双 Tab 分离，
//     模型表格独享完整弹窗宽度。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronRight, GripVertical, Loader2, Plus, RefreshCw } from 'lucide-react'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Switch } from '@shared/components/ui/switch'
import {
  reorderLlmProviders,
  updateLlmProvider,
  useLlmProviders,
  type LlmProviderSummary
} from '@shared/hooks/useLlmProviders'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useModelCatalogStatus } from '@shared/modelCatalog/useModelCatalog'
import { toastError, toastSuccess } from '@shared/state/toast'

import { AI_TAB_ANCHOR_SCROLL_MT, llmProviderAnchorId } from '../aiTabAnchors'
import { Section } from '../parts/Section'
import { AddProviderDialog } from './AddProviderDialog'
import { ProviderDetailPane } from './ProviderDetailPane'

function isWebBuild(): boolean {
  return (
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'
  )
}

function providerIdFromAnchor(anchorId: string): string | null {
  const prefix = llmProviderAnchorId('')
  return anchorId.startsWith(prefix) ? anchorId.slice(prefix.length) : null
}

function SortableProviderRow({
  provider,
  readOnly,
  toggling,
  onOpen,
  onToggleEnabled
}: {
  provider: LlmProviderSummary
  readOnly: boolean
  toggling: boolean
  onOpen: () => void
  onToggleEnabled: (enabled: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: provider.id,
    disabled: readOnly
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  const isLocalNoKey = provider.id === 'ollama' || provider.id === 'lmstudio'
  const keyHealthy = provider.hasKey || isLocalNoKey
  const enabledCount = provider.enabledModelCount ?? 0
  const totalCount = provider.totalModelCount ?? 0

  const statusLabel = !provider.enabled
    ? t('settings.providers.disabledBadge')
    : isLocalNoKey && !provider.hasKey
      ? t('settings.providers.localNoKeyBadge')
      : provider.hasKey
        ? t('settings.providers.keyConfiguredBadge')
        : t('settings.providers.keyMissingBadge')

  return (
    <div
      ref={setNodeRef}
      style={style}
      id={llmProviderAnchorId(provider.id)}
      className={cn(
        'group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-ink-2/60',
        AI_TAB_ANCHOR_SCROLL_MT,
        isDragging && 'relative z-10 rounded-lg bg-ink-2 opacity-75 shadow-sm'
      )}
    >
      {!readOnly && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('settings.providers.dragAria', {
            name: provider.displayName || provider.id
          })}
          className="-ml-1 shrink-0 cursor-grab touch-none rounded p-1 text-ink-fg-3 opacity-55 transition-opacity hover:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>
      )}

      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-ink-border-soft bg-ink-2">
          <ProviderBrandIcon
            customIcon={provider.customIcon}
            providerId={provider.id}
            protocol={provider.protocol}
            variant="color"
            className="size-5 shrink-0"
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-body font-medium text-ink-fg">
              {provider.displayName || provider.id}
            </span>
            <span className="shrink-0 rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta text-ink-fg-2">
              {provider.protocol}
            </span>
            {provider.isDefault && (
              <span className="shrink-0 whitespace-nowrap rounded bg-ink-3 px-1.5 py-0.5 text-aux leading-none text-ink-fg-2">
                {t('settings.providers.defaultBadge')}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                !provider.enabled ? 'bg-ink-fg-3/50' : keyHealthy ? 'bg-ok' : 'bg-warn'
              )}
            />
            <span className="text-aux text-ink-fg-3">{statusLabel}</span>
            {totalCount > 0 && (
              <span className="font-mono text-meta tabular-nums text-ink-fg-3">
                {`${enabledCount}/${totalCount}`}
              </span>
            )}
          </div>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-2.5">
        <Switch
          checked={provider.enabled}
          disabled={readOnly || toggling}
          onCheckedChange={onToggleEnabled}
          aria-label={t('settings.providers.enabledAria', {
            name: provider.displayName || provider.id
          })}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onOpen}
          aria-label={t('settings.providers.configureAria', {
            name: provider.displayName || provider.id
          })}
        >
          <span>{t('settings.providers.configureButton')}</span>
          <ChevronRight className="size-3.5 text-ink-fg-2" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

export function ModelServicesSection(): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isWeb = isWebBuild()
  const { providers, isLoading, isError } = useLlmProviders(true)
  const catalog = useModelCatalogStatus()

  const [editingProviderId, setEditingProviderId] = React.useState<string | null>(null)
  const [togglingId, setTogglingId] = React.useState<string | null>(null)
  const [addOpen, setAddOpen] = React.useState(false)

  // 监听来自 ModelPicker 齿轮跳锚点的选择事件（深链直达某家配置弹窗）。
  React.useEffect(() => {
    const pickFromAnchor = (anchorId: string): void => {
      const pid = providerIdFromAnchor(anchorId)
      if (pid) setEditingProviderId(pid)
    }
    if (typeof window !== 'undefined' && window.location.hash) {
      pickFromAnchor(window.location.hash.slice(1))
    }
    const onFocusAnchor = (evt: Event): void => {
      const id = (evt as CustomEvent<string>).detail
      if (typeof id === 'string') pickFromAnchor(id)
    }
    const onHash = (): void => {
      pickFromAnchor(window.location.hash.slice(1))
    }
    window.addEventListener('mailagent:focus-anchor', onFocusAnchor)
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('mailagent:focus-anchor', onFocusAnchor)
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  const editingProvider = React.useMemo(
    () => (editingProviderId ? providers.find((p) => p.id === editingProviderId) ?? null : null),
    [providers, editingProviderId]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    if (isWeb) return
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = providers.findIndex((p) => p.id === active.id)
    const newIndex = providers.findIndex((p) => p.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const nextOrder = arrayMove(providers, oldIndex, newIndex).map((p) => p.id)
    try {
      await reorderLlmProviders(nextOrder)
      await qc.invalidateQueries({ queryKey: qk.llm.providers() })
    } catch (err) {
      toastError(t('settings.providers.title'), errorMessage(err))
    }
  }

  async function handleToggleEnabled(provider: LlmProviderSummary, next: boolean): Promise<void> {
    setTogglingId(provider.id)
    try {
      await updateLlmProvider(provider.id, { enabled: next })
      await qc.invalidateQueries({ queryKey: qk.llm.providers() })
      await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
    } catch (err) {
      toastError(provider.displayName || provider.id, errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleCatalogRefresh(): Promise<void> {
    const ok = await catalog.forceRefresh()
    if (ok) {
      toastSuccess(t('settings.providers.catalogUpdated'))
    } else if (catalog.lastError) {
      toastError(t('settings.providers.catalogSyncFailed'), catalog.lastError)
    } else {
      toastSuccess(t('settings.providers.catalogUpToDate'))
    }
  }

  let content: React.ReactNode
  if (isError) {
    content = (
      <div className="px-4 py-3.5 text-aux text-ink-fg-3">
        {t('settings.providers.loadError')}
      </div>
    )
  } else if (isLoading) {
    content = (
      <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        {t('settings.providers.loading')}
      </div>
    )
  } else if (providers.length === 0) {
    content = (
      <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.providers.empty')}</div>
    )
  } else {
    content = (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(evt) => void handleDragEnd(evt)}
      >
        <SortableContext
          items={providers.map((p) => p.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="divide-y divide-ink-border-soft">
            {providers.map((p) => (
              <SortableProviderRow
                key={p.id}
                provider={p}
                readOnly={isWeb}
                toggling={togglingId === p.id}
                onOpen={() => setEditingProviderId(p.id)}
                onToggleEnabled={(v) => void handleToggleEnabled(p, v)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    )
  }

  return (
    <Section
      title={t('settings.providers.title')}
      helper={t('settings.providers.helper')}
      meta={
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={catalog.refreshing}
            onClick={() => void handleCatalogRefresh()}
            title={t('settings.providers.catalogRefresh')}
            className="inline-flex items-center gap-1 text-aux text-ink-fg-3 transition-colors hover:text-ink-fg disabled:opacity-50"
          >
            {catalog.refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            <span className="font-mono text-meta">{catalog.generatedAt}</span>
          </button>
          {!isWeb && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="flex items-center gap-1 text-aux font-medium text-ink-fg-2 transition-colors hover:text-ink-fg"
            >
              <Plus className="size-3.5" />
              {t('settings.providers.addButton')}
            </button>
          )}
        </div>
      }
    >
      {content}

      <Dialog
        open={editingProvider !== null}
        onOpenChange={(open) => {
          if (!open) setEditingProviderId(null)
        }}
      >
        <DialogContent className="flex max-h-[85vh] w-[92vw] max-w-[820px] flex-col gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">
            {editingProvider ? editingProvider.displayName || editingProvider.id : ''}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('settings.providers.helper')}
          </DialogDescription>
          {editingProvider && (
            <ProviderDetailPane
              key={editingProvider.id}
              provider={editingProvider}
              readOnly={isWeb}
              onDeleted={() => setEditingProviderId(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {!isWeb && (
        <AddProviderDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          existingIds={providers.map((p) => p.id)}
          onCreated={(createdId) => setEditingProviderId(createdId)}
        />
      )}
    </Section>
  )
}
