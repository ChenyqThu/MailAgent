// chat-panel P4 composer-parity C1-① — extended-thinking provider options for the gateway.
//
// The model-family matrix (originally mirrored from the legacy custom_api.ts thinking branch):
// opus-4-7 / opus-4-8 / fable REJECT manual budget_tokens with HTTP 400 → they require
// adaptive thinking + top-level effort; sonnet-4-6 (default) + older Claude 4 accept a manual
// budget.
//
// 🔴 S3 — the legacy engine was deleted; THIS FILE is now the SSoT for the matrix + budget
//    rationale. Update the model families / budget here when a new family changes behaviour.
//
// WP-16a (0805 P1) — effort 档位层：`effortCallOptions` 把 canonical 档位（none..max，词表在
// @shared/modelCatalog/effortTiers）映射成各协议 wire 形状，与旧 Brain 布尔路径
// （`thinkingProviderOptions`）**并存**——chatRun 只在请求体显式携带合法 `effort` 时走新路径，
// 未携带时旧路径字节级不变（16b 换 UI 前 owner 观感不许变）。
//
// 🔴 step-0 结论（为什么不整层压在 ai@7 统一 `reasoning` 参数上）：ai@7 确有跨厂商抽象
// （streamText CallSettings 的 `reasoning: 'provider-default'|'none'|'minimal'|'low'|'medium'|
// 'high'|'xhigh'`，各 vendored SDK 均实现），但 ① 枚举**没有 `max`**（owner 阶梯三家要 max，
// anthropic SDK 的 effortMap 查不到 max 会 warning + 静默丢档）；② anthropic 的 manual-budget
// 分支在 SDK 里按 maxOutputTokens 百分比推 budget，与本文件钉住的 16k 矩阵冲突；③ 各 SDK 里
// provider-specific options **恒赢**统一参数 —— 所以除 google 外全走 providerOptions（确定性、
// 可测、支持 max），google 走统一参数（其 SDK 按模型代自动分流 Gemini3 `thinkingLevel` /
// Gemini2.5 `thinkingBudget`，手写 budget 表反而会打中 Gemini3 的 thinkingBudget 弃用面）。
// crs 中转透传已实测证实（.trellis/…/research/crs-effort-passthrough.md）。

import type { JSONValue } from 'ai'

// 词表叶子（零运行时依赖，不拉 180K catalog JSON 进 gateway bundle）；家族阶梯/子集查询
// （effortOptionsForModel）在 @shared/modelCatalog/effort，仅 renderer（16b）消费。
import {
  clampEffortToProtocol,
  isEffortTier,
  type EffortTier
} from '@shared/modelCatalog/effortTiers'

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

// ── WP-16a effort 档位 → wire ──────────────────────────────────────────────────────────

/** anthropic manual-budget 族（sonnet-4-6 / 老 Claude 4）的档位 → budgetTokens 数值表。
 *  `medium = 16_000` **有意等于**旧 Brain 布尔路径的 THINKING_BUDGET_TOKENS —— manual 族上
 *  「effort medium」≈「旧 Brain 开」，观感连续。上限 60k 给 64k 输出天花板（chatRun 恒传
 *  maxOutputTokens）留余量 —— Anthropic 要求 budget_tokens < max_tokens；下限 4k 远高于
 *  API 最低 1024。crs 实测 budget_tokens 透传且随档缩放（research/crs-effort-passthrough.md §B）。 */
export const MANUAL_THINKING_BUDGET_TOKENS: Record<Exclude<EffortTier, 'none'>, number> = {
  low: 4_000,
  medium: 16_000,
  high: 32_000,
  xhigh: 48_000,
  max: 60_000
}

/** WP-16a — an effort tier resolved to the two AI SDK call-option surfaces it may ride on. */
export interface EffortCallOptions {
  /** per-provider providerOptions（anthropic/openai/deepseek/openai-compatible/openrouter）。 */
  providerOptions?: Record<string, Record<string, JSONValue>>
  /** ai@7 统一 `reasoning` call setting —— 仅 google 协议使用（SDK 按模型代分流 thinkingLevel
   *  / thinkingBudget；统一枚举无 max，google 子集本就不含 max）。 */
  reasoning?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
}

