// P1 provider registry — the SDK-HEAVY half of the provider layer.
//
// 🔴 MEDIUM-6 (batch1 review) — this module top-level imports SIX provider SDK packages, so it
//    must NEVER be statically value-imported by an always-loaded module. The only runtime entry
//    is the flag-on `await import()` in ai_gateway_lifecycle.ts; everything SDK-free (providerRef
//    parsing, snapshot types, URL canonicalization, the credentials error) lives in providerRef.ts
//    and is what chatRun / thinking / config import. A static-source test pins this split
//    (tests/ai-gateway/provider_lazy_import.test.ts).

import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import {
  createProviderRegistry,
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type ImageModel
} from 'ai'

import { anthropicBaseUrl } from './config'
import {
  canonicalApiBase,
  canonicalRoot,
  IMAGE_MODEL_PROTOCOLS,
  parseProviderRef,
  ProviderCredentialsError,
  ProviderImageModelError,
  type LegacyProviderConfig,
  type ProviderModelResolver,
  type ProviderRegistryLogger,
  type ProviderSnapshot,
  type ProviderSnapshotFetcher,
  type ProviderSnapshotProvider,
  type ProviderProtocol,
  type ResolvedProviderModel
} from './providerRef'

// Back-compat re-exports (tests + any consumer that imported the whole surface from here before
// the MEDIUM-6 split). New always-loaded code must import from './providerRef' instead.
export {
  canonicalApiBase,
  canonicalRoot,
  IMAGE_MODEL_PROTOCOLS,
  isProviderCredentialsError,
  parseProviderRef,
  ProviderCredentialsError,
  ProviderImageModelError
} from './providerRef'
export type {
  LegacyProviderConfig,
  ParsedProviderRef,
  ProviderModelResolver,
  ProviderProtocol,
  ProviderRegistryLogger,
  ProviderSnapshot,
  ProviderSnapshotFetcher,
  ProviderSnapshotModel,
  ProviderSnapshotModelCapabilities,
  ProviderSnapshotProvider,
  ResolvedProviderModel
} from './providerRef'

type RegistryProvider = Parameters<typeof createProviderRegistry>[0][string]

export interface BuiltProviderRegistry {
  registry: ReturnType<typeof createProviderRegistry>
  providers: Map<string, ProviderSnapshotProvider>
}

const SNAPSHOT_TTL_MS = 30_000
const MAX_OUTPUT_CEILING = 64_000

// HIGH-1 — protocols whose upstream accepts keyless calls (local unauthenticated services, e.g. a
// LAN Ollama behind createOpenAICompatible). Every other protocol requires a per-provider key once
// the registry path is on; Python provider_routing carries the same semantics.
const KEY_OPTIONAL_PROTOCOLS: ReadonlySet<string> = new Set(['openai-compatible'])

// 发版终审 M2（codex）— 自定义 header 与系统鉴权头碰撞时系统 apiKey 恒赢（大小写不敏感），
// 对齐 Python probe `_merge_headers` 的既有语义（llm_providers.py）：锁定版本的各 AI SDK 在
// 系统鉴权头**之后**展开自定义 headers，自定义 `Authorization`/`X-API-Key` 会顶掉 apiKey →
// 出现「Settings 测试成功但 chat 失败」。剔除仅在行 key 非空时做——keyless openai-compatible
// （LAN 网关）可能以自定义 Authorization 作唯一凭证（Python 侧 api_key 为空时 auth={}，
// 自定义头同样存活），与可达路径上的 Python 行为逐一对齐。
const AUTH_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'x-api-key'])

