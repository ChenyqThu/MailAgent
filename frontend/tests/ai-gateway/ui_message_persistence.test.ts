// chat-panel P4 Phase 02 — UIMessage persistence v1 round-trip (write → reload).
//
// Exercises the dual-write that the embedded Gateway performs in onFinish: a turn
// is appended with both the canonical AI SDK UIMessage JSON (ui_message_json) and
// the extracted legacy text (content), then reloaded back into a UIMessage. chat_db
// is better-sqlite3 (main-only) so we mock electron + point AI_CHAT_DB_PATH at a tmp
// file, exactly like tests/main/chat_db.test.ts.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { appMock } = vi.hoisted(() => ({
  appMock: { isPackaged: false, getPath: (_k: string) => '/tmp' }
}))
vi.mock('electron', () => ({ app: appMock }))

import {
  appendMessage,
  closeChatDb,
  getOrCreateSession,
  listMessages
} from '../../src/electron/main/chat_db'
import {
  chatMessageToUIMessage,
  extractTextFromUIMessage,
  parseUiMessageJson,
  type MailAgentUIMessage
} from '../../src/shared/assistant/uiMessage'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-gw-persist-'))
  process.env['AI_CHAT_DB_PATH'] = join(tmpDir, 'ai_chat.db')
  closeChatDb()
})
afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

/** Mimic the Gateway wrapper's persistTurn dual-write for one assistant turn. */
function persistAssistant(sessionId: number, ui: MailAgentUIMessage): void {
  appendMessage({
    sessionId,
    role: 'assistant',
    content: extractTextFromUIMessage(ui),
    status: 'complete',
    model: 'claude-sonnet-4-6',
    tokensInput: 5,
    tokensOutput: 7,
    uiMessageJson: JSON.stringify(ui)
  })
}

describe('UIMessage persistence — dual-write + reload', () => {
  test('write ui_message_json + content, reload round-trips losslessly', () => {
    const session = getOrCreateSession({ emailId: 1, backendKind: 'custom-api' })
    const asst: MailAgentUIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hi there' }],
      metadata: { model: 'claude-sonnet-4-6', tokensInput: 5, tokensOutput: 7 }
    }
    persistAssistant(session.id, asst)

    const [row] = listMessages(session.id)
    // legacy projection.
    expect(row.content).toBe('Hi there')
    // canonical column present.
    expect(row.ui_message_json).not.toBeNull()
    expect(parseUiMessageJson(row.ui_message_json)?.parts[0]).toMatchObject({
      type: 'text',
      text: 'Hi there'
    })
    // reload: canonical is the SSoT, with the stable row id re-stamped.
    const reloaded = chatMessageToUIMessage(row)
    expect(reloaded.role).toBe('assistant')
    expect(extractTextFromUIMessage(reloaded)).toBe('Hi there')
    expect(reloaded.id).toBe(String(row.id))
    expect(reloaded.metadata?.model).toBe('claude-sonnet-4-6')
  })

  test('legacy row (null ui_message_json) synthesizes a UIMessage from content', () => {
    const session = getOrCreateSession({ emailId: 2, backendKind: 'custom-api' })
    // a legacy-runtime write — no uiMessageJson.
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'plain legacy reply',
      status: 'complete'
    })
    const [row] = listMessages(session.id)
    expect(row.ui_message_json).toBeNull()
    const ui = chatMessageToUIMessage(row)
    expect(ui.role).toBe('assistant')
    expect(extractTextFromUIMessage(ui)).toBe('plain legacy reply')
    expect(ui.id).toBe(String(row.id))
  })

  test('legacy thinking row reloads as a reasoning + text UIMessage', () => {
    const session = getOrCreateSession({ emailId: 3, backendKind: 'custom-api' })
    const row = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'final answer',
      status: 'complete'
    })
    // simulate a finalized thinking turn (legacy column).
    const withThinking = { ...row, thinking: 'let me think...' }
    const ui = chatMessageToUIMessage(withThinking)
    expect(ui.parts.some((p) => p.type === 'reasoning')).toBe(true)
    expect(extractTextFromUIMessage(ui)).toBe('final answer')
  })
})

describe('UIMessage mapper — pure helpers', () => {
  test('extractTextFromUIMessage concatenates text parts, ignores non-text', () => {
    const ui = {
      id: 'x',
      role: 'assistant' as const,
      parts: [
        { type: 'reasoning' as const, text: 'thinking' },
        { type: 'text' as const, text: 'one ' },
        { type: 'text' as const, text: 'two' }
      ]
    }
    expect(extractTextFromUIMessage(ui)).toBe('one two')
  })

  test('parseUiMessageJson returns null on malformed / non-message JSON', () => {
    expect(parseUiMessageJson(null)).toBeNull()
    expect(parseUiMessageJson('not json')).toBeNull()
    expect(parseUiMessageJson('{"role":"assistant"}')).toBeNull() // no parts[]
    expect(parseUiMessageJson('{"role":"assistant","parts":[]}')).not.toBeNull()
  })
})
