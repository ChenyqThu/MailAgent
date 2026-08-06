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
//
// 🔴 08-05 WP-13 复核补：`enabled` 参数（默认 true，既有调用点语义逐字不变）。滑块菜单的
// 触发器**一挂载就在工具条上**，而这个 hook 无条件跑 = 每次渲染 composer 就往 serve-api 打
// 两发（`/api/chat/config` flag + `/api/connector/list`），哪怕用户从没点开过菜单 —— 实测
// `composer_plus_menu.test.tsx` 一轮 7 发 flag 请求。这与同一个菜单里 skill 摘要那条
// 「未展开不打请求」纪律自相矛盾，故把门给出来，由调用方传 `open`。
//   · `enabled=false` 时**只是不发请求，仍照常读共享缓存**（react-query 的 `enabled:false`
//     不影响 `data` 命中）—— 所以设置页拉过 `qk.connectors()` 之后，菜单不用打开也有数据。
//   · 代价（有意接受，已随复核报给上游）：`anyActive` 驱动的**常驻强调点**从「恒准」降级为
//     「知道了才亮」——首次会话里用户没开过菜单、也没进过设置页时不亮。语义仍不撒谎（亮 =
//     确实有已连接且启用的 connector），只是「不亮」从「没有」变成「没有或还不知道」。

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

export function useConnectorQuickRows(enabled = true): ConnectorQuickRows {
  const api = useMailApi()

  const { data: flagEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('connectorToolsEnabled'),
    queryFn: fetchConnectorToolsEnabled,
    enabled,
    staleTime: 30_000,
    retry: false
  })

  const list = useQuery<ConnectorSummary[]>({
    queryKey: qk.connectors(),
    queryFn: () => api.connector.list(),
    // 两道门是**与**关系：调用方的 enabled 在前（没展开就一发都不打），flag 判定在后
    // （PR5 那条「不看 flag 就打 409」的纪律一个字不动）。
    enabled: enabled && flagEnabled === true,
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
