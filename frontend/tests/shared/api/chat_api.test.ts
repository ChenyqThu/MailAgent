// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createChatRuntime } from '../../../src/shared/api/chat_api'

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createChatRuntime.importAgentPlugin', () => {
  test('posts zipBase64 through the authenticated JSON transport', async () => {
    const fetchMock = vi.fn(async () => envelope({
      plugin: { name: 'demo', source: 'upload' },
      skills: [],
      mcpServers: []
    }))
    vi.stubGlobal('fetch', fetchMock)

    const api = createChatRuntime({ baseUrl: 'https://mail.example/api' })
    await api.importAgentPlugin('YWJj')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example/api/agent/skills/plugin/import')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ zipBase64: 'YWJj' })
    })
  })
})
