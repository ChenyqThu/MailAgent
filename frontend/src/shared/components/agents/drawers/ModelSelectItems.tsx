// task 07-12 P3 — Agents 各抽屉 model 选择器共用的 SelectItem 列表。
//
// flag off（providerRegistryEnabled=false，默认）：扁平列表 + orphan 标注。
// flag on：按 provider 分组（有 human displayName 时显示人类名 + 品牌图标，否则保持
// `default（主网关）` / `providerId` fallback —— 严格保留 ModelSelectItems.test.tsx 文本契约）；
// 每项带彩色品牌 SVG 图标（svg `textContent` 为空，保持模型 id 文本断言不变）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import {
  indexProvidersById,
  resolveProviderGroupLabel
} from '@shared/components/providers/modelSelect.lib'
import {
  DEFAULT_PROVIDER_ID,
  groupModelRefs,
  stripProviderPrefix,
  useLlmProviders,
  useProviderRegistryEnabled
} from '@shared/hooks/useLlmProviders'
import { lookupModelMeta } from '@shared/modelCatalog/lookup'
import { SelectGroup, SelectItem, SelectLabel } from '@shared/components/ui/select'

export function ModelSelectItems({
  models,
  current
}: {
  models: string[]
  current: string | null
}): React.ReactElement {
  const { t } = useTranslation()
  const registryEnabled = useProviderRegistryEnabled()
  const { providers } = useLlmProviders(registryEnabled)
  const providersById = React.useMemo(() => indexProvidersById(providers), [providers])
  const list = current && !models.includes(current) ? [...models, current] : models

  const renderItem = (id: string, display: string, providerId: string): React.ReactElement => {
    const isOrphan = !models.includes(id)
    const prov = providersById.get(providerId)
    const meta = lookupModelMeta(display, prov?.protocol ?? null)
    return (
      <SelectItem key={id} value={id}>
        <span className="inline-flex items-center gap-1.5">
          {registryEnabled && (
            <ProviderBrandIcon
              customIcon={prov?.customIcon}
              catalogProviderId={meta?.catalogProviderId}
              providerId={providerId}
              protocol={prov?.protocol}
              variant="color"
              className="size-3.5 shrink-0"
            />
          )}
          <span>{display}</span>
          {isOrphan && (
            <span style={{ color: 'rgb(var(--ink-fg-3))', marginLeft: 6 }}>
              {t('settings.ai.enabledModels.notEnabled', {
                defaultValue: '（未启用）'
              })}
            </span>
          )}
        </span>
      </SelectItem>
    )
  }

  if (!registryEnabled) {
    return <>{list.map((id) => renderItem(id, id, DEFAULT_PROVIDER_ID))}</>
  }
  return (
    <>
      {groupModelRefs(list).map((g) => {
        const prov = providersById.get(g.providerId)
        const groupLabel = resolveProviderGroupLabel(
          g.providerId,
          providersById,
          t('settings.providers.group.default')
        )
        return (
          <SelectGroup key={g.providerId}>
            <SelectLabel>
              <span className="inline-flex items-center gap-1.5">
                {prov && (
                  <ProviderBrandIcon
                    customIcon={prov.customIcon}
                    providerId={g.providerId}
                    protocol={prov.protocol}
                    variant="color"
                    className="size-3.5 shrink-0"
                  />
                )}
                <span>{groupLabel}</span>
              </span>
            </SelectLabel>
            {g.refs.map((id) => renderItem(id, stripProviderPrefix(id), g.providerId))}
          </SelectGroup>
        )
      })}
    </>
  )
}
