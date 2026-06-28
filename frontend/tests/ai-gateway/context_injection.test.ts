// chat-panel P4 Phase 06 (context injection) — end-to-end gateway wiring tests.
//
// Drives the real gateway HTTP server (startAiGatewayServer) with a capturing mock model so we can
// assert the system prompt that actually reached the model: with a systemPromptProvider + a request
// contextSnapshot the system carries the safety floor + standing context + the untrusted email-body
// fence; a malformed snapshot is rejected pre-stream (400); without a provider the gateway passes
// body.system through unchanged (Phase 02 behaviour, byte-identical).

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

/** Minimal shape of the prompt the model is called with — enough to read the system message. */
type PromptMessage = { role: string; content: unknown }

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import {
  buildAgentContextSnapshot,
  type ContextScope,
  type CapabilityContext,
  type UIStateContext
} from '@shared/assistant/context/contextSnapshot'

const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

/** A mock model that records the `system` part of the prompt it was called with, then finishes. */
function capturingModel(captured: { system: string | null }): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options: { prompt: PromptMessage[] }) => {
      const sys = options.prompt.find((m) => m.role === 'system')
      captured.system = sys && typeof sys.content === 'string' ? sys.content : null
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 }
              }
            }
          ]
        })
      }
    }
  })
}

const SCOPE: ContextScope = {
  surface: 'email-chat',
  anchorType: 'email',
  anchorId: 53675,
  sessionId: 1,
  backendKind: 'ai-sdk'
}
const UI: UIStateContext = { locale: 'en', timezone: 'UTC', route: '/', panelMode: 'dock' }
const CAPS: CapabilityContext = {
  thinkingEnabled: false,
  attachmentsEnabled: false,
  toolCallingEnabled: true,
  humanApprovalRequired: true,
  enabledSkills: []
}

function snapshot() {
  return buildAgentContextSnapshot({
    scope: SCOPE,
    uiState: UI,
    capabilities: CAPS,
    createdAt: '2026-06-25T00:00:00.000Z',
    activeEmail: {
      internalId: 53675,
      subject: 'Q3 plan',
      senderName: 'Alice',
      senderAddr: 'alice@acme.test',
      dateIso: '2026-06-01',
      mailbox: 'INBOX',
      threadId: 't',
      notionPageId: null,
      bodyMarkdown: 'The quarterly numbers are attached.',
      bodySource: 'sqlite-body'
    }
  })
}

function baseCfg(
  model: MockLanguageModelV3,
  extra: Partial<AiGatewayConfig> = {}
): AiGatewayConfig {
  return {
    port: 0,
    baseUrl: 'https://example.test/api',
    apiKey: 'k',
    model: 'claude-sonnet-4-6',
    createModel: () => model,
    ...extra
  }
}

async function postChat(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('context injection — gateway system prompt', () => {
  test('provider + contextSnapshot → system has floor + standing + untrusted body fence', async () => {
    const captured = { system: null as string | null }
    const cfg = baseCfg(capturingModel(captured), {
      systemPromptProvider: () => ({
        standingContext: '# AGENT\nfocused email agent',
        memorySummary: 'prefers concise'
      })
    })
    const h = await start(cfg)
    const res = await postChat(h.port, {
      sessionId: null,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      anchor: { type: 'email', id: 53675 },
      contextSnapshot: snapshot()
    })
    // drain the stream so onFinish runs + the server completes.
    await res.text()
    expect(captured.system).toContain('## Safety guardrails')
    expect(captured.system).toContain('focused email agent')
    expect(captured.system).toContain('UNTRUSTED_EMAIL_BODY_START id=53675')
    expect(captured.system).toContain('The quarterly numbers are attached.')
  })

  test('malformed contextSnapshot → 400 E_INVALID_ARG (pre-stream)', async () => {
    const captured = { system: null as string | null }
    const cfg = baseCfg(capturingModel(captured), {
      systemPromptProvider: () => ({ standingContext: 'x' })
    })
    const h = await start(cfg)
    const res = await postChat(h.port, {
      sessionId: null,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      contextSnapshot: { version: 'mailagent.context.vBOGUS', scope: {} }
    })
    expect(res.status).toBe(400)
    const env = (await res.json()) as { error?: string }
    expect(env.error).toBe('E_INVALID_ARG')
    expect(captured.system).toBeNull() // never reached the model
  })

  test('no provider → body.system passthrough (Phase 02 byte-identical)', async () => {
    const captured = { system: null as string | null }
    const cfg = baseCfg(capturingModel(captured)) // no systemPromptProvider
    const h = await start(cfg)
    const res = await postChat(h.port, {
      sessionId: null,
      system: 'CUSTOM-LEGACY-SYSTEM',
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    })
    await res.text()
    expect(captured.system).toBe('CUSTOM-LEGACY-SYSTEM')
  })

  // ── M2 — query-recalled memory injected end-to-end through the gateway ──────────────────────────
  test('M2 — retrieveMemory recalled block reaches the model system prompt (keyed on raw user text)', async () => {
    const seenQueries: string[] = []
    const captured = { system: null as string | null }
    const cfg = baseCfg(capturingModel(captured), {
      systemPromptProvider: () => ({ standingContext: '# AGENT\nfocused email agent' }),
      retrieveMemory: async (query: string) => {
        seenQueries.push(query)
        return [{ id: 'm1', memory: 'User prefers terse Chinese' }]
      }
    })
    const h = await start(cfg)
    const res = await postChat(h.port, {
      sessionId: null,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is my tone preference' }] }
      ]
    })
    await res.text()
    expect(seenQueries).toEqual(['what is my tone preference']) // recall keyed on the raw user text
    expect(captured.system).toContain('UNTRUSTED_RECALLED_MEMORY_START')
    expect(captured.system).toContain('User prefers terse Chinese')
  })

  test('M2 — no retrieveMemory → no recalled block (flag-off byte-level)', async () => {
    const captured = { system: null as string | null }
    const cfg = baseCfg(capturingModel(captured), {
      systemPromptProvider: () => ({ standingContext: '# AGENT\nfocused' })
      // retrieveMemory omitted → MAILAGENT_MEM0_RETRIEVAL off
    })
    const h = await start(cfg)
    const res = await postChat(h.port, {
      sessionId: null,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    })
    await res.text()
    expect(captured.system).not.toContain('UNTRUSTED_RECALLED_MEMORY_START')
  })

  test('M2 — retrieveMemory returns null (recall failed / timeout) → context-light, turn unbroken', async () => {
    const captured = { system: null as string | null }
    const cfg = baseCfg(capturingModel(captured), {
      systemPromptProvider: () => ({ standingContext: '# AGENT\nfocused' }),
      retrieveMemory: async () => null // simulate failure / timeout degrade
    })
    const h = await start(cfg)
    const res = await postChat(h.port, {
      sessionId: null,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    })
    await res.text()
    expect(captured.system).not.toContain('UNTRUSTED_RECALLED_MEMORY_START')
    expect(captured.system).toContain('focused') // turn still ran with standing context
  })
})
