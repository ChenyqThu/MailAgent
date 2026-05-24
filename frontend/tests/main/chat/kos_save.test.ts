// Sprint 19 P1-C — chat → KOS save service tests.
//
// Covers pure helpers (slug / title / page content build) + the integrated
// saveConversationToKos service. KOSClient is mocked via the
// __setKosClientForSaveTests injection point so no real network. chat_db
// uses :memory: per the existing fixture pattern.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  appendMessage,
  closeChatDb,
  createNewSession
} from '../../../src/electron/main/chat_db'
import {
  __setKosClientForSaveTests,
  buildAutoTitle,
  buildConversationPageContent,
  buildConversationSlug,
  saveConversationToKos
} from '../../../src/electron/main/chat/kos_save'
import { KOSError, type KOSClient } from '../../../src/electron/main/kos/client'

// ── fixture ───────────────────────────────────────────────────────

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mailagent-kossave-'))
  dbPath = join(tmpDir, 'ai_chat.db')
  process.env.AI_CHAT_DB_PATH = dbPath
})

afterEach(() => {
  closeChatDb()
  __setKosClientForSaveTests(null)
  delete process.env.AI_CHAT_DB_PATH
  rmSync(tmpDir, { recursive: true, force: true })
})

// Mock KOSClient — only putPage is used by the save service.
function mockClient(impl: {
  putPage?: (slug: string, content: string) => Promise<{ slug: string; status: string }>
}): KOSClient {
  return {
    putPage:
      impl.putPage ??
      (async (slug: string) => ({ slug, status: 'created' as const, chunks: 1 }))
  } as unknown as KOSClient
}

// ── pure helpers ──────────────────────────────────────────────────

describe('buildConversationSlug', () => {
  test('default prefix chat-history/mailagent/<email>/<session>/<message>', () => {
    expect(buildConversationSlug({ emailId: 100, sessionId: 5, messageId: 42 })).toBe(
      'chat-history/mailagent/100/5/42'
    )
  })

  test('custom prefix override', () => {
    expect(
      buildConversationSlug({ emailId: 1, sessionId: 1, messageId: 1, prefix: 'notes' })
    ).toBe('notes/1/1/1')
  })
})

describe('buildAutoTitle', () => {
  test('first sentence cap 50 chars', () => {
    const longUser = '这是个很长的问题. 后面还有更多内容应该被忽略.'
    expect(buildAutoTitle(longUser)).toBe('这是个很长的问题')
  })

  test('first line when no sentence punctuation', () => {
    expect(buildAutoTitle('Bob 关于 Acme 的合作建议\n下面是详细\n更多')).toBe(
      'Bob 关于 Acme 的合作建议'
    )
  })

  test('slice 50 when too long', () => {
    const long = 'a'.repeat(80)
    expect(buildAutoTitle(long)).toHaveLength(50)
  })

  test('empty string → fallback placeholder', () => {
    expect(buildAutoTitle('')).toBe('Conversation excerpt')
    expect(buildAutoTitle('   \n   ')).toBe('Conversation excerpt')
  })
})

describe('buildConversationPageContent', () => {
  const baseOpts = {
    userContent: 'Hi Bob, what about the Acme deal?',
    assistantContent: 'Based on prior thread, Acme expects a quote by Friday.',
    emailId: 100,
    sessionId: 5,
    messageId: 42,
    title: 'Bob Acme deal',
    savedAtIso: '2026-05-23T10:00:00Z',
    backendModel: 'claude-sonnet-4-6'
  }

  test('frontmatter contains all required fields', () => {
    const content = buildConversationPageContent(baseOpts)
    expect(content).toMatch(/^---\n/)
    // Lucien 2026-05-23 spec — mailagent.* nested under one key, IDs as
    // sub-keys (alphabetical: email_id / message_id / session_id).
    expect(content).toContain('mailagent:\n  email_id: 100\n  message_id: 42\n  session_id: 5')
    expect(content).toContain('model: claude-sonnet-4-6')
    expect(content).toContain('saved_at: 2026-05-23T10:00:00Z')
    expect(content).toContain('source: mailagent-chat')
    expect(content).toContain('tags: [chat-history, mailagent, conversation]')
    expect(content).toContain('title: "Bob Acme deal"')
    expect(content).toContain('type: conversation')
  })

  test('body has User + Assistant sections when userContent present', () => {
    const content = buildConversationPageContent(baseOpts)
    expect(content).toContain('## User')
    expect(content).toContain('Hi Bob, what about the Acme deal?')
    expect(content).toContain('## Assistant')
    expect(content).toContain('Based on prior thread, Acme expects a quote by Friday.')
  })

  test('body skips User section when userContent empty', () => {
    const content = buildConversationPageContent({ ...baseOpts, userContent: '' })
    expect(content).not.toContain('## User')
    expect(content).toContain('## Assistant')
    expect(content).toContain('Based on prior thread')
  })

  test('null backendModel writes model: unknown', () => {
    const content = buildConversationPageContent({ ...baseOpts, backendModel: null })
    expect(content).toContain('model: unknown')
  })

  test('title with quotes is JSON-escaped', () => {
    const content = buildConversationPageContent({ ...baseOpts, title: 'Re: "important"' })
    expect(content).toContain('title: "Re: \\"important\\""')
  })
})

// ── saveConversationToKos integration ─────────────────────────────

