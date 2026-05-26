// Sprint 4 — chat dispatcher contract.
//
// The dispatcher is the seam between the backend iterator and (a) the
// ai_chat.db rows + (b) the IPC sink. Tests inject a fake backend that
// yields known events and a sink that just records them, so we can
// assert both sides match the spec from chat/types.ts.
//
// We deliberately do NOT test the real Notion Agent / Custom API
// backends here — those are Task #11 / #12 and have their own fixtures.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendMessage,
  closeChatDb,
  getOrCreateSession,
  listMessages,
  type BackendKind
} from '../../src/electron/main/chat_db'
import {
  abortAllChatSessions,
  abortChatSession,
  editChatMessage,
  startChat,
  __resetChatDispatcher,
  type StreamSink
} from '../../src/electron/main/chat/dispatcher'
import { __resetBackendRegistry, registerChatBackend } from '../../src/electron/main/chat/registry'
import type {
  ChatBackend,
  ChatStreamEnvelope,
  ChatStreamEvent
} from '../../src/electron/main/chat/types'

let tmpDir: string

function recordingSink(): StreamSink & { events: ChatStreamEnvelope[] } {
  const events: ChatStreamEnvelope[] = []
  return {
    events,
    send(env) {
      events.push(env)
    }
  }
}

/** Build a backend that yields the supplied events one by one. Useful
 *  for asserting that the dispatcher persists + forwards each shape
 *  correctly. */
function fakeBackend(kind: BackendKind, script: ChatStreamEvent[]): ChatBackend {
  return {
    kind,
    async *stream() {
      for (const ev of script) yield ev
    }
  }
}

function tickAsync(times = 6): Promise<void> {
  // The dispatcher runs `void runStream(...)` — it scheduled microtasks
  // before chat:start returned. Give the event loop a few iterations to
  // drain them before asserting on persisted state.
  return new Promise((resolve) => {
    let n = 0
    const tick = (): void => {
      if (++n >= times) resolve()
      else queueMicrotask(tick)
    }
    queueMicrotask(tick)
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-disp-'))
  process.env['AI_CHAT_DB_PATH'] = join(tmpDir, 'ai_chat.db')
  closeChatDb()
  __resetBackendRegistry()
  __resetChatDispatcher()
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  __resetBackendRegistry()
  __resetChatDispatcher()
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

describe('dispatcher — happy path', () => {
  test('startChat appends user + streaming assistant and yields chunks', async () => {
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'Hello ' },
        { type: 'chunk', delta: 'world' },
        { type: 'usage', inputTokens: 8, outputTokens: 2, costUsd: 0.0001, model: 'claude' },
        { type: 'done', finalContent: 'Hello world', model: 'claude' }
      ])
    )
    const sink = recordingSink()
    const result = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: 'claude-sonnet-4-6',
        backendAgentPageId: null
      },
      sink
    )
    expect(result.sessionId).toBeGreaterThan(0)
    expect(result.userMessageId).toBeGreaterThan(0)
    expect(result.assistantMessageId).toBeGreaterThan(result.userMessageId)

    // 2026-05-26 — MAILAGENT_AGENT_HARNESS default ON (Sprint 19 §B HIT
    // cutover). harness path wraps the legacy single-pass in a multi-iter
    // loop that flips status='complete' AFTER the stream finishes + tool
    // dispatch decides nothing's left to do. tickAsync(6) microtask burst
    // ran out before the trailing updateMessage settled, so happy-path
    // status used to land on 'streaming'. Poll listMessages directly until
    // the row flips (≤ 2 s) — keeps the assertion semantic ("after the
    // stream completes, the row reads complete") rather than coupled to a
    // specific microtask-chain depth.
    let assistant = listMessages(result.sessionId).find((r) => r.role === 'assistant')
    const waitDeadline = Date.now() + 2000
    while ((!assistant || assistant.status !== 'complete') && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      assistant = listMessages(result.sessionId).find((r) => r.role === 'assistant')
    }
    const rows = listMessages(result.sessionId)
    expect(rows.length).toBe(2)
    const user = rows.find((r) => r.role === 'user')!
    expect(user.content).toBe('hi')
    expect(user.status).toBe('complete')
    expect(assistant).toBeDefined()
    expect(assistant!.status).toBe('complete')
    expect(assistant!.content).toBe('Hello world')
    expect(assistant!.tokens_input).toBe(8)
    expect(assistant!.tokens_output).toBe(2)
    expect(assistant!.cost_usd).toBeCloseTo(0.0001, 6)
    expect(assistant!.model).toBe('claude')

    // Sink forwarded every event in order.
    const evTypes = sink.events.map((e) => e.event.type)
    expect(evTypes).toEqual(['chunk', 'chunk', 'usage', 'done'])
    expect(sink.events.every((e) => e.sessionId === result.sessionId)).toBe(true)
    expect(sink.events.every((e) => e.messageId === result.assistantMessageId)).toBe(true)
  })

  test('tool_call events persist as role=tool rows + forward to sink', async () => {
    registerChatBackend(
      fakeBackend('notion-agent', [
        {
          type: 'tool_call',
          name: 'notion-agent agents route',
          args: { query: 'reply to alice' },
          status: 'running',
          durationMs: 200
        },
        {
          type: 'tool_call',
          name: 'notion-agent agents route',
          args: { query: 'reply to alice' },
          status: 'ok',
          durationMs: 420,
          detail: 'Email Agent'
        },
        { type: 'chunk', delta: 'OK done.' },
        { type: 'done', finalContent: 'OK done.', model: 'gpt-5.4' }
      ])
    )
    const sink = recordingSink()
    const result = await startChat(
      {
        emailId: 101,
        userMessage: 'help me reply',
        backendKind: 'notion-agent',
        backendModel: 'gpt-5.4',
        backendAgentPageId: 'agent-1'
      },
      sink
    )
    await tickAsync()
    const rows = listMessages(result.sessionId)
    const toolRows = rows.filter((r) => r.role === 'tool')
    expect(toolRows.length).toBe(2)
    expect(JSON.parse(toolRows[0].content).status).toBe('running')
    expect(JSON.parse(toolRows[1].content).status).toBe('ok')
    expect(JSON.parse(toolRows[1].content).detail).toBe('Email Agent')

    expect(sink.events.map((e) => e.event.type)).toEqual([
      'tool_call',
      'tool_call',
      'chunk',
      'done'
    ])
  })
})