function sanitizeProviderHeaders(provider: ProviderSnapshotProvider): Record<string, string> {
  if (!provider.apiKey) return provider.headers
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(provider.headers)) {
    if (AUTH_HEADER_NAMES.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

function createProvider(
  provider: ProviderSnapshotProvider,
  logger: ProviderRegistryLogger
): RegistryProvider | null {
  const rawBaseUrl = provider.baseUrl.trim()
  const options = {
    apiKey: provider.apiKey,
    headers: sanitizeProviderHeaders(provider)
  }

  // HIGH-2 — per-protocol baseURL canonicalization (双端契约, mirrored by Python provider_routing):
  // the DB row keeps the user's raw value; each consumer derives the protocol's canonical form.
  // Empty base → omit baseURL so the SDK's official default applies (openai-compatible excepted —
  // it has no default and is skipped with a warning).
  switch (provider.protocol) {
    case 'anthropic':
      // canonical_root + '/v1': strip a trailing /vN then let anthropicBaseUrl re-append /v1, so
      // 'https://host/api/v1' and 'https://host/api' both hit '<root>/v1/messages'
      // (@ai-sdk/anthropic only appends '/messages'; Python's AsyncAnthropic gets the bare root).
      return createAnthropic({
        ...options,
        ...(rawBaseUrl ? { baseURL: anthropicBaseUrl(canonicalRoot(rawBaseUrl)) } : {})
      })
    case 'openai':
      return createOpenAI({
        ...options,
        ...(rawBaseUrl ? { baseURL: canonicalApiBase(rawBaseUrl) } : {})
      })
    case 'openai-compatible': {
      if (!rawBaseUrl) {
        logger.warn(
          `[ai-gateway] skipping openai-compatible LLM provider without baseUrl: ${provider.id}`
        )
        return null
      }
      return createOpenAICompatible({
        ...options,
        baseURL: canonicalApiBase(rawBaseUrl),
        name: provider.id,
        includeUsage: true
      })
    }
    case 'deepseek':
      return createDeepSeek({
        ...options,
        ...(rawBaseUrl ? { baseURL: canonicalApiBase(rawBaseUrl) } : {})
      })
    case 'google':
      // google 非空值原样透传：@ai-sdk/google 的默认路径习惯是 /v1beta（非 /v1），套用
      // canonical_api_base 会拼出不存在的路径 —— 用户自定义值按其网关文档原样填（契约条款）。
      return createGoogleGenerativeAI({
        ...options,
        ...(rawBaseUrl ? { baseURL: rawBaseUrl } : {})
      })
    case 'openrouter':
      // openrouter 官方默认已含 /api/v1；非空自定义值同 openai 家族用 canonical_api_base。
      return createOpenRouter({
        ...options,
        ...(rawBaseUrl ? { baseURL: canonicalApiBase(rawBaseUrl) } : {})
      })
    default:
      logger.warn(`[ai-gateway] skipping unsupported LLM provider protocol: ${provider.protocol}`)
      return null
  }
}

export function buildProviderRegistry(
  snapshot: ProviderSnapshot,
  logger: ProviderRegistryLogger = console
): BuiltProviderRegistry {
  const providers: Record<string, RegistryProvider> = {}
  const enabledProviders = new Map<string, ProviderSnapshotProvider>()

  for (const provider of snapshot.providers) {
    if (!provider.enabled) continue
    const instance = createProvider(provider, logger)
    if (!instance) continue
    providers[provider.id] = instance
    enabledProviders.set(provider.id, provider)
  }

  return {
    // ai@7 DefaultProviderRegistry.splitId uses indexOf(separator), so model ids may contain ':'.
    registry: createProviderRegistry(providers),
    providers: enabledProviders
  }
}

function resolveFromRegistry(built: BuiltProviderRegistry, ref: string): ResolvedProviderModel {
  const parsed = parseProviderRef(ref)
  const provider = built.providers.get(parsed.providerId)
  if (!provider) throw new Error(`No enabled LLM provider: ${parsed.providerId}`)

  // HIGH-1 — registry-only credentials: the selected row's key is the authority (the legacy
  // global-key pre-gate is skipped when the registry path is on). A key-requiring protocol with an
  // empty row key fails HERE with the typed E_NO_LLM_KEY the entrypoints already map to 503.
  if (!provider.apiKey && !KEY_OPTIONAL_PROTOCOLS.has(provider.protocol)) {
    throw new ProviderCredentialsError(
      `LLM provider ${parsed.providerId} 缺少 API key（Settings → 模型服务中补全后重试）`
    )
  }

  let model = built.registry.languageModel(`${parsed.providerId}:${parsed.modelId}`)
  const modelConfig = provider.models.find(
    (candidate) => candidate.enabled && candidate.id === parsed.modelId
  )
  if (modelConfig?.maxOutput != null) {
    model = wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { maxOutputTokens: Math.min(MAX_OUTPUT_CEILING, modelConfig.maxOutput) }
      })
    })
  }

  return {
    ...parsed,
    model,
    protocol: provider.protocol as ProviderProtocol
  }
}

export function resolveProviderModel(
  built: BuiltProviderRegistry,
  ref: string
): ResolvedProviderModel {
  return resolveFromRegistry(built, ref)
}

