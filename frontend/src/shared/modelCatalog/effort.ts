// WP-16a effort 内核（2/2）—— 厂商家族阶梯 + 「这个模型该给用户看哪几档」的查询接口（16b 的
// composer effort 菜单消费方）。词表/协议子集在同目录 effortTiers.ts（gateway 也 import 那份，
// 本文件因为要查 catalog（180K JSON）只给 renderer 用）。
//
// 🔴 两轴分离（`ae53df4c` 教训，owner 用中转、一个 provider 混装多家模型）：
//   - **阶梯归属按 catalog 厂商家族**（claude-* 挂在 openai-compatible 中转上也给 Claude 阶梯）；
//   - **wire 形状按 protocol**（thinking.ts 的 effortCallOptions），且展示子集 = 家族阶梯 ∩
//     协议可表达集（PROTOCOL_EFFORT_TIERS）。
//
// 家族阶梯（owner 2026-08-05 拍板 + S2 第二轮分族，prd.md「effort 阶梯」+「S2 已拍板」）：
//   OpenAI GPT        none/low/medium/high/xhigh/max   默认 medium
//   Claude adaptive 族 low/medium/high/xhigh/max        默认 medium（opus-4-7/4-8/opus-5/fable，
//                      服务端自适应，**无 none**；owner 口中的 extra = xhigh）
//   Claude manual 族   none/low/medium/high             默认 medium（sonnet/haiku 等 thinking
//                      enable 配置的型号，无 xhigh/max —— S2 拍板口径）
//   Gemini            low/medium/high                  默认 low
//   Deepseek          none/low/high/max                默认 low
//   其他家默认         none/low/medium/high/max         默认 medium
//
// Claude 分族判据 = effortTiers.ts 的 `modelSupportsManualThinking`（单源下沉，gateway wire
// 分支与这里共用同一函数，禁止两处手抄模型清单）。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import { lookupModelMeta } from './lookup'
import {
  EFFORT_TIERS,
  isEffortTier,
  modelSupportsManualThinking,
  PROTOCOL_EFFORT_TIERS,
  type EffortTier
} from './effortTiers'

export type EffortVendorFamily = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'other'

interface FamilyLadder {
  tiers: readonly EffortTier[]
  defaultTier: EffortTier
}

// anthropic 家族按 manual/adaptive 分两个阶梯（S2 拍板），选择在 effortOptionsForModel 里按
// 模型 id 判；其余家族一族一梯。
const FAMILY_LADDERS: Record<Exclude<EffortVendorFamily, 'anthropic'>, FamilyLadder> = {
  openai: { tiers: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultTier: 'medium' },
  google: { tiers: ['low', 'medium', 'high'], defaultTier: 'low' },
  deepseek: { tiers: ['none', 'low', 'high', 'max'], defaultTier: 'low' },
  other: { tiers: ['none', 'low', 'medium', 'high', 'max'], defaultTier: 'medium' }
}

/** adaptive 族（opus-4-7/4-8/opus-5/fable）：服务端自适应，**无「不思考」档**（S2 拍板 ——
 *  这类模型不带 thinking 参数也会自发思考，给 none 是对用户撒谎）。 */
const ANTHROPIC_ADAPTIVE_LADDER: FamilyLadder = {
  tiers: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultTier: 'medium'
}

/** manual 族（sonnet/haiku 等 thinking enable 配置的型号）：**有** none，无 xhigh/max
 *  （owner 原话口径）。budgetTokens 数值映射在 thinking.ts（wire 层表项对 xhigh/max 仍全函数
 *  兜底，但 UI 子集到 high 为止）。 */
const ANTHROPIC_MANUAL_LADDER: FamilyLadder = {
  tiers: ['none', 'low', 'medium', 'high'],
  defaultTier: 'medium'
}

/** catalog providerId → 家族。目录里的其他厂牌（alibaba / xai / mistral / …）→ 'other'。 */
const CATALOG_FAMILY: Record<string, EffortVendorFamily> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek'
}

/** catalog 全 miss 时按协议兜底家族。中转/聚合协议背后什么都可能是 → 'other'（owner 的
 *  「其他家不清楚的」阶梯），**不是**该协议的原生方言家族。 */
const PROTOCOL_FALLBACK_FAMILY: Record<LlmProviderProtocol, EffortVendorFamily> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  'openai-compatible': 'other',
  openrouter: 'other'
}

