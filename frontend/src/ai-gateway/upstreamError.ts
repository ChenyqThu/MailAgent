// 发版终审 M3（codex）/ M-1（fable）— AI SDK 上游错误 → 固定形状文案，gateway core 单源。
//
// 绝不透传 err.message：中转/恶意 provider 的错误正文可能回显 Authorization / x-api-key /
// 自定义签名 header 值，APICallError.message 会带上它们。APICallError → 'HTTP <status>
// <name>'；其余 → 错误类名 + 固定文案。仅供 AI SDK（provider registry）调用路径；flag off
// 裸 fetch / legacy 路径的既有错误形状不走它（字节级纪律，nl_search.ts 同款分叉手法）。
//
// 🔴 不能住 providerRef.ts —— 那里被 provider_lazy_import.test.ts 钉死 type-only import；
// 本模块 value-import `ai`（gateway core 本就依赖），消费方 = server.ts（title/followups）+
// searchAgentRun.ts + electron main 的 llm_provider_resolver.ts（re-export 保兼容，
// translate/nl_search 经它取用）。

import { APICallError } from 'ai'

export function sanitizedUpstreamErrorMessage(err: unknown): string {
  if (APICallError.isInstance(err)) {
    return err.statusCode != null
      ? `HTTP ${err.statusCode} ${err.name}`
      : `${err.name}: upstream LLM call failed`
  }
  if (err instanceof Error) return `${err.name}: upstream LLM call failed`
  return 'unknown upstream LLM error'
}
