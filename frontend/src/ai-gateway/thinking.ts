// chat-panel P4 composer-parity C1-① — extended-thinking provider options for the gateway.
//
// The model-family matrix (originally mirrored from the legacy custom_api.ts thinking branch):
// opus-4-7 / opus-4-8 / fable REJECT manual budget_tokens with HTTP 400 → they require
// adaptive thinking + top-level effort; sonnet-4-6 (default) + older Claude 4 accept a manual
// budget.
//
// 🔴 S3 — the legacy engine was deleted; THIS FILE is now the SSoT for the matrix + budget
//    rationale. Update the model families / budget here when a new family changes behaviour.

import type { JSONValue } from 'ai'

// MEDIUM-6 — type from the SDK-free providerRef (providers.ts only loads behind the flag).
import type { ProviderProtocol } from './providerRef'

const THINKING_BUDGET_TOKENS = 16_000
const THINKING_EFFORT = 'high' as const

/** Does this Claude model accept manual extended thinking (`{type:'enabled', budgetTokens}`)?
 *  opus-4-7 / opus-4-8 / fable reject it (400) and require adaptive; everything else → manual. */
function modelSupportsManualThinking(model: string): boolean {
  const lower = model.toLowerCase()
  if (lower.includes('opus-4-7') || lower.includes('opus-4-8') || lower.includes('fable')) {
    return false
  }
  return true
}

/** Build the @ai-sdk/anthropic `providerOptions` for extended thinking on `model`, or undefined
 *  when thinking is off (→ caller omits providerOptions entirely, byte-identical to no-thinking).
 *  Manual `{type:'enabled', budgetTokens}` for sonnet/older; `{type:'adaptive'}` + `effort` for
 *  opus-4-7/4-8/fable. The shape matches AnthropicProviderOptions (thinking union + effort enum). */
export function thinkingProviderOptions(
  model: string,
  enabled: boolean,
  protocol: ProviderProtocol = 'anthropic'
): Record<string, Record<string, JSONValue>> | undefined {
  if (!enabled || protocol !== 'anthropic') return undefined
  const anthropic: Record<string, JSONValue> = modelSupportsManualThinking(model)
    ? { thinking: { type: 'enabled', budgetTokens: THINKING_BUDGET_TOKENS } }
    : { thinking: { type: 'adaptive' }, effort: THINKING_EFFORT }
  return { anthropic }
}