/** 协议原生方言家族（passthroughUnknown 判定用）。openai-compatible 说的是 openai 方言；
 *  openrouter 官方文档承诺跨厂商 reasoning 归一（reasoning.effort → 各家 wire），→ null =
 *  不构成「方言错配」。 */
const PROTOCOL_NATIVE_DIALECT: Record<LlmProviderProtocol, EffortVendorFamily | null> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  'openai-compatible': 'openai',
  openrouter: null
}

export interface EffortModelOptions {
  /** 可供选择的档位（升序，canonical 序）。无 reasoning 能力 → 恒 `['none']`。
   *
   *  🔴 **16b 契约**：`options` 退化成 `['none']`（= 该模型没有 reasoning 能力）时，请求体应当
   *  **根本不带 `effort` 键**（走旧路径），而不是发 `effort:'none'` —— 「不思考」对一个本来就
   *  不思考的模型不是一档，是「这个控件不适用」。两条实证依据：deepseek 协议的 `none` 会往 wire
   *  发 `thinking:{type:'disabled'}`（对 deepseek-chat 这类非 reasoning 模型是多余参数）；openai
   *  协议的 `none` 会让 SDK 推 `reasoning_effort`（responses 分支对非 reasoning 模型只 warning，
   *  chat 分支则直接下发）。`effortCallOptions` 有意不查 catalog、无从自行判断，所以这一条只能
   *  由调用方守。 */
  options: EffortTier[]
  /** 🔴 **16b 硬契约（上面那条注释的结构化版本）**：`applicable === false`（= `options` 退化成
   *  `['none']`，模型无 reasoning 能力）⇒ **请求体不得携带 `effort` 键**（连 `'none'` 也不塞，
   *  走旧路径）。16b 用这个布尔做结构性门（不渲染控件 + 不写请求体字段），而不是自己比对
   *  `options` 数组 —— 数组比对漏一处就把 `effort:'none'` 塞给无能力模型（deepseek 会多发
   *  `thinking:{type:'disabled'}`；openai chat-completions 分支会无条件下发 `reasoning_effort`）。 */
  applicable: boolean
  /** 家族默认档，保证 ∈ options。 */
  defaultTier: EffortTier
  /** 阶梯归属家族（展示层：图标/文案可用）。 */
  family: EffortVendorFamily
  /** reasoning 能力三态：true / false（catalog 有标注但不含 reasoning）/ null（catalog 无此
   *  模型或未标注 —— **unknown ≠ false**，16b 呈现时不得当 false 灰死）。 */
  reasoningCapable: boolean | null
  /** 诚实信号位（true = UI 不得声称档位一定生效）。三段式口径（复核收紧 2026-08-05）：
   *    ① 目录未命中（厂商未知）→ true —— 不知道对面是谁，谈不上「透传已知」；
   *    ② 厂商已知但其**原生方言不可判**（非四大方言家族，如 alibaba/xai/mistral）或
   *       方言 ≠ 当前协议原生方言（中转必须做 API 方言翻译）→ true；
   *    ③ 厂商已知且方言即协议原生（同族直通）→ false。
   *  openrouter 例外 carve-out：四大家族模型 → false（官方文档承诺跨厂商 reasoning 归一），
   *  ①② 两段照常为 true。crs 双腿（同族直通形态）实测透传已证实
   *  （research/crs-effort-passthrough.md，2026-08-05）。 */
  passthroughUnknown: boolean
}

/** 16b 查询接口：这个模型在这个协议上该暴露哪几档、默认哪档。
 *
 *  `reasoningCapable` 覆写位走「DB 行权威、目录兜底」纪律（镜像 useComposerModels 侧的叠加
 *  方向）：调用方拿得到 provider 行 `capabilities.reasoning` 的布尔就传进来（wins）；行未标注
 *  （null/undefined）→ 落回 catalog 三态。 */
