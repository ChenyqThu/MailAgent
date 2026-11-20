import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  Trash2,
  X
} from 'lucide-react'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { PROVIDER_ICON_PRESETS } from '@shared/components/providers/modelSelect.lib'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { Switch } from '@shared/components/ui/switch'
import {
  deleteLlmProvider,
  testLlmProvider,
  updateLlmProvider,
  useLlmProviderModels,
  type LlmProviderSummary,
  type LlmProviderTestResult
} from '@shared/hooks/useLlmProviders'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { isOpencodeBaseUrl } from '@shared/lib/opencodeSession'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { ProviderModelsPanel } from './ProviderModelsPanel'
import { AI_TAB_ANCHOR_IDS } from '../aiTabAnchors'

function FieldRow({
  label,
  children
}: {
  label: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="shrink-0 pt-1 text-aux text-ink-fg-1 sm:w-[110px]">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** 增量式 Header 编辑器：底层走 PATCH headerPatch，增删改单键绝不动未改动的高敏 Header。 */
function IncrementalHeadersEditor({
  headerNames,
  readOnly,
  onPatch
}: {
  headerNames: readonly string[]
  readOnly: boolean
  onPatch: (patch: Record<string, string | null>) => Promise<boolean>
}): React.ReactElement {
  const { t } = useTranslation()
  const [draftValues, setDraftValues] = React.useState<Record<string, string>>({})
  const [newKey, setNewKey] = React.useState('')
  const [newValue, setNewValue] = React.useState('')

  async function saveExisting(name: string): Promise<void> {
    const val = draftValues[name] ?? ''
    if (!val) return
    const ok = await onPatch({ [name]: val })
    if (ok) {
      setDraftValues((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      toastSuccess(t('settings.providers.headers.updated'))
    }
  }

  async function removeHeader(name: string): Promise<void> {
    const ok = await onPatch({ [name]: null })
    if (ok) toastSuccess(t('settings.providers.headers.updated'))
  }

  async function addNewHeader(): Promise<void> {
    const k = newKey.trim()
    if (!k || !newValue) return
    const ok = await onPatch({ [k]: newValue })
    if (ok) {
      setNewKey('')
      setNewValue('')
      toastSuccess(t('settings.providers.headers.updated'))
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-aux text-ink-fg-3">{t('settings.providers.headers.incrementalHint')}</p>
      {headerNames.map((name) => {
        const val = draftValues[name] ?? ''
        return (
          <div key={name} className="flex items-center gap-1.5">
            <span className="w-[140px] shrink-0 truncate font-mono text-[12px] text-ink-fg-2">
              {name}
            </span>
            <Input
              type="password"
              disabled={readOnly}
              value={val}
              placeholder={t('settings.providers.headers.setPlaceholder')}
              onChange={(e) => setDraftValues((prev) => ({ ...prev, [name]: e.target.value }))}
              className="h-7 flex-1 font-mono text-[12px]"
              aria-label={name}
            />
            {!readOnly && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={val.length === 0}
                  onClick={() => void saveExisting(name)}
                >
                  {t('settings.providers.headers.update')}
                </Button>
                <button
                  type="button"
                  onClick={() => void removeHeader(name)}
                  aria-label={t('settings.providers.headers.deleteAria', { name })}
                  className="rounded p-1 text-ink-fg-3 transition-colors hover:bg-ink-3 hover:text-fail"
                >
                  <X className="size-3.5" />
                </button>
              </>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <div className="flex items-center gap-1.5 pt-0.5">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder={t('settings.providers.headers.keyPlaceholder')}
            className="h-7 w-[140px] shrink-0 font-mono text-[12px]"
          />
          <Input
            type="password"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder={t('settings.providers.headers.valuePlaceholder')}
            className="h-7 flex-1 font-mono text-[12px]"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={newKey.trim().length === 0 || newValue.length === 0}
            onClick={() => void addNewHeader()}
          >
            <Plus className="size-3" />
            {t('settings.providers.headers.add')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function ProviderDetailPane({
  provider,
  readOnly,
  onDeleted
}: {
  provider: LlmProviderSummary
  readOnly: boolean
  onDeleted?: (deletedId: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { models } = useLlmProviderModels(provider.id, true)

  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<LlmProviderTestResult | null>(null)
  const [selectedTestModel, setSelectedTestModel] = React.useState<string>('__auto__')

  const [nameDraft, setNameDraft] = React.useState(provider.displayName)
  const [baseUrlDraft, setBaseUrlDraft] = React.useState(provider.baseUrl)
  const [keyDraft, setKeyDraft] = React.useState('')
  const [showKey, setShowKey] = React.useState(false)

  const [iconOpen, setIconOpen] = React.useState(false)
  const [customIconDraft, setCustomIconDraft] = React.useState(provider.customIcon ?? '')

  const [poolOpen, setPoolOpen] = React.useState((provider.extraKeyLast4s?.length ?? 0) > 0)
  const [extraKeysText, setExtraKeysText] = React.useState('')
  const [headersOpen, setHeadersOpen] = React.useState(provider.headerNames.length > 0)
  const isLocalNoKey = provider.id === 'ollama' || provider.id === 'lmstudio'
  const keyReadyOnMount = provider.hasKey || isLocalNoKey
  const [activeTab, setActiveTab] = React.useState<'models' | 'connection'>(() =>
    keyReadyOnMount && (provider.totalModelCount ?? 0) > 0 ? 'models' : 'connection'
  )

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: qk.llm.providers() })
    await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
  }

  async function patch(patchBody: Parameters<typeof updateLlmProvider>[1]): Promise<boolean> {
    setBusy(true)
    try {
      await updateLlmProvider(provider.id, patchBody)
      await invalidate()
      return true
    } catch (err) {
      toastError(provider.displayName || provider.id, errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitPrimaryKey(): Promise<void> {
    const trimmed = keyDraft.trim()
    if (!trimmed) return
    const ok = await patch({ apiKey: trimmed })
    if (ok) {
      setKeyDraft('')
      toastSuccess(t('settings.providers.apiKey.saved'))
    }
  }

  async function submitExtraPool(): Promise<void> {
    const keys = extraKeysText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const ok = await patch({ extraApiKeys: keys })
    if (ok) {
      setExtraKeysText('')
      toastSuccess(t('settings.providers.keyPool.saved'))
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy(true)
    try {
      await deleteLlmProvider(provider.id)
      toastSuccess(t('settings.providers.deleted', { name: provider.displayName || provider.id }))
      await invalidate()
      onDeleted?.(provider.id)
    } catch (err) {
      toastError(provider.displayName || provider.id, errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      const modelId = selectedTestModel === '__auto__' ? undefined : selectedTestModel
      setTestResult(await testLlmProvider(provider.id, modelId))
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const keyPlaceholder = provider.hasKey
    ? t('settings.providers.apiKey.set', { last4: provider.keyLast4 ?? '····' })
    : t('settings.providers.apiKey.unset')

  const totalKeyCount = provider.keyCount ?? (provider.hasKey ? 1 : 0)
  const modelEnabledCount =
    models.length > 0 ? models.filter((m) => m.enabled).length : (provider.enabledModelCount ?? 0)
  const modelTotalCount = models.length > 0 ? models.length : (provider.totalModelCount ?? 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 弹窗顶栏：图标选择器 + 名称/协议 + 快速测试连接 + 启停开关 + 删除 */}
      <div className="shrink-0 border-b border-ink-border-soft bg-ink-1 px-6 py-4 pr-14">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Popover open={iconOpen} onOpenChange={setIconOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={readOnly}
                  aria-label={t('settings.providers.iconPicker.buttonAria')}
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-ink-border-soft bg-ink-2 transition-colors hover:border-ink-border-strong disabled:cursor-default"
                >
                  <ProviderBrandIcon
                    customIcon={provider.customIcon}
                    providerId={provider.id}
                    protocol={provider.protocol}
                    variant="color"
                    className="size-5"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[272px] p-3">
                <div className="mb-2 text-aux font-medium text-ink-fg">
                  {t('settings.providers.iconPicker.title')}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {PROVIDER_ICON_PRESETS.map((slug) => (
                    <button
                      key={slug}
                      type="button"
                      title={slug}
                      onClick={() => {
                        void patch({ customIcon: slug }).then((ok) => {
                          if (ok) {
                            setCustomIconDraft(slug)
                            setIconOpen(false)
                          }
                        })
                      }}
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded border transition-colors',
                        provider.customIcon === slug
                          ? 'border-coral/60 bg-coral/10'
                          : 'border-transparent hover:bg-ink-3'
                      )}
                    >
                      <ProviderBrandIcon
                        customIcon={slug}
                        providerId={slug}
                        variant="color"
                        className="size-4"
                      />
                    </button>
                  ))}
                </div>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <Input
                    value={customIconDraft}
                    onChange={(e) => setCustomIconDraft(e.target.value)}
                    placeholder={t('settings.providers.iconPicker.customPlaceholder')}
                    className="h-7 flex-1 text-aux"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!customIconDraft.trim()}
                    onClick={() => {
                      void patch({ customIcon: customIconDraft.trim() }).then((ok) => {
                        if (ok) setIconOpen(false)
                      })
                    }}
                  >
                    {t('settings.providers.iconPicker.apply')}
                  </Button>
                  {provider.customIcon && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void patch({ customIcon: null }).then((ok) => {
                          if (ok) {
                            setCustomIconDraft('')
                            setIconOpen(false)
                          }
                        })
                      }}
                    >
                      {t('settings.providers.iconPicker.reset')}
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-lead font-semibold text-ink-fg">
                  {provider.displayName || provider.id}
                </span>
                <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta text-ink-fg-2">
                  {provider.protocol}
                </span>
                {provider.isDefault && (
                  <span className="rounded bg-ink-3 px-1.5 py-0.5 text-aux leading-none text-ink-fg-3">
                    {t('settings.providers.defaultBadge')}
                  </span>
                )}
                {totalKeyCount > 1 && (
                  <span className="rounded bg-coral/15 px-1.5 py-0.5 font-mono text-meta text-coral">
                    {t('settings.providers.keyPool.countBadge', { count: totalKeyCount })}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-micro text-ink-fg-3">{provider.id}</div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testing || readOnly}
              onClick={() => void handleTest()}
            >
              {testing ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t('settings.providers.test.running')}
                </>
              ) : (
                <>
                  <Plug className="size-3.5" />
                  {t('settings.providers.test.button')}
                </>
              )}
            </Button>
            <Switch
              checked={provider.enabled}
              disabled={readOnly || busy}
              onCheckedChange={(v: boolean) => void patch({ enabled: v })}
              aria-label={t('settings.providers.enabledAria', {
                name: provider.displayName || provider.id
              })}
            />
            {!provider.isDefault && !readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void handleDelete()}
                aria-label={t('settings.providers.deleteAria', {
                  name: provider.displayName || provider.id
                })}
              >
                <Trash2 className="size-3.5 text-ink-fg-2 hover:text-fail" />
              </Button>
            )}
          </div>
        </div>

        {testResult && (
          <div className="mt-2.5 flex items-center">
            {testResult.ok ? (
              <span className="rounded bg-ok/15 px-2.5 py-0.5 text-aux text-ok">
                {typeof testResult.latencyMs === 'number'
                  ? t('settings.providers.test.ok', { ms: testResult.latencyMs })
                  : t('settings.providers.test.okNoLatency')}
              </span>
            ) : (
              <span
                className="max-w-full truncate rounded bg-fail/10 px-2.5 py-0.5 text-aux text-fail"
                title={testResult.error ?? ''}
              >
                {testResult.error ?? t('settings.providers.test.fail')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 双 Tab 切换：模型列表 vs 连接与安全 */}
      <div
        role="tablist"
        aria-label={provider.displayName || provider.id}
        className="flex shrink-0 items-center gap-1.5 border-b border-ink-border-soft bg-ink-2/35 px-6 py-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'models'}
          onClick={() => setActiveTab('models')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-aux transition-colors',
            activeTab === 'models'
              ? 'bg-ink-1 font-medium text-ink-fg shadow-sm'
              : 'text-ink-fg-2 hover:bg-ink-2 hover:text-ink-fg'
          )}
        >
          <span>{t('settings.providers.modalTabs.models')}</span>
          {modelTotalCount > 0 && (
            <span className="font-mono text-meta tabular-nums text-ink-fg-3">
              {`${modelEnabledCount}/${modelTotalCount}`}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'connection'}
          onClick={() => setActiveTab('connection')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-aux transition-colors',
            activeTab === 'connection'
              ? 'bg-ink-1 font-medium text-ink-fg shadow-sm'
              : 'text-ink-fg-2 hover:bg-ink-2 hover:text-ink-fg'
          )}
        >
          <span>{t('settings.providers.modalTabs.connection')}</span>
        </button>
      </div>

      {/* 弹窗滚动内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-thin">
        {activeTab === 'models' ? (
          <ProviderModelsPanel
            providerId={provider.id}
            protocol={provider.protocol}
            readOnly={readOnly}
          />
        ) : (
          <div className="divide-y divide-ink-border-soft">
            {/* 通栏双列：名称 + API 地址 */}
            <div className="grid grid-cols-1 gap-3 pb-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-aux text-ink-fg-1">{t('settings.providers.displayName')}</span>
                <Input
                  disabled={readOnly || busy}
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => {
                    if (nameDraft !== provider.displayName) void patch({ displayName: nameDraft })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nameDraft !== provider.displayName) {
                      void patch({ displayName: nameDraft })
                    }
                  }}
                  className="h-8 w-full"
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-aux text-ink-fg-1">{t('settings.providers.baseUrl')}</span>
                <Input
                  disabled={readOnly || busy}
                  value={baseUrlDraft}
                  placeholder={t('settings.providers.baseUrlPlaceholder')}
                  onChange={(e) => setBaseUrlDraft(e.target.value)}
                  onBlur={() => {
                    if (baseUrlDraft !== provider.baseUrl) void patch({ baseUrl: baseUrlDraft })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && baseUrlDraft !== provider.baseUrl) {
                      void patch({ baseUrl: baseUrlDraft })
                    }
                  }}
                  className="h-8 w-full font-mono text-[12px]"
                />
                {isOpencodeBaseUrl(baseUrlDraft) && (
                  <p className="mt-1 text-aux text-ink-fg-3">
                    {t('settings.providers.headers.opencodeSessionHint')}
                  </p>
                )}
              </div>
            </div>

            <FieldRow label={t('settings.providers.apiKey.label')}>
              <div className="flex max-w-xl flex-wrap items-center gap-1.5">
                <div className="relative min-w-[180px] flex-1">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    disabled={readOnly || busy}
                    value={keyDraft}
                    placeholder={keyPlaceholder}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onBlur={() => {
                      if (keyDraft.trim().length > 0 && !busy) void submitPrimaryKey()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitPrimaryKey()
                    }}
                    className="h-8 pr-8"
                    aria-label={t('settings.providers.apiKey.label')}
                  />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={
                      showKey
                        ? t('settings.providers.apiKey.hideAria')
                        : t('settings.providers.apiKey.showAria')
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-fg-3 hover:text-ink-fg"
                  >
                    {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                {!readOnly && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy || keyDraft.trim().length === 0}
                    onClick={() => void submitPrimaryKey()}
                  >
                    {t('settings.providers.apiKey.save')}
                  </Button>
                )}
                {provider.hasKey && !readOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void patch({ apiKey: null })}
                    aria-label={t('settings.providers.apiKey.clearAria')}
                  >
                    {t('settings.providers.apiKey.clear')}
                  </Button>
                )}
              </div>
            </FieldRow>

            {/* 多 Key 429 冷却轮换池 */}
            <div className="py-2">
              <button
                type="button"
                onClick={() => setPoolOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left text-aux text-ink-fg-1 hover:text-ink-fg"
              >
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className="size-3.5 text-ink-fg-3" />
                  {t('settings.providers.keyPool.title')}
                  {(provider.extraKeyLast4s?.length ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1">
                      {provider.extraKeyLast4s?.map((last4, idx) => (
                        <span
                          key={`${last4}-${idx}`}
                          className="rounded bg-ink-3 px-1 py-0.5 font-mono text-micro text-ink-fg-2"
                        >
                          ····{last4}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={cn('size-3.5 text-ink-fg-3 transition-transform', !poolOpen && '-rotate-90')}
                />
              </button>
              {poolOpen && (
                <div className="mt-2 flex flex-col gap-2 pl-5">
                  <p className="text-aux text-ink-fg-3">{t('settings.providers.keyPool.helper')}</p>
                  <textarea
                    rows={3}
                    disabled={readOnly || busy}
                    value={extraKeysText}
                    onChange={(e) => setExtraKeysText(e.target.value)}
                    placeholder={t('settings.providers.keyPool.placeholder')}
                    className="w-full max-w-xl rounded-md border border-ink-border bg-ink-2 p-2 font-mono text-[12px] text-ink-fg placeholder:text-ink-fg-3 focus:outline-none focus:ring-2 focus:ring-coral/70"
                  />
                  {!readOnly && (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busy || extraKeysText.trim().length === 0}
                        onClick={() => void submitExtraPool()}
                      >
                        {t('settings.providers.keyPool.save')}
                      </Button>
                      {(provider.extraKeyLast4s?.length ?? 0) > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void patch({ extraApiKeys: [] })}
                        >
                          {t('settings.providers.keyPool.clear')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 增量自定义 Header */}
            <div className="py-2">
              <button
                type="button"
                onClick={() => setHeadersOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left text-aux text-ink-fg-1 hover:text-ink-fg"
              >
                <span className="inline-flex items-center gap-2">
                  <span>{t('settings.providers.headers.label')}</span>
                  {provider.headerNames.length > 0 && (
                    <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta text-ink-fg-2">
                      {provider.headerNames.length}
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={cn(
                    'size-3.5 text-ink-fg-3 transition-transform',
                    !headersOpen && '-rotate-90'
                  )}
                />
              </button>
              {headersOpen && (
                <div className="mt-2 pl-1">
                  <IncrementalHeadersEditor
                    headerNames={provider.headerNames}
                    readOnly={readOnly || busy}
                    onPatch={(hp) => patch({ headerPatch: hp })}
                  />
                </div>
              )}
            </div>

            {/* 出站隐私占位符脱敏 */}
            <FieldRow label={t('settings.providers.privacyMask.label')}>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={provider.privacyMaskEnabled === true}
                    disabled={readOnly || busy}
                    onCheckedChange={(v: boolean) => void patch({ privacyMaskEnabled: v })}
                    aria-label={t('settings.providers.privacyMask.aria', {
                      name: provider.displayName || provider.id
                    })}
                  />
                  <a
                    href={`#${AI_TAB_ANCHOR_IDS.privacyMask}`}
                    className="text-aux text-coral hover:underline"
                  >
                    {t('settings.providers.privacyMask.configureRules')}
                  </a>
                </div>
                <p className="text-aux text-ink-fg-3">{t('settings.providers.privacyMask.helper')}</p>
              </div>
            </FieldRow>

            {/* 指定探测模型（搭配顶部测试连接按钮使用） */}
            {models.length > 0 && (
              <FieldRow label={t('settings.providers.test.modelAria')}>
                <Select value={selectedTestModel} onValueChange={setSelectedTestModel}>
                  <SelectTrigger
                    className="h-8 w-[240px]"
                    aria-label={t('settings.providers.test.modelAria')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">
                      {t('settings.providers.test.modelAuto')}
                    </SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="font-mono text-[12px]">
                        {m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
