// ConnectorsSection — 设置-AI「外部连接（MCP）」区（08-06 起降级为深链）。
//
// 🔴 connector 的**唯一** owner 操作面已迁到独立的 Connectors 配置台（/connectors，
// owner 拍板：「connector 单独一个配置页」）。这里只留一张指路卡 —— 同一份数据绝不
// 在两处都能改（那会造出两个事实来源）；连接 / 授权 / per-tool 三档 / BYOK key /
// 断开等全部操作在配置台里。
//
// 门控语义原样保留：flag（connectorToolsEnabled，`MAILAGENT_MCP_CONNECTORS`）off 时
// 整区不渲染，且**一个 /api/connector/* 请求都不发**（off 时那些端点全 409）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'

import { qk } from '@shared/lib/queryKeys'
import { Button } from '@shared/components/ui/button'

import { Section } from '../parts/Section'
import { fetchConnectorToolsEnabled } from './shared'

export function ConnectorsSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { data: flagEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('connectorToolsEnabled'),
    queryFn: fetchConnectorToolsEnabled,
    staleTime: 30_000,
    retry: false
  })

  // flag off（false / 加载中 / 不可达）→ 整区不渲染。
  if (flagEnabled !== true) return null

  return (
    <Section title={t('settings.connectors.title')} helper={t('settings.connectors.desc')}>
      <div className="flex items-center justify-between gap-3 px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
        <div className="min-w-0 flex-1">
          <div className="text-aux font-medium text-ink-fg">
            {t('connectorsConsole.settingsLink.movedTitle')}
          </div>
          <div className="mt-0.5 text-meta text-ink-fg-2">
            {t('connectorsConsole.settingsLink.movedHelper')}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void navigate({ to: '/connectors', search: { item: 'external' } })}
        >
          {t('connectorsConsole.settingsLink.open')}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </Section>
  )
}
