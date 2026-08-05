// chat-panel P4 Phase 06a (cutover) — loopback-only CORS (httpUtil.corsHeadersFor).
//
// The embedded gateway is a same-machine loopback server reached by the Electron renderer (packaged
// file:// → Origin 'null'; dev → http://localhost:<vite>). corsHeadersFor reflects the Origin only
// when it is loopback / file / null / absent, so a REMOTE cross-origin page cannot read a response —
// replacing the blanket ACAO '*' (architecture §13.8.5/§13.11.6/§13.12.7/§13.13.5).

import type { Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { corsHeadersFor } from '../../src/ai-gateway/httpUtil'
import { createAiGatewayServer } from '../../src/ai-gateway/server'

describe('corsHeadersFor — allow the renderer / loopback origins', () => {
  test('absent Origin (server-to-server / same-origin) → no headers', () => {
    expect(corsHeadersFor(undefined)).toEqual({})
  })

  test("packaged renderer file:// → Origin 'null' is reflected", () => {
    expect(corsHeadersFor('null')).toEqual({
      'Access-Control-Allow-Origin': 'null',
      Vary: 'Origin'
    })
  })

  test('file:// origin is reflected', () => {
    expect(corsHeadersFor('file://')['Access-Control-Allow-Origin']).toBe('file://')
  })

  test('loopback origins (127.0.0.1 / localhost / [::1], any port) are reflected', () => {
    for (const o of [
      'http://127.0.0.1:5173',
      'http://localhost:8200',
      'https://127.0.0.1',
      'http://[::1]:9300'
    ]) {
      expect(corsHeadersFor(o)).toEqual({ 'Access-Control-Allow-Origin': o, Vary: 'Origin' })
    }
  })
})

describe('corsHeadersFor — reject remote cross-origin', () => {
  test('a remote https Origin gets no ACAO (browser blocks the read)', () => {
    for (const o of [
      'https://evil.example',
      'https://mail.chenge.ink',
      'http://127.0.0.1.evil.example', // not a real loopback host — must NOT match
      'http://localhost.evil.example'
    ]) {
      const headers = corsHeadersFor(o)
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
      expect(headers.Vary).toBe('Origin') // still Vary so caches key on Origin
    }
  })
})

// Wiring-level gate (chat-ui batch 2026-08). The unit tests above only prove the FUNCTION is
// correct — Phase 06a shipped with corsHeadersFor attached to the SSE sites but NOT the
// writeJson GET routes, so the dev renderer's /health probe was CORS-blocked and the panel
// showed the engine-unavailable read-only face while the gateway was healthy. These tests pin
// the server entry: every response carries the reflected ACAO for loopback origins, none for
// remote — so the gap cannot silently reopen.
describe('server wiring — every response carries loopback-only CORS', () => {
  let server: Server
  let base = ''

  beforeAll(async () => {
    server = createAiGatewayServer({
      port: 0,
      baseUrl: 'https://llm.example.test/api',
      apiKey: null,
      model: 'claude-test'
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr == null || typeof addr === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve()))
    )
  })

  test('GET /health with the dev renderer Origin reflects ACAO (the D7 false-positive fix)', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'http://localhost:5173' }
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  test('GET /api/ai/config with a loopback Origin reflects ACAO', async () => {
    const res = await fetch(`${base}/api/ai/config`, {
      headers: { Origin: 'http://127.0.0.1:5173' }
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
  })

  test('GET /health with a REMOTE Origin still gets no ACAO', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'https://evil.example' }
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')).toBe('Origin')
  })

  test('GET /health without an Origin (curl / server-to-server) carries no CORS headers', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
