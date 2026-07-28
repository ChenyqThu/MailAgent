import type {
  ProviderModelResolver,
  ProviderSnapshot,
  ResolvedProviderModel
} from '../../ai-gateway/providerRef'

import { MAX_OUTPUT_TOKENS } from '@shared/lib/llm_limits'

import { daemonRequest } from './daemon_api'
import { getLlmApiKey, getLlmBaseUrl } from './llm_settings'

// 批 2 review MEDIUM-4 → 发版终审 M3 下沉：实现移到 gateway core（server.ts /
// searchAgentRun.ts 同源消费）；这里 re-export 保兼容（translate/nl_search + 单测都从
// 本模块取用）。
export { sanitizedUpstreamErrorMessage } from '../../ai-gateway/upstreamError'

// MAX_OUTPUT_TOKENS 单源自 `@shared/lib/llm_limits`（issue #68）。

export interface MainProcessResolvedProviderModel extends ResolvedProviderModel {
  maxOutputTokens: number
}

export interface MainProcessProviderModelResolver extends ProviderModelResolver {
  resolve(ref: string): Promise<MainProcessResolvedProviderModel>
}

let sharedResolverPromise: Promise<MainProcessProviderModelResolver> | null = null

/**
 * 发版终审 HIGH-1（fable）— keytar-only 旧 LLM key 一次性回填。
 *
 * Python seed 只读 .env：key 只存在 macOS Keychain（keytar slot、未 dual-write 到 .env）
 * 的存量用户，seed 出的 default provider 行密文为空 → flag on 后五个 LLM 入口全 503。
 * 修法：flag-on 启动时（resolver 构建**之前**，见 ai_gateway_lifecycle 调用点）拉一次
 * snapshot——default 行无 key（snapshot 返回解密 key 字段，判空即可）且 legacy 链
 * （getLlmApiKey：env → keytar）有值 → PATCH 回填；serve-api 落库即 bump version，后建的
 * resolver 首拉快照天然拿到新 key。幂等（default 行已有 key 恒 no-op）；任何失败仅
 * warning，绝不阻断 gateway 启动（fail-open 腿仍可用 legacy env key 兜底）。
 */
export async function backfillLegacyDefaultProviderKey(): Promise<void> {
  try {
    const snapshot = await daemonRequest<ProviderSnapshot>('GET', '/llm/providers/snapshot')
    const defaultRow = snapshot.providers.find((provider) => provider.id === 'default')
    if (!defaultRow || defaultRow.apiKey) return
    const legacyKey = await getLlmApiKey()
    if (!legacyKey) return
    await daemonRequest('PATCH', '/llm/providers/default', { body: { apiKey: legacyKey } })
    console.log('[ai-gateway] backfilled the keytar-only LLM key into the default provider row')
  } catch (err) {
    console.warn('[ai-gateway] legacy LLM key backfill skipped (non-fatal)', err)
  }
}

/**
 * Default ON（2026-07-13 cutover）——镜像 ai_gateway_lifecycle 的 envBool(key, true)
 * 先例（MAILAGENT_ISLAND_AGENT_ENABLED）：缺省/空串 = on（删键 = on）；显式值仅
 * '1'/'true'（trim + 大小写不敏感）→ on，其余（'false'/'0' 等）→ off 应急回退——
 * 与 Python pydantic 对 'false'/'0' 的 bool 解析同向（显式 false 才 off）。
 */
export function isLlmProviderRegistryEnabled(): boolean {
  const raw = process.env['MAILAGENT_LLM_PROVIDER_REGISTRY']
  if (raw == null || raw === '') return true
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
              configuredMax == null ? MAX_OUTPUT_TOKENS : Math.min(MAX_OUTPUT_TOKENS, configuredMax)
          }
        }
      }
    })()
  }
  return sharedResolverPromise
}
