// task 07-12 P5 cutover（2026-07-13）— isLlmProviderRegistryEnabled 默认值 pin。
//
// 缺省/空串 = on（删键 = on），显式仅 '1'/'true'（trim + 大小写不敏感）→ on，其余
// （'false'/'0' 等）→ off 应急回退——镜像 ai_gateway_lifecycle envBool(key, true)
// 先例（MAILAGENT_ISLAND_AGENT_ENABLED），与 Python pydantic 对 'false'/'0' 的
// bool 解析同向（显式 false 才 off；Python 侧默认由
// tests/llm_agent/test_provider_routing.py::test_flag_default_on_after_cutover pin）。

import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRequest: vi.fn() }))
vi.mock('../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: vi.fn(),
  getLlmBaseUrl: vi.fn(() => 'https://test.llm')
}))

const { isLlmProviderRegistryEnabled } =
  await import('../../src/electron/main/llm_provider_resolver')

const KEY = 'MAILAGENT_LLM_PROVIDER_REGISTRY'
const saved = process.env[KEY]

afterEach(() => {
  if (saved == null) delete process.env[KEY]
  else process.env[KEY] = saved
})

describe('isLlmProviderRegistryEnabled — default ON (2026-07-13 cutover)', () => {
  test('unset → on（删键 = on）', () => {
    delete process.env[KEY]
    expect(isLlmProviderRegistryEnabled()).toBe(true)
  })

  test('empty string → on（同缺省）', () => {
    process.env[KEY] = ''
    expect(isLlmProviderRegistryEnabled()).toBe(true)
  })

  test.each(['false', '0', 'FALSE', 'off', 'garbage'])(
    "explicit '%s' → off（应急回退）",
    (value) => {
      process.env[KEY] = value
      expect(isLlmProviderRegistryEnabled()).toBe(false)
    }
  )

  test.each(['true', '1', 'TRUE', ' true '])("explicit '%s' → on", (value) => {
    process.env[KEY] = value
    expect(isLlmProviderRegistryEnabled()).toBe(true)
  })
})