/** Narrow an unknown request-body value to an EffortTier (absent/junk → null → legacy path). */
export function effortTierFromBody(value: unknown): EffortTier | null {
  return isEffortTier(value) ? value : null
}

/** Build the streamText call options for an EXPLICIT effort tier on `model` @ `protocol`.
 *
 *  Total over all (tier, protocol) pairs：不可表达的档先 clamp 进协议子集（google/openrouter 的
 *  `max`→`xhigh`，clampEffortToProtocol —— 绝不静默丢掉「要思考」）。`undefined` = 本协议对该档
 *  什么都不发（anthropic/openai-compatible 的 `none`，= 今天关 Brain 的字节形状）。
 *
 *  展示归属按 catalog 厂商、**wire 形状按这里的 protocol**（`ae53df4c` 教训——owner 的中转一个
 *  provider 混装多家模型；家族阶梯 ∩ 协议子集在 @shared/modelCatalog/effort 完成，本函数不查
 *  catalog）。 */
export function effortCallOptions(
  model: string,
  effort: EffortTier,
  protocol: ProviderProtocol
): EffortCallOptions | undefined {
  const tier = clampEffortToProtocol(effort, protocol)
  switch (protocol) {
    case 'anthropic': {
      // none = 完全不发 thinking（与 Brain 关字节一致）。档位沿现有二分：manual 族走
      // budgetTokens 数值映射；opus-4-7/4-8/fable 走 adaptive + effort（枚举 low..max 逐字合法）。
      if (tier === 'none') return undefined
      const anthropic: Record<string, JSONValue> = modelSupportsManualThinking(model)
        ? { thinking: { type: 'enabled', budgetTokens: MANUAL_THINKING_BUDGET_TOKENS[tier] } }
        : { thinking: { type: 'adaptive' }, effort: tier }
      return { providerOptions: { anthropic } }
    }
    case 'openai':
      // reasoningEffort 枚举含全部档位（none 是 gpt-5.1+ 的合法显式关断值）。
      return { providerOptions: { openai: { reasoningEffort: tier } } }
    case 'deepseek':
      // none → thinking disabled；档位 → thinking enabled + reasoningEffort（SDK 枚举 low..max）。
      if (tier === 'none') {
        return { providerOptions: { deepseek: { thinking: { type: 'disabled' } } } }
      }
      return {
        providerOptions: {
          deepseek: { thinking: { type: 'enabled' }, reasoningEffort: tier }
        }
      }
    case 'openai-compatible':
      // 自由字符串 passthrough（SDK 解析键用协议通用的 'openaiCompatible'，与 provider 行 id
      // 无关）。none → 不发任何 reasoning 参数：上游是「随便什么中转」，显式 'none' 在非 OpenAI
      // 系上游可能 400，省略 = 今天的字节形状，最稳。crs 腿实测 reasoning_effort 透传且生效
      // （research §C）。
      if (tier === 'none') return undefined
      return { providerOptions: { openaiCompatible: { reasoningEffort: tier } } }
    case 'openrouter':
      // providerOptions.openrouter 被原样 spread 进请求体；reasoning.effort 枚举 none..xhigh
      // （无 max，已被 clamp 收掉）。openrouter 文档承诺把 effort 归一到各家 wire。
      return {
        providerOptions: {
          openrouter: { reasoning: { effort: tier as Exclude<EffortTier, 'max'> } }
        }
      }
    case 'google': {
      // 统一 `reasoning` 参数（非 providerOptions）：@ai-sdk/google 的 resolveThinkingConfig 按
      // 模型代分流（Gemini3 → thinkingLevel，2.5 → thinkingBudget 百分比），手写 budget 表会
      // 打中 Gemini3 的 thinkingBudget 弃用面。max 已 clamp 成 xhigh（统一枚举无 max）。
      return { reasoning: tier as Exclude<EffortTier, 'max'> }
    }
  }
}
