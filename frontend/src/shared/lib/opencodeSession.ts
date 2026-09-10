// OpenCode 会话头（零依赖叶子：网关与设置页共用）。
//
// OpenCode Go 自 2026-09-06 起拒收不带 `x-opencode-session` 的请求（400 MissingSessionID）。
// 值 = 每段对话一个稳定 ID；按官方文档只用于路由与提示缓存，不承载对话内容。
// Python 侧同一判据：src/llm_agent/provider_routing.py::is_opencode_base —— 改一处要同步。

export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/** 用户已在 provider 自定义 header 里配了会话头（大小写不敏感）→ 尊重显式配置，不再自动附加。 */
export function hasOpencodeSessionHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === OPENCODE_SESSION_HEADER)
}

export function isOpencodeBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}
