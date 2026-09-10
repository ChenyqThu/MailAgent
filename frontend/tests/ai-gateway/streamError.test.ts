import { describe, expect, test, vi } from 'vitest'
import { APICallError, RetryError } from 'ai'

import { formatStreamError, reportStreamError } from '../../src/ai-gateway/streamError'

function opencode400(): APICallError {
  return new APICallError({
    message: 'Bad Request',
    url: 'https://opencode.ai/zen/go/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseBody:
      '{"type":"error","error":{"type":"MissingSessionID",\n  "message":"missing x-opencode-session"}}'
  })
}

describe('formatStreamError', () => {
  test('带上 HTTP 状态与压平换行后的 provider 返回体', () => {
    expect(formatStreamError(opencode400())).toBe(
      'HTTP 400 Bad Request — {"type":"error","error":{"type":"MissingSessionID", "message":"missing x-opencode-session"}}'
    )
  })

  test('重试耗尽的 RetryError 解开到 lastError', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts. Last error: Bad Request',
      reason: 'maxRetriesExceeded',
      errors: [opencode400()]
    })
    expect(formatStreamError(retry)).toMatch(/^HTTP 400 Bad Request — .*MissingSessionID/)
  })

  test('返回体已在 message 里时不重复拼接', () => {
    const error = new APICallError({
      message: 'Insufficient balance',
      url: 'https://opencode.ai/zen/go/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 401,
      responseBody: 'Insufficient balance'
    })
    expect(formatStreamError(error)).toBe('HTTP 401 Insufficient balance')
  })

  test('非 APICallError 原样取 message', () => {
    expect(formatStreamError(new Error('boom'))).toBe('boom')
    expect(formatStreamError('plain')).toBe('plain')
  })
})

describe('reportStreamError', () => {
  test('落一行日志并返回同一段文本', () => {
    const log = vi.fn()
    const text = reportStreamError(log, 'chat_stream_error', { sessionId: 7 }, opencode400())
    expect(text).toMatch(/^HTTP 400/)
    expect(log).toHaveBeenCalledWith({ event: 'chat_stream_error', sessionId: 7, error: text })
  })

  test('没有注入日志函数时照常返回文本', () => {
    expect(reportStreamError(undefined, 'chat_stream_error', {}, new Error('x'))).toBe('x')
  })
})
