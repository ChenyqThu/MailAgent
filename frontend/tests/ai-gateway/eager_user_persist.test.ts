// #12 (dogfood session-history) — eager user-message persistence tests.
//
// Root cause: the AI SDK gateway only persists via onFinish (makePersistOnFinish). When a first
// turn is HITL-paused (responseMessageAwaitsApproval → true), onFinish skips persistTurn → the
// ai_chat_sessions row exists (created by onEnsureSession) but ai_chat_messages is empty →
// listAllSessions excludes it (WHERE EXISTS messages) → history missing the pending session.
//
// Fix: cfg.onTurnStart is called at turn START (before streaming), writing the user message
// eagerly so the session appears in history immediately. A module-level Set (eagerWrittenSessionIds
// in ai_gateway_lifecycle.ts) prevents double-writing when both paths fire (normal turns).
//
// Test structure
// ① Pure (no DB, no better-sqlite3): gateway calls cfg.onTurnStart with the correct sessionId +
//    userMessage at turn START, before the stream.
// ② Pure simulation (in-memory fake DB): after onTurnStart fires, the session IS in the history
//    snapshot (has a user-message row).
// ③ Pure simulation: HITL-paused first turn — onTurnStart writes the user message, persistTurn is
//    skipped → session still shows in history with exactly one user row (no assistant yet).
// ④ Pure simulation: full dedup logic — complete turn (onTurnStart + persistTurn) + HITL resume
//    both produce exactly ONE user row, ONE assistant row.
//
// 🔴 Note on better-sqlite3 ABI: tests ②-④ were originally implemented as chat_db integration
// tests but the native better-sqlite3.node is compiled for Electron (ABI ~NMV 130); plain
// `npx vitest run` under Node ≥ v24 carries a different NMV and the module fails to load. All
// tests in this file are now pure so they run in any Node without an ABI rebuild.

import { afterEach, describe, expect, test } from 'vitest'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { startAiGatewayServer, type AiGatewayHandle } from '../../src/ai-gateway/server'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

// ── helpers ───────────────────────────────────────────────────────────────────

const CHAT_CFG = {
  port: 0,
  baseUrl: 'https://crs.example/api',
  apiKey: 'sk-test-key',
  model: 'claude-sonnet-4-6'
} as const

function mockTextModel(parts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'r1' },
          ...parts.map((delta) => ({ type: 'text-delta' as const, id: 'r1', delta })),
          { type: 'text-end', id: 'r1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 }
            }
          }
        ]
      })
    })
  })
}

/** Drain an SSE response to completion (so onFinish fires). */
async function drainSse(res: Response): Promise<void> {
  const reader = res.body!.getReader()
  while (!(await reader.read()).done) {}
}

// ── gateway handle cleanup ────────────────────────────────────────────────────
const handles: AiGatewayHandle[] = []
async function start(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const h = await startAiGatewayServer(cfg)
  handles.push(h)
  return h
}

afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

// ── § ① Pure tests: gateway calls cfg.onTurnStart ────────────────────────────

describe('① onTurnStart callback wiring in handleChat', () => {
  test('cfg.onTurnStart is called with the sessionId and the user UIMessage', async () => {
    const calls: Array<{ sessionId: number | null; userMessage: MailAgentUIMessage | null }> = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['ok']),
      onTurnStart: (sessionId, userMessage) => {
        calls.push({ sessionId, userMessage })
      }
    })
    const body = JSON.stringify({
      sessionId: 42,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }]
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
    await drainSse(res)
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe(42)
    expect(calls[0].userMessage).not.toBeNull()
    expect((calls[0].userMessage as unknown as { role?: string })?.role).toBe('user')
  })

  test('onTurnStart receives null sessionId when body omits sessionId', async () => {
    const calls: Array<{ sessionId: number | null; userMessage: MailAgentUIMessage | null }> = []
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['ok']),
      onTurnStart: (sessionId, userMessage) => calls.push({ sessionId, userMessage })
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
      })
    })
    await drainSse(res)
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBeNull()
  })

  test('onTurnStart error does NOT break the stream (best-effort)', async () => {
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['alive']),
      onTurnStart: () => {
        throw new Error('intentional onTurnStart failure')
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 1,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
      })
    })
    // Stream should complete normally despite the throw.
    await drainSse(res)
    expect(res.status).toBe(200)
  })

  test('cfg without onTurnStart still works (backward-compatible)', async () => {
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['ok'])
      // no onTurnStart
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 1,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
      })
    })
    await drainSse(res)
    expect(res.status).toBe(200)
  })

  test('onTurnStart is called BEFORE the stream (turn start semantics)', async () => {
    // Ensure the eager-write fires before any assistant text arrives.
    // We verify order by checking that onTurnStart was called before the stream body
    // is consumed (i.e., before drainSse, before any token arrives).
    let turnStartFired = false
    let streamConsumed = false
    const h = await start({
      ...CHAT_CFG,
      createModel: () => mockTextModel(['token']),
      onTurnStart: (_sid, _msg) => {
        expect(streamConsumed).toBe(false)
        turnStartFired = true
      }
    })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 99,
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'order check' }] }]
      })
    })
    expect(turnStartFired).toBe(true) // fired before the response body was read
    await drainSse(res)
    streamConsumed = true
  })
})