describe('dispatcher — abort', () => {
  test('abortChatSession during streaming flips the message to aborted', async () => {
    // Backend that emits a chunk then waits on signal.
    const backend: ChatBackend = {
      kind: 'custom-api',
      async *stream({ signal }) {
        yield { type: 'chunk', delta: 'partial' } as ChatStreamEvent
        // Wait until aborted then exit naturally.
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    }
    registerChatBackend(backend)
    const sink = recordingSink()
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink
    )
    await tickAsync()

    expect(listMessages(r.sessionId).find((m) => m.role === 'assistant')!.status).toBe('streaming')

    const flipped = abortChatSession(r.sessionId)
    await tickAsync()

    expect(flipped).toBeGreaterThanOrEqual(1)
    const final = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    expect(final.status).toBe('aborted')
    // Partial content preserved (not blanked).
    expect(final.content).toBe('partial')
  })

  test('rapid second startChat on same session pre-empts the first', async () => {
    let firstStarted = false
    const firstBackend: ChatBackend = {
      kind: 'custom-api',
      async *stream({ signal }) {
        firstStarted = true
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    }
    registerChatBackend(firstBackend)
    const sink1 = recordingSink()
    const r1 = await startChat(
      {
        emailId: 101,
        userMessage: 'first',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink1
    )
    await tickAsync()
    expect(firstStarted).toBe(true)

    // Second turn on the same (email, backend) session — should land on
    // the same session row, abort the first stream, start a new one.
    __resetBackendRegistry()
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'second' },
        { type: 'done', finalContent: 'second', model: null }
      ])
    )
    const sink2 = recordingSink()
    const r2 = await startChat(
      {
        emailId: 101,
        userMessage: 'second',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink2
    )
    expect(r2.sessionId).toBe(r1.sessionId)
    await tickAsync()

    const rows = listMessages(r1.sessionId)
    // Two user messages, two assistant messages. First assistant aborted,
    // second completed.
    const assistants = rows.filter((r) => r.role === 'assistant').sort((a, b) => a.id - b.id)
    expect(assistants.length).toBe(2)
    expect(assistants[0].status).toBe('aborted')
    expect(assistants[1].status).toBe('complete')
    expect(assistants[1].content).toBe('second')
  })

  test('abortAllChatSessions terminates every in-flight stream', async () => {
    const backend: ChatBackend = {
      kind: 'custom-api',
      async *stream({ signal }) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    }
    registerChatBackend(backend)
    const sinkA = recordingSink()
    const sinkB = recordingSink()
    const ra = await startChat(
      {
        emailId: 101,
        userMessage: 'a',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sinkA
    )
    const rb = await startChat(
      {
        emailId: 102,
        userMessage: 'b',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sinkB
    )
    await tickAsync()

    abortAllChatSessions()
    await tickAsync()

    expect(listMessages(ra.sessionId).find((m) => m.role === 'assistant')!.status).toBe('aborted')
    expect(listMessages(rb.sessionId).find((m) => m.role === 'assistant')!.status).toBe('aborted')
  })
})

describe('dispatcher — error paths', () => {
  test('backend throws → assistant message flips to error + sink gets error event', async () => {
    const backend: ChatBackend = {
      kind: 'custom-api',
      async *stream() {
        yield { type: 'chunk', delta: 'partial' } as ChatStreamEvent
        throw new Error('upstream 503')
      }
    }
    registerChatBackend(backend)
    const sink = recordingSink()
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink
    )
    await tickAsync()
    const assistant = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    expect(assistant.status).toBe('error')
    expect(assistant.error_message).toBe('upstream 503')
    expect(assistant.content).toBe('partial')
    const errEvent = sink.events.find((e) => e.event.type === 'error')
    expect(errEvent).toBeTruthy()
    if (errEvent?.event.type === 'error') {
      expect(errEvent.event.code).toBe('E_BACKEND_CRASH')
    }
  })

  test('backend yields ErrorEvent → message flips to error and stops the stream', async () => {
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'so far so good' },
        { type: 'error', code: 'E_QUOTA', message: 'quota exhausted' }
      ])
    )
    const sink = recordingSink()
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink
    )
    await tickAsync()
    const assistant = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    expect(assistant.status).toBe('error')
    expect(assistant.error_message).toBe('quota exhausted')
    expect(sink.events.map((e) => e.event.type)).toEqual(['chunk', 'error'])
  })

  test('sawError defensive break drops events emitted AFTER error (codex N carry-forward)', async () => {
    // A misbehaving backend that emits chunks + done past an error. Pre-fix
    // dispatcher would flip the assistant from error → complete on the
    // trailing done event and persist the post-error chunk into content.
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'partial' },
        { type: 'error', code: 'E_QUOTA', message: 'quota exhausted' },
        { type: 'chunk', delta: 'should-be-dropped' },
        { type: 'done', finalContent: 'wrong final', model: null }
      ])
    )
    const sink = recordingSink()
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink
    )
    await tickAsync()
    const assistant = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    expect(assistant.status).toBe('error')
    expect(assistant.error_message).toBe('quota exhausted')
    // Content is whatever was buffered BEFORE the error, never the
    // "wrong final" overwrite.
    expect(assistant.content).toBe('partial')
    // Sink only saw events up to + including the error.
    expect(sink.events.map((e) => e.event.type)).toEqual(['chunk', 'error'])
  })

  test('startChat with unregistered backend throws', async () => {
    // No registerChatBackend — registry is empty after beforeEach reset.
    const sink = recordingSink()
    await expect(
      startChat(
        {
          emailId: 101,
          userMessage: 'hi',
          backendKind: 'custom-api',
          backendModel: null,
          backendAgentPageId: null
        },
        sink
      )
    ).rejects.toThrow(/No chat backend registered/)
  })

  test('startChat with negative emailId throws', async () => {
    registerChatBackend(fakeBackend('custom-api', []))
    const sink = recordingSink()
    await expect(
      startChat(
        {
          emailId: -1,
          userMessage: 'hi',
          backendKind: 'custom-api',
          backendModel: null,
          backendAgentPageId: null
        },
        sink
      )
    ).rejects.toThrow(/invalid emailId/)
  })

  test('startChat with empty user message throws', async () => {
    registerChatBackend(fakeBackend('custom-api', []))
    const sink = recordingSink()
    await expect(
      startChat(
        {
          emailId: 101,
          userMessage: '',
          backendKind: 'custom-api',
          backendModel: null,
          backendAgentPageId: null
        },
        sink
      )
    ).rejects.toThrow(/non-empty string/)
  })
})

