/** 消息 status.error → 文本：字符串原样，Error 取 message，其余 JSON。直接 `JSON.stringify` 一个
 *  Error 得到的是 `{}`，真正的原因会被吞掉。 */
export function turnErrorText(error: unknown): string | undefined {
  if (error == null) return undefined
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
