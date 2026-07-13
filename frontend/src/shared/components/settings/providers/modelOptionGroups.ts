// task 07-12 P3 — EnvField optionGroups 的构建 helper（功能位选择器按 provider 分组）。
//
// 仅 providerRegistryEnabled=true 的分支调用（flag off 的扁平 options 路径不经过这里，
// 字节级不变）。value 恒为完整 providerRef（写入面不变——env 键 / report_agent 行存全串），
// 组内 label 显示去前缀的 model id；orphan 标注由调用方经 renderLabel 注入。

import type * as React from 'react'
import type { TFunction } from 'i18next'

import {
  DEFAULT_PROVIDER_ID,
  groupModelRefs,
  stripProviderPrefix
} from '@shared/hooks/useLlmProviders'

export interface ModelOptionGroup {
  label: React.ReactNode
  options: Array<{ value: string; label: React.ReactNode }>
}

export function buildModelOptionGroups(
  ids: string[],
  t: TFunction,
  renderLabel?: (id: string, display: string) => React.ReactNode
): ModelOptionGroup[] {
  return groupModelRefs(ids).map((g) => ({
    label:
      g.providerId === DEFAULT_PROVIDER_ID ? t('settings.providers.group.default') : g.providerId,
    options: g.refs.map((id) => {
      const display = stripProviderPrefix(id)
      return { value: id, label: renderLabel ? renderLabel(id, display) : display }
    })
  }))
}
