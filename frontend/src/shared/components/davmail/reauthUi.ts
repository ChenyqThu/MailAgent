// DavMail 重新认证的纯展示逻辑（task 10-28-davmail-self-reauth）。弹窗、设置页、看板卡片共用。

import type { TFunction } from 'i18next'

/**
 * 「完成认证」按钮可不可点的粗判。🔴 回调地址的解析规则只在后端有一份
 * （`src/mail/davmail_reauth.py`），这里不抄：粗判只挡空输入和明显不是回调的东西，
 * 解析失败以后端返回的 stage=parse 为准。
 */
export function looksLikeCallback(text: string): boolean {
  const s = text.trim()
  if (!s) return false
  return s.includes('code=') || (!/\s/.test(s) && s.length > 20)
}

/** 剩余毫秒 → `m:ss`。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 登录到期的一句话（`auth_days_left`：负数 = 已过期，null = 没有交互认证记录）。 */
export function authExpiryLabel(t: TFunction, daysLeft: number | null | undefined): string {
  if (daysLeft == null) return t('davmailReauth.expiry.unrecorded')
  if (daysLeft <= 0) return t('davmailReauth.expiry.expired')
  if (daysLeft < 1) return t('davmailReauth.expiry.lessThanDay')
  // 向下取整，与 watchdog 通知标题（`_format_days_left`）同一口径：提醒宁可说少一天。
  return t('davmailReauth.expiry.daysLeft', { days: Math.floor(daysLeft) })
}
