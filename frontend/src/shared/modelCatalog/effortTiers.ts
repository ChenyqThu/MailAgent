// WP-16a effort 内核（1/2）—— canonical 档位枚举 + 每协议可表达子集。
//
// 🔴 **零运行时依赖叶子模块**：gateway 侧（`src/ai-gateway/thinking.ts`，always-loaded）与
// renderer 侧（16b composer effort 菜单）都要这份词表；catalog 查表（180K JSON）只有 renderer
// 需要，所以按「下沉常量」纪律拆两层 —— 本文件只有常量与纯函数，家族阶梯 + 目录查表在同目录
// `effort.ts`。唯一 import 是 type-only 的协议联合（编译期擦除，镜像 lookup.ts 的做法）。
//
// canonical 有序枚举（owner 2026-08-05 拍板）：`none < low < medium < high < xhigh < max`。
// `none` = 不思考（wire 上各协议表达不同：anthropic/openai-compatible 省略参数、openai 显式
// `reasoningEffort:'none'`、deepseek `thinking:{type:'disabled'}`、google 统一参数 `'none'`）。
//
// per-protocol 可表达子集（「映射不到的档就不出现在该 protocol 的子集里」）：
//   - anthropic / openai / deepseek / openai-compatible：全 6 档。
//     anthropic providerOptions `effort` 枚举 = low..max（none 走「省略」）；openai
//     `reasoningEffort` 枚举含全部 7 值（我们不用 minimal）；deepseek `reasoningEffort`
//     枚举 = low..max + thinking disabled；openai-compatible 是自由字符串 passthrough。
//   - google：无 `max` —— wire 走 ai@7 统一 `reasoning` 参数（其枚举到 xhigh 为止；google SDK
//     内部按模型代分流 Gemini3 thinkingLevel / 2.5 thinkingBudget，见 thinking.ts 注释）。
//   - openrouter：无 `max` —— 其 `reasoning.effort` 枚举 = none..xhigh（.d.ts 契约）。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

export const EFFORT_TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type EffortTier = (typeof EFFORT_TIERS)[number]

export function isEffortTier(value: unknown): value is EffortTier {
  return typeof value === 'string' && (EFFORT_TIERS as readonly string[]).includes(value)
}

/** 档位在 canonical 序里的下标（none=0 … max=5）。 */
export function effortTierIndex(tier: EffortTier): number {
  return (EFFORT_TIERS as readonly string[]).indexOf(tier)
}

const ALL_TIERS: readonly EffortTier[] = EFFORT_TIERS
const NO_MAX_TIERS: readonly EffortTier[] = ['none', 'low', 'medium', 'high', 'xhigh']

/** 每协议可表达的档位子集（升序）。协议未知（null）按「全部可表达」处理 —— 子集裁剪是
 *  展示层关心的事，wire 层（thinking.ts）对任何档位都是全函数（不可表达的档 clamp 到
 *  该协议最近的低档）。 */
export const PROTOCOL_EFFORT_TIERS: Record<LlmProviderProtocol, readonly EffortTier[]> = {
  anthropic: ALL_TIERS,
  openai: ALL_TIERS,
  'openai-compatible': ALL_TIERS,
  deepseek: ALL_TIERS,
  google: NO_MAX_TIERS,
  openrouter: NO_MAX_TIERS
}

/** 把一个档位收进协议可表达子集：可表达 → 原样；不可表达（google/openrouter 的 `max`）→
 *  向下取最近的可表达档（`max`→`xhigh`）。确定性、无静默丢弃（绝不把「要思考」降成不思考）。 */
export function clampEffortToProtocol(
  tier: EffortTier,
  protocol: LlmProviderProtocol | null | undefined
): EffortTier {
  if (protocol == null) return tier
  const allowed = PROTOCOL_EFFORT_TIERS[protocol]
  if (allowed.includes(tier)) return tier
  const idx = effortTierIndex(tier)
  for (let i = idx - 1; i >= 0; i--) {
    const lower = EFFORT_TIERS[i]
    if (allowed.includes(lower)) return lower
  }
  // 理论不可达（每个子集都含 none）；兜底保持类型完备。
  return 'none'
}
