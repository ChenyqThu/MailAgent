// 邮件 HTML 消毒 —— 阅读区 (EmailBodyFrame) 与 compose 发送拼回的原文引用块共用同一套
// 硬化规则。单一来源避免两处各自维护漂移; 保证「预览所见 = 实际发送」(compose 引用块
// 渲染与发送走同一 sanitize 配置)。
//
// 独立回归守护见 tests/components/dompurify_xss.test.ts —— 该文件故意 mirror 一份配置
// 断言典型 XSS 向量被剥离, 若此处漂移测试会失败。
import DOMPurify from 'dompurify'

// 仅允许 image/* 的 data: URI (防 `data:text/html` 注入), 外加常见安全 scheme。
// 缺它默认 regex 会把 `data:image/png;base64,...` 内联图也剥掉。
export const SAFE_EMAIL_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|data:image\/(?:png|jpe?g|gif|webp|svg\+xml|heic)):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

export const EMAIL_PURIFY_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['target', 'onerror', 'onclick', 'onload'],
  ALLOWED_URI_REGEXP: SAFE_EMAIL_URI_REGEXP
}

/** 硬化 sanitize: 渲染 / 发送不可信邮件 HTML (原文引用块等) 时用, 与阅读区同配置。 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_PURIFY_OPTS)
}
