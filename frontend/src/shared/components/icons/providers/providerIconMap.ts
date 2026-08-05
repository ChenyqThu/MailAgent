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
  AnthropicIcon,
  DeepSeekIcon,
  DoubaoIcon,
  GeminiIcon,
  KimiIcon,
  MiniMaxIcon,
  OpenAiIcon,
  OpenRouterIcon,
  QwenIcon,
  SiliconCloudIcon,
  ZhipuIcon,
  type ProviderIconProps
} from './brandIcons'

export type ProviderIconRender = (props: ProviderIconProps) => React.JSX.Element

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

/** protocol → logo。`openai-compatible` 有意留空：它是「随便什么中转」的意思，
 *  贴 OpenAI 的 logo 会撒谎（背后可能是 Qwen/GLM/自建）→ 走 Cpu 兜底。 */
export const PROTOCOL_ICONS: Partial<Record<LlmProviderProtocol, ProviderIconRender>> = {
  anthropic: AnthropicIcon,
  openai: OpenAiIcon,
  google: GeminiIcon,
  deepseek: DeepSeekIcon,
  openrouter: OpenRouterIcon
}

/** 解析（纯函数，组件外可测）。命不中返回 null → 调用方渲染中性兜底。 */
export function resolveProviderIcon(
  providerId: string | null | undefined,
  protocol?: LlmProviderProtocol | null
): ProviderIconRender | null {
  const id = (providerId ?? '').trim().toLowerCase()
  const byId = id ? PROVIDER_ICONS[id] : undefined
  if (byId) return byId
  const byProtocol = protocol ? PROTOCOL_ICONS[protocol] : undefined
  return byProtocol ?? null
}

export type { ProviderIconProps }
