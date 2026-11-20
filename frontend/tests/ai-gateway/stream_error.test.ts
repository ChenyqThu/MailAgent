import { describe, expect, it, vi } from 'vitest'
import { APICallError, RetryError } from 'ai'

import { formatStreamError, redactErrorText, reportStreamError } from '../../src/ai-gateway/streamError'

describe('streamError redaction & RetryError unwrapping', () => {
  it('redacts explicit secrets even across the 400-char boundary before slicing', () => {
    const secret = 'sk-ant-api03-very-long-secret-value-998877'
    const longPrefix = 'A'.repeat(390)
    const err = new APICallError({
      message: `Bad Request with ${secret}`,
      url: 'https://relay.example.test/v1/messages',
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: `${longPrefix} echoed=${secret} tail`
    })

    const out = formatStreamError(err, [secret])
    expect(out).not.toContain('sk-ant-api03')
    expect(out).not.toContain(secret)
    expect(out).toContain('HTTP 400 Bad Request with ***')
    expect(out).toContain('***')
  })

  it('scrubs generic Bearer / sk- / mak_ / x-api-key echoes without explicit secret list', () => {
    const raw =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig x-api-key: "sk-proj-abcd1234567890" key=mak_abcdef1234567890'
    const scrubbed = redactErrorText(raw)
    expect(scrubbed).not.toContain('eyJhbGciOi')
    expect(scrubbed).not.toContain('sk-proj-abcd1234567890')
    expect(scrubbed).not.toContain('mak_abcdef1234567890')
    expect(scrubbed).toContain('***')
  })

  it('unwraps RetryError.lastError and logs redacted text via reportStreamError', () => {
    const inner = new APICallError({
      message: 'Rate limit exceeded',
      url: 'https://api.example.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: 'Too many requests for token sk-live-secret-1234567890'
    })
    const retryErr = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [inner]
    })
    const log = vi.fn()
    const out = reportStreamError(log, 'chat_stream_error', { sessionId: 42 }, retryErr)
    expect(out).toContain('HTTP 429 Rate limit exceeded')
    expect(out).not.toContain('sk-live-secret-1234567890')
    expect(log).toHaveBeenCalledWith({
      event: 'chat_stream_error',
      sessionId: 42,
      error: out
    })
  })
})