export function effortOptionsForModel(
  modelId: string,
  protocol: LlmProviderProtocol | null | undefined,
  opts?: { reasoningCapable?: boolean | null }
): EffortModelOptions {
  const meta = lookupModelMeta(modelId, protocol)

  const family: EffortVendorFamily = meta
    ? (CATALOG_FAMILY[meta.catalogProviderId] ?? 'other')
    : protocol != null
      ? PROTOCOL_FALLBACK_FAMILY[protocol]
      : 'other'

  const fromCatalog: boolean | null =
    meta?.capabilities == null ? null : meta.capabilities.reasoning === true
  const override = opts?.reasoningCapable
  const reasoningCapable = typeof override === 'boolean' ? override : fromCatalog

  // 三段式口径（见 EffortModelOptions.passthroughUnknown 的字段注释）：厂商方言取自
  // **目录命中**（CATALOG_FAMILY 只认四大方言家族），不是阶梯用的 family —— family 的
  // PROTOCOL_FALLBACK_FAMILY 兜底是「给个合理阶梯」，不构成「知道对面厂商」的证据。
  const vendorDialect: EffortVendorFamily | null = meta
    ? (CATALOG_FAMILY[meta.catalogProviderId] ?? null)
    : null
  let passthroughUnknown: boolean
  if (vendorDialect == null || protocol == null) {
    // ① 目录未命中 / ② 前半：厂商在目录里但原生方言不可判（alibaba/xai/…）；协议未知同理。
    passthroughUnknown = true
  } else {
    const native = PROTOCOL_NATIVE_DIALECT[protocol]
    // ② 后半 / ③：方言 vs 协议原生方言；openrouter（native=null）对已判明方言的厂商 carve-out
    // 成 false（官方文档承诺跨厂商 reasoning 归一）。
    passthroughUnknown = native != null && vendorDialect !== native
  }

  if (reasoningCapable === false) {
    // 无 reasoning 能力：控件不适用（applicable=false ⇒ 16b 请求体不带 effort 键，见字段注释）。
    return {
      options: ['none'],
      applicable: false,
      defaultTier: 'none',
      family,
      reasoningCapable,
      passthroughUnknown
    }
  }

  // Claude 分族（S2）：manual/adaptive 两梯，判据单源 effortTiers.modelSupportsManualThinking
  // （includes 匹配，`claude-opus-5[1m]` 这类带档位后缀/前缀的中转 id 原样可判）。
  const ladder =
    family === 'anthropic'
      ? modelSupportsManualThinking(modelId)
        ? ANTHROPIC_MANUAL_LADDER
        : ANTHROPIC_ADAPTIVE_LADDER
      : FAMILY_LADDERS[family]
  const protocolTiers =
    protocol != null ? PROTOCOL_EFFORT_TIERS[protocol] : (EFFORT_TIERS as readonly EffortTier[])
  const options = ladder.tiers.filter((tier) => protocolTiers.includes(tier))
  if (options.length === 0) {
    // 理论不可达（每家阶梯都至少有一个 ≤xhigh 的档）；兜底不返回空数组砸 UI，且按「不适用」
    // 处理（没有档可选 = 控件不该出现，更不该往请求体写 effort）。
    return {
      options: ['none'],
      applicable: false,
      defaultTier: 'none',
      family,
      reasoningCapable,
      passthroughUnknown
    }
  }
  const defaultTier = options.includes(ladder.defaultTier) ? ladder.defaultTier : options[0]
  return { options, applicable: true, defaultTier, family, reasoningCapable, passthroughUnknown }
}

// ── 持久化（照抄 Brain 布尔开关的机制：全局 localStorage 键，非 per-session）─────────────
//
// 参照物 = AiChatPanel.tsx 的 THINKING_PREF（'mailagent.chat.thinkingEnabled'，'1'/'0'，
// panel-owned state + best-effort try/catch）。effort 同机制同纪律：全局一个键，值 = canonical
// 档位字符串；缺失/非法 → null = **「用户还没显式选过」**。
// 🔴 S2 拍板（08-05 第二轮）：pref 为 null 时 16b **主动下发 defaultTier**（applicable 时），
// 不是「不发 effort 走旧布尔路径」——owner 接受这次行为反转（Claude 从「默认不思考」变
// 「默认 medium thinking」）。旧布尔路径只剩两种到达方式：applicable=false 的模型（16b 契约
// 不带 effort 键）与尚未换 16b UI 的场景。
// 🔴 只给 renderer 调（gateway 进程没有 localStorage，也永远不该读它——effort 走请求体）。

export const EFFORT_PREF_KEY = 'mailagent.chat.effort'

export function readEffortPref(): EffortTier | null {
  try {
    const raw = localStorage.getItem(EFFORT_PREF_KEY)
    return isEffortTier(raw) ? raw : null
  } catch {
    return null
  }
}

export function writeEffortPref(tier: EffortTier | null): void {
  try {
    if (tier == null) localStorage.removeItem(EFFORT_PREF_KEY)
    else localStorage.setItem(EFFORT_PREF_KEY, tier)
  } catch {
    /* ignore — pref persistence is best-effort（镜像 writeThinkingPref） */
  }
}
