import { describe, expect, test } from 'vitest'

import i18n from '@shared/i18n'
import { runErrorText } from '@shared/lib/runErrorText'

await i18n.changeLanguage('zh-CN')

describe('runErrorText', () => {
  test('known codes read as text; gateway HTTP codes share one entry; unknown codes pass through', () => {
    const t = i18n.t.bind(i18n)
    expect(runErrorText('E_RUN_TIMEOUT', t)).toBe('运行超时，AI 在时限内没有完成')
    expect(runErrorText('E_GATEWAY_HTTP_502', t)).toBe('AI 服务请求失败')
    expect(runErrorText('E_SOMETHING_NEW', t)).toBe('E_SOMETHING_NEW')
  })
})
