// task 07-12 P3 — Settings「模型服务」区（prd §4.5）：多 provider 并存管理。
//
// 仅在 /chat/config.providerRegistryEnabled=true 时由 AiTab 渲染（flag off → 旧「LLM
// 网关」区字节级不变，门控在 AiTab 侧）。远程 web 全区只读渲染（写端点后端也已收紧
// verify_local_token → 远程 403，双保险）。
//
// 添加 provider = 模板下拉（预填 protocol + baseURL + displayName，research/02 实测端点）
// → 内联表单（id slug / 名称 / baseUrl / apiKey）→ POST。id 是 registry key（后端
// _PROVIDER_ID_RE 校验），创建后不可改。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'

import { createLlmProvider, useLlmProviders } from '@shared/hooks/useLlmProviders'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'

import { Section } from '../parts/Section'
import { ProviderCard } from './ProviderCard'
import { PROVIDER_TEMPLATES, type ProviderTemplate } from './templates'

function isWebBuild(): boolean {
  return (
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'
  )
}

function AddProviderForm({
  onDone,
  onCancel
}: {
  onDone: () => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  // radix SelectItem 不接受空串 value（已知坑）——模板 key 恒非空，初始选中第一个模板。
  const [templateKey, setTemplateKey] = React.useState<string>(PROVIDER_TEMPLATES[0].key)
  const template: ProviderTemplate =
    PROVIDER_TEMPLATES.find((p) => p.key === templateKey) ?? PROVIDER_TEMPLATES[0]
  const [id, setId] = React.useState(PROVIDER_TEMPLATES[0].key)
  const [displayName, setDisplayName] = React.useState(PROVIDER_TEMPLATES[0].displayName)
  const [baseUrl, setBaseUrl] = React.useState(PROVIDER_TEMPLATES[0].baseUrl)
  const [apiKey, setApiKey] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  function applyTemplate(key: string): void {
    const next = PROVIDER_TEMPLATES.find((p) => p.key === key)
    if (!next) return
    setTemplateKey(key)
    setId(next.custom ? '' : next.key)
    setDisplayName(next.displayName)
    setBaseUrl(next.baseUrl)
  }

  const idValid = /^[a-z][a-z0-9_-]{0,40}$/.test(id)
  const baseUrlOk = !template.baseUrlRequired || baseUrl.trim().length > 0
  const canSubmit = idValid && baseUrlOk && !submitting

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    try {
      await createLlmProvider({
        id,
        protocol: template.protocol,
        displayName,
        baseUrl: baseUrl.trim(),
        ...(apiKey.length > 0 ? { apiKey } : {})
      })
      setApiKey('')
      toastSuccess(t('settings.providers.added', { name: displayName || id }))
      await onDone()
    } catch (err) {
      toastError(t('settings.providers.addTitle'), errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const templateLabel = (p: ProviderTemplate): string =>
    p.custom ? t(`settings.providers.template.${p.key}`) : p.displayName

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="w-[88px] shrink-0 text-aux text-ink-fg-1">
          {t('settings.providers.add.template')}
        </span>
        <Select value={templateKey} onValueChange={applyTemplate}>
          <SelectTrigger className="w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_TEMPLATES.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {templateLabel(p)}
                <span className="ml-1.5 font-mono text-meta text-ink-fg-3">{p.protocol}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-[88px] shrink-0 text-aux text-ink-fg-1">
          {t('settings.providers.add.id')}
        </span>
        <Input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={t('settings.providers.add.idPlaceholder')}
          className="h-7 w-[260px] font-mono text-[12px]"
          aria-label={t('settings.providers.add.id')}
        />
        {id.length > 0 && !idValid && (
          <span className="text-aux text-fail">{t('settings.providers.add.idInvalid')}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-[88px] shrink-0 text-aux text-ink-fg-1">
          {t('settings.providers.displayName')}
        </span>
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="h-7 w-[260px]"
          aria-label={t('settings.providers.displayName')}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-[88px] shrink-0 text-aux text-ink-fg-1">
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
          className="h-7 w-[320px] font-mono text-[12px]"
          aria-label={t('settings.providers.baseUrl')}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-[88px] shrink-0 text-aux text-ink-fg-1">
          {t('settings.providers.apiKey.label')}
        </span>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('settings.providers.apiKey.unset')}
          className="h-7 w-[260px]"
          aria-label={t('settings.providers.apiKey.label')}
        />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
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
        <Button variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t('settings.providers.add.cancel')}
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
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)

  const content: React.ReactNode = (() => {
    if (isError) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          {t('settings.providers.loadError')}
        </div>
      )
    }
    if (isLoading) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.providers.loading')}
        </div>
      )
    }
    if (providers.length === 0) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.providers.empty')}</div>
      )
    }
    return providers.map((p) => (
      <ProviderCard
        key={p.id}
        provider={p}
        readOnly={isWeb}
        expanded={expandedId === p.id}
        onToggleExpand={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
      />
    ))
  })()

  return (
    <Section
      title={t('settings.providers.title')}
      helper={t('settings.providers.helper')}
      meta={
        !isWeb && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-1 text-xs text-ink-fg-2 transition-colors hover:text-ink-fg"
          >
            <Plus className="size-3" />
            {t('settings.providers.addButton')}
          </button>
        )
      }
    >
      {content}
      {adding && !isWeb && (
        <AddProviderForm
          onDone={async () => {
            setAdding(false)
            await qc.invalidateQueries({ queryKey: qk.llm.providers() })
            await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </Section>
  )
}
