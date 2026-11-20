// 流错误 → 一行可排障文本（聊天气泡的错误行 + ai-gateway.log 共用）。
//
// provider 拒绝的判据常在 APICallError.responseBody 里，message 往往只有一句「Bad Request」；
// ai@7 重试耗尽时抛 RetryError，真正的上游错误在 lastError。不解开这两层，UI 只剩「响应出错」。
//
// 🔴 Phase 0 安全加固：中转/调试代理可能在 responseBody 里回显请求头（Authorization /
//    x-api-key / API key）。必须先脱敏再按 BODY_LIMIT 截断（顺序反了会让前缀漏网）。

import { APICallError, RetryError } from 'ai'

const BODY_LIMIT = 400
const REDACTED = '***'
const MIN_SECRET_LEN = 4

// 常见凭据字面模式（即便调用方未显式传入 secrets，也兜底剥掉请求头/API key 回显）。
const GENERIC_SECRET_PATTERNS: readonly RegExp[] = [
  /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"',;}\]]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
  /((?:x-api-key|api[-_]?key)\s*[:=]\s*["']?)[^\s"',;}\]]+/gi,
  /\bsk-(?:ant-[A-Za-z0-9_-]{8,}|proj-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{12,})\b/g,
  /\bmak_[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g
]

/** 将已知秘密值与常见鉴权回显替换为 `***`（按秘密长度降序替换，防长串被短前缀切碎）。 */
export function redactErrorText(text: string, secrets?: readonly string[]): string {
  if (!text) return text
  let out = text
  if (secrets && secrets.length > 0) {
    const unique = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LEN))]
    unique.sort((a, b) => b.length - a.length)
    for (const secret of unique) {
      out = out.split(secret).join(REDACTED)
    }
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    out = out.replace(pattern, (_full, prefix?: string) => (prefix ? `${prefix}${REDACTED}` : REDACTED))
  }
  return out
}

export function formatStreamError(error: unknown, secrets?: readonly string[]): string {
  const cause = RetryError.isInstance(error) ? (error.lastError ?? error) : error
  const rawMessage = cause instanceof Error ? cause.message : String(cause)
  const message = redactErrorText(rawMessage, secrets)
  if (!APICallError.isInstance(cause)) return message
  const head = cause.statusCode != null ? `HTTP ${cause.statusCode} ${message}` : message
  const redactedBody = cause.responseBody ? redactErrorText(cause.responseBody, secrets) : ''
  const body = redactedBody.replace(/\s+/g, ' ').trim().slice(0, BODY_LIMIT)
  return body && !message.includes(body) ? `${head} — ${body}` : head
}

/** toUIMessageStream 的 onError 共用：格式化 → 落一行 ai-gateway.log → 返回给气泡的文本。 */
export function reportStreamError(
  log: ((record: Record<string, unknown>) => void) | undefined,
  event: string,
  context: Record<string, unknown>,
  error: unknown,
  secrets?: readonly string[]
): string {
  const text = formatStreamError(error, secrets)
  log?.({ event, ...context, error: text })
  return text
}
