// 批 2 review HIGH-3 — onboarding:llmProviderSave / llmProviderTest 收紧测试。
//
// renderer 不再传 id/protocol/baseURL 组合：main 以 @shared/onboarding/
// llmProviderTemplates 为权威解析；仅 custom 两模板收用户 baseUrl（http/https +
// 拒 userinfo）；Test 只放行本次 session 内 Save 过的 provider id（防 renderer 拿
// main 的本地 token 权限对任意既有 provider 触发出网请求 = confused deputy）。
// daemonRequest 全程 mock（不依赖真 serve-api 端点）。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDaemonRequest } = vi.hoisted(() => ({ mockDaemonRequest: vi.fn() }))

vi.mock('../../src/electron/main/daemon_api', () => ({
  daemonRequest: mockDaemonRequest,
  daemonRequestRaw: vi.fn()
}))

const { __test__ } = await import('../../src/electron/main/handlers/onboarding')
const { llmProviderSave, llmProviderTest, resetLlmProviderSession } = __test__

beforeEach(() => {
  vi.clearAllMocks()
  resetLlmProviderSession()
  mockDaemonRequest.mockResolvedValue({})
})

describe('llmProviderSave — 模板单源解析', () => {
  it('rejects unknown templateKey without touching the daemon', async () => {
    const res = await llmProviderSave({ templateKey: 'evil', apiKey: 'sk-x' })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_INVALID')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it('rejects the legacy {id, protocol} shape (templateKey missing)', async () => {
    const res = await llmProviderSave({
      id: 'attacker',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8300'
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_INVALID')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it('preset template: id/protocol/displayName/baseUrl all resolved from the main-side table', async () => {
    const res = await llmProviderSave({ templateKey: 'dashscope', apiKey: ' sk-x ' })
    expect(res).toEqual({ ok: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/llm/providers', {
      body: {
        id: 'dashscope',
        protocol: 'openai-compatible',
        displayName: '通义千问 Qwen (DashScope)',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-x',
        enabled: true
      }
    })
  })

  it('preset template rejects a renderer-supplied baseUrl (fail-loud, no daemon call)', async () => {
    const res = await llmProviderSave({
      templateKey: 'dashscope',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'sk-x'
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_INVALID')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it('custom-openai requires a baseUrl', async () => {
    const res = await llmProviderSave({ templateKey: 'custom-openai', apiKey: 'sk-x' })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_INVALID')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['non-http scheme', 'ftp://relay.example/v1'],
    ['userinfo URL', 'https://user:pass@relay.example/v1'],
    ['unparseable', 'not a url']
  ])('custom template rejects %s', async (_label, baseUrl) => {
    const res = await llmProviderSave({ templateKey: 'custom-openai', baseUrl, apiKey: 'sk-x' })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('E_INVALID')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it('custom template accepts a valid https baseUrl', async () => {
    const res = await llmProviderSave({
      templateKey: 'custom-openai',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'sk-x'
    })
    expect(res).toEqual({ ok: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/llm/providers', {
      body: expect.objectContaining({
        id: 'custom-openai',
        protocol: 'openai-compatible',
        baseUrl: 'https://relay.example/v1'
      })
    })
  })

  it('falls back to PATCH upsert (template-resolved fields) when the id already exists', async () => {
    mockDaemonRequest
      .mockRejectedValueOnce(new Error("provider 'anthropic' already exists"))
      .mockResolvedValueOnce({})
    const res = await llmProviderSave({ templateKey: 'anthropic', apiKey: 'sk-x' })
    expect(res).toEqual({ ok: true })
    expect(mockDaemonRequest).toHaveBeenLastCalledWith('PATCH', '/llm/providers/anthropic', {
      body: {
        protocol: 'anthropic',
        displayName: 'Anthropic 官方',
        baseUrl: '',
        apiKey: 'sk-x',
        enabled: true
      }
    })
  })
})

describe('llmProviderTest — session 白名单', () => {
  it('refuses ids that were not saved in this onboarding session (no daemon call)', async () => {
    const res = await llmProviderTest({ id: 'default' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('本次引导')
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it('allows exactly the id saved via llmProviderSave, others stay refused', async () => {
    await llmProviderSave({ templateKey: 'anthropic', apiKey: 'sk-x' })
    mockDaemonRequest.mockClear()
    mockDaemonRequest.mockResolvedValue({ ok: true, latencyMs: 42, error: null })

    const allowed = await llmProviderTest({ id: 'anthropic' })
    expect(allowed).toEqual({ ok: true, latencyMs: 42, error: undefined })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/llm/providers/anthropic/test')

    mockDaemonRequest.mockClear()
    const refused = await llmProviderTest({ id: 'dashscope' })
    expect(refused.ok).toBe(false)
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })

  it('failed save does not whitelist the id', async () => {
    mockDaemonRequest.mockRejectedValue(new Error('boom'))
    const res = await llmProviderSave({ templateKey: 'anthropic', apiKey: 'sk-x' })
    expect(res.ok).toBe(false)
    mockDaemonRequest.mockClear()
    const test = await llmProviderTest({ id: 'anthropic' })
    expect(test.ok).toBe(false)
    expect(mockDaemonRequest).not.toHaveBeenCalled()
  })
})
