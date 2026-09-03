// W8 模型选择器 — 厂商 logo 的**精确**映射（PRD：不抄 lobehub ModelIcon 的 model-id 正则
// 模糊猜测；本仓有一等字段可查，猜不如查表）。
//
// 三级解析，都只读本仓已有的一等字段，没有任何字符串启发式：
//   ① **目录命中的厂商**（`CatalogModelMeta.catalogProviderId`，见 @shared/modelCatalog）——
//      「这个模型是哪一家出的」是**模型自身的属性**，与用户怎么配 provider 无关，故优先级最高；
//   ② providerId（`llm_provider.id`，slug）—— 内置模板 key 全在 PROVIDER_ICONS 里；
//   ③ protocol（`llm_provider.protocol`，DB 列）—— 兜住 `default`（legacy seed 行，id 不
//      带厂商信息）和用户自己起名的 provider（如 id='my-relay'、protocol='anthropic'）；
//   ④ 都不中 → 调用方渲染 lucide Cpu 中性图标（自建 OpenAI 兼容中转等）。
//
// 🔴 ① 是 08-05 dogfood-4 补的，收的是**中转 provider** 这个真实形态：owner 机器上
// `default`（protocol=anthropic，display_name「Anthropic-crs」）下**同时挂着** 19 个 gpt-5.x
// 与 claude 系模型 —— 旧的两级解析把 gpt-5.5 打成 Anthropic 彩标（**错的信息比没有更糟**），
// 而 `gpt`（protocol=openai-compatible，同一个中转）下的 gpt-5 只能掉成灰 Cpu。原注释里
// 「providerId 是自己的 slug，猜不如查表」的判断只在「一个 provider = 一家厂商」时成立；
// 中转场景下 provider slug / protocol 携带的厂商信息**不可靠甚至错误**。
//
// 🔴 ① 未命中（目录里没这个 id、或该 id 多家都有 ⇒ lookup 判歧义 MISS）就**诚实降级**到
// ②③，不做任何 model-id 正则启发式。逐级降级也意味着本次改动**不会让任何输入比改动前更差**：
// 目录给不出厂商时，走的仍是与改动前逐字相同的两级。
//
// 🔴 表里的值是**渲染函数**（直接调用 `render(props)` 拿 element），不是当组件 `<Icon/>` 用 ——
// 抄 ToolTraceCard.toolKindIconEl 的既有约束，避开 react-hooks/static-components
// （「组件在 render 期间创建」）。它们是无 hook 的纯 SVG，直接调用没有副作用。
//
// 本文件是 .ts（零 JSX）——同目录 index.tsx 只导出组件，满足 react-refresh/only-export-components。
// 图形资产来源与授权见同目录 NOTICE.md（MIT © LobeHub）。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import {
  AnthropicColorIcon,
  AnthropicIcon,
  CohereIcon,
  DeepSeekColorIcon,
  DeepSeekIcon,
  DoubaoColorIcon,
  DoubaoIcon,
  FireworksIcon,
  GeminiColorIcon,
  GeminiIcon,
  GroqIcon,
  KimiIcon,
  MiniMaxColorIcon,
  MiniMaxIcon,
  MistralIcon,
  OpenAiIcon,
  OpenRouterIcon,
  PerplexityIcon,
  QwenColorIcon,
  QwenIcon,
  SiliconCloudColorIcon,
  SiliconCloudIcon,
  TogetherAiIcon,
  XaiIcon,
  ZhipuColorIcon,
  ZhipuIcon,
  type ProviderIconProps
} from './brandIcons'

export type ProviderIconRender = (props: ProviderIconProps) => React.JSX.Element

/** mono / color 两套资产。color 是默认（owner dogfood-3 明确要过彩色）；缺 color 变体的
 *  三家（openai / openrouter / kimi，理由见 brandIcons.tsx 文件头）自动落回 mono。 */
export type ProviderIconVariant = 'mono' | 'color'

/** 厂商 slug（小写）→ logo。key 覆盖三类来源，同一张表共用（都是「厂商 slug」这一种词汇）：
 *  settings/onboarding 两张模板表的内置 key · 各家最常见的别名（用户改过 id 时还能中）·
 *  **目录 provider id**（catalog.json `providers` 的 key，解析第①级用）。
 *
 *  🔴 目录侧的 key 与我们的历史 key 不同名的那几家（`alibaba`/`alibaba-cn` = Qwen、
 *  `moonshotai` = Kimi、`zhipuai`/`zai` = 智谱/Z.AI）必须在这里补齐别名，否则目录命中了却
 *  查不到 logo，会静默降级回 providerId —— 正是本次要修的那个错。曾经登记「有意无资产」的
 *  七家（cohere / fireworks-ai / groq / mistral / perplexity / togetherai / xai）09-02 已补齐
 *  mono 资产，`providerIcons.test.ts` 的无资产名单随之清空；快照更新后冒出新厂商时那道闸会红。 */
