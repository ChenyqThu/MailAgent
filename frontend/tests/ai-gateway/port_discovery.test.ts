// chat-panel P4 Phase 02 — renderer-side AI SDK runtime discovery (flags.ts).
//
// The renderer learns the embedded Gateway's loopback port from ?aiGatewayPort=
// (injected by main createWindow, same channel as ?apiPort=). These tests pin the
// three resolver gates the panel branches on. flags.ts reads process.env first
// (vitest has no Vite `define`, so the build constants are undefined and the
// resolver falls back to env) — vi.stubEnv / vi.stubGlobal drive them.

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  getChatRuntimeMode,
  isAiSdkGatewayEnabled,
  resolveAiGatewayBaseUrl
} from '../../src/shared/assistant/runtime/flags'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('flags — getChatRuntimeMode', () => {
  test("'ai-sdk' resolves to ai-sdk (no longer folds to external-store)", () => {
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    expect(getChatRuntimeMode()).toBe('ai-sdk')
  })

  test("'external-store' and 'ag-ui' still fold to external-store", () => {
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'external-store')
    expect(getChatRuntimeMode()).toBe('external-store')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ag-ui')
    expect(getChatRuntimeMode()).toBe('external-store')
  })

  test('default / unknown → legacy', () => {
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', '')
    expect(getChatRuntimeMode()).toBe('legacy')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'whatever')
    expect(getChatRuntimeMode()).toBe('legacy')
  })
})

describe('flags — isAiSdkGatewayEnabled', () => {
  test('truthy values enable; default off', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', '1')
    expect(isAiSdkGatewayEnabled()).toBe(true)
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', 'true')
    expect(isAiSdkGatewayEnabled()).toBe(true)
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', '')
    expect(isAiSdkGatewayEnabled()).toBe(false)
  })
})

describe('flags — resolveAiGatewayBaseUrl', () => {
  test('reads ?aiGatewayPort= into a loopback base URL', () => {
    vi.stubGlobal('window', {
      location: { search: '?apiPort=8200&aiGatewayPort=8300' }
    })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('absent param → null (entry stays hidden)', () => {
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('non-numeric / non-positive port → null', () => {
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=abc' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=0' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('no window (non-renderer) → null', () => {
    // node env has no window by default; do not stub it.
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })
})