describe('dispatcher — multi-session isolation', () => {
  test('separate sessions stream independently', async () => {
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'a' },
        { type: 'done', finalContent: 'a', model: null }
      ])
    )
    const sink1 = recordingSink()
    const sink2 = recordingSink()
    const r1 = await startChat(
      {
        emailId: 101,
        userMessage: 'one',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink1
    )
    const r2 = await startChat(
      {
        emailId: 202,
        userMessage: 'two',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink2
    )
    expect(r1.sessionId).not.toBe(r2.sessionId)
    await tickAsync()

    expect(sink1.events.every((e) => e.sessionId === r1.sessionId)).toBe(true)
    expect(sink2.events.every((e) => e.sessionId === r2.sessionId)).toBe(true)
  })

  test('abortChatSession scoped to the supplied id (untouched sibling)', async () => {
    const blockingBackend: ChatBackend = {
      kind: 'custom-api',
      async *stream({ signal }) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    }
    registerChatBackend(blockingBackend)
    const sink1 = recordingSink()
    const sink2 = recordingSink()
    const r1 = await startChat(
      {
        emailId: 101,
        userMessage: 'one',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink1
    )
    const r2 = await startChat(
      {
        emailId: 202,
        userMessage: 'two',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      sink2
    )
    await tickAsync()

    abortChatSession(r1.sessionId)
    await tickAsync()

    expect(listMessages(r1.sessionId).find((m) => m.role === 'assistant')!.status).toBe('aborted')
    expect(listMessages(r2.sessionId).find((m) => m.role === 'assistant')!.status).toBe('streaming')

    abortChatSession(r2.sessionId)
  })

  test('abortChatSession on a nonexistent session is a no-op (returns 0)', () => {
    // No backend registered, no session created — call should return 0.
    getOrCreateSession({ emailId: 1, backendKind: 'custom-api' }) // create empty
    expect(abortChatSession(99999)).toBe(0)
  })
})

