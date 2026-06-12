function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** text-only 邮件的 plaintext → HTML 降级渲染。
 *  KISS: 不解析 markdown, 不自动链接 URL；body_markdown 对 text-only 邮件
 *  就是原始 plaintext。 */
export function plaintextToHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0) return ''
  const escaped = escapeHtmlText(normalized)

  return escaped
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('')
}
