// chat-panel P4 Phase 02 — AI Gateway /health + /api/ai/config contract.
//
// The gateway core is pure (node:http + ai), so these run in plain Node with no
// electron / keytar / chat_db. Each test starts a server on a kernel-assigned port
// (port: 0) and tears it down in afterEach.

import { afterEach, describe, expect, test } from 'vitest'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'

const handles: AiGatewayHandle[] = []
async function start(cfg: Parameters<typeof startAiGatewayServer>[0]): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

const BASE_CFG = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
} as const

describe('ai-gateway — /health', () => {
  test('GET /health → ok + observable config', async () => {
    const h = await start(BASE_CFG)
    const res = await fetch(`http://127.0.0.1:${h.port}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.service).toBe('mailagent-ai-gateway')
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.hasKey).toBe(true)
    expect(body.baseUrl).toBe('https://crs.example/api')
  })

  test('hasKey=false when apiKey is null (the key never crosses to a caller)', async () => {
    const h = await start({ ...BASE_CFG, apiKey: null })
    const res = await fetch(`http://127.0.0.1:${h.port}/health`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.hasKey).toBe(false)
    // the health payload must never echo the key itself.
    expect(JSON.stringify(body)).not.toContain('sk-test-key')
  })
})

describe('ai-gateway — /api/ai/config', () => {
  test('modelConfigured reflects key presence; persistence reflects injection', async () => {
    const h = await start(BASE_CFG)
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.modelConfigured).toBe(true)
    // no persistTurn injected → persistence false.
    expect(body.persistence).toBe(false)
    expect(body.model).toBe('claude-sonnet-4-6')
  })

  test('persistence=true when a persistTurn writer is injected', async () => {
    const h = await start({ ...BASE_CFG, persistTurn: () => {} })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/config`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.persistence).toBe(true)
  })

  test('modelConfigured=false when key absent', async () => {
    const h = await start({ ...BASE_CFG, apiKey: '' })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/config`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.modelConfigured).toBe(false)
  })
})

describe('ai-gateway — routing', () => {
  test('unknown route → 404 json', async () => {
    const h = await start(BASE_CFG)
    const res = await fetch(`http://127.0.0.1:${h.port}/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('not_found')
  })
})