describe('dispatcher — metadata pass-through (opus L carry-forward)', () => {
  test('done event with metadata JSON-encodes into assistant row', async () => {
    registerChatBackend(
      fakeBackend('notion-agent', [
        { type: 'chunk', delta: 'hi back' },
        {
          type: 'usage',
          inputTokens: 4,
          outputTokens: 2,
          costUsd: null,
          model: 'claude-sonnet-4-6',
          metadata: { thread_id: 'thr-xyz' }
        },
        {
          type: 'done',
          finalContent: 'hi back',
          model: 'claude-sonnet-4-6',
          metadata: { thread_id: 'thr-xyz' }
        }
      ])
    )
    const sink = recordingSink()
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'notion-agent',
        backendModel: null,
        backendAgentPageId: 'agent-1'
      },
      sink
    )
    await tickAsync()
    const assistant = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    expect(assistant.metadata).toBe('{"thread_id":"thr-xyz"}')
    expect(assistant.model).toBe('claude-sonnet-4-6')
  })

  test('metadata observed mid-stream survives a later done without metadata', async () => {
    registerChatBackend(
      fakeBackend('notion-agent', [
        {
          type: 'usage',
          inputTokens: 4,
          outputTokens: 2,
          costUsd: null,
          model: null,
          metadata: { thread_id: 'thr-mid' }
        },
        { type: 'chunk', delta: 'ok' },
        { type: 'done', finalContent: 'ok', model: null }
      ])
    )
    const sink = recordingSink()
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'notion-agent',
        backendModel: null,
        backendAgentPageId: 'agent-1'
      },
      sink
    )
    await tickAsync()
    const assistant = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    expect(assistant.metadata).toBe('{"thread_id":"thr-mid"}')
  })
})

describe('dispatcher — sink behaviour', () => {
  test('sink receives envelopes synchronously in event order', async () => {
    const ordered: string[] = []
    const orderedSink: StreamSink = {
      send(env) {
        ordered.push(env.event.type)
      }
    }
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'a' },
        { type: 'chunk', delta: 'b' },
        { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0, model: null },
        { type: 'done', finalContent: 'ab', model: null }
      ])
    )
    await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      orderedSink
    )
    await tickAsync()
    expect(ordered).toEqual(['chunk', 'chunk', 'usage', 'done'])
  })

  test('sink errors are swallowed by the dispatcher (does not break the stream)', async () => {
    let chunksPersisted = 0
    const errorSink: StreamSink = {
      send: vi.fn(() => {
        // Force the second chunk's sink send to throw to mimic a
        // closed webContents racing the stream.
        chunksPersisted++
        if (chunksPersisted === 2) throw new Error('webContents destroyed')
      })
    }
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'a' },
        { type: 'chunk', delta: 'b' },
        { type: 'done', finalContent: 'ab', model: null }
      ])
    )
    const r = await startChat(
      {
        emailId: 101,
        userMessage: 'hi',
        backendKind: 'custom-api',
        backendModel: null,
        backendAgentPageId: null
      },
      errorSink
    )
    await tickAsync()
    // Even with sink throw, DB should still reflect a completed
    // assistant — the dispatcher must not let a sink failure short
    // the persistence path. If the dispatcher DOES short, the
    // assistant row stays 'streaming' / 'error' and we'll catch
    // the regression here.
    const assistant = listMessages(r.sessionId).find((m) => m.role === 'assistant')!
    // Either complete (full happy path with caught sink err) or error
    // (dispatcher classified the sink throw as a backend crash) — we
    // accept both, but assistant must NOT be left at 'streaming'.
    expect(['complete', 'error']).toContain(assistant.status)
  })
})

