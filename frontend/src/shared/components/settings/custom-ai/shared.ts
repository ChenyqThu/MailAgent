// Shared helpers for the Settings "Custom AI" section subfiles.
//
// resolveApiBaseUrl() + the /chat/config flag fetchers are used across multiple
// custom-ai/* subfiles; they live here so each section file imports one source.

import { useEnvStore } from '@shared/state/env'

/** task 07-22 — read a main-env-only bool flag's **.env intent value** (WebCapabilityRow precedent).
 *  These flags are NOT surfaced on /chat/config (the gateway reads them once via envBool at Electron
 *  main startup), so the only source is the .env snapshot. envBool semantics mirror
 *  (ai_gateway_lifecycle.ts): unset → default; else lowercased ∈ {1,true}. Store not ready →
 *  optimistically returns default (so a loading state isn't misread as off). Lives here (not in a
 *  component file) so both SystemCapabilitiesSection and SkillsSection import one source without
 *  tripping react-refresh/only-export-components. */
export function useEnvFlagIntent(key: string, defaultValue: boolean): boolean {
  const envState = useEnvStore((s) => s.state)
  if (envState.status !== 'ready') return defaultValue
  const raw = envState.snapshot.values[key] ?? ''
  if (raw === '') return defaultValue
  return ['1', 'true'].includes(raw.trim().toLowerCase())
}

// Resolve serve-api base URL for direct fetch calls (mirrors useLlmModels.ts resolveApiBaseUrl;
// intentionally duplicated to avoid circular imports with the chat runtime).
export function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
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

/** Fetch userMdCompileEnabled from serve-api /chat/config (runtime flag, not vite define).
 *  Returns false when not configured or the endpoint is unreachable. */
export async function fetchUserMdCompileEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { userMdCompileEnabled?: unknown } }
    return body?.data?.userMdCompileEnabled === true
  } catch {
    return false
  }
}

/** Fetch standingDocsEditorEnabled from serve-api /chat/config.
 *  Returns true when not configured or endpoint is unreachable (default-ON flag). */
export async function fetchStandingDocsEditorEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return true // default ON: show section when config unavailable
    const body = (await resp.json()) as { data?: { standingDocsEditorEnabled?: unknown } }
    // Explicit false → hide. undefined/null/true → show (default ON).
    return body?.data?.standingDocsEditorEnabled !== false
  } catch {
    return true
  }
}

/** Fetch execPolicyEnabled from serve-api /chat/config. Returns false (hide) when not configured
 *  or unreachable — this flag is default-OFF (unlike standingDocs), so absence means "not enabled". */
export async function fetchExecPolicyEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { execPolicyEnabled?: unknown } }
    return body?.data?.execPolicyEnabled === true
  } catch {
    return false
  }
}

/** Fetch connectorToolsEnabled from serve-api /chat/config (MCP connector 灰度 flag，08-01 PR4).
 *  Returns false (hide) when not configured or unreachable — flag off 时 `/api/connector/*` 全部
 *  409，渲染一个只会报错的区块比不渲染更糟，故与 execPolicy 同姿态：不确定就当没开。 */
export async function fetchConnectorToolsEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { connectorToolsEnabled?: unknown } }
    return body?.data?.connectorToolsEnabled === true
  } catch {
    return false
  }
}

/** Fetch skillInstallEnabled from serve-api /chat/config. Returns false (hide) when not
 *  configured or unreachable — default-OFF flag (same posture as fetchExecPolicyEnabled). */
export async function fetchSkillInstallEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { skillInstallEnabled?: unknown } }
    return body?.data?.skillInstallEnabled === true
  } catch {
    return false
  }
}

export async function fetchSkillCreatorEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { skillCreatorEnabled?: unknown } }
    return body?.data?.skillCreatorEnabled === true
  } catch {
    return false
  }
}

export async function fetchAgentPluginsEnabled(): Promise<boolean> {
  try {
    const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!resp.ok) return false
    const body = (await resp.json()) as { data?: { agentPluginsEnabled?: unknown } }
    return body?.data?.agentPluginsEnabled === true
  } catch {
    return false
  }
}
