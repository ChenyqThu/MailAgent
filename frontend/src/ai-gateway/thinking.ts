// chat-panel P4 composer-parity C1-① — extended-thinking provider options for the gateway.
//
// Mirrors the legacy custom_api.ts buildAnthropicRequestBody thinking branch (the model-family
// matrix): opus-4-7 / opus-4-8 / fable REJECT manual budget_tokens with HTTP 400 → they require
// adaptive thinking + top-level effort; sonnet-4-6 (default) + older Claude 4 accept a manual
// budget. Kept as a PURE gateway-local copy of the simple model-string check so chatRun stays free
// of the heavy shared/chat/custom_api import (the gateway pure-ish contract, chatRun.ts:8).
//
// 🔴 SSoT for the matrix + budget rationale: src/shared/chat/backends/custom_api.ts:55-75. If the
//    model families or budget change there, mirror them here (no shared import to avoid the dep).

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
  enabled: boolean
): Record<string, Record<string, unknown>> | undefined {
  if (!enabled) return undefined
  const anthropic = modelSupportsManualThinking(model)
    ? { thinking: { type: 'enabled', budgetTokens: THINKING_BUDGET_TOKENS } }
    : { thinking: { type: 'adaptive' }, effort: THINKING_EFFORT }
  return { anthropic }
}
