// 08-04 WP6 — composer「+」菜单里「外部连接」那一项的**可见性判据 + 数据源**。
//
// 08-03 首版把这段查询长在 ConnectorQuickPanel 组件里（它当时自带触发器，判据只服务自己的
// 显隐）。入口收编进「+」菜单后，判据要在**菜单渲染前**就拿到（决定那一项出不出、「+」上要
// 不要挂强调点），面板内容则只管画行 —— 于是下沉成 hook。
//
// 🔴 显隐三态原样保留（PR5 修过一个「不看 flag 就打 409」的破口，这里不许重犯）：
//   flag 未知 / 加载中 → **按 off 处理**（`flagEnabled !== true`），list 查询 disabled，
//   一个 `/api/connector/*` 请求都不发；flag on 但零行 → `available=false`（打开只有一片
//   空白的菜单项是纯噪音）。只有 flag on **且**至少一行时 `available` 才为 true。

import { useQuery } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { fetchConnectorToolsEnabled } from '@shared/components/settings/custom-ai/shared'
import type { ConnectorSummary } from '@shared/api/types'

export type ConnectorQuickRows = {
  rows: ConnectorSummary[]
  /** flag on **且**至少一行 —— 「+」菜单里才出「外部连接」这一项。 */
  available: boolean
  /** 至少一个「已连接且已启用」的 connector —— 「+」按钮挂常驻强调点（A2 语义）。 */
  anyActive: boolean
}

export function useConnectorQuickRows(): ConnectorQuickRows {
  const api = useMailApi()

  const { data: flagEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('connectorToolsEnabled'),
    queryFn: fetchConnectorToolsEnabled,
    staleTime: 30_000,
    retry: false
  })

  const list = useQuery<ConnectorSummary[]>({
    queryKey: qk.connectors(),
    queryFn: () => api.connector.list(),
    enabled: flagEnabled === true,
    staleTime: 10_000,
    retry: false
  })

  const rows = list.data ?? []
  return {
    rows,
    available: flagEnabled === true && rows.length > 0,
    anyActive: rows.some((c) => c.enabled && c.status === 'connected')
  }
}
