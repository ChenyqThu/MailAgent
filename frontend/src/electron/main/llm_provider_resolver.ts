import type {
  ProviderModelResolver,
  ProviderSnapshot,
  ResolvedProviderModel
} from '../../ai-gateway/providerRef'

import { daemonRequest } from './daemon_api'
import { getLlmApiKey, getLlmBaseUrl } from './llm_settings'

const MAX_OUTPUT_TOKENS = 64_000

export interface MainProcessResolvedProviderModel extends ResolvedProviderModel {
  maxOutputTokens: number
}

export interface MainProcessProviderModelResolver extends ProviderModelResolver {
  resolve(ref: string): Promise<MainProcessResolvedProviderModel>
}

let sharedResolverPromise: Promise<MainProcessProviderModelResolver> | null = null

/** Mirror electron readEnvBool: only '1'/'true' (case-insensitive) → true. */
export function isLlmProviderRegistryEnabled(): boolean {
  const raw = process.env['MAILAGENT_LLM_PROVIDER_REGISTRY']
  if (raw == null || raw === '') return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true'
}

/**
 * Main-process singleton for the flag-on provider registry. The SDK-heavy provider
 * module stays behind this dynamic import so flag-off startup never loads it.
 */
export async function getLlmProviderModelResolver(): Promise<MainProcessProviderModelResolver> {
  if (!sharedResolverPromise) {
    sharedResolverPromise = (async () => {
      const apiKey = await getLlmApiKey()
      const baseUrl = getLlmBaseUrl()
      let latestSnapshot: ProviderSnapshot | null = null
      const { createProviderModelResolver } = await import('../../ai-gateway/providers')
      const resolver = createProviderModelResolver({
        fetchSnapshot: async () => {
          const snapshot = await daemonRequest<ProviderSnapshot>('GET', '/llm/providers/snapshot')
          latestSnapshot = snapshot
          return snapshot
        },
        legacy: { apiKey, baseUrl }
      })
      return {
        async resolve(ref: string): Promise<MainProcessResolvedProviderModel> {
          const resolved = await resolver.resolve(ref)
          const configuredMax = latestSnapshot?.providers
            .find((provider) => provider.id === resolved.providerId)
            ?.models.find((model) => model.enabled && model.id === resolved.modelId)?.maxOutput
          return {
            ...resolved,
            maxOutputTokens:
              configuredMax == null
                ? MAX_OUTPUT_TOKENS
                : Math.min(MAX_OUTPUT_TOKENS, configuredMax)
          }
        }
      }
    })()
  }
  return sharedResolverPromise
}
