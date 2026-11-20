// L4 群聊 g1 + Phase 4 — 一次模型调用的美元成本估算（叶子：只引 @shared/modelCatalog/lookup）。
//
// 定价源 = modelCatalog 快照的 CatalogCost（$ / 百万 token，models.dev）。不新建手抄定价表
// （父设计 §9 否决 pricing.ts）。查不到模型 / 目录无 cost / usage 缺席 → null：调用方落库 NULL，
// hourly_budget 地板对 NULL 不生效、由 tokens 地板兜底（父设计 §5）。
//
// Phase 4 四档阶梯计价：
//   total = (uncachedInput * cost.input + output * cost.output
//            + cacheRead * (cost.cacheRead ?? cost.input)
//            + cacheWrite * (cost.cacheWrite ?? cost.input)) / 1_000_000
//
// 🔴 口径纪律（严防 cacheRead 被双倍计价）：
//   ai@7 LanguageModelUsage.inputTokens 是**总 prompt token**（含 noCacheTokens + cacheRead +
//   cacheWrite）。因此默认（inputIsUncachedOnly 未置 true）先按 noCacheTokens 或
//   max(0, inputTokens - cacheRead - cacheWrite) 扣出未缓存输入，绝不把已走缓存折扣的 token
//   按原价再算一遍。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'
import { lookupModelMeta } from '@shared/modelCatalog/lookup'

export interface TokenUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  noCacheTokens?: number | null
  /** true = 调用方传入的 inputTokens 仅代表未缓存输入（Anthropic raw API 口径）；
   *  false/省略 = AI SDK 口径，inputTokens 为含缓存的总 prompt token。 */
  inputIsUncachedOnly?: boolean
}

const PER_MILLION = 1_000_000

function nonNeg(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function uncachedInputOf(usage: TokenUsage, cacheRead: number, cacheWrite: number): number {
  if (typeof usage.noCacheTokens === 'number' && Number.isFinite(usage.noCacheTokens)) {
    return Math.max(0, usage.noCacheTokens)
  }
  const input = nonNeg(usage.inputTokens)
  if (usage.inputIsUncachedOnly === true) return input
  return Math.max(0, input - cacheRead - cacheWrite)
}

/** 估算四档阶梯成本（美元）。input / output 任一侧目录无价而 usage 有数 → 仍返 null（不给半价）。 */
export function costUsdFor(
  modelId: string | null | undefined,
  usage: TokenUsage | null | undefined,
  protocol?: LlmProviderProtocol | null
): number | null {
  if (!modelId || !usage) return null
  const cacheRead = nonNeg(usage.cacheReadTokens)
  const cacheWrite = nonNeg(usage.cacheWriteTokens)
  const uncachedInput = uncachedInputOf(usage, cacheRead, cacheWrite)
  const output = nonNeg(usage.outputTokens)
  if (uncachedInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null

  const cost = lookupModelMeta(modelId, protocol)?.cost
  if (!cost) return null
  if ((uncachedInput > 0 || cacheRead > 0 || cacheWrite > 0) && cost.input == null) return null
  if (output > 0 && cost.output == null) return null

  const inRate = cost.input ?? 0
  const outRate = cost.output ?? 0
  const readRate = cost.cacheRead ?? inRate
  const writeRate = cost.cacheWrite ?? inRate

  return (
    (uncachedInput * inRate +
      output * outRate +
      cacheRead * readRate +
      cacheWrite * writeRate) /
    PER_MILLION
  )
}

/** 估算 Prompt Cache 读取省下的金额（美元）。查不到价或无 cacheRead → null。 */
export function cacheSavedUsdFor(
  modelId: string | null | undefined,
  usage: TokenUsage | null | undefined,
  protocol?: LlmProviderProtocol | null
): number | null {
  if (!modelId || !usage) return null
  const cacheRead = nonNeg(usage.cacheReadTokens)
  if (cacheRead === 0) return 0
  const cost = lookupModelMeta(modelId, protocol)?.cost
  if (!cost || cost.input == null) return null
  const readRate = cost.cacheRead ?? cost.input
  return Math.max(0, cacheRead * (cost.input - readRate)) / PER_MILLION
}
