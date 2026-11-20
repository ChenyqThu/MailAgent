// task 07-12 P3 — 「模型服务」区的内置 provider 模板（prd §4.5：模板只预填
// protocol + baseURL + displayName，key 恒由用户填）。
//
// baseUrl 事实来源 = research/02 §3-4（各家端点全部实测 401 证实存在）；'' = 官方默认
// （后端 llm_providers.py _DEFAULT_BASES 兜底：anthropic/openai/deepseek/openrouter/google）。
// openai-compatible 无官方默认 → 国内各家/本地引擎模板显式带 base、自定义模板必填。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

export type ProviderTemplateCategory = 'popular' | 'cn' | 'global' | 'local' | 'custom'

export interface ProviderTemplate {
  /** 模板 key（选择器 value）+ 预填 provider id（slug，用户可改）。 */
  key: string
  protocol: LlmProviderProtocol
  /** 预填 displayName；自定义模板为 ''（用户自己命名）。 */
  displayName: string
  /** 预填 baseUrl；'' = 官方默认（后端兜底）。 */
  baseUrl: string
  /** openai-compatible 自定义/自建中转无官方默认 → baseUrl 必填。 */
  baseUrlRequired: boolean
  /** 分类过滤标签。 */
  category: ProviderTemplateCategory
  /** 本地推理服务（Ollama / LM Studio 等）默认不需要 API Key。 */
  keyOptional?: boolean
  /** 自定义模板：picker 文案走 i18n（settings.providers.template.<key>），id 预填为空。 */
  custom?: boolean
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    key: 'anthropic',
    protocol: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: '',
    baseUrlRequired: false,
    category: 'popular'
  },
  {
    key: 'openai',
    protocol: 'openai',
    displayName: 'OpenAI',
    baseUrl: '',
    baseUrlRequired: false,
    category: 'popular'
  },
  {
    key: 'google',
    protocol: 'google',
    displayName: 'Google Gemini',
    baseUrl: '',
    baseUrlRequired: false,
    category: 'popular'
  },
  {
    key: 'deepseek',
    protocol: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: '',
    baseUrlRequired: false,
    category: 'cn'
  },
  {
    key: 'dashscope',
    protocol: 'openai-compatible',
    displayName: '通义千问 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlRequired: true,
    category: 'cn'
  },
  {
    key: 'zhipu',
    protocol: 'openai-compatible',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlRequired: true,
    category: 'cn'
  },
  {
    key: 'kimi',
    protocol: 'openai-compatible',
    displayName: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlRequired: true,
    category: 'cn'
  },
  {
    key: 'minimax',
    protocol: 'openai-compatible',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    baseUrlRequired: true,
    category: 'cn'
  },
  {
    key: 'doubao',
    protocol: 'openai-compatible',
    displayName: '豆包方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    baseUrlRequired: true,
    category: 'cn'
  },
  {
    key: 'siliconflow',
    protocol: 'openai-compatible',
    displayName: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    baseUrlRequired: true,
    category: 'cn'
  },
  {
    key: 'openrouter',
    protocol: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: '',
    baseUrlRequired: false,
    category: 'popular'
  },
  {
    key: 'ollama',
    protocol: 'openai-compatible',
    displayName: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    baseUrlRequired: true,
    category: 'local',
    keyOptional: true
  },
  {
    key: 'lmstudio',
    protocol: 'openai-compatible',
    displayName: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    baseUrlRequired: true,
    category: 'local',
    keyOptional: true
  },
  {
    key: 'opencode',
    protocol: 'openai-compatible',
    displayName: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    baseUrlRequired: true,
    category: 'global'
  },
  {
    key: 'groq',
    protocol: 'openai-compatible',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    baseUrlRequired: true,
    category: 'global'
  },
  {
    key: 'mistral',
    protocol: 'openai-compatible',
    displayName: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    baseUrlRequired: true,
    category: 'global'
  },
  {
    key: 'xai',
    protocol: 'openai-compatible',
    displayName: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    baseUrlRequired: true,
    category: 'global'
  },
  {
    key: 'custom-openai',
    protocol: 'openai-compatible',
    displayName: '',
    baseUrl: '',
    baseUrlRequired: true,
    category: 'custom',
    custom: true
  },
  {
    key: 'custom-anthropic',
    protocol: 'anthropic',
    displayName: '',
    baseUrl: '',
    baseUrlRequired: false,
    category: 'custom',
    custom: true
  }
]

/** 根据模板 key 或展示名生成不撞现有 ID 的合法 slug（匹配后端 `^[a-z][a-z0-9_-]{0,40}$`）。 */
export function suggestProviderSlug(rawSeed: string, existingIds: readonly string[]): string {
  const taken = new Set(existingIds)
  const cleaned = rawSeed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32)
  const base = cleaned || 'custom-provider'
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i += 1) {
    const cand = `${base.slice(0, 36)}-${i}`
    if (!taken.has(cand)) return cand
  }
  return `${base.slice(0, 30)}-${Date.now() % 10000}`
}
