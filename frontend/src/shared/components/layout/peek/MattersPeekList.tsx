// 事项域 peek —— 同一组件 `MatterList`（真行 / 真分组 / 真筛选 chip）。
// 数据 = `matterLiveListOptions`（与工作台同 key，访问过零请求）经 `applyMatterListQuery`
// 用工作台 store 里当前的 query / search 过滤；选中态与折叠组也读同一个 store。
// 点行 = `revealMatter`（工作台点行的同一条桥：开对象标签 + 切清单视图）。

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import type { Matter } from '@shared/api/types/matter'
import { matterLiveListOptions, useMattersApi } from '@shared/components/matters/hooks'
import { MatterList } from '@shared/components/matters/MatterList'
import { applyMatterListQuery } from '@shared/components/matters/matterListQuery'
import { useMatterWorkspace } from '@shared/components/matters/matterWorkspaceStore'
import { navigateToDomain } from '@shared/navigation/domain-location'

import type { PeekListProps } from './PeekChrome'

const noop = (): void => {}

export default function MattersPeekList({ onNavigate }: PeekListProps): React.ReactElement {
  const navigate = useNavigate()
  const api = useMattersApi()
  const live = useQuery(matterLiveListOptions(api))
  const matters = useMemo(() => live.data?.items ?? [], [live.data])
  const query = useMatterWorkspace((s) => s.query)
  const search = useMatterWorkspace((s) => s.search)
  const selectedId = useMatterWorkspace((s) => s.selectedId)
  const setQuery = useMatterWorkspace((s) => s.setQuery)
  const setSearch = useMatterWorkspace((s) => s.setSearch)
  const revealMatter = useMatterWorkspace((s) => s.revealMatter)
  // render 期不调 Date.now()（react-hooks/purity）：挂载时冻结一次，与 MatterList 同模式。
  const [now] = useState(() => Date.now())
  const visible = useMemo(
    () => applyMatterListQuery(matters, query, search, { now }),
    [matters, query, search, now]
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-nav-peek-list="matters">
      <MatterList
        matters={visible}
        query={query}
        onQueryChange={setQuery}
        scopeTotal={null}
        tags={[]}
        now={now}
        selectedId={selectedId}
        search={search}
        loading={live.isPending && matters.length === 0}
        onSearchChange={setSearch}
        onSelect={(matter: Matter) => {
          revealMatter(matter)
          navigateToDomain(navigate, 'matters')
          onNavigate()
        }}
        onCreate={noop}
        onManageTags={noop}
      />
    </div>
  )
}
