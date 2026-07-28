// task 07-12 批 2 review HIGH-3 — onboarding「AI 模型」步的 provider 模板单源。
//
// 主进程（handlers/onboarding.ts llmProviderSave）以本表为**权威**：renderer 只传
// templateKey，id/protocol/displayName/baseUrl 全部由 main 从本表解析——堵掉「renderer
// 传任意 id/protocol/baseURL 组合，由 main 持本地 token 代理创建 provider」的
// confused-deputy 面。renderer（onboarding/steps.tsx）从同一模块投影下拉列表，防两份漂移。
//
// 与 Settings 的 PROVIDER_TEMPLATES（settings/providers/templates.ts）有意分列：
// onboarding 是 Chinese-only 的极简收敛面（模板 key 即 provider id、不许自选 id），
// Settings 是全功能管理面（trust model 不同：renderer 直连 serve-api、token 经
// webRequest 注入，不走 main 代理）。
//
// baseUrl 事实来源 = task research/02 §3-4（各家端点实测）；'' = 官方默认
// （后端 llm_providers.py _DEFAULT_BASES 兜底）。

export interface OnboardingLlmTemplate {
  /** provider id（slug，服务端 _PROVIDER_ID_RE: 小写字母开头 + [a-z0-9_-]）。 */
  key: string
  /** displayName（onboarding Chinese-only，无 i18n）。 */
  name: string
  protocol: 'anthropic' | 'openai' | 'openai-compatible' | 'deepseek' | 'openrouter'
  /** 固定端点；'' = 官方默认。非 custom 模板恒用本值，renderer 传值无效。 */
  baseUrl: string
  /** 仅 custom 两模板可由用户提供 baseUrl（main 侧校验 http/https + 拒 userinfo）。 */
  allowCustomBaseUrl?: boolean
  /** openai-compatible 自定义无官方默认 → baseUrl 必填。 */
  baseUrlRequired?: boolean
}

export const ONBOARDING_LLM_TEMPLATES: readonly OnboardingLlmTemplate[] = [
  { key: 'anthropic', name: 'Anthropic 官方', protocol: 'anthropic', baseUrl: '' },
  { key: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: '' },
  { key: 'deepseek', name: 'DeepSeek', protocol: 'deepseek', baseUrl: '' },
  {
    key: 'dashscope',
    name: '通义千问 Qwen (DashScope)',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  },
  {
    key: 'moonshot',
    name: 'Kimi (月之暗面)',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1'
  },
  {
    key: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1'
  },
  {
    key: 'doubao',
    name: '豆包 (火山方舟)',
    protocol: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  },
  {
    key: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1'
  },
  { key: 'openrouter', name: 'OpenRouter', protocol: 'openrouter', baseUrl: '' },
  {
    key: 'custom-openai',
    name: '自定义 (OpenAI 兼容)',
    protocol: 'openai-compatible',
    baseUrl: '',
    allowCustomBaseUrl: true,
    baseUrlRequired: true
  },
  {
    key: 'custom-anthropic',
    name: '自定义 (Anthropic 兼容)',
    protocol: 'anthropic',
    baseUrl: '',
    allowCustomBaseUrl: true
  }
]

export function findOnboardingLlmTemplate(key: string): OnboardingLlmTemplate | undefined {
  return ONBOARDING_LLM_TEMPLATES.find((t) => t.key === key)
}

/** custom 模板用户 baseUrl 校验：返回问题描述（Chinese-only onboarding 文案），null = 合法。
 *  main 侧调用是权威（renderer 复用只为提前反馈）。仅收 http/https、拒 userinfo
 *  （`user:pass@host` 形态常被用来混淆目标主机）。 */
export function invalidCustomBaseUrlReason(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'API 地址不是合法 URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'API 地址仅支持 http/https'
  }
  if (url.username !== '' || url.password !== '') {
    return 'API 地址不得携带用户名/密码（userinfo）'
  }
  return null
}

/** `onboarding:llmProviderTest` 的 IPC 结果 —— main（handlers/onboarding.ts）与 renderer
 *  （onboarding/ipc.ts）的**单源**，两侧各自 `export type` 复出，不再手抄第二份
 *  （issue #67 item 6：同一契约跨 IPC 边界抄了两份）。renderer 不 import main，故这类
 *  跨边界形状一律落在本模块——与上面模板表同一个「防两份漂移」理由。
 *
 *  🔴 两个字段都是 optional，且这**不是**下游 serve-api 的形状：
 *  `POST /llm/providers/{id}/test`（src/api/routers/llm_providers.py:736-771）两条分支恒发
 *  `latencyMs` + `error`，settings 侧走 HTTP 直连、用 `useLlmProviders.ts` 里那个**同名但更严**
 *  的类型是对的。这里松，是因为 main 在代理时会插入自己的护栏返回（缺 id / 非本次引导保存的
 *  id / catch 兜底），那几条根本没跑到上游、没有 latency 可言。两个类型描述的是两条不同的
 *  通道，合并它们才是错的。 */
export interface LlmProviderTestResult {
  ok: boolean
  /** 上游探测往返毫秒。main 的护栏分支不含此字段 —— 消费侧必须判 `typeof === 'number'`。 */
  latencyMs?: number
  /** 可读错误（不含 key）。成功时缺席（main 把上游的 null 映射成 undefined）。 */
  error?: string
}
