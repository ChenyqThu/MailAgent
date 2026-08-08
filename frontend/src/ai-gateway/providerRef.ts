// P1 provider registry — the SDK-FREE half of the provider layer (batch1 review MEDIUM-6).
//
// 🔴 Lazy-rollback discipline: providers.ts top-level imports SIX provider SDK packages
//    (@ai-sdk/{anthropic,openai,openai-compatible,deepseek,google} + @openrouter/ai-sdk-provider),
//    so it must only ever load behind the MAILAGENT_LLM_PROVIDER_REGISTRY flag (dynamic import in
//    ai_gateway_lifecycle.ts). Everything the ALWAYS-LOADED modules (chatRun / thinking / config /
//    lifecycle top level) need — providerRef parsing, snapshot wire types, URL canonicalization,
//    the typed credentials error — lives HERE, with zero runtime imports (the 'ai' import below is
//    type-only, fully erased). Never add a value import of an SDK package to this file.

import type { LanguageModel } from 'ai'

export type ProviderProtocol =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'deepseek'
  | 'google'
  | 'openrouter'

export interface ProviderSnapshotModelCapabilities {
  tools: boolean
  vision: boolean
  reasoning: boolean
}

export interface ProviderSnapshotModel {
  id: string
  displayName: string | null
  enabled: boolean
  /** null = 未标注（PRD §4.3b 注记②：snapshot 不臆造能力位；Python 对 seed/manual 行发 null）。
   *  Consumers must treat null as "unknown", NOT as all-false / all-true. */
  capabilities: ProviderSnapshotModelCapabilities | null
  maxOutput: number | null
  contextWindow?: number | null
  source: 'fetched' | 'manual'
}

export interface ProviderSnapshotProvider {
  id: string
  protocol: ProviderProtocol | string
  displayName: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  enabled: boolean
  models: ProviderSnapshotModel[]
}

export interface ProviderSnapshot {
  version: number
  providers: ProviderSnapshotProvider[]
}

export interface ParsedProviderRef {
  providerId: string
  modelId: string
}

export interface ResolvedProviderModel extends ParsedProviderRef {
  model: LanguageModel
  protocol: ProviderProtocol
  /** harness-chat lane C (07-15) — the explicit output-token ceiling to pass to streamText/
   *  generateText for THIS model: `min(64000, row.maxOutput)` when the resolved provider row pins
   *  a lower cap, else the 64k owner-discipline default. Only the main-process wrapping resolver
   *  (`getLlmProviderModelResolver`, llm_provider_resolver.ts — used by both the gateway lifecycle
   *  AND translate/nl_search) populates this; the legacy/test-mock resolveModelFactory branches in
   *  chatRun.ts leave it undefined, and callers fall back to 64_000 themselves. Optional so every
   *  existing ResolvedProviderModel producer stays source-compatible. */
  maxOutputTokens?: number
  contextWindow?: number | null
}

export interface ProviderModelResolver {
  resolve(ref: string): Promise<ResolvedProviderModel>
}

export type ProviderSnapshotFetcher = () => Promise<ProviderSnapshot>

export interface ProviderRegistryLogger {
  warn(message: string, error?: unknown): void
}

export interface LegacyProviderConfig {
  apiKey: string | null
  baseUrl: string
}

export function parseProviderRef(ref: string): ParsedProviderRef {
  const separatorIndex = ref.indexOf(':')
  if (separatorIndex === -1) return { providerId: 'default', modelId: ref }
  return {
    providerId: ref.slice(0, separatorIndex),
    modelId: ref.slice(separatorIndex + 1)
  }
}

// ── URL canonicalization（批 1 review HIGH-2，双端契约 —— Python provider_routing 同一段文字）──
//
// DB base_url 存用户原始输入（写入仅 trim + 去尾 '/'）；按协议在消费端归一：
//   anthropic     → canonical_root + '/v1'（@ai-sdk/anthropic 只补 /messages）
//   openai 家族   → canonical_api_base（已以 /vN 结尾原样，否则补 /v1）
//   google        → 非空原样（其 SDK 路径习惯不同 —— providers.ts 分支注释）

/** canonical_root（anthropic 协议用）= trim + 去尾 '/' 后再剥一段尾部 `/v<N>`（若有）。
 *  这样用户填 `https://host/api/v1` 与 `https://host/api` 两种形态最终产出同一 URL。 */
export function canonicalRoot(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/v\d+$/, '')
}

/** canonical_api_base（openai / deepseek / openai-compatible / openrouter 用）= trim + 去尾 '/'
 *  后：已以 `/v<N>` 结尾则原样（保 /v2 等非默认版本），否则补 `/v1`。空值 → ''（调用方走官方默认）。 */
export function canonicalApiBase(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

// ── typed credentials error（批 1 review HIGH-1）────────────────────────────────────────────────
//
// Flag ON skips the legacy global-key pre-gate (llmCredentialsMissing in chatRun.ts); the resolver
// then throws THIS error when the selected provider row lacks a required key (openai-compatible
// rows may run keyless — local unauthenticated services). The entrypoints map `.code` back to the
// existing 503 E_NO_LLM_KEY wire shape, so registry-only credentials work without an .env key.

export class ProviderCredentialsError extends Error {
  readonly code = 'E_NO_LLM_KEY' as const

  constructor(message: string) {
    super(message)
    this.name = 'ProviderCredentialsError'
  }
}

export function isProviderCredentialsError(e: unknown): e is ProviderCredentialsError {
  return e instanceof Error && (e as { code?: unknown }).code === 'E_NO_LLM_KEY'
}
