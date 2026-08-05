// W8 模型选择器 — providerId → 厂商 logo 的**精确**映射（PRD：不抄 lobehub ModelIcon 的
// model-id 正则模糊猜测；本仓的 providerId 是自己的 slug，猜不如查表）。
//
// 两级解析，都只读本仓已有的一等字段，没有任何字符串启发式：
//   ① providerId（`llm_provider.id`，slug）—— 内置模板 key 全在 PROVIDER_ICONS 里；
//   ② protocol（`llm_provider.protocol`，DB 列）—— 兜住 `default`（legacy seed 行，id 不
//      带厂商信息）和用户自己起名的 provider（如 id='my-relay'、protocol='anthropic'）；
//   ③ 都不中 → 调用方渲染 lucide Cpu 中性图标（自建 OpenAI 兼容中转等）。
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
  DeepSeekColorIcon,
  DeepSeekIcon,
  DoubaoColorIcon,
  DoubaoIcon,
  GeminiColorIcon,
  GeminiIcon,
  KimiIcon,
  MiniMaxColorIcon,
  MiniMaxIcon,
  OpenAiIcon,
  OpenRouterIcon,
  QwenColorIcon,
  QwenIcon,
  SiliconCloudColorIcon,
  SiliconCloudIcon,
  ZhipuColorIcon,
  ZhipuIcon,
  type ProviderIconProps
} from './brandIcons'

export type ProviderIconRender = (props: ProviderIconProps) => React.JSX.Element

/** mono / color 两套资产。color 是默认（owner dogfood-3 明确要过彩色）；缺 color 变体的
 *  三家（openai / openrouter / kimi，理由见 brandIcons.tsx 文件头）自动落回 mono。 */
export type ProviderIconVariant = 'mono' | 'color'

/** providerId（小写）→ logo。key 覆盖 settings/onboarding 两张模板表的全部内置 key，
 *  外加各家最常见的别名（用户改过 id 时还能中）。 */
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
  zhipu: ZhipuIcon,
  glm: ZhipuIcon,
  kimi: KimiIcon,
  moonshot: KimiIcon,
  minimax: MiniMaxIcon,
  doubao: DoubaoIcon,
  siliconflow: SiliconCloudIcon,
  siliconcloud: SiliconCloudIcon
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
  zhipu: ZhipuColorIcon,
  glm: ZhipuColorIcon,
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

/** 解析（纯函数，组件外可测）。命不中返回 null → 调用方渲染中性兜底。
 *
 *  🔴 变体回退是**逐级**的：color 命中 → 用 color；color 缺席但 mono 命中 → 用 mono
 *  （不是「整条链退回 mono」）。这样 openai 在彩色语境下仍出 OpenAI 单色标，而不是掉成 Cpu。 */
export function resolveProviderIcon(
  providerId: string | null | undefined,
  protocol?: LlmProviderProtocol | null,
  variant: ProviderIconVariant = 'mono'
): ProviderIconRender | null {
  const id = (providerId ?? '').trim().toLowerCase()
  if (id) {
    const byId =
      variant === 'color' ? (PROVIDER_COLOR_ICONS[id] ?? PROVIDER_ICONS[id]) : PROVIDER_ICONS[id]
    if (byId) return byId
  }
  if (!protocol) return null
  const byProtocol =
    variant === 'color'
      ? (PROTOCOL_COLOR_ICONS[protocol] ?? PROTOCOL_ICONS[protocol])
      : PROTOCOL_ICONS[protocol]
  return byProtocol ?? null
}

export type { ProviderIconProps }
