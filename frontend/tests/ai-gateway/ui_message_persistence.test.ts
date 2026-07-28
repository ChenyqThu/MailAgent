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

  // dogfood 07-27 Lane D — 粘贴的图片以 FileUIPart 进 user 消息，落库走的是
  // ai_gateway_lifecycle 的 `uiMessageJson: JSON.stringify(userMessage)`（onTurnStart eager 写 +
  // persistTurn 兜底，两处同一份整条消息）。渲染端能显示图的前提是这条链**一个 part 都不丢** ——
  // `content` 那列是 extractTextFromUIMessage 的纯文本投影，图只活在 ui_message_json 里，
  // 谁要是为了瘦身把 file part 从 canonical JSON 里剔掉（data URL 可达 3M 字符，是个真诱惑），
  // 历史里的图就会在重启后集体消失，且 content 一列看不出任何异常。这条用例就是那道闸。
  test('user 行的图片 file part 原样 round-trip（content 只投影文本，图活在 canonical JSON）', () => {
    const session = getOrCreateSession({ emailId: 4, backendKind: 'custom-api' })
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const user = {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: '这张图里写了什么' },
        { type: 'file', url: dataUrl, mediaType: 'image/png', filename: 'screenshot.png' }
      ]
    } as unknown as MailAgentUIMessage
    appendMessage({
      sessionId: session.id,
      role: 'user',
      content: extractTextFromUIMessage(user),
      status: 'complete',
      uiMessageJson: JSON.stringify(user)
    })

    const [row] = listMessages(session.id)
    // legacy 投影只有文本 —— 图不在这里，所以它不能是唯一的真相源
    expect(row.content).toBe('这张图里写了什么')
    // 🔴 重载回来的 UIMessage 里，file part 逐字节还在（渲染端据此画 <img>）
    const reloaded = chatMessageToUIMessage(row)
    const file = reloaded.parts.find((p) => p.type === 'file') as
      | { type: 'file'; url: string; mediaType: string; filename?: string }
      | undefined
    expect(file).toBeTruthy()
    expect(file!.url).toBe(dataUrl)
    expect(file!.mediaType).toBe('image/png')
    expect(file!.filename).toBe('screenshot.png')
    // 文本 part 并列还在（图不取代文本）
    expect(extractTextFromUIMessage(reloaded)).toBe('这张图里写了什么')
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
