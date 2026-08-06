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

/** Claude 分族判据（S2 拍板 08-05 第二轮）：这个 Claude 模型走 manual thinking
 *  （`{type:'enabled', budgetTokens}`）还是服务端自适应（adaptive + effort）？
 *
 *  🔴 **单源下沉**（CLAUDE.md 跨边界手抄纪律）：gateway 的 wire 分支（thinking.ts
 *  `effortCallOptions`/`thinkingProviderOptions`）与 renderer 的阶梯选择（effort.ts
 *  `effortOptionsForModel` —— adaptive 族无 none、manual 族 none/low/medium/high）都要这条
 *  判据，故从 thinking.ts 下沉到本词表叶子，两侧 import 同一函数，不许在任何一处再手抄
 *  模型 id 清单。
 *
 *  adaptive 族 = opus-4-7 / opus-4-8 / **opus-5** / fable：
 *    - opus-4-7 / opus-4-8 / fable：manual budget 会被 API 以 400 拒绝（legacy custom_api
 *      时代的生产实证，原注释随矩阵迁到这里）。
 *    - opus-5：S2 拍板归入 adaptive 族（「服务端自适应」）。crs 实测（2026-08-05）：manual
 *      budget **不 400**（两种形状都 200），但**不带任何 thinking 参数也会自发思考**——服务端
 *      自适应的行为签名，与拍板一致；注意这会让旧 Brain 布尔路径对 opus-5 从 manual 16k 翻成
 *      adaptive+high（有意的行为变更，见 S2 终报）。
 *  其余（sonnet / haiku / 老 Claude 4）→ manual。 */
export function modelSupportsManualThinking(model: string): boolean {
  const lower = model.toLowerCase()
  if (
    lower.includes('opus-4-7') ||
    lower.includes('opus-4-8') ||
    lower.includes('opus-5') ||
    lower.includes('fable')
  ) {
    return false
  }
  return true
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
