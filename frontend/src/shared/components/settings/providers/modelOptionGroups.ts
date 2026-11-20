// task 07-12 P3 — EnvField optionGroups 的构建 helper（功能位选择器按 provider 分组）。
//
// 使用 React.createElement（零 JSX）保留 .ts 形态，避开 react-refresh/only-export-components。
// value 恒为完整 providerRef；label 带厂商彩色 SVG + 模型名；有 providers 列表时组标题使用人类 displayName。

import * as React from 'react'
import type { TFunction } from 'i18next'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import {
  indexProvidersById,
  resolveProviderGroupLabel
} from '@shared/components/providers/modelSelect.lib'
import {
  groupModelRefs,
  stripProviderPrefix,
  type LlmProviderSummary
} from '@shared/hooks/useLlmProviders'
import { lookupModelMeta } from '@shared/modelCatalog/lookup'

export interface ModelOptionGroup {
  label: React.ReactNode
  options: Array<{ value: string; label: React.ReactNode }>
}

export function buildModelOptionGroups(
  ids: string[],
  t: TFunction,
  renderLabel?: (id: string, display: string) => React.ReactNode,
  providers?: readonly LlmProviderSummary[]
): ModelOptionGroup[] {
  const providersById = indexProvidersById(providers)
  return groupModelRefs(ids).map((g) => {
    const prov = providersById.get(g.providerId)
    const groupText = resolveProviderGroupLabel(
      g.providerId,
      providersById,
      t('settings.providers.group.default')
    )
    const groupLabel = prov
      ? React.createElement(
          'span',
          { className: 'inline-flex items-center gap-1.5' },
          React.createElement(ProviderBrandIcon, {
            customIcon: prov.customIcon,
            providerId: g.providerId,
            protocol: prov.protocol,
            variant: 'color',
            className: 'size-3.5 shrink-0'
          }),
          React.createElement('span', null, groupText)
        )
      : groupText

    return {
      label: groupLabel,
      options: g.refs.map((id) => {
        const display = stripProviderPrefix(id)
        const textNode = renderLabel ? renderLabel(id, display) : display
        const meta = lookupModelMeta(display, prov?.protocol ?? null)
        return {
          value: id,
          label: React.createElement(
            'span',
            { className: 'inline-flex items-center gap-1.5' },
            React.createElement(ProviderBrandIcon, {
              customIcon: prov?.customIcon,
              catalogProviderId: meta?.catalogProviderId,
              providerId: g.providerId,
              protocol: prov?.protocol,
              variant: 'color',
              className: 'size-3.5 shrink-0'
            }),
            React.createElement('span', null, textNode)
          )
        }
      })
    }
  })
}
