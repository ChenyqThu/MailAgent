// task 07-12 P3 — Agents 各抽屉 model 选择器共用的 SelectItem 列表。
//
// flag off（providerRegistryEnabled=false，默认）：渲染与收编前各抽屉内联代码 DOM
// 等价的扁平列表（enabledModels + orphan 追加 +「（未启用）」标注）。
// flag on：同一列表按 provider 分组（providerRef 按第一个 ':' 切分；裸 id → default
// 组「主网关」），组内显示去前缀的 model id——值仍是完整 providerRef，写入面不变
// （report_agent 行 / env 键照旧存全串）。
//
// 「跟随全局 / 不设」等哨兵 SelectItem 留在各抽屉本地（每家语义不同），本组件只管
// 模型项。current 传当前保存值（哨兵态传 null，不参与 orphan 判定）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import {
  DEFAULT_PROVIDER_ID,
  groupModelRefs,
  stripProviderPrefix,
  useProviderRegistryEnabled
} from '@shared/hooks/useLlmProviders'
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
  const list = current && !models.includes(current) ? [...models, current] : models

  const renderItem = (id: string, display: string): React.ReactElement => {
    const isOrphan = !models.includes(id)
    return (
      <SelectItem key={id} value={id}>
        {display}
        {isOrphan && (
          <span style={{ color: 'rgb(var(--ink-fg-3))', marginLeft: 6 }}>
            {t('settings.ai.enabledModels.notEnabled', {
              defaultValue: '（未启用）'
            })}
          </span>
        )}
      </SelectItem>
    )
  }

  if (!registryEnabled) {
    return <>{list.map((id) => renderItem(id, id))}</>
  }
  return (
    <>
      {groupModelRefs(list).map((g) => (
        <SelectGroup key={g.providerId}>
          <SelectLabel>
            {g.providerId === DEFAULT_PROVIDER_ID
              ? t('settings.providers.group.default')
              : g.providerId}
          </SelectLabel>
          {g.refs.map((id) => renderItem(id, stripProviderPrefix(id)))}
        </SelectGroup>
      ))}
    </>
  )
}