describe('saveConversationToKos', () => {
  test('end-to-end: pairs user→assistant + pushes to KOS', async () => {
    const sess = createNewSession({
      emailId: 100,
      backendKind: 'custom-api',
      backendModel: 'sonnet'
    })
    const userMsg = appendMessage({
      sessionId: sess.id,
      role: 'user',
      content: 'What did Bob say?',
      status: 'complete'
    })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'Bob proposed integration plan A.',
      status: 'complete'
    })

    const pushed: Array<{ slug: string; content: string }> = []
    __setKosClientForSaveTests(
      mockClient({
        putPage: async (slug, content) => {
          pushed.push({ slug, content })
          return { slug, status: 'created' }
        }
      })
    )

    const result = await saveConversationToKos({ messageId: asstMsg.id })
    expect(result.slug).toBe(`chat-history/mailagent/100/${sess.id}/${asstMsg.id}`)
    expect(result.status).toBe('created')
    expect(result.contentBytes).toBeGreaterThan(0)
    expect(pushed).toHaveLength(1)
    expect(pushed[0].slug).toBe(`chat-history/mailagent/100/${sess.id}/${asstMsg.id}`)
    expect(pushed[0].content).toContain('Bob proposed integration plan A.')
    expect(pushed[0].content).toContain('What did Bob say?')
    expect(pushed[0].content).toContain('mailagent:\n  email_id: 100')
    // userMsg used only as setup, verify it's the captured one.
    expect(userMsg.role).toBe('user')
  })

  test('custom slug override', async () => {
    const sess = createNewSession({ emailId: 200, backendKind: 'custom-api' })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete'
    })

    let receivedSlug = ''
    __setKosClientForSaveTests(
      mockClient({
        putPage: async (slug) => {
          receivedSlug = slug
          return { slug, status: 'updated' }
        }
      })
    )
    const r = await saveConversationToKos({
      messageId: asstMsg.id,
      slug: 'notes/my-custom-slug'
    })
    expect(r.slug).toBe('notes/my-custom-slug')
    expect(r.status).toBe('updated')
    expect(receivedSlug).toBe('notes/my-custom-slug')
  })

  test('throws E_NOT_FOUND for non-existent messageId', async () => {
    __setKosClientForSaveTests(mockClient({}))
    await expect(saveConversationToKos({ messageId: 99999 })).rejects.toMatchObject({
      code: 'E_NOT_FOUND'
    })
  })

  test('throws E_INVALID_ARG when message is role=user (not assistant)', async () => {
    const sess = createNewSession({ emailId: 1, backendKind: 'custom-api' })
    const userMsg = appendMessage({
      sessionId: sess.id,
      role: 'user',
      content: 'q',
      status: 'complete'
    })
    __setKosClientForSaveTests(mockClient({}))
    await expect(saveConversationToKos({ messageId: userMsg.id })).rejects.toMatchObject({
      code: 'E_INVALID_ARG'
    })
  })

  test('throws E_INVALID_ARG when assistant content is empty', async () => {
    const sess = createNewSession({ emailId: 1, backendKind: 'custom-api' })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: '',
      status: 'complete'
    })
    __setKosClientForSaveTests(mockClient({}))
    await expect(saveConversationToKos({ messageId: asstMsg.id })).rejects.toMatchObject({
      code: 'E_INVALID_ARG'
    })
  })

  test('throws E_INVALID_ARG for negative messageId', async () => {
    __setKosClientForSaveTests(mockClient({}))
    await expect(saveConversationToKos({ messageId: -1 })).rejects.toMatchObject({
      code: 'E_INVALID_ARG'
    })
  })

  test('assistant without preceding user message → push but no User section', async () => {
    const sess = createNewSession({ emailId: 300, backendKind: 'custom-api' })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'orphan assistant turn',
      status: 'complete'
    })

    let captured = ''
    __setKosClientForSaveTests(
      mockClient({
        putPage: async (slug, content) => {
          captured = content
          return { slug, status: 'created' }
        }
      })
    )
    await saveConversationToKos({ messageId: asstMsg.id })
    expect(captured).toContain('## Assistant')
    expect(captured).toContain('orphan assistant turn')
    expect(captured).not.toContain('## User')
  })

  test('KOSError propagates with original code', async () => {
    const sess = createNewSession({ emailId: 1, backendKind: 'custom-api' })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete'
    })
    __setKosClientForSaveTests(
      mockClient({
        putPage: async () => {
          throw new KOSError('KOS down', 'E_KOS_NETWORK')
        }
      })
    )
    await expect(saveConversationToKos({ messageId: asstMsg.id })).rejects.toMatchObject({
      code: 'E_KOS_NETWORK'
    })
  })

  test('non-KOSError exceptions propagate unchanged', async () => {
    const sess = createNewSession({ emailId: 1, backendKind: 'custom-api' })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete'
    })
    __setKosClientForSaveTests(
      mockClient({
        putPage: async () => {
          throw new Error('random error')
        }
      })
    )
    await expect(saveConversationToKos({ messageId: asstMsg.id })).rejects.toThrow('random error')
  })

  test('content bytes reported matches actual UTF-8 size', async () => {
    const sess = createNewSession({ emailId: 1, backendKind: 'custom-api' })
    appendMessage({
      sessionId: sess.id,
      role: 'user',
      content: '问题',
      status: 'complete'
    })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: '回答',
      status: 'complete'
    })

    let capturedContent = ''
    __setKosClientForSaveTests(
      mockClient({
        putPage: async (slug, content) => {
          capturedContent = content
          return { slug, status: 'created' }
        }
      })
    )
    const r = await saveConversationToKos({ messageId: asstMsg.id })
    expect(r.contentBytes).toBe(Buffer.byteLength(capturedContent, 'utf8'))
  })
})

// Mark vi import as used (vitest 4 prefers explicit reference even when
// only types or mock-init helpers are needed).
void vi
