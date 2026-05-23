// Sprint 19 PR-2f — Sender email → KOS slug helper.
//
// 集中 slug 转换逻辑给 sender_digest_cache 用; chat harness 启动时按
// senderAddr 异步预 fetch KOS digest (`people/<slug>`). 跟后端 Python
// src.kos.producer.normalize_message_id_for_slug 算法风格一致 (lowercase
// + 非 alnum → dash + 折叠 + trim).

/**
 * Map sender email → KOS `people/...` slug.
 *
 * Examples:
 *   senderToKosPeopleSlug('bob@acme.com')        → 'people/bob-acme-com'
 *   senderToKosPeopleSlug('Bob <bob@acme.com>')  → 'people/bob-bob-acme-com'
 *   senderToKosPeopleSlug('')                     → 'people/unknown'
 *
 * Caller can override prefix (default `people/`) for other namespaces
 * (companies/, projects/, concepts/).
 */
export function senderToKosPeopleSlug(
  email: string | null | undefined,
  prefix: string = 'people/'
): string {
  if (!email || typeof email !== 'string') return `${prefix}unknown`
  const lower = email.toLowerCase().trim()
  // 去掉常见 RFC 2822 角括号 / display-name 包装
  const stripped = lower.replace(/[<>"']/g, ' ')
  const slugPart = stripped
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${prefix}${slugPart || 'unknown'}`
}