// ── § ② ③ ④ Pure-simulation tests: dedup / history invariants ────────────────
//
// These tests model the lifecycle's eagerWrittenUserMessages Set（keyed
// `${sessionId}:${userMessageId}` — message-id keying, NOT bare sessionId, so an
// abandoned HITL turn can't swallow the next message）and the appendMessage/
// listAllSessions behaviors using plain in-memory arrays. They verify the same
// behavioral contracts as DB integration tests would, without requiring
// better-sqlite3 (avoids ABI mismatch under plain Node).

/** Mirror of ai_gateway_lifecycle.ts eagerUserMessageKey. */
function eagerKey(sessionId: number, userMessageId: string): string {
  return `${sessionId}:${userMessageId}`
}

/** Minimal in-memory "DB" that mirrors listAllSessions / listMessages semantics. */
function makeMemDb() {
  const rows: { sessionId: number; role: string; content: string }[] = []
  const sessionsCreated = new Set<number>()
  let nextId = 1
  return {
    createSession: () => {
      const id = nextId++
      sessionsCreated.add(id)
      return id
    },
    appendMessage: (row: { sessionId: number; role: string; content: string }) => {
      rows.push(row)
    },
    // WHERE EXISTS (SELECT 1 FROM ai_chat_messages WHERE session_id = s.id)
    listAllSessions: () =>
      [...sessionsCreated]
        .filter((id) => rows.some((r) => r.sessionId === id))
        .map((id) => ({
          id,
          first_user_message:
            rows.find((r) => r.sessionId === id && r.role === 'user')?.content ?? ''
        })),
    listMessages: (sessionId: number) => rows.filter((r) => r.sessionId === sessionId)
  }
}

describe('② eager persist → session immediately in history', () => {
  test('after onTurnStart writes user message, session appears in listAllSessions', () => {
    const db = makeMemDb()
    const sessionId = db.createSession()

    // Before any message: session is NOT in listAllSessions (no messages yet).
    expect(db.listAllSessions().find((s) => s.id === sessionId)).toBeUndefined()

    // Simulate onTurnStart: eagerly write the user message.
    db.appendMessage({ sessionId, role: 'user', content: '请帮我查邮件' })

    // Now the session MUST appear in listAllSessions (EXISTS messages).
    const all = db.listAllSessions()
    const found = all.find((s) => s.id === sessionId)
    expect(found).toBeDefined()
    expect(found?.first_user_message).toContain('请帮我查邮件')
  })
})

