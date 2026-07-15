// task 07-12 P3 — 「模型服务」区的内置 provider 模板（prd §4.5：模板只预填
// protocol + baseURL + displayName，key 恒由用户填）。
//
// baseUrl 事实来源 = research/02 §3-4（各家端点全部实测 401 证实存在）；'' = 官方默认
// （后端 llm_providers.py _DEFAULT_BASES 兜底：anthropic/openai/deepseek/openrouter/google）。
// openai-compatible 无官方默认 → 国内各家模板显式带 base、自定义模板必填。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

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
  /** 自定义模板：picker 文案走 i18n（settings.providers.template.<key>），id 预填为空。 */
  custom?: boolean
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    key: 'anthropic',
    protocol: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: '',
    baseUrlRequired: false
  },
  { key: 'openai', protocol: 'openai', displayName: 'OpenAI', baseUrl: '', baseUrlRequired: false },
  {
    key: 'google',
    protocol: 'google',
    displayName: 'Google Gemini',
    baseUrl: '',
    baseUrlRequired: false
  },
  {
    key: 'deepseek',
    protocol: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: '',
    baseUrlRequired: false
  },
  {
    key: 'dashscope',
    protocol: 'openai-compatible',
    displayName: '通义千问 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlRequired: true
  },
  {
    key: 'zhipu',
    protocol: 'openai-compatible',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlRequired: true
  },
  {
    key: 'kimi',
    protocol: 'openai-compatible',
    displayName: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlRequired: true
  },
  {
    key: 'minimax',
    protocol: 'openai-compatible',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    baseUrlRequired: true
  },
  {
    key: 'doubao',
    protocol: 'openai-compatible',
    displayName: '豆包方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    baseUrlRequired: true
  },
  {
    key: 'siliconflow',
    protocol: 'openai-compatible',
    displayName: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    baseUrlRequired: true
  },
  {
    key: 'openrouter',
    protocol: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: '',
    baseUrlRequired: false
  },
  {
    key: 'custom-openai',
    protocol: 'openai-compatible',
    displayName: '',
    baseUrl: '',
    baseUrlRequired: true,
    custom: true
  },
  {
    key: 'custom-anthropic',
    protocol: 'anthropic',
    displayName: '',
    baseUrl: '',
    baseUrlRequired: false,
    custom: true
  }
]
