// dynamic-models — React Query hooks for upstream model list + enabled-model set.
//
// FALLBACK_MODELS is the single source of truth for the four supported models
// used when LLM_ENABLED_MODELS is not configured in .env. All three consumers
// (AIChatPanel model picker, AgentsTab ConfigDrawer radio list, AiTab selects)
// import from here so the list only changes in one place.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from './useMailApi'

export const FALLBACK_MODELS: string[] = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-fable-5',
  'gpt-5.5'
]

// ── upstream models (from LLM gateway GET /v1/models via serve-api) ─────────

export function useUpstreamModels(provider: 'main' | 'translate' = 'main'): {
  models: string[]
  isLoading: boolean
  error: string | undefined
  refresh: () => Promise<void>
} {
  const api = useMailApi()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: qk.llm.upstreamModels(provider),
    queryFn: () => api.llm.listUpstreamModels({ provider }),
    staleTime: 5 * 60 * 1_000, // 5 min mirrors server-side TTL
    retry: false
  })

  const refresh = async (): Promise<void> => {
    await api.llm.listUpstreamModels({ refresh: true, provider })
    await qc.invalidateQueries({ queryKey: qk.llm.upstreamModels(provider) })
  }

  return {
    models: q.data?.models ?? [],
    isLoading: q.isLoading,
    error: q.data?.error,
    refresh
  }
}

// ── enabled models (LLM_ENABLED_MODELS, hot-read from /chat/config) ─────────

/** /chat/config 的模型面投影（enabledModels + provider registry flag）——一次 fetch
 *  两个消费 hook 共享（批 2 review LOW-7：flag 探针不得为同一端点另开独立 query/fetch）。
 *  useEnabledModels / useProviderRegistryEnabled 用同一 queryKey + queryFn，各自 select
 *  投影一个切片，React Query 按 key 去重 → 打开 Settings/抽屉只发一次 /chat/config。 */
export interface ChatConfigModelsProbe {
  enabledModels: string[]
  providerRegistryEnabled: boolean
  /** issue #54 — KOS 激活 gate 显因切片（开关 / 开关AND凭据齐全），设置-集成 KOS 区
   *  被动提示消费。与模型切片同 fetch（同端点不另开独立 query，LOW-7）。 */
  kosConsumerEnabled: boolean
  kosConfigured: boolean
}

export function useEnabledModels(): { models: string[]; rawEnabled: string[] } {
  // queryKey ['chat','config','enabledModels']: AiTab's checkbox handler
  // calls invalidateQueries on this key after writing LLM_ENABLED_MODELS so
  // the chat picker reflects the new selection without a page reload.
  const q = useQuery({
    queryKey: qk.chat.config('enabledModels'),
    queryFn: fetchChatConfigModelsProbe,
    select: (d) => d.enabledModels,
    staleTime: 30_000, // 30s — fast enough for post-save invalidation
    retry: false
  })

  const rawEnabled = q.data ?? []
  return {
    rawEnabled,
    models: rawEnabled.length > 0 ? rawEnabled : FALLBACK_MODELS
  }
}

/** Fetch the models-facing slice of serve-api /chat/config (dotenv_values hot-read).
 *  Unreachable / not configured → all-off defaults（flag-off 姿态，旧 UI 字节级现状）。 */
export async function fetchChatConfigModelsProbe(): Promise<ChatConfigModelsProbe> {
  try {
    const baseUrl = resolveApiBaseUrl()
    const resp = await fetch(`${baseUrl}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return _PROBE_DEFAULTS
    const body = (await resp.json()) as {
      data?: {
        enabledModels?: unknown
        providerRegistryEnabled?: unknown
        kosConsumerEnabled?: unknown
        kosConfigured?: unknown
      }
    }
    const raw = body?.data?.enabledModels
    return {
      enabledModels: Array.isArray(raw)
        ? raw.filter((s): s is string => typeof s === 'string')
        : [],
      providerRegistryEnabled: body?.data?.providerRegistryEnabled === true,
      kosConsumerEnabled: body?.data?.kosConsumerEnabled === true,
      kosConfigured: body?.data?.kosConfigured === true
    }
  } catch {
    return _PROBE_DEFAULTS
  }
}

const _PROBE_DEFAULTS: ChatConfigModelsProbe = {
  enabledModels: [],
  providerRegistryEnabled: false,
  kosConsumerEnabled: false,
  kosConfigured: false
}

/** issue #54 — KOS 激活 gate 探针（设置-集成 KOS 区「开关开着 ≠ 实际激活」被动显因）。
 *  与 useEnabledModels / useProviderRegistryEnabled 共享同一 /chat/config query
 *  （同 queryKey + queryFn，React Query 按 key 去重）。 */
export function useKosGate(): {
  consumerEnabled: boolean
  configured: boolean
  isLoading: boolean
} {
  const q = useQuery({
    queryKey: qk.chat.config('enabledModels'),
    queryFn: fetchChatConfigModelsProbe,
    select: (d) => ({ consumerEnabled: d.kosConsumerEnabled, configured: d.kosConfigured }),
    staleTime: 30_000,
    retry: false
  })
  return {
    consumerEnabled: q.data?.consumerEnabled ?? false,
    configured: q.data?.configured ?? false,
    isLoading: q.isLoading
  }
}

/** Resolve the serve-api base URL for direct fetch calls, matching how
 *  the chat runtime determines it (see runtime.ts buildEngine / resolveApiPort).
 *  Intentionally duplicated here to keep this module free of circular imports
 *  with the chat runtime; keep in sync if the port-resolution logic changes.
 *  Exported for other raw-fetch consumers (e.g. AgentsTab 预处理 prompt 查看器). */
export function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  // Electron renderer: port injected by main via ?apiPort=N (same as runtime.ts).
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}