/** task 09-02 (generate_image) — resolve an IMAGE model from the same registry / providerRef
 *  vocabulary. Only the two OpenAI-shaped protocols carry `imageModel()` (`/images/generations`
 *  + `/images/edits`); every other enabled row throws the typed `ProviderImageModelError` so the
 *  tool can say "pick an OpenAI-protocol model in Settings" instead of surfacing whatever the
 *  registry would throw for a provider without image support. The credentials rule is the
 *  language-model rule verbatim (row key is the authority; openai-compatible may run keyless). */
export function resolveImageModel(built: BuiltProviderRegistry, ref: string): ImageModel {
  const parsed = parseProviderRef(ref)
  const provider = built.providers.get(parsed.providerId)
  if (!provider) {
    throw new ProviderImageModelError(`No enabled LLM provider: ${parsed.providerId}`)
  }
  if (!IMAGE_MODEL_PROTOCOLS.has(provider.protocol)) {
    throw new ProviderImageModelError(
      `LLM provider ${parsed.providerId} (${provider.protocol}) has no image model — IMAGE_GEN_MODEL must point at an openai / openai-compatible provider`
    )
  }
  if (!provider.apiKey && !KEY_OPTIONAL_PROTOCOLS.has(provider.protocol)) {
    throw new ProviderCredentialsError(
      `LLM provider ${parsed.providerId} 缺少 API key（Settings → 模型服务中补全后重试）`
    )
  }
  return built.registry.imageModel(`${parsed.providerId}:${parsed.modelId}`)
}

function createLegacyResolution(config: LegacyProviderConfig, ref: string): ResolvedProviderModel {
  // HIGH-1 — this fail-open leg only runs on the FLAG-ON path (snapshot unreachable / cold start).
  // With the global pre-gate skipped, an empty legacy key here must fail typed rather than fire a
  // keyless upstream call that 401s opaquely.
  if (!config.apiKey || config.apiKey.length === 0) {
    throw new ProviderCredentialsError(
      'LLM provider 快照不可用，且回退用的 LLM_API_KEY 未配置（检查 serve-api 或补 .env key）'
    )
  }
  const parsed = parseProviderRef(ref)
  const anthropic = createAnthropic({
    apiKey: config.apiKey,
    baseURL: anthropicBaseUrl(config.baseUrl)
  })
  return { ...parsed, model: anthropic(parsed.modelId), protocol: 'anthropic' }
}

export function createProviderModelResolver(options: {
  fetchSnapshot: ProviderSnapshotFetcher
  legacy: LegacyProviderConfig
  logger?: ProviderRegistryLogger
  now?: () => number
}): ProviderModelResolver {
  const logger = options.logger ?? console
  const now = options.now ?? Date.now
  let cachedSnapshot: ProviderSnapshot | null = null
  let cachedRegistry: BuiltProviderRegistry | null = null
  let expiresAt = 0
  let warnedUnavailable = false

  async function refresh(): Promise<BuiltProviderRegistry | null> {
    if (now() < expiresAt) return cachedRegistry

    try {
      const snapshot = await options.fetchSnapshot()
      expiresAt = now() + SNAPSHOT_TTL_MS
      warnedUnavailable = false
      if (cachedSnapshot?.version === snapshot.version && cachedRegistry) {
        cachedSnapshot = snapshot
        return cachedRegistry
      }
      cachedSnapshot = snapshot
      cachedRegistry = buildProviderRegistry(snapshot, logger)
      return cachedRegistry
    } catch (error) {
      expiresAt = now() + SNAPSHOT_TTL_MS
      if (!warnedUnavailable) {
        logger.warn(
          '[ai-gateway] LLM provider snapshot unavailable; using fail-open fallback',
          error
        )
        warnedUnavailable = true
      }
      return cachedRegistry
    }
  }

  return {
    async resolve(ref: string): Promise<ResolvedProviderModel> {
      const registry = await refresh()
      return registry
        ? resolveFromRegistry(registry, ref)
        : createLegacyResolution(options.legacy, ref)
    },
    // task 09-02 — no legacy leg on purpose: the env fallback is an anthropic single-provider
    // config, which structurally has no image model. Snapshot unreachable → typed error.
    async resolveImageModel(ref: string): Promise<ImageModel> {
      const registry = await refresh()
      if (!registry) {
        throw new ProviderImageModelError(
          'LLM provider 快照不可用，无法解析图像模型（检查 serve-api 后重试）'
        )
      }
      return resolveImageModel(registry, ref)
    }
  }
}
