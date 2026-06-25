// chat-panel P4 Phase 06a (cutover) — loopback-only CORS (httpUtil.corsHeadersFor).
//
// The embedded gateway is a same-machine loopback server reached by the Electron renderer (packaged
// file:// → Origin 'null'; dev → http://localhost:<vite>). corsHeadersFor reflects the Origin only
// when it is loopback / file / null / absent, so a REMOTE cross-origin page cannot read a response —
// replacing the blanket ACAO '*' (architecture §13.8.5/§13.11.6/§13.12.7/§13.13.5).

import { describe, expect, test } from 'vitest'

import { corsHeadersFor } from '../../src/ai-gateway/httpUtil'

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
