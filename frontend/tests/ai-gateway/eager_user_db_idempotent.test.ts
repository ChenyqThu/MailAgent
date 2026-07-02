// MEDIUM-1 (rebase 复审) — DB-idempotent eager user persist, against the REAL chat_db.
//
// Scenario closed by the fix: ① onTurnStart eagerly writes user row u1 + seeds the in-memory Set;
// ② the turn pauses at an approval gate (Set key kept); ③ the ISLAND /decide resume's persistTurn
// dedups against the Set AND deletes the key; ④ minutes later the user re-opens the chat panel and
// clicks the stale approval card → the renderer resume goes through handleChat → onTurnStart again,
// with an EMPTY Set → pre-fix it appended the SAME user message a second time (E_APPROVAL_USED only
// skips persistTurn, not this eager write). Fix: check the DB by (session, ui id, role='user')
// before appending — hit → re-seed the fast path + skip.
//
// chat_db is better-sqlite3 (main-only) so we mock electron + point AI_CHAT_DB_PATH at a tmp file,
// exactly like ui_message_persistence.test.ts. The onTurnStart body lives in ai_gateway_lifecycle
// (imports electron.app at module top — not loadable here), so the test mirrors its exact post-fix
// sequence against the real DB; the contract pinned is chat_db's role-scoped lookup + the
// one-row-per-(session, ui id) invariant.

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
  findAssistantMessageRowIdByUiId,
  findUserMessageRowIdByUiId,
  getOrCreateSession,
  listMessages
} from '../../src/electron/main/chat_db'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-gw-eager-'))
  process.env['AI_CHAT_DB_PATH'] = join(tmpDir, 'ai_chat.db')
  closeChatDb()
})
afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function userMsg(id: string, text: string): MailAgentUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as unknown as MailAgentUIMessage
}

/** Mirror of the lifecycle's post-fix onTurnStart eager write (Set fast path + DB idempotency). */
function eagerPersistUser(
  sessionId: number,
  userMessage: MailAgentUIMessage,
  eagerSet: Set<string>
): void {
  const key = `${sessionId}:${userMessage.id}`
  if (eagerSet.has(key)) return
  if (findUserMessageRowIdByUiId(sessionId, userMessage.id) != null) {
    eagerSet.add(key)
    return
  }
  appendMessage({
    sessionId,
    role: 'user',
    content: '帮我起草回复',
    status: 'complete',
    uiMessageJson: JSON.stringify(userMessage)
  })
  eagerSet.add(key)
}

describe('MEDIUM-1 — eager user persist is DB-idempotent', () => {
  test('two onTurnStart passes for the same (session, user id) with a CLEARED Set → exactly one row', () => {
    const sessionId = getOrCreateSession({ emailId: 1, backendKind: 'custom-api' }).id
    const u1 = userMsg('u1', '帮我起草回复')

    // ① original turn: eager write.
    const set1 = new Set<string>()
    eagerPersistUser(sessionId, u1, set1)
    expect(listMessages(sessionId).filter((m) => m.role === 'user')).toHaveLength(1)

    // ③ island resume's persistTurn deduped against the Set and DELETED the key — model that by a
    // brand-new empty Set (also models a gateway restart).
    // ④ renderer resume of the stale card: onTurnStart again, Set empty → DB check must skip.
    const set2 = new Set<string>()
    eagerPersistUser(sessionId, u1, set2)

    const users = listMessages(sessionId).filter((m) => m.role === 'user')
    expect(users).toHaveLength(1) // pre-fix: 2 (the duplicate row)
    // the DB hit re-seeded the fast path so a THIRD pass short-circuits on the Set.
    expect(set2.has(`${sessionId}:u1`)).toBe(true)
  })

  test('a NEW user message (different id) in the same session is still appended', () => {
    const sessionId = getOrCreateSession({ emailId: 1, backendKind: 'custom-api' }).id
    const set = new Set<string>()
    eagerPersistUser(sessionId, userMsg('u1', 'a'), set)
    eagerPersistUser(sessionId, userMsg('u2', 'b'), new Set<string>()) // cleared Set, new id
    expect(listMessages(sessionId).filter((m) => m.role === 'user')).toHaveLength(2)
  })

  test('role-scoped lookup: user lookup never matches an assistant row (and vice versa)', () => {
    const sessionId = getOrCreateSession({ emailId: 1, backendKind: 'custom-api' }).id
    appendMessage({
      sessionId,
      role: 'assistant',
      content: '好的',
      status: 'complete',
      uiMessageJson: JSON.stringify({ id: 'shared-id', role: 'assistant', parts: [] })
    })
    expect(findUserMessageRowIdByUiId(sessionId, 'shared-id')).toBeNull()
    expect(findAssistantMessageRowIdByUiId(sessionId, 'shared-id')).not.toBeNull()

    appendMessage({
      sessionId,
      role: 'user',
      content: '你好',
      status: 'complete',
      uiMessageJson: JSON.stringify({ id: 'shared-id', role: 'user', parts: [] })
    })
    expect(findUserMessageRowIdByUiId(sessionId, 'shared-id')).not.toBeNull()
  })

  test('rows without ui_message_json are never matched (legacy rows stay invisible)', () => {
    const sessionId = getOrCreateSession({ emailId: 1, backendKind: 'custom-api' }).id
    appendMessage({ sessionId, role: 'user', content: 'legacy', status: 'complete' })
    expect(findUserMessageRowIdByUiId(sessionId, 'u1')).toBeNull()
  })
})