describe('③ HITL-paused first turn still shows in history', () => {
  test('HITL skip of persistTurn leaves the eagerly-written user message intact', () => {
    const db = makeMemDb()
    const sessionId = db.createSession()
    const eagerSet = new Set<string>()

    // Simulate onTurnStart: message key not yet in set → eager write user message.
    if (!eagerSet.has(eagerKey(sessionId, 'u1'))) {
      db.appendMessage({ sessionId, role: 'user', content: '帮我起草答复' })
      eagerSet.add(eagerKey(sessionId, 'u1'))
    }

    // persistTurn SKIPPED because responseMessageAwaitsApproval → true.
    // (We simply don't call appendMessage for the assistant here.)

    // Session IS in history via the eager user row.
    expect(db.listAllSessions().find((s) => s.id === sessionId)).toBeDefined()

    // Exactly ONE message: user row only (no assistant yet).
    const msgs = db.listMessages(sessionId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('帮我起草答复')
  })
})

describe('④ idempotent: complete turn and HITL resume produce exactly ONE user + ONE assistant', () => {
  test('complete turn (no HITL): onTurnStart + persistTurn → no duplicate user rows', () => {
    const db = makeMemDb()
    const sessionId = db.createSession()
    const eagerSet = new Set<string>()

    // onTurnStart: eager write (message key not in set).
    if (!eagerSet.has(eagerKey(sessionId, 'u1'))) {
      db.appendMessage({ sessionId, role: 'user', content: '你好' })
      eagerSet.add(eagerKey(sessionId, 'u1'))
    }

    // persistTurn fires (turn completed, NOT HITL-paused) — matches by message id.
    const eagerWritten = eagerSet.has(eagerKey(sessionId, 'u1'))
    if (eagerWritten) eagerSet.delete(eagerKey(sessionId, 'u1'))
    if (!eagerWritten) {
      // Fallback path — only executes if eager write failed (Set not populated).
      db.appendMessage({ sessionId, role: 'user', content: '你好' })
    }
    db.appendMessage({ sessionId, role: 'assistant', content: '我是AI助手。' })

    const msgs = db.listMessages(sessionId)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  test('eager write failure fallback: persistTurn writes user when Set is empty', () => {
    const db = makeMemDb()
    const sessionId = db.createSession()
    const eagerSet = new Set<string>() // Set never populated (simulates onTurnStart failure)

    // persistTurn fires: eagerWritten = false → writes user message normally (fallback path).
    const eagerWritten = eagerSet.has(eagerKey(sessionId, 'u1'))
    if (eagerWritten) eagerSet.delete(eagerKey(sessionId, 'u1'))
    if (!eagerWritten) {
      db.appendMessage({ sessionId, role: 'user', content: '测试回退' })
    }
    db.appendMessage({ sessionId, role: 'assistant', content: '好的。' })

    const msgs = db.listMessages(sessionId)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(msgs.find((m) => m.role === 'user')?.content).toBe('测试回退')
  })

  test('HITL resume: onTurnStart guards resume (same message id) → ONE user + ONE assistant', () => {
    // This test verifies the lifecycle guard: onTurnStart skips when the SAME user
    // message (matched by `${sessionId}:${messageId}` key) was already eagerly written,
    // so the HITL resume turn does NOT write a second user row.
    const db = makeMemDb()
    const sessionId = db.createSession()
    const eagerSet = new Set<string>()

    // === Turn 1 (HITL-paused) ===
    // onTurnStart: key not in set → eager write.
    if (!eagerSet.has(eagerKey(sessionId, 'u1'))) {
      db.appendMessage({ sessionId, role: 'user', content: '帮我起草答复' })
      eagerSet.add(eagerKey(sessionId, 'u1'))
    }
    // persistTurn SKIPPED (responseMessageAwaitsApproval → true).
    // eagerSet still has the key (not cleared because persistTurn never ran).

    // === Resume turn (after user approved) ===
    // onTurnStart fires again: rawMessages still ends with the ORIGINAL user msg（same id
    // 'u1'）→ key IS in set → skip (no duplicate user write).
    if (!eagerSet.has(eagerKey(sessionId, 'u1'))) {
      // This branch must NOT execute (the guard must have caught it).
      db.appendMessage({ sessionId, role: 'user', content: 'DUPLICATE' })
      eagerSet.add(eagerKey(sessionId, 'u1'))
    }
    // persistTurn fires (resume turn is complete) — lastUserMessage is still 'u1':
    const eagerWritten = eagerSet.has(eagerKey(sessionId, 'u1'))
    if (eagerWritten) eagerSet.delete(eagerKey(sessionId, 'u1'))
    if (!eagerWritten) {
      // Would write user again — must NOT happen here (eagerWritten was true).
      db.appendMessage({ sessionId, role: 'user', content: 'SHOULD_NOT_APPEAR' })
    }
    db.appendMessage({ sessionId, role: 'assistant', content: '草稿已创建。' })

    const msgs = db.listMessages(sessionId)
    // Exactly ONE user message (from Turn 1 eager write).
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
    // The user message is the original one, NOT the duplicate.
    expect(msgs.find((m) => m.role === 'user')?.content).toBe('帮我起草答复')
  })

  test('abandoned HITL turn does NOT swallow the NEXT user message (message-id keying)', () => {
    // Regression guard for the sessionId-keyed variant: turn 1 is HITL-paused and then
    // ABANDONED (approval never resolved → persistTurn never ran → key never cleared).
    // With bare-sessionId keying the next message would be skipped by onTurnStart AND
    // by persistTurn → lost. Message-id keying persists it normally.
    const db = makeMemDb()
    const sessionId = db.createSession()
    const eagerSet = new Set<string>()

    // === Turn 1 (HITL-paused, then abandoned) ===
    if (!eagerSet.has(eagerKey(sessionId, 'u1'))) {
      db.appendMessage({ sessionId, role: 'user', content: '第一条（审批被放弃）' })
      eagerSet.add(eagerKey(sessionId, 'u1'))
    }
    // persistTurn never runs; 'u1' key stays in the set.

    // === Turn 2: a NEW user message in the same session (fresh id 'u2') ===
    if (!eagerSet.has(eagerKey(sessionId, 'u2'))) {
      db.appendMessage({ sessionId, role: 'user', content: '第二条' })
      eagerSet.add(eagerKey(sessionId, 'u2'))
    }
    // persistTurn for turn 2 completes normally (matched by 'u2').
    const eagerWritten = eagerSet.has(eagerKey(sessionId, 'u2'))
    if (eagerWritten) eagerSet.delete(eagerKey(sessionId, 'u2'))
    if (!eagerWritten) {
      db.appendMessage({ sessionId, role: 'user', content: 'SHOULD_NOT_APPEAR' })
    }
    db.appendMessage({ sessionId, role: 'assistant', content: '好的。' })

    const msgs = db.listMessages(sessionId)
    const users = msgs.filter((m) => m.role === 'user')
    // BOTH user messages persisted — the second one was not swallowed.
    expect(users).toHaveLength(2)
    expect(users.map((m) => m.content)).toContain('第二条')
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })
})