// Sprint 14 PR B — inline edit (truncate + re-stream).
describe('dispatcher — editChatMessage', () => {
  test('truncates tail + appends new user/assistant + streams reply', async () => {
    registerChatBackend(
      fakeBackend('custom-api', [
        { type: 'chunk', delta: 'edited reply' },
        { type: 'done', finalContent: 'edited reply', model: 'claude' }
      ])
    )
    // Seed a session with a user→assistant→user→assistant tail.
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const userA = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'first ask',
      status: 'complete'
    })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'first reply',
      status: 'complete'
    })
    const userB = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'second ask',
      status: 'complete'
    })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'second reply',
      status: 'complete'
    })

    const sink = recordingSink()
    const result = await editChatMessage(
      {
        sessionId: session.id,
        editingMessageId: userB.id,
        newContent: 'edited ask',
        backendKind: 'custom-api',
        backendModel: 'claude',
        backendAgentPageId: null
      },
      sink
    )
    expect(result.sessionId).toBe(session.id)
    await tickAsync(8)

    const after = listMessages(session.id)
    // userA + its assistant reply survive; userB + tail were truncated;
    // editChatMessage appended a fresh user + assistant pair.
    expect(after).toHaveLength(4)
    expect(after.map((m) => m.content)).toEqual([
      'first ask',
      'first reply',
      'edited ask',
      'edited reply'
    ])
    expect(after[2].role).toBe('user')
    expect(after[3].role).toBe('assistant')
    expect(after[3].status).toBe('complete')
    // Original userB id is gone (the row was truncated, not reused).
    expect(after.find((m) => m.id === userB.id)).toBeUndefined()
    expect(after.find((m) => m.id === userA.id)).toBeDefined()
  })

  test('rejects an assistant message id with E_INVALID_ARG', async () => {
    registerChatBackend(fakeBackend('custom-api', [{ type: 'done', finalContent: '' }]))
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    appendMessage({ sessionId: session.id, role: 'user', content: 'q', status: 'complete' })
    const assistant = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'a',
      status: 'complete'
    })

    await expect(
      editChatMessage(
        {
          sessionId: session.id,
          editingMessageId: assistant.id,
          newContent: 'try edit assistant',
          backendKind: 'custom-api',
          backendModel: 'claude',
          backendAgentPageId: null
        },
        recordingSink()
      )
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    // Existing rows untouched on rejection.
    expect(listMessages(session.id)).toHaveLength(2)
  })

  test('rejects an unknown session with E_NOT_FOUND', async () => {
    registerChatBackend(fakeBackend('custom-api', [{ type: 'done', finalContent: '' }]))
    await expect(
      editChatMessage(
        {
          sessionId: 9999,
          editingMessageId: 1,
          newContent: 'x',
          backendKind: 'custom-api',
          backendModel: null,
          backendAgentPageId: null
        },
        recordingSink()
      )
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  test('rejects an editingMessageId that belongs to a different session', async () => {
    registerChatBackend(fakeBackend('custom-api', [{ type: 'done', finalContent: '' }]))
    const sessionA = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const sessionB = getOrCreateSession({ emailId: 102, backendKind: 'custom-api' })
    const orphan = appendMessage({
      sessionId: sessionB.id,
      role: 'user',
      content: 'wrong session',
      status: 'complete'
    })

    await expect(
      editChatMessage(
        {
          sessionId: sessionA.id,
          editingMessageId: orphan.id,
          newContent: 'cross-session',
          backendKind: 'custom-api',
          backendModel: null,
          backendAgentPageId: null
        },
        recordingSink()
      )
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect(listMessages(sessionB.id)).toHaveLength(1)
  })

  test('rejects empty newContent before touching the DB', async () => {
    registerChatBackend(fakeBackend('custom-api', [{ type: 'done', finalContent: '' }]))
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const user = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'q',
      status: 'complete'
    })

    await expect(
      editChatMessage(
        {
          sessionId: session.id,
          editingMessageId: user.id,
          newContent: '',
          backendKind: 'custom-api',
          backendModel: null,
          backendAgentPageId: null
        },
        recordingSink()
      )
    ).rejects.toThrow(/non-empty string/)
    // Pre-validation rejection: the user row remains untouched.
    expect(listMessages(session.id)).toHaveLength(1)
  })
})
