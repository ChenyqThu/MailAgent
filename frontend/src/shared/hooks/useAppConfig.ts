// serve-api `/chat/config` 的**工作台 flag 投影**（事项 + 通讯录），单 key 单请求。
//
// 为什么收敛成一个模块（速赢包 §4a）：`useMatterFlags` 与 `useContactFlags` 打的是同一个
// `/chat/config`，却各用一个 queryKey（`qk.matters.config()` / `qk.contacts.config()`）⇒
// 启动阶段同一请求发两遍、互不复用。这里改成同 queryKey + 同 queryFn，两个 hook 各自
// `select` 投影一个切片（`useLlmModels` 的模型面探针共享是同一套做法）。
//
// 🔴 与旧实现的行为差：拉不到**不再**吞成 `{enabled:false}`。serve-api 是软门控
// （backend_lifecycle 后台轮询，开窗时常还没起），而两个 flag 由常驻 Sidebar 在启动那一瞬
// 触发 —— 旧写法把「后端还没起」当成一次成功响应缓存住，于是事项/通讯录渲染成「已禁用」
// 空态且不再重试。现在失败即 throw：react-query 进 error 态 + 指数退避重试，
// `mailagent:api-ready` 到达时再失效一次（useApiReadyRefresh）。

import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'

import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { qk } from '@shared/lib/queryKeys'

/** 两个工作台的原始 flag 面。语义投影（如通讯录治理 Agent 的 AND）留给各自的 select。 */
export interface AppConfigFlags {
  mattersEnabled: boolean
  matterAgentEnabled: boolean
  contactsEnabled: boolean
  contactAgentEnabled: boolean
}

/** 单 key —— 也是 `useApiReadyRefresh` 在 serve-api 就绪时要失效的那个键。 */
export const APP_CONFIG_QUERY_KEY = qk.chat.config('workspaceFlags')

/** 🔴 失败一律 throw（不返回 all-off 默认值）——见文件头。 */
export async function fetchAppConfigFlags(): Promise<AppConfigFlags> {
  const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
  if (!response.ok) throw new Error(`GET /chat/config failed: HTTP ${response.status}`)
  const body = (await response.json()) as {
    data?: {
      mattersEnabled?: unknown
      matterAgentEnabled?: unknown
      contactsEnabled?: unknown
      contactAgentEnabled?: unknown
    }
  }
  return {
    mattersEnabled: body.data?.mattersEnabled === true,
    matterAgentEnabled: body.data?.matterAgentEnabled === true,
    contactsEnabled: body.data?.contactsEnabled === true,
    contactAgentEnabled: body.data?.contactAgentEnabled === true
  }
}

/** 调用方传**模块级稳定**的 select（每次 render 新建的箭头函数会让投影每次重算）。 */
export function useAppConfig<TSelected>(
  select: (flags: AppConfigFlags) => TSelected
): UseQueryResult<TSelected, Error> {
  return useQuery({
    queryKey: APP_CONFIG_QUERY_KEY,
    queryFn: fetchAppConfigFlags,
    select,
    staleTime: 30_000,
    // 启动竞态专治: serve-api 晚起时前几次必失败, 3 次指数退避 (react-query 默认
    // retryDelay: 1s/2s/4s) 覆盖典型的软门控启动窗口。
    retry: 3
  })
}
