import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check, ChevronDown, Eye, Search, Wrench } from 'lucide-react'

import { formatTokens } from '@shared/assistant/components/modelDetailCard.lib'
import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import { groupComposerModels, type ComposerModelOption } from '@shared/hooks/useComposerModels'
import { type LlmProviderSummary } from '@shared/hooks/useLlmProviders'
import { cn } from '@shared/lib/cn'
import { useModelCatalogRevision } from '@shared/modelCatalog/useModelCatalog'

import {
  buildRichModelOption,
  filterRichModelOptions,
  indexProvidersById,
  resolveProviderGroupLabel
} from './modelSelect.lib'

const CAPABILITY_BADGES = [
  { key: 'vision', Icon: Eye, tint: 'bg-info/12 text-info', labelKey: 'settings.providers.models.cap.vision' },
  { key: 'tools', Icon: Wrench, tint: 'bg-ok/12 text-ok', labelKey: 'settings.providers.models.cap.tools' },
  {
    key: 'reasoning',
    Icon: Brain,
    tint: 'bg-ai/12 text-ai',
    labelKey: 'settings.providers.models.cap.reasoning'
  }
] as const

function RichCapabilityIcons({
  option
}: {
  option: ComposerModelOption
}): React.ReactElement | null {
  const { t } = useTranslation()
  const caps = option.capabilities
  if (!caps) return null
  const active = CAPABILITY_BADGES.filter((b) => caps[b.key] === true)
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {active.map(({ key, Icon, tint, labelKey }) => (
        <span
          key={key}
          title={t(labelKey)}
          aria-label={t(labelKey)}
          className={cn('grid size-[15px] place-items-center rounded-[3px]', tint)}
        >
          <Icon size={10} strokeWidth={2.25} className="shrink-0" />
        </span>
      ))}
    </span>
  )
}

export interface ModelSelectProps {
  value: string
  onValueChange: (next: string) => void
  models: readonly string[]
  providers?: readonly LlmProviderSummary[]
  sentinelOption?: { value: string; label: string }
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}

export function ModelSelect({
  value,
  onValueChange,
  models,
  providers,
  sentinelOption,
  placeholder,
  disabled = false,
  className,
  ariaLabel
}: ModelSelectProps): React.ReactElement {
  const { t } = useTranslation()
  useModelCatalogRevision()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const providersById = React.useMemo(() => indexProvidersById(providers), [providers])
  const isSentinel = sentinelOption !== undefined && value === sentinelOption.value
  const allRefs = React.useMemo(() => {
    if (!value || isSentinel || models.includes(value)) return [...models]
    return [...models, value]
  }, [models, value, isSentinel])

  const options = React.useMemo(
    () => allRefs.map((ref) => buildRichModelOption(ref, providersById)),
    [allRefs, providersById]
  )
  const filtered = React.useMemo(() => filterRichModelOptions(options, query), [options, query])
  const groups = React.useMemo(() => groupComposerModels(filtered), [filtered])
  const selectedOpt = React.useMemo(
    () => (isSentinel || !value ? null : options.find((o) => o.ref === value) ?? null),
    [options, value, isSentinel]
  )
  const selectedProvider = selectedOpt ? providersById.get(selectedOpt.providerId) : undefined

  const triggerText = isSentinel
    ? sentinelOption.label
    : (selectedOpt?.displayName ?? placeholder ?? t('settings.providers.select.placeholder'))

  const showSearch = options.length >= 8

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            'flex h-8 w-[240px] items-center justify-between gap-2 rounded-md border border-ink-border bg-ink-2 px-3',
            'text-aux text-ink-fg transition-colors duration-fast ease-standard',
            'hover:border-ink-border-strong focus:outline-none focus:ring-2 focus:ring-coral/70',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selectedOpt && (
              <ProviderBrandIcon
                customIcon={selectedProvider?.customIcon}
                catalogProviderId={selectedOpt.catalogMeta?.catalogProviderId}
                providerId={selectedOpt.providerId}
                protocol={selectedOpt.protocol}
                variant="color"
                className="size-3.5 shrink-0"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{triggerText}</span>
            {selectedOpt?.contextWindow ? (
              <span className="shrink-0 font-mono text-micro text-ink-fg-3">
                {formatTokens(selectedOpt.contextWindow)}
              </span>
            ) : null}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-fg-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-1.5">
        {showSearch && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded border border-ink-border-soft bg-ink-1 px-2 py-1">
            <Search className="size-3.5 shrink-0 text-ink-fg-3" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.providers.select.searchPlaceholder')}
              className="w-full bg-transparent text-aux text-ink-fg placeholder:text-ink-fg-3 focus:outline-none"
            />
          </div>
        )}
        <div className="scrollbar-thin max-h-[300px] overflow-y-auto">
          {sentinelOption && !query.trim() && (
            <button
              type="button"
              onClick={() => {
                onValueChange(sentinelOption.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-aux transition-colors',
                value === sentinelOption.value
                  ? 'bg-coral/10 text-coral font-medium'
                  : 'text-ink-fg-1 hover:bg-ink-3'
              )}
            >
              <span className="truncate">{sentinelOption.label}</span>
              {value === sentinelOption.value && <Check className="size-3.5 shrink-0" />}
            </button>
          )}
          {groups.length === 0 ? (
            <div className="px-2 py-4 text-center text-aux text-ink-fg-3">
              {t('settings.providers.select.empty')}
            </div>
          ) : (
            groups.map((group) => {
              const prov = providersById.get(group.providerId)
              const groupLabel = resolveProviderGroupLabel(
                group.providerId,
                providersById,
                t('settings.providers.group.default')
              )
              return (
                <div key={group.providerId} className="mt-1 first:mt-0">
                  {groups.length > 1 && (
                    <div className="flex items-center gap-1.5 px-2 py-1 text-aux font-medium text-ink-fg-2">
                      <ProviderBrandIcon
                        customIcon={prov?.customIcon}
                        providerId={group.providerId}
                        protocol={prov?.protocol}
                        variant="color"
                        className="size-3.5 shrink-0"
                      />
                      <span className="truncate">{groupLabel}</span>
                    </div>
                  )}
                  {group.options.map((opt) => {
                    const isSelected = opt.ref === value
                    const isOrphan = !models.includes(opt.ref)
                    return (
                      <button
                        key={opt.ref}
                        type="button"
                        onClick={() => {
                          onValueChange(opt.ref)
                          setOpen(false)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
                          isSelected
                            ? 'bg-coral/10 text-coral'
                            : 'text-ink-fg hover:bg-ink-3'
                        )}
                      >
                        <ProviderBrandIcon
                          customIcon={prov?.customIcon}
                          catalogProviderId={opt.catalogMeta?.catalogProviderId}
                          providerId={opt.providerId}
                          protocol={opt.protocol}
                          variant="color"
                          className="size-3.5 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-aux">
                          {opt.displayName}
                          {isOrphan && (
                            <span className="ml-1 text-aux text-ink-fg-3">
                              {t('settings.ai.enabledModels.notEnabled')}
                            </span>
                          )}
                        </span>
                        <RichCapabilityIcons option={opt} />
                        {opt.contextWindow ? (
                          <span className="shrink-0 font-mono text-micro text-ink-fg-3">
                            {formatTokens(opt.contextWindow)}
                          </span>
                        ) : null}
                        {isSelected && <Check className="size-3.5 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
