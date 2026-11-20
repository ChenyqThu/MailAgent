import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Eye, EyeOff, Loader2, Plug } from 'lucide-react'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Input } from '@shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import {
  createLlmProvider,
  probeLlmProviderDraft,
  refreshLlmProviderModels,
  type LlmProviderProtocol,
  type LlmProviderTestResult
} from '@shared/hooks/useLlmProviders'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import {
  PROVIDER_TEMPLATES,
  suggestProviderSlug,
  type ProviderTemplate,
  type ProviderTemplateCategory
} from './templates'

type CategoryTab = 'all' | ProviderTemplateCategory

const CATEGORY_TABS: readonly CategoryTab[] = ['all', 'popular', 'cn', 'global', 'local', 'custom']
const PROTOCOLS: readonly LlmProviderProtocol[] = [
  'anthropic',
  'openai',
  'openai-compatible',
  'google',
  'deepseek',
  'openrouter'
]

export function AddProviderDialog({
  open,
  onOpenChange,
  existingIds,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingIds: readonly string[]
  onCreated: (providerId: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [category, setCategory] = React.useState<CategoryTab>('all')
  const [templateKey, setTemplateKey] = React.useState<string>(PROVIDER_TEMPLATES[0].key)
  const template: ProviderTemplate =
    PROVIDER_TEMPLATES.find((p) => p.key === templateKey) ?? PROVIDER_TEMPLATES[0]

  const [id, setId] = React.useState<string>(() =>
    suggestProviderSlug(PROVIDER_TEMPLATES[0].key, existingIds)
  )
  const [protocol, setProtocol] = React.useState<LlmProviderProtocol>(
    PROVIDER_TEMPLATES[0].protocol
  )
  const [displayName, setDisplayName] = React.useState<string>(PROVIDER_TEMPLATES[0].displayName)
  const [baseUrl, setBaseUrl] = React.useState<string>(PROVIDER_TEMPLATES[0].baseUrl)
  const [apiKey, setApiKey] = React.useState('')
  const [showKey, setShowKey] = React.useState(false)
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [probing, setProbing] = React.useState(false)
  const [probeResult, setProbeResult] = React.useState<LlmProviderTestResult | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const visibleTemplates = React.useMemo(
    () =>
      category === 'all'
        ? PROVIDER_TEMPLATES
        : PROVIDER_TEMPLATES.filter((p) => p.category === category),
    [category]
  )

  const templateLabel = (p: ProviderTemplate): string => {
    if (p.custom) return t(`settings.providers.template.${p.key}`)
    if (p.key === 'ollama' || p.key === 'lmstudio' || p.key === 'opencode') {
      return t(`settings.providers.template.${p.key}`, { defaultValue: p.displayName })
    }
    return p.displayName
  }

  function applyTemplate(next: ProviderTemplate): void {
    setTemplateKey(next.key)
    setProtocol(next.protocol)
    setDisplayName(next.custom ? '' : templateLabel(next))
    setBaseUrl(next.baseUrl)
    setId(suggestProviderSlug(next.custom ? 'custom-gw' : next.key, existingIds))
    setProbeResult(null)
    if (next.custom) setShowAdvanced(true)
  }

  const idValid = /^[a-z][a-z0-9_-]{0,40}$/.test(id)
  const baseUrlOk = !template.baseUrlRequired || baseUrl.trim().length > 0
  const canProbe = baseUrlOk && !probing && !submitting
  const canSubmit = idValid && baseUrlOk && !submitting

  async function handleProbe(): Promise<void> {
    setProbing(true)
    setProbeResult(null)
    try {
      const r = await probeLlmProviderDraft({
        protocol,
        baseUrl: baseUrl.trim(),
        ...(apiKey.length > 0 ? { apiKey } : {})
      })
      setProbeResult(r)
    } catch (err) {
      setProbeResult({ ok: false, latencyMs: 0, error: errorMessage(err) })
    } finally {
      setProbing(false)
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await createLlmProvider({
        id,
        protocol,
        displayName: displayName.trim() || id,
        baseUrl: baseUrl.trim(),
        ...(apiKey.length > 0 ? { apiKey } : {})
      })
      // 创建后 best-effort 拉取一次模型清单（中转无 /models 时静默跳过，不影响建行）。
      if (!template.custom || baseUrl.trim().length > 0) {
        await refreshLlmProviderModels(id).catch(() => undefined)
      }
      await qc.invalidateQueries({ queryKey: qk.llm.providers() })
      await qc.invalidateQueries({ queryKey: qk.llm.providerModels(id) })
      await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
      toastSuccess(t('settings.providers.added', { name: displayName.trim() || id }))
      setApiKey('')
      setProbeResult(null)
      onCreated(id)
      onOpenChange(false)
    } catch (err) {
      toastError(t('settings.providers.addTitle'), errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.providers.addTitle')}</DialogTitle>
          <DialogDescription>{t('settings.providers.add.desc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1">
          {CATEGORY_TABS.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={cn(
                'rounded px-2.5 py-1 text-aux transition-colors',
                category === cat
                  ? 'bg-coral/15 text-coral font-medium'
                  : 'text-ink-fg-2 hover:bg-ink-3'
              )}
            >
              {t(`settings.providers.categories.${cat}`)}
            </button>
          ))}
        </div>

        <div className="scrollbar-thin grid max-h-[180px] grid-cols-2 gap-1.5 overflow-y-auto rounded-md border border-ink-border-soft bg-ink-1 p-2 sm:grid-cols-3">
          {visibleTemplates.map((tpl) => {
            const active = tpl.key === templateKey
            return (
              <button
                key={tpl.key}
                type="button"
                onClick={() => applyTemplate(tpl)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-coral/50 bg-coral/10 text-ink-fg'
                    : 'border-transparent bg-ink-2/60 text-ink-fg-1 hover:bg-ink-3'
                )}
              >
                <ProviderBrandIcon
                  providerId={tpl.key}
                  protocol={tpl.protocol}
                  variant="color"
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-aux font-medium">{templateLabel(tpl)}</div>
                  <div className="truncate font-mono text-micro text-ink-fg-3">{tpl.protocol}</div>
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <span className="w-[96px] shrink-0 text-aux text-ink-fg-1">
              {t('settings.providers.displayName')}
            </span>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={templateLabel(template)}
              className="h-8 flex-1"
              aria-label={t('settings.providers.displayName')}
            />
          </div>

          <div className="flex items-center gap-3">
            <span className="w-[96px] shrink-0 text-aux text-ink-fg-1">
              {t('settings.providers.baseUrl')}
            </span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                template.baseUrlRequired
                  ? t('settings.providers.add.baseUrlRequired')
                  : t('settings.providers.baseUrlPlaceholder')
              }
              className="h-8 flex-1 font-mono text-[12px]"
              aria-label={t('settings.providers.baseUrl')}
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <span className="w-[96px] shrink-0 text-aux text-ink-fg-1">
                {t('settings.providers.apiKey.label')}
              </span>
              <div className="relative flex-1">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('settings.providers.apiKey.unset')}
                  className="h-8 pr-8"
                  aria-label={t('settings.providers.apiKey.label')}
                />
                <button
                  type="button"
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
            </div>
            {template.keyOptional && (
              <span className="pl-[108px] text-aux text-ink-fg-3">
                {t('settings.providers.add.keyOptionalHint')}
              </span>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 text-aux text-ink-fg-2 hover:text-ink-fg"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', !showAdvanced && '-rotate-90')}
              />
              {t('settings.providers.add.advancedToggle')}
              <span className="ml-1 font-mono text-meta text-ink-fg-3">({id || '…'})</span>
            </button>

            {showAdvanced && (
              <div className="mt-2 flex flex-col gap-2 rounded-md border border-ink-border-soft bg-ink-1 p-2.5">
                <div className="flex items-center gap-3">
                  <span className="w-[84px] shrink-0 text-aux text-ink-fg-1">
                    {t('settings.providers.add.id')}
                  </span>
                  <Input
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    placeholder={t('settings.providers.add.idPlaceholder')}
                    className="h-7 flex-1 font-mono text-[12px]"
                    aria-label={t('settings.providers.add.id')}
                  />
                  {id.length > 0 && !idValid && (
                    <span className="text-aux text-fail">{t('settings.providers.add.idInvalid')}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-[84px] shrink-0 text-aux text-ink-fg-1">
                    {t('settings.providers.add.protocol')}
                  </span>
                  <Select
                    value={protocol}
                    onValueChange={(v) => setProtocol(v as LlmProviderProtocol)}
                  >
                    <SelectTrigger className="h-7 flex-1 font-mono text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROTOCOLS.map((p) => (
                        <SelectItem key={p} value={p} className="font-mono text-[12px]">
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="items-center justify-between sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canProbe}
              onClick={() => void handleProbe()}
            >
              {probing ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t('settings.providers.add.probing')}
                </>
              ) : (
                <>
                  <Plug className="size-3.5" />
                  {t('settings.providers.add.probe')}
                </>
              )}
            </Button>
            {probeResult &&
              (probeResult.ok ? (
                <span className="rounded bg-ok/15 px-2 py-0.5 text-aux text-ok">
                  {t('settings.providers.add.probeOk', { ms: probeResult.latencyMs })}
                </span>
              ) : (
                <span
                  className="max-w-[240px] truncate text-aux text-fail"
                  title={probeResult.error ?? ''}
                >
                  {probeResult.error ?? t('settings.providers.add.probeFail')}
                </span>
              ))}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t('settings.providers.add.cancel')}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                t('settings.providers.add.submit')
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
