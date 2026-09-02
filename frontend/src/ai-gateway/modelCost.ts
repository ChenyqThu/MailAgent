// L4 群聊 g1 — 一次模型调用的美元成本估算（叶子：只引 @shared/modelCatalog/lookup）。
//
// 定价源 = modelCatalog 快照的 CatalogCost（$ / 百万 token，models.dev）。不新建手抄定价表
// （父设计 §9 否决 pricing.ts）。查不到模型 / 目录无 cost / usage 缺席 → null：调用方落库 NULL，
// hourly_budget 地板对 NULL 不生效、由 tokens 地板兜底（父设计 §5）。
//
// gateway 吃 lookup.ts（含 catalog.json）的实证：ai_gateway_lifecycle.ts 已 import
// @shared/modelCatalog/contextWindow → ./lookup → ./catalog.json，是既有生产 import 链。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'
import { lookupModelMeta } from '@shared/modelCatalog/lookup'

export interface TokenUsage {
  inputTokens: number | null
  outputTokens: number | null
}

const PER_MILLION = 1_000_000

/** 估算成本（美元）。input / output 任一侧目录无价而 usage 有数 → 仍返 null（不给半价）。 */
export function costUsdFor(
  modelId: string | null | undefined,
  usage: TokenUsage | null | undefined,
  protocol?: LlmProviderProtocol | null
): number | null {
  if (!modelId || !usage) return null
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  if (input === 0 && output === 0) return null
  const cost = lookupModelMeta(modelId, protocol)?.cost
  if (!cost) return null
  if (input > 0 && cost.input == null) return null
  if (output > 0 && cost.output == null) return null
  return (input * (cost.input ?? 0) + output * (cost.output ?? 0)) / PER_MILLION
}
