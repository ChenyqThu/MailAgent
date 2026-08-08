import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import { lookupModelMeta } from './lookup'

export interface ContextWindowSnapshotModel {
  contextWindow?: number | null
}

export function resolveContextWindow(input: {
  providerId: string
  modelId: string
  protocol: LlmProviderProtocol | null | undefined
  snapshotModel?: ContextWindowSnapshotModel | null
}): number | null {
  const rowValue = input.snapshotModel?.contextWindow
  if (typeof rowValue === 'number' && Number.isFinite(rowValue) && rowValue > 0) return rowValue
  return lookupModelMeta(input.modelId, input.protocol)?.contextWindow ?? null
}
