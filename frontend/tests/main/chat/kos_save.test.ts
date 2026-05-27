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

import { appendMessage, closeChatDb, createNewSession } from '../../../src/electron/main/chat_db'
import {
  __setKosClientForSaveTests,
  __setSummarizerForTests,
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
  __setSummarizerForTests(null)
  delete process.env.AI_CHAT_DB_PATH
  rmSync(tmpDir, { recursive: true, force: true })
})

// Mock KOSClient — only putPage is used by the save service.
function mockClient(impl: {
  putPage?: (slug: string, content: string) => Promise<{ slug: string; status: string }>
}): KOSClient {
  return {
    putPage:
      impl.putPage ?? (async (slug: string) => ({ slug, status: 'created' as const, chunks: 1 }))
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
    expect(buildConversationSlug({ emailId: 1, sessionId: 1, messageId: 1, prefix: 'notes' })).toBe(
      'notes/1/1/1'
    )
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

  test('② frontmatter contains source_refs pointing at the bulk-ingest email slug', () => {
    const content = buildConversationPageContent(baseOpts)
    // Block-list form, single-quoted value, slug byte-matches the bulk
    // ingest's sources/email/<internal_id> (email_id == internal_id).
    expect(content).toContain("source_refs:\n  - 'sources/email/100'")
  })

  test('body has User + Assistant sections when no summaryBody (fallback path)', () => {
    const content = buildConversationPageContent(baseOpts)
    expect(content).toContain('## User')
    expect(content).toContain('Hi Bob, what about the Acme deal?')
    expect(content).toContain('## Assistant')
    expect(content).toContain('Based on prior thread, Acme expects a quote by Friday.')
  })

  test('fallback body skips User section when userContent empty', () => {
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

  // ── ③ structured-summary body path ──────────────────────────────

  test('③ summaryBody replaces raw transcript + injects reference line under H1', () => {
    const summaryBody = [
      '# Acme 报价讨论',
      '## 关键结论 / 决策',
      '- 周五前给 Acme 出报价',
      '## 涉及实体 / 待办',
      '- Bob (待办: 出报价)'
    ].join('\n')
    const content = buildConversationPageContent({
      ...baseOpts,
      summaryBody,
      emailSubject: 'Acme 合作'
    })
    // No raw transcript leaks into the body.
    expect(content).not.toContain('## User')
    expect(content).not.toContain('## Assistant')
    expect(content).not.toContain('Hi Bob, what about the Acme deal?')
    // LLM H1 preserved, reference line injected right after it as subtitle.
    expect(content).toContain('# Acme 报价讨论')
    expect(content).toContain('> 关于邮件《Acme 合作》的讨论 · 关联 sources/email/100')
    // Structured sections from the LLM survive.
    expect(content).toContain('## 关键结论 / 决策')
    expect(content).toContain('- 周五前给 Acme 出报价')
    expect(content).toContain('## 涉及实体 / 待办')
  })

  test('③ summaryBody without leading H1 → reference line prepended', () => {
    const content = buildConversationPageContent({
      ...baseOpts,
      summaryBody: '## 关键结论 / 决策\n- 无明确结论',
      emailSubject: 'Acme 合作'
    })
    expect(content).toContain('> 关于邮件《Acme 合作》的讨论 · 关联 sources/email/100')
    expect(content).toContain('## 关键结论 / 决策')
  })

  test('③ summaryBody with null emailSubject → reference line omits subject', () => {
    const content = buildConversationPageContent({
      ...baseOpts,
      summaryBody: '# 主题\n## 关键结论 / 决策\n- x',
      emailSubject: null
    })
    expect(content).toContain('> 关于邮件的讨论 · 关联 sources/email/100')
    expect(content).not.toContain('《')
  })

  test('③ empty/whitespace summaryBody falls back to raw transcript', () => {
    const content = buildConversationPageContent({ ...baseOpts, summaryBody: '   \n  ' })
    expect(content).toContain('## User')
    expect(content).toContain('## Assistant')
  })
})

// ── saveConversationToKos integration ─────────────────────────────

describe('saveConversationToKos', () => {
  // Default: a summarizer that throws so the raw-transcript fallback (④)
  // runs. This keeps the existing transcript-shape assertions valid AND
  // guarantees no real network call leaks out of the suite. Individual
  // tests override with a success/failure mock as needed. Reset to the
  // real summarizer in the top-level afterEach.
  beforeEach(() => {
    __setSummarizerForTests(async () => {
      throw Object.assign(new Error('no key in test'), { code: 'E_NO_LLM_KEY' })
    })
  })

  test('end-to-end: pairs user→assistant + pushes to KOS (summarizer fails → raw body)', async () => {
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
    // ② source_refs always present, slug byte-matches bulk-ingest email page.
    expect(pushed[0].content).toContain("source_refs:\n  - 'sources/email/100'")
    // userMsg used only as setup, verify it's the captured one.
    expect(userMsg.role).toBe('user')
  })

  test('③ summarizer success → structured body, no raw transcript, source_refs present', async () => {
    const sess = createNewSession({ emailId: 555, backendKind: 'custom-api' })
    appendMessage({
      sessionId: sess.id,
      role: 'user',
      content: '好的, 那 Acme 的报价什么时候给?',
      status: 'complete'
    })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: '根据上文, Acme 期望周五前拿到报价。',
      status: 'complete'
    })

    const seenPromptArgs: Array<{ emailId: number; emailSubject: string | null }> = []
    __setSummarizerForTests(async (opts) => {
      seenPromptArgs.push({ emailId: opts.emailId, emailSubject: opts.emailSubject })
      return [
        '# Acme 报价时间确认',
        '## 关键结论 / 决策',
        '- Acme 期望周五前拿到报价',
        '## 涉及实体 / 待办',
        '- Acme (待办: 周五前出报价)'
      ].join('\n')
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

    const result = await saveConversationToKos({ messageId: asstMsg.id })
    expect(result.status).toBe('created')
    // Structured summary in the body; raw transcript NOT restated.
    expect(captured).toContain('# Acme 报价时间确认')
    expect(captured).toContain('## 关键结论 / 决策')
    expect(captured).toContain('- Acme 期望周五前拿到报价')
    expect(captured).not.toContain('## User')
    expect(captured).not.toContain('## Assistant')
    expect(captured).not.toContain('好的, 那 Acme 的报价什么时候给?')
    // Reference line links the bulk-ingest email page.
    expect(captured).toContain('· 关联 sources/email/555')
    expect(captured).toContain("source_refs:\n  - 'sources/email/555'")
    // Summarizer received emailId (no email body restated). Subject is null
    // here because no email_metadata row exists in the :memory: chat DB.
    expect(seenPromptArgs).toHaveLength(1)
    expect(seenPromptArgs[0].emailId).toBe(555)
  })

  test('④ summarizer failure → raw transcript fallback, save still succeeds', async () => {
    const sess = createNewSession({ emailId: 777, backendKind: 'custom-api' })
    appendMessage({
      sessionId: sess.id,
      role: 'user',
      content: 'Bob 说了什么?',
      status: 'complete'
    })
    const asstMsg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'Bob 提议方案 A。',
      status: 'complete'
    })

    __setSummarizerForTests(async () => {
      throw Object.assign(new Error('upstream 500'), { code: 'E_UPSTREAM' })
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

    const result = await saveConversationToKos({ messageId: asstMsg.id })
    // Save succeeds despite LLM failure (non-fatal fallback).
    expect(result.status).toBe('created')
    expect(captured).toContain('## User')
    expect(captured).toContain('Bob 说了什么?')
    expect(captured).toContain('## Assistant')
    expect(captured).toContain('Bob 提议方案 A。')
    // source_refs present on the fallback body too.
    expect(captured).toContain("source_refs:\n  - 'sources/email/777'")
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
