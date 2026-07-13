import { beforeEach, describe, expect, test, vi } from 'vitest'

const {
  mockGenerateText,
  mockGetLlmApiKey,
  mockGetLlmProviderModelResolver,
  mockIsLlmProviderRegistryEnabled,
  mockResolveProviderModel,
  mockSanitizedUpstreamErrorMessage
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGetLlmApiKey: vi.fn(),
  mockGetLlmProviderModelResolver: vi.fn(),
  mockIsLlmProviderRegistryEnabled: vi.fn(),
  mockResolveProviderModel: vi.fn(),
  mockSanitizedUpstreamErrorMessage: vi.fn(() => 'HTTP 401 APICallError')
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

vi.mock('../../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: mockGetLlmApiKey,
  getLlmBaseUrl: () => 'https://test.llm',
  getLlmModel: () => 'openai-main:gpt-5'
}))

vi.mock('../../../src/electron/main/llm_provider_resolver', () => ({
  getLlmProviderModelResolver: mockGetLlmProviderModelResolver,
  isLlmProviderRegistryEnabled: mockIsLlmProviderRegistryEnabled,
  sanitizedUpstreamErrorMessage: mockSanitizedUpstreamErrorMessage
}))

vi.mock('ai', () => ({ generateText: mockGenerateText }))

const fetchMock = vi.fn()
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

const handler = await import('../../../src/electron/main/handlers/nl_search')

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.USER_EMAIL
  mockGetLlmApiKey.mockResolvedValue('test-key')
  mockIsLlmProviderRegistryEnabled.mockReturnValue(false)
  mockResolveProviderModel.mockResolvedValue({
    providerId: 'openai-main',
    modelId: 'gpt-5',
    model: { modelId: 'sdk-gpt-5' },
    protocol: 'openai',
    maxOutputTokens: 32_000
  })
  mockGetLlmProviderModelResolver.mockResolvedValue({ resolve: mockResolveProviderModel })
})

describe('nlToDsl provider registry routing', () => {
  test('flag off preserves the exact legacy Anthropic request wire', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00-07:00'))
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'from:echo newer_than:7d 新人培训' }] })
    })

    const result = await handler.nlToDsl('找一下 echo 这几天发的新人培训邮件')

    expect(result).toEqual({ dsl: 'from:echo newer_than:7d 新人培训' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://test.llm/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'
    })
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(init.body).toBe(
      JSON.stringify({
        model: 'openai-main:gpt-5',
        max_tokens: 64_000,
        system: body.system,
        messages: [{ role: 'user', content: '找一下 echo 这几天发的新人培训邮件' }]
      })
    )
    expect(body.system).toContain("Today's date is 2026-07-13 (local time).")
    vi.useRealTimers()
  })

  test('flag on resolves providerRef and uses AI SDK without fetch', async () => {
    mockIsLlmProviderRegistryEnabled.mockReturnValue(true)
    mockGetLlmApiKey.mockResolvedValue(null)
    mockGenerateText.mockResolvedValue({ text: 'from:echo is:unread 合同', finishReason: 'stop' })

    const result = await handler.nlToDsl('echo 发来的未读合同')

    expect(result).toEqual({ dsl: 'from:echo is:unread 合同' })
    expect(mockResolveProviderModel).toHaveBeenCalledWith('openai-main:gpt-5')
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: 'sdk-gpt-5' },
        maxOutputTokens: 32_000,
        prompt: 'echo 发来的未读合同'
      })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('flag on upstream failure returns the sanitized message, never err.message (MEDIUM-4)', async () => {
    mockIsLlmProviderRegistryEnabled.mockReturnValue(true)
    const leaky = new Error('401 body echoed Authorization: Bearer sk-live-LEAK')
    mockGenerateText.mockRejectedValue(leaky)

    const result = await handler.nlToDsl('echo 发来的未读合同')

    expect(result.error).toBe('E_UPSTREAM')
    expect(mockSanitizedUpstreamErrorMessage).toHaveBeenCalledWith(leaky)
    expect(result.message).toBe('HTTP 401 APICallError')
    expect(result.message).not.toContain('sk-live-LEAK')
  })

  test('flag off keeps the legacy raw fetch-failure message shape', async () => {
    mockIsLlmProviderRegistryEnabled.mockReturnValue(false)
    fetchMock.mockRejectedValue(new Error('socket hang up'))

    const result = await handler.nlToDsl('echo 发来的未读合同')

    expect(result.error).toBe('E_UPSTREAM')
    expect(result.message).toBe('LLM fetch failed: socket hang up')
    expect(mockSanitizedUpstreamErrorMessage).not.toHaveBeenCalled()
  })
})
