import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { MatterAgentOverrides } from '@shared/api/types/matter'
import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'

/**
 * 全局跟进 Agent 的模型默认（`owner_settings` 的 `matter_agent_defaults`，0813 轮 3 · B10）。
 *
 * 形状抄同一个弹窗里的兄弟设置 `useMatterRunWebFace`：**显示的必须恒等于存进去的** ——
 * 保存失败不留乐观值（立刻退回服务端事实 + 由调用方 toast），保存成功写回的是**服务端返回
 * 的那份归一化结果**，不是我们发过去的（服务端会 trim / 去重，回显请求会让两边劈叉）。
 *
 * 🔴 `{}` = 三项都没配（= 跟随下一层），与「读失败」不是一回事：后者要如实说出来，绝不能
 * 静默显示成「没配过」—— 那会诱使 owner 在一份看不见的旧配置上重新配一遍。
 */

export const MATTER_AGENT_DEFAULTS_KEY = ['matters', 'agent-defaults'] as const

const ENDPOINT = '/matters/agent-defaults'

/** wire → 归一化块。认不出的字段丢掉、剩下的照用（同 Python 读侧的取舍）。 */
function parseDefaults(value: unknown): MatterAgentOverrides {
  if (value === null || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const out: MatterAgentOverrides = {}
  if (typeof raw.model === 'string' && raw.model) out.model = raw.model
  if (typeof raw.effort === 'string' && raw.effort) out.effort = raw.effort
  // 🔴 `[]` 必须能表达（= 显式不设兜底），所以判的是「键在不在 + 是不是数组」，不是真不真。
  if (Array.isArray(raw.fallback_models)) {
    out.fallback_models = raw.fallback_models.filter((x): x is string => typeof x === 'string')
  }
  return out
}

export function useMatterAgentDefaults(options?: {
  onSaveError?(error: unknown): void
}): {
  /** 当前该显示的默认（保存中显示乐观值；未取到时 undefined —— 调用侧据此显示加载态）。 */
  defaults: MatterAgentOverrides | undefined
  isLoading: boolean
  isError: boolean
  isSaving: boolean
  save(next: MatterAgentOverrides): void
} {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: MATTER_AGENT_DEFAULTS_KEY,
    queryFn: async (): Promise<MatterAgentOverrides> => {
      const response = await fetch(`${resolveApiBaseUrl()}${ENDPOINT}`, {
        credentials: 'include'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { data?: { defaults?: unknown } }
      return parseDefaults(payload.data?.defaults)
    },
    staleTime: 30_000
  })

  const save = useMutation({
    mutationFn: async (next: MatterAgentOverrides): Promise<MatterAgentOverrides> => {
      const response = await fetch(`${resolveApiBaseUrl()}${ENDPOINT}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: next })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { data?: { defaults?: unknown } }
      return parseDefaults(payload.data?.defaults)
    },
    onSuccess: (stored) => {
      queryClient.setQueryData(MATTER_AGENT_DEFAULTS_KEY, stored)
    },
    onError: (error) => options?.onSaveError?.(error)
  })

  return {
    // 🔴 失败时 `save.variables` 仍留着刚提交的那份，但 `isPending` 已为 false ⇒ 不再显示它，
    // 界面自动退回 query 里的服务端事实（= 回滚）。
    defaults: save.isPending ? save.variables : query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    isSaving: save.isPending,
    save: (next) => save.mutate(next)
  }
}
