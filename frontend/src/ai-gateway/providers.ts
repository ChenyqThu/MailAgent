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
  type LanguageModel
} from 'ai'

import { anthropicBaseUrl } from './config'

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
  capabilities: ProviderSnapshotModelCapabilities
  maxOutput: number | null
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

type RegistryProvider = Parameters<typeof createProviderRegistry>[0][string]

export interface BuiltProviderRegistry {
  registry: ReturnType<typeof createProviderRegistry>
  providers: Map<string, ProviderSnapshotProvider>
}

const SNAPSHOT_TTL_MS = 30_000
const MAX_OUTPUT_CEILING = 64_000

export function parseProviderRef(ref: string): ParsedProviderRef {
  const separatorIndex = ref.indexOf(':')
  if (separatorIndex === -1) return { providerId: 'default', modelId: ref }
  return {
    providerId: ref.slice(0, separatorIndex),
    modelId: ref.slice(separatorIndex + 1)
  }
}

function createProvider(
  provider: ProviderSnapshotProvider,
  logger: ProviderRegistryLogger
): RegistryProvider | null {
  const baseUrl = provider.baseUrl.trim()
  const options = {
    apiKey: provider.apiKey,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    headers: provider.headers
  }

  switch (provider.protocol) {
    case 'anthropic':
      return createAnthropic({
        ...options,
        ...(baseUrl ? { baseURL: anthropicBaseUrl(baseUrl) } : {})
      })
    case 'openai':
      return createOpenAI(options)
    case 'openai-compatible': {
      if (!baseUrl) {
        logger.warn(
          `[ai-gateway] skipping openai-compatible LLM provider without baseUrl: ${provider.id}`
        )
        return null
      }
      return createOpenAICompatible({
        ...options,
        baseURL: baseUrl,
        name: provider.id,
        includeUsage: true
      })
    }
    case 'deepseek':
      return createDeepSeek(options)
    case 'google':
      return createGoogleGenerativeAI(options)
    case 'openrouter':
      return createOpenRouter(options)
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

function createLegacyResolution(config: LegacyProviderConfig, ref: string): ResolvedProviderModel {
  const parsed = parseProviderRef(ref)
  const anthropic = createAnthropic({
    apiKey: config.apiKey ?? '',
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
    }
  }
}
