// 流错误 → 一行可排障文本（聊天气泡的错误行 + ai-gateway.log 共用）。
//
// provider 拒绝的判据常在 APICallError.responseBody 里，message 往往只有一句「Bad Request」；
// ai@7 重试耗尽时抛 RetryError，真正的上游错误在 lastError。不解开这两层，UI 只剩「响应出错」。

import { APICallError, RetryError } from 'ai'

const BODY_LIMIT = 400

export function formatStreamError(error: unknown): string {
  const cause = RetryError.isInstance(error) ? (error.lastError ?? error) : error
  const message = cause instanceof Error ? cause.message : String(cause)
  if (!APICallError.isInstance(cause)) return message
  const head = cause.statusCode != null ? `HTTP ${cause.statusCode} ${message}` : message
  const body = cause.responseBody?.replace(/\s+/g, ' ').trim().slice(0, BODY_LIMIT)
  return body && !message.includes(body) ? `${head} — ${body}` : head
}

/** toUIMessageStream 的 onError 共用：格式化 → 落一行 ai-gateway.log → 返回给气泡的文本。 */
export function reportStreamError(
  log: ((record: Record<string, unknown>) => void) | undefined,
  event: string,
  context: Record<string, unknown>,
  error: unknown
): string {
  const text = formatStreamError(error)
  log?.({ event, ...context, error: text })
  return text
}
