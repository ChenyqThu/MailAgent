// dynamic-models — React Query hooks for upstream model list + enabled-model set.
//
// FALLBACK_MODELS is the single source of truth for the four supported models
// used when LLM_ENABLED_MODELS is not configured in .env. All three consumers
// (AIChatPanel model picker, AgentsTab ConfigDrawer radio list, AiTab selects)
// import from here so the list only changes in one place.

import { useQuery, useQueryClient } from '@tanstack/react-query'
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
    queryKey: ['llm', 'upstream-models', provider] as const,
    queryFn: () => api.llm.listUpstreamModels({ provider }),
    staleTime: 5 * 60 * 1_000, // 5 min mirrors server-side TTL
    retry: false
  })

  const refresh = async (): Promise<void> => {
    await api.llm.listUpstreamModels({ refresh: true, provider })
    await qc.invalidateQueries({ queryKey: ['llm', 'upstream-models', provider] })
  }

  return {
    models: q.data?.models ?? [],
    isLoading: q.isLoading,
    error: q.data?.error,
    refresh
  }
}

// ── enabled models (LLM_ENABLED_MODELS, hot-read from /chat/config) ─────────

export function useEnabledModels(): { models: string[]; rawEnabled: string[] } {
  // queryKey ['chat','config','enabledModels']: AiTab's checkbox handler
  // calls invalidateQueries on this key after writing LLM_ENABLED_MODELS so
  // the chat picker reflects the new selection without a page reload.
  const q = useQuery({
    queryKey: ['chat', 'config', 'enabledModels'] as const,
    queryFn: fetchEnabledModels,
    staleTime: 30_000, // 30s — fast enough for post-save invalidation
    retry: false
  })

  const rawEnabled = q.data ?? []
  return {
    rawEnabled,
    models: rawEnabled.length > 0 ? rawEnabled : FALLBACK_MODELS
  }
}

/** Fetch LLM_ENABLED_MODELS from serve-api /chat/config (dotenv_values hot-read).
 *  Returns [] when not configured or the endpoint is unreachable. */
async function fetchEnabledModels(): Promise<string[]> {
  try {
    const baseUrl = resolveApiBaseUrl()
    const resp = await fetch(`${baseUrl}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return []
    const body = (await resp.json()) as { data?: { enabledModels?: unknown } }
    const raw = body?.data?.enabledModels
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/** Resolve the serve-api base URL for direct fetch calls, matching how
 *  the chat runtime determines it (see runtime.ts buildEngine / resolveApiPort).
 *  Intentionally duplicated here to keep this module free of circular imports
 *  with the chat runtime; keep in sync if the port-resolution logic changes. */
function resolveApiBaseUrl(): string {
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
