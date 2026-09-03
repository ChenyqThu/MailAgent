// task 09-02 — the「图像生成模型」select's candidate set, as a pure function so the filter has a
// unit test instead of living inside a React memo.
//
// A candidate = an ENABLED model ref (the same /chat/config enabledModels list every other model
// picker uses) whose provider is enabled AND speaks one of the two protocols the AI SDK ships an
// image model for. The protocol list is the gateway's own (providerRef.ts IMAGE_MODEL_PROTOCOLS —
// the resolver refuses anything else), so Settings can never offer a ref the tool would reject.
// Capabilities are deliberately NOT consulted: `capabilities_json` has no image bit and the
// registry does not invent one (llm-provider-registry.md §2), so a text-only gpt-4o row stays
// selectable — the honest surface is the tool error on first use, not a guessed badge.

import { refProviderId } from '@shared/hooks/useLlmProviders'

import { IMAGE_MODEL_PROTOCOLS } from '../../../../ai-gateway/providerRef'

export interface ImageModelProviderRow {
  id: string
  protocol: string
  enabled: boolean
}

export function imageModelCandidates(
  enabledRefs: readonly string[],
  providers: ReadonlyArray<ImageModelProviderRow>
): string[] {
  const imageProviders = new Set(
    providers.filter((p) => p.enabled && IMAGE_MODEL_PROTOCOLS.has(p.protocol)).map((p) => p.id)
  )
  return enabledRefs.filter((ref) => imageProviders.has(refProviderId(ref)))
}
