import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToModelMessages, type UIMessage } from 'ai'
import { AssistantChatTransport } from '@assistant-ui/react-ai-sdk'

import { appendMessage, closeChatDb, createNewSession, listMessages } from '../../src/electron/main/chat_db'
import { chatMessageToUIMessage } from '../../src/shared/assistant/uiMessage'
import {
  appendCompactSummaryToSystem,
  selectMessagesForModelContext,
  type CompactMessageMetadata
} from '../../src/ai-gateway/compactSelect'

const { appMock } = vi.hoisted(() => ({
  appMock: { isPackaged: false, getPath: (_key: string) => '/tmp' }
}))
vi.mock('electron', () => ({ app: appMock }))

let tmpDir: string

function compactMessage(id = 'compact-1'): UIMessage {
  const metadata: CompactMessageMetadata = {
    kind: 'compact',
    version: 1,
    compactedThroughMessageId: 10,
    firstKeptMessageId: 11,
    tokensBefore: 90_000,
    estimatedTokensAfter: 20_000,
    model: 'test-model',
    reason: 'manual',
    valid: true,
    createdAt: 1_786_147_200_000
  }
  return {
    id,
    role: 'system',
    metadata,
    parts: [
      { type: 'text', text: '## User goal\nKeep the critical facts.' },
      { type: 'data-compact', data: { metadata } }
    ]
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'compact-spike-'))
  process.env['AI_CHAT_DB_PATH'] = join(tmpDir, 'ai_chat.db')
  closeChatDb()
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

describe('manual compact spike', () => {
  test('S1: system row metadata and canonical UIMessage round-trip verbatim', () => {
    const session = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    const uiMessage = compactMessage()
    const metadata = uiMessage.metadata as CompactMessageMetadata
    appendMessage({
      sessionId: session.id,
      role: 'system',
      content: '## User goal\nKeep the critical facts.',
      status: 'complete',
      metadata: JSON.stringify(metadata),
      uiMessageJson: JSON.stringify(uiMessage)
    })

    const [row] = listMessages(session.id)
    expect(JSON.parse(row.metadata ?? '{}')).toEqual(metadata)
    expect(chatMessageToUIMessage(row)).toEqual({ ...uiMessage, id: String(row.id) })
    expect(chatMessageToUIMessage(row).role).toBe('system')
  })

  test('S2: AssistantChatTransport preserves metadata and custom parts in body.messages', async () => {
    let capturedBody: unknown
    const transport = new AssistantChatTransport({
      api: 'http://example.invalid/api/ai/chat',
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body))
        return new Response('data: {"type":"finish"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
      }
    })
    await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'spike',
      messageId: undefined,
      messages: [compactMessage()],
      abortSignal: undefined
    })

    expect(capturedBody).toMatchObject({ messages: [compactMessage()] })
  })

  test('S3: marker removal converts normally and summary stays fenced in system', async () => {
    const raw: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'old' }] },
      compactMessage(),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'new' }] }
    ]
    const selected = selectMessagesForModelContext(raw)
    const modelMessages = await convertToModelMessages(selected.messages)
    expect(modelMessages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'new' }] }])
    expect(appendCompactSummaryToSystem('SYSTEM', selected.summary)).toContain(
      '<UNTRUSTED_COMPACT_SUMMARY>'
    )
  })
})
