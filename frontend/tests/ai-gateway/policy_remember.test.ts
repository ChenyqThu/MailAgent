// S2 W1 (task 07-02-s2-exec-skill-install) — POST /api/ai/policy/remember (the exec approval card's
// "always allow" side-channel). The endpoint delegates to cfg.rememberExecApproval (the Electron
// wrapper peeks the pending exec approval, derives a full-PIN rule, and persists it). Covers: 501 when
// exec tools aren't wired, 400 on a missing toolCallId, typed error passthrough, and the success shape.

import { describe, expect, test } from 'vitest'

import { startAiGatewayServer } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'

async function withServer(
  rememberExecApproval: AiGatewayConfig['rememberExecApproval'],
  run: (base: string) => Promise<void>
): Promise<void> {
  const handle = await startAiGatewayServer({
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    apiKey: 'test',
    model: 'test-model',
    rememberExecApproval
  })
  try {
    await run(`http://127.0.0.1:${handle.port}`)
  } finally {
    await handle.close()
  }
}

const post = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/ai/policy/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

describe('POST /api/ai/policy/remember', () => {
  test('not wired (exec tools off) → 501', async () => {
    await withServer(undefined, async (base) => {
      const res = await post(base, { toolCallId: 'tc1' })
      expect(res.status).toBe(501)
      expect((await res.json()).error).toBe('E_NOT_IMPLEMENTED')
    })
  })

  test('missing toolCallId → 400', async () => {
    await withServer(async () => ({}), async (base) => {
      const res = await post(base, {})
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('E_INVALID_ARG')
    })
  })

  test('success → 200 with the created rule', async () => {
    const seen: string[] = []
    await withServer(
      async (toolCallId) => {
        seen.push(toolCallId)
        return { id: 5, capability: 'exec', dangerous: false }
      },
      async (base) => {
        const res = await post(base, { toolCallId: 'tc-exec' })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string; rule: { id: number; capability: string } }
        expect(body.status).toBe('ok')
        expect(body.rule).toMatchObject({ id: 5, capability: 'exec' })
        expect(seen).toEqual(['tc-exec'])
      }
    )
  })

  test('no pending approval (E_APPROVAL_NOT_FOUND) → 404', async () => {
    await withServer(
      async () => {
        throw Object.assign(new Error('no pending approval'), { code: 'E_APPROVAL_NOT_FOUND' })
      },
      async (base) => {
        const res = await post(base, { toolCallId: 'gone' })
        expect(res.status).toBe(404)
        expect((await res.json()).error).toBe('E_APPROVAL_NOT_FOUND')
      }
    )
  })

  test('a derivation error (E_INVALID_ARG / non-exec) → 400', async () => {
    await withServer(
      async () => {
        throw Object.assign(new Error('not an exec tool'), { code: 'E_NOT_FOUND' })
      },
      async (base) => {
        const res = await post(base, { toolCallId: 'x' })
        expect(res.status).toBe(400) // approvalErrorStatus default (non-E_APPROVAL_* code)
        expect((await res.json()).error).toBe('E_NOT_FOUND')
      }
    )
  })
})
