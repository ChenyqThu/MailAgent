// 设计补充规格 §4/§5：「设置 → 事项」承载**标签管理**与 **Matter Agent 全局配置**
// （G-31，0812 owner Q6=做）。
//
// 🔴 这里只做**深链**，不复制配置面：两个弹窗都是既有组件，事项详情页里的入口一并保留。
// 同一份数据只有一个可写面 —— 设置页再画一遍表单就是第二处真相（`/connectors` 配置台
// 收编内置工具审批档时踩过同一条线，那次的结论是把设置里的旧区降级成深链）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Settings2, Tags } from 'lucide-react'

import type { MatterTagDefinition } from '@shared/api/types/matter'
import { useMatterFlags, useMattersApi } from '@shared/components/matters/hooks'
import { MatterGlobalAgentModal } from '@shared/components/matters/MatterGlobalAgentModal'
import { MatterTagManagerModal } from '@shared/components/matters/MatterTagManagerModal'
import { listMatterTagsSafely, MATTER_TAGS_QUERY_KEY } from '@shared/components/matters/matterTags'
import { Button } from '@shared/components/ui/button'

import { PageHeader } from '../parts/PageHeader'
import { Row } from '../parts/Row'
import { Section } from '../parts/Section'

export function MattersTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const { mattersEnabled, matterAgentEnabled } = useMatterFlags()
  const [tagManagerOpen, setTagManagerOpen] = React.useState(false)
  const [globalAgentOpen, setGlobalAgentOpen] = React.useState(false)

  const tagsQuery = useQuery<{ items: MatterTagDefinition[] }>({
    queryKey: MATTER_TAGS_QUERY_KEY,
    queryFn: () => listMatterTagsSafely(api),
    enabled: mattersEnabled,
    staleTime: 30_000
  })
  const tags = tagsQuery.data?.items ?? []
  const usedTagCount = tags.filter((tag) => tag.usage_count > 0).length

  return (
    <>
      <PageHeader
        eyebrow="MATTERS"
        title={t('settings.matters.title')}
        description={t('settings.matters.description')}
      />

      <Section title={t('settings.matters.section')} helper={t('settings.matters.helper')}>
        <Row
          label={t('settings.matters.tags.label')}
          helper={
            tagsQuery.isError
              ? t('settings.matters.tags.loadFailed')
              : t('settings.matters.tags.helper', { count: usedTagCount, total: tags.length })
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!mattersEnabled}
            onClick={() => setTagManagerOpen(true)}
          >
            <Tags size={13} />
            {t('settings.matters.tags.open')}
          </Button>
        </Row>
        <Row
          label={t('settings.matters.agent.label')}
          helper={t('settings.matters.agent.helper')}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!mattersEnabled || !matterAgentEnabled}
            onClick={() => setGlobalAgentOpen(true)}
          >
            <Settings2 size={13} />
            {t('settings.matters.agent.open')}
          </Button>
        </Row>
      </Section>

      <MatterTagManagerModal open={tagManagerOpen} tags={tags} onOpenChange={setTagManagerOpen} />
      {globalAgentOpen ? (
        <MatterGlobalAgentModal onClose={() => setGlobalAgentOpen(false)} />
      ) : null}
    </>
  )
}
