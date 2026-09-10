// 与 Python 侧 tests/llm_agent/test_opencode_session.py 用同一组用例（两边判据要一致）。
import { describe, expect, test } from 'vitest'

import { hasOpencodeSessionHeader, isOpencodeBaseUrl } from '@shared/lib/opencodeSession'

describe('isOpencodeBaseUrl', () => {
  test.each([
    ['https://opencode.ai/zen/go/v1', true],
    ['https://opencode.ai/zen/v1', true],
    ['https://api.opencode.ai/v1', true],
    ['https://crs.chenge.ink/api', false],
    ['https://notopencode.ai/v1', false],
    ['opencode.ai/zen', false],
    ['', false]
  ])('%s → %s', (url, expected) => {
    expect(isOpencodeBaseUrl(url)).toBe(expected)
  })
})

test('hasOpencodeSessionHeader 大小写不敏感', () => {
  expect(hasOpencodeSessionHeader({ 'X-OpenCode-Session': 'a' })).toBe(true)
  expect(hasOpencodeSessionHeader({ 'x-other': 'a' })).toBe(false)
})
