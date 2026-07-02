// R2-3 (v1.1.0 dogfood) — approval-paused assistant persistence tests.
//
// Symptom: a first turn paused at an approval gate DID show in history (#12 eager user persist),
// but switching back to the session lost the AI's reply — makePersistOnFinish skipped the whole
// paused turn (dogfood-#3 trade-off), so only the user row existed.
//
// Fix under test:
// ① redactApprovalRequestedParts — display-safe copy: drop `approval-requested` tool parts (no dead
//   "待确认" card on reload), keep produced text / completed tool parts; null when nothing displayable.
// ② makePersistOnFinish routes a PAUSED turn to cfg.persistPausedAssistant (with the redacted copy)
//   and still never calls persistTurn for it; hook omitted → old skip, byte-identical.
// ③ Upsert contract (pure sim of the lifecycle + chat_db.findAssistantMessageRowIdByUiId): the
//   resume turn's persistTurn REPLACES the paused row (same merged UIMessage id) — exactly ONE
//   assistant row with the final content, no duplicates.
//
// All pure / in-memory — no better-sqlite3 (Electron-ABI native module can't load under plain Node).

import { describe, expect, test } from 'vitest'

import {
  makePersistOnFinish,
  redactApprovalRequestedParts,
  responseMessageAwaitsApproval
} from '../../src/ai-gateway/chatRun'
import type { AiGatewayConfig } from '../../src/ai-gateway/config'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

// ── fixtures ──────────────────────────────────────────────────────────────────

const TEXT_PART = { type: 'text', text: '我准备好了一封回复草稿，需要你确认后发送。' }
const APPROVAL_PART = {
  type: 'tool-email_prepare_send',
  state: 'approval-requested',
  toolCallId: 't1',
  input: { to: 'a@b.test' }
}
const DONE_TOOL_PART = {
  type: 'tool-email_search',
  state: 'output-available',
  toolCallId: 't0',
  input: { query: 'q' },
  output: { hits: [] }
}

function msg(id: string, parts: unknown[]): MailAgentUIMessage {
  return { id, role: 'assistant', parts } as unknown as MailAgentUIMessage
}

function userMsg(id: string, text: string): MailAgentUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as unknown as MailAgentUIMessage
}

/** Minimal PreparedChatRun stand-in — only the fields makePersistOnFinish touches. */
function fakeRun(sessionId: number | null): never {
  return {
    sessionId,
    modelId: 'claude-sonnet-4-6',
    rawMessages: [userMsg('u1', '帮我回复这封邮件')],
    result: { usage: Promise.resolve(undefined) },
    auditEntries: []
  } as never
}

// ── ① redactApprovalRequestedParts ───────────────────────────────────────────

describe('redactApprovalRequestedParts', () => {
  test('drops approval-requested tool parts, keeps produced text', () => {
    const r = redactApprovalRequestedParts(msg('a1', [TEXT_PART, APPROVAL_PART]))
    expect(r).not.toBeNull()
    const parts = (r as unknown as { parts: Array<{ type: string; state?: string }> }).parts
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('text')
    expect(responseMessageAwaitsApproval(r as MailAgentUIMessage)).toBe(false)
  })

  test('keeps completed tool parts (history already renders them)', () => {
    const r = redactApprovalRequestedParts(msg('a1', [DONE_TOOL_PART, APPROVAL_PART]))
    expect(r).not.toBeNull()
    const parts = (r as unknown as { parts: Array<{ type: string; state?: string }> }).parts
    expect(parts).toHaveLength(1)
    expect(parts[0].state).toBe('output-available')
  })

  test('null when only an approval part remains (nothing displayable)', () => {
    expect(redactApprovalRequestedParts(msg('a1', [APPROVAL_PART]))).toBeNull()
  })

  test('null when remaining text is whitespace-only', () => {
    expect(
      redactApprovalRequestedParts(msg('a1', [{ type: 'text', text: '  ' }, APPROVAL_PART]))
    ).toBeNull()
  })

  test('does not mutate the original message', () => {
    const original = msg('a1', [TEXT_PART, APPROVAL_PART])
    redactApprovalRequestedParts(original)
    expect((original as unknown as { parts: unknown[] }).parts).toHaveLength(2)
  })
})

// ── ② makePersistOnFinish routing ────────────────────────────────────────────

