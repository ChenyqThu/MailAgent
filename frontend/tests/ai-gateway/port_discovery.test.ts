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

// task A — 远程 web 切 AI SDK: resolveAiGatewayBaseUrl three-branch resolution.
//   (1) ?aiGatewayPort=N present → http://127.0.0.1:N  (LOCAL Electron, byte-identical)
//   (2) no port + web build + ai-sdk on → ''            (same-origin serve-api proxy)
//   (3) otherwise → null                                (legacy)
// The crux: '' ONLY ever fires on the web build with the ai-sdk runtime on; the local
// Electron path (port present → http://…) and every off path (→ null) are unchanged.
describe('flags — resolveAiGatewayBaseUrl three-branch (task A web proxy)', () => {
  test('(2) web build + ai-sdk runtime on, no port → "" (same-origin proxy)', () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBe('')
  })

  test('(2) "" makes the transport/health/approval URLs same-origin (proxy-bound)', () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    vi.stubGlobal('window', { location: { search: '' } })
    const base = resolveAiGatewayBaseUrl()
    expect(base).toBe('')
    // The exact strings the renderer composes (transport / health / followups / approval).
    expect(`${base}/api/ai/chat`).toBe('/api/ai/chat')
    expect(`${base}/health`).toBe('/health')
    expect(`${base}/api/ai/title`).toBe('/api/ai/title')
    expect(`${base}/api/ai/approval/resolve`).toBe('/api/ai/approval/resolve')
  })

  test('(3) web build but ai-sdk runtime OFF → null (legacy, byte-identical)', () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    // MAILAGENT_CHAT_RUNTIME unset + master off → getChatRuntimeMode() === 'legacy'.
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('(1) LOCAL byte-identical: port present wins even on a web build', () => {
    // Defensive: were a web page ever served with ?aiGatewayPort=, the loopback branch
    // still wins (it returns BEFORE the web check) — local-direct semantics preserved.
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=8300' } })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('(1) LOCAL Electron (NOT web) + ai-sdk on, port present → loopback (unchanged)', () => {
    // Electron build: VITE_BUILD_TARGET is NOT 'web' (left unset). Port present → loopback,
    // exactly as before this change — the local path never resolves to '' .
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=8300' } })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('(3) NOT web (Electron) + ai-sdk on + NO port → null (never "" off-web)', () => {
    // The byte-identical guard: a non-web build with ai-sdk on but no port param resolves to
    // null (the old behaviour), never the new same-origin '' — that is web-only.
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('(3) NOT web + runtime off + no port → null (pre-change default)', () => {
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })
})
