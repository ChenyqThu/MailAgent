import type { TFunction } from 'i18next'

/** 后台运行的错误码（async_jobs.last_error / matter run error.code）→ 给人看的说明。
 *  未收录的码原样返回 —— 新码漏收只是显示得不好看，不会丢信息。 */
export function runErrorText(code: string, t: TFunction): string {
  const key = code.startsWith('E_GATEWAY_HTTP_') ? 'E_GATEWAY_HTTP' : code
  return t(`runErrors.${key}`, { defaultValue: code })
}