describe('makePersistOnFinish approval-pause routing', () => {
  test('paused turn → persistPausedAssistant called with the REDACTED copy, persistTurn NOT called', async () => {
    const persisted: unknown[] = []
    const paused: Array<{ sessionId: number | null; message: MailAgentUIMessage; model: string }> =
      []
    const cfg = {
      persistTurn: (t: unknown) => {
        persisted.push(t)
      },
      persistPausedAssistant: (
        sessionId: number | null,
        redactedMessage: MailAgentUIMessage,
        modelId: string
      ) => {
        paused.push({ sessionId, message: redactedMessage, model: modelId })
      }
    } as unknown as AiGatewayConfig

    const onFinish = makePersistOnFinish(cfg, fakeRun(7))
    await onFinish({
      responseMessage: msg('a1', [TEXT_PART, APPROVAL_PART]),
      isAborted: false
    } as never)

    expect(persisted).toHaveLength(0)
    expect(paused).toHaveLength(1)
    expect(paused[0].sessionId).toBe(7)
    expect(paused[0].model).toBe('claude-sonnet-4-6')
    expect(responseMessageAwaitsApproval(paused[0].message)).toBe(false) // redacted
  })

  test('paused turn + hook omitted → nothing persisted, no throw (pre-R2-3 behaviour)', async () => {
    const persisted: unknown[] = []
    const cfg = {
      persistTurn: (t: unknown) => {
        persisted.push(t)
      }
    } as unknown as AiGatewayConfig
    const onFinish = makePersistOnFinish(cfg, fakeRun(7))
    await onFinish({
      responseMessage: msg('a1', [TEXT_PART, APPROVAL_PART]),
      isAborted: false
    } as never)
    expect(persisted).toHaveLength(0)
  })

  test('paused turn with NO displayable content → hook not called', async () => {
    const paused: unknown[] = []
    const cfg = {
      persistTurn: () => {},
      persistPausedAssistant: (...args: unknown[]) => {
        paused.push(args)
      }
    } as unknown as AiGatewayConfig
    const onFinish = makePersistOnFinish(cfg, fakeRun(7))
    await onFinish({
      responseMessage: msg('a1', [APPROVAL_PART]),
      isAborted: false
    } as never)
    expect(paused).toHaveLength(0)
  })

  test('normal completed turn → persistTurn called, pause hook NOT called', async () => {
    const persisted: unknown[] = []
    const paused: unknown[] = []
    const cfg = {
      persistTurn: (t: unknown) => {
        persisted.push(t)
      },
      persistPausedAssistant: (...args: unknown[]) => {
        paused.push(args)
      }
    } as unknown as AiGatewayConfig
    const onFinish = makePersistOnFinish(cfg, fakeRun(7))
    await onFinish({
      responseMessage: msg('a1', [TEXT_PART]),
      isAborted: false
    } as never)
    expect(persisted).toHaveLength(1)
    expect(paused).toHaveLength(0)
  })

  test('aborted turn → neither path fires', async () => {
    const persisted: unknown[] = []
    const paused: unknown[] = []
    const cfg = {
      persistTurn: (t: unknown) => {
        persisted.push(t)
      },
      persistPausedAssistant: (...args: unknown[]) => {
        paused.push(args)
      }
    } as unknown as AiGatewayConfig
    const onFinish = makePersistOnFinish(cfg, fakeRun(7))
    await onFinish({
      responseMessage: msg('a1', [TEXT_PART, APPROVAL_PART]),
      isAborted: true
    } as never)
    expect(persisted).toHaveLength(0)
    expect(paused).toHaveLength(0)
  })

  test('hook throwing does not break onFinish', async () => {
    const cfg = {
      persistTurn: () => {},
      persistPausedAssistant: () => {
        throw new Error('intentional hook failure')
      }
    } as unknown as AiGatewayConfig
    const onFinish = makePersistOnFinish(cfg, fakeRun(7))
    await expect(
      onFinish({
        responseMessage: msg('a1', [TEXT_PART, APPROVAL_PART]),
        isAborted: false
      } as never)
    ).resolves.toBeUndefined()
  })
})

// ── ③ upsert contract (pure sim of lifecycle + findAssistantMessageRowIdByUiId) ──

describe('paused→resume upsert produces exactly one assistant row', () => {
  test('pause inserts redacted row; resume with SAME merged id replaces it', () => {
    // In-memory mirror of ai_chat_messages + findAssistantMessageRowIdByUiId ($.id lookup).
    const rows: Array<{ id: number; role: string; content: string; uiId: string }> = []
    let nextId = 1
    const findByUiId = (uiId: string): number | null =>
      [...rows].reverse().find((r) => r.role === 'assistant' && r.uiId === uiId)?.id ?? null
    const upsertAssistant = (uiId: string, content: string): void => {
      const existing = findByUiId(uiId)
      if (existing != null) {
        rows[rows.findIndex((r) => r.id === existing)].content = content
      } else {
        rows.push({ id: nextId++, role: 'assistant', content, uiId })
      }
    }

    // Pause: redacted copy persisted (text only).
    upsertAssistant('a1', '我准备好了一封回复草稿，需要你确认后发送。')
    expect(rows).toHaveLength(1)

    // Resume: merged full turn keeps the SAME UIMessage id → REPLACE, not append.
    upsertAssistant('a1', '我准备好了一封回复草稿，需要你确认后发送。已发送完成。')
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain('已发送完成')

    // A later, different turn appends normally.
    upsertAssistant('a2', '还需要别的吗？')
    expect(rows).toHaveLength(2)
  })
})