export const PROVIDER_ICONS: Record<string, ProviderIconRender> = {
  anthropic: AnthropicIcon,
  claude: AnthropicIcon,
  'custom-anthropic': AnthropicIcon,
  openai: OpenAiIcon,
  google: GeminiIcon,
  gemini: GeminiIcon,
  deepseek: DeepSeekIcon,
  openrouter: OpenRouterIcon,
  dashscope: QwenIcon,
  qwen: QwenIcon,
  alibaba: QwenIcon,
  'alibaba-cn': QwenIcon,
  zhipu: ZhipuIcon,
  glm: ZhipuIcon,
  zhipuai: ZhipuIcon,
  zai: ZhipuIcon,
  kimi: KimiIcon,
  moonshot: KimiIcon,
  moonshotai: KimiIcon,
  minimax: MiniMaxIcon,
  doubao: DoubaoIcon,
  siliconflow: SiliconCloudIcon,
  siliconcloud: SiliconCloudIcon,
  xai: XaiIcon,
  grok: XaiIcon,
  mistral: MistralIcon,
  groq: GroqIcon,
  perplexity: PerplexityIcon,
  togetherai: TogetherAiIcon,
  together: TogetherAiIcon,
  cohere: CohereIcon,
  'fireworks-ai': FireworksIcon,
  fireworks: FireworksIcon
}

/** 上表的 color 对应物。**只列真的有可用 color 资产的家** —— 查不到就自动落回 mono 表，
 *  故这里缺席不是 bug（openai / openrouter / kimi 三家有意缺席，理由见 brandIcons.tsx）。 */
export const PROVIDER_COLOR_ICONS: Record<string, ProviderIconRender> = {
  anthropic: AnthropicColorIcon,
  claude: AnthropicColorIcon,
  'custom-anthropic': AnthropicColorIcon,
  google: GeminiColorIcon,
  gemini: GeminiColorIcon,
  deepseek: DeepSeekColorIcon,
  dashscope: QwenColorIcon,
  qwen: QwenColorIcon,
  alibaba: QwenColorIcon,
  'alibaba-cn': QwenColorIcon,
  zhipu: ZhipuColorIcon,
  glm: ZhipuColorIcon,
  zhipuai: ZhipuColorIcon,
  zai: ZhipuColorIcon,
  minimax: MiniMaxColorIcon,
  doubao: DoubaoColorIcon,
  siliconflow: SiliconCloudColorIcon,
  siliconcloud: SiliconCloudColorIcon
}

/** protocol → logo。`openai-compatible` 有意留空：它是「随便什么中转」的意思，
 *  贴 OpenAI 的 logo 会撒谎（背后可能是 Qwen/GLM/自建）→ 走 Cpu 兜底。 */
export const PROTOCOL_ICONS: Partial<Record<LlmProviderProtocol, ProviderIconRender>> = {
  anthropic: AnthropicIcon,
  openai: OpenAiIcon,
  google: GeminiIcon,
  deepseek: DeepSeekIcon,
  openrouter: OpenRouterIcon
}

export const PROTOCOL_COLOR_ICONS: Partial<Record<LlmProviderProtocol, ProviderIconRender>> = {
  anthropic: AnthropicColorIcon,
  google: GeminiColorIcon,
  deepseek: DeepSeekColorIcon
}

/** 解析的输入。**有意写成对象而不是位置参数**：优先级正是这次的 bug 本体（新加的
 *  `catalogProviderId` 排在最前），第四个位置参数却读起来像最不重要的那个。 */
export interface ProviderIconSource {
  /** ① 目录命中的厂商（`CatalogModelMeta.catalogProviderId`）。目录未命中 / 判歧义时传
   *  null|undefined —— 解析自然落到 ②。 */
  catalogProviderId?: string | null
  /** ② 用户的 `llm_provider.id`。 */
  providerId?: string | null
  /** ③ 用户的 `llm_provider.protocol`。 */
  protocol?: LlmProviderProtocol | null
}

/** 一级 slug 查表（含 variant 逐级回退）。 */
function iconForSlug(
  slug: string | null | undefined,
  variant: ProviderIconVariant
): ProviderIconRender | null {
  const key = (slug ?? '').trim().toLowerCase()
  if (!key) return null
  const hit =
    variant === 'color' ? (PROVIDER_COLOR_ICONS[key] ?? PROVIDER_ICONS[key]) : PROVIDER_ICONS[key]
  return hit ?? null
}

/** 解析（纯函数，组件外可测）。三级都不中返回 null → 调用方渲染中性兜底。
 *
 *  🔴 变体回退是**逐级**的：color 命中 → 用 color；color 缺席但 mono 命中 → 用 mono
 *  （不是「整条链退回 mono」）。这样 openai 在彩色语境下仍出 OpenAI 单色标，而不是掉成 Cpu。 */
export function resolveProviderIcon(
  source: ProviderIconSource,
  variant: ProviderIconVariant = 'mono'
): ProviderIconRender | null {
  const byCatalog = iconForSlug(source.catalogProviderId, variant)
  if (byCatalog) return byCatalog
  const byId = iconForSlug(source.providerId, variant)
  if (byId) return byId
  const protocol = source.protocol
  if (!protocol) return null
  const byProtocol =
    variant === 'color'
      ? (PROTOCOL_COLOR_ICONS[protocol] ?? PROTOCOL_ICONS[protocol])
      : PROTOCOL_ICONS[protocol]
  return byProtocol ?? null
}

export type { ProviderIconProps }
