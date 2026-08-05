// chat-panel P4 Phase 02 / S3 — renderer-side AI SDK gateway base-URL discovery (flags.ts).
//
// The renderer learns the embedded Gateway's loopback port from ?aiGatewayPort=
// (injected by main createWindow, same channel as ?apiPort=). S3 removed the
// cutover-era runtime/gateway flags — discovery is now the ONLY resolution:
//   (1) ?aiGatewayPort=N present → http://127.0.0.1:N   (LOCAL Electron, direct loopback)
//   (2) no port + web build      → ''                    (same-origin serve-api proxy)
//   (3) otherwise                → null                  (error face, no engine fallback)
// vi.stubEnv('VITE_BUILD_TARGET','web') drives the web branch (flags.ts reads process.env
// first — under vitest there is no Vite `define`).

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  captureAiGatewayPortAtBoot,
  resolveAiGatewayBaseUrl
} from '../../src/shared/assistant/runtime/flags'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('flags — resolveAiGatewayBaseUrl (Electron loopback)', () => {
  test('reads ?aiGatewayPort= into a loopback base URL', () => {
    vi.stubGlobal('window', {
      location: { search: '?apiPort=8200&aiGatewayPort=8300' }
    })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('absent param (Electron, not web) → null (error face)', () => {
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('non-numeric / non-positive port → null', () => {
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=abc' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=0' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('no window (non-renderer, not web) → null', () => {
    // node env has no window by default; do not stub it.
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })
})

describe('flags — resolveAiGatewayBaseUrl (web same-origin proxy)', () => {
  test('web build, no port → "" (same-origin serve-api proxy)', () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBe('')
  })

  test('"" makes the transport/health/approval URLs same-origin (proxy-bound)', () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubGlobal('window', { location: { search: '' } })
    const base = resolveAiGatewayBaseUrl()
    expect(base).toBe('')
    // The exact strings the renderer composes (transport / health / title / approval).
    expect(`${base}/api/ai/chat`).toBe('/api/ai/chat')
    expect(`${base}/health`).toBe('/health')
    expect(`${base}/api/ai/title`).toBe('/api/ai/title')
    expect(`${base}/api/ai/approval/resolve`).toBe('/api/ai/approval/resolve')
  })

  test('LOCAL wins: port present resolves to loopback even on a web build', () => {
    // Defensive: were a web page ever served with ?aiGatewayPort=, the loopback branch
    // still wins (it returns BEFORE the web check) — local-direct semantics preserved.
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    vi.stubGlobal('window', { location: { search: '?aiGatewayPort=8300' } })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('NOT web (Electron) + no port → null, never "" off-web', () => {
    // The same-origin '' is web-only: a non-web build without the port param resolves to
    // null (error face), never the proxy base.
    vi.stubGlobal('window', { location: { search: '?apiPort=8200' } })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })
})

describe('flags — sessionStorage stash (dev reload resilience)', () => {
  // A vite forced full-reload racing a TanStack Router search rewrite can drop the
  // boot-injected ?aiGatewayPort= mid-session (dev only). The stash written on the
  // first successful read keeps the gateway reachable across that reload.
  function makeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v)
    }
  }

  test('param read stashes the port; later param-less read falls back to the stash', () => {
    const sessionStorage = makeStorage()
    vi.stubGlobal('window', {
      location: { search: '?apiPort=8200&aiGatewayPort=8300' },
      sessionStorage
    })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
    // Simulate the reload that lost the query params (same WebContents → same storage).
    vi.stubGlobal('window', { location: { search: '?view=inbox' }, sessionStorage })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('no param + empty stash (Electron) → still null (error face unchanged)', () => {
    vi.stubGlobal('window', {
      location: { search: '?view=inbox' },
      sessionStorage: makeStorage()
    })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })

  test('EAGER boot capture: entry-time stash survives a nav that cleared the params before any surface read them', () => {
    // The 2026-08-04 acceptance hole: chat surfaces mount lazily, so with a LAZY-only stash,
    // navigating to /sessions (params cleared) before any surface ever resolved the port left
    // the stash empty → unavailable face. The entry calls captureAiGatewayPortAtBoot() while
    // the boot URL still carries the param.
    const sessionStorage = makeStorage()
    vi.stubGlobal('window', {
      location: { search: '?apiPort=8200&aiGatewayPort=8300' },
      sessionStorage
    })
    captureAiGatewayPortAtBoot()
    // Router clears the search; only NOW does the first chat surface resolve.
    vi.stubGlobal('window', { location: { search: '' }, sessionStorage })
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('boot capture without the param is a no-op that preserves an existing stash', () => {
    const sessionStorage = makeStorage()
    sessionStorage.setItem('mailagent:aiGatewayPort', '8300')
    vi.stubGlobal('window', { location: { search: '?view=inbox' }, sessionStorage })
    captureAiGatewayPortAtBoot()
    expect(resolveAiGatewayBaseUrl()).toBe('http://127.0.0.1:8300')
  })

  test('invalid param does not poison the stash', () => {
    const sessionStorage = makeStorage()
    vi.stubGlobal('window', {
      location: { search: '?aiGatewayPort=abc' },
      sessionStorage
    })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
    vi.stubGlobal('window', { location: { search: '' }, sessionStorage })
    expect(resolveAiGatewayBaseUrl()).toBeNull()
  })
})
