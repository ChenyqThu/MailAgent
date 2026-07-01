// dogfood #3 (HITL 授权重复 / 卡 loading) — makePersistOnFinish must NOT persist a turn that is
// paused at an approval gate. HITL is two /api/ai/chat requests (initial → approval-requested pause;
// resume → executed), each firing onFinish. The old code persisted lastUserMessage(rawMessages) on
// BOTH, and on the resume rawMessages still END with the original user message → a duplicate `user`
// row + a second `assistant` row → a reloaded session showed the whole turn twice + a stuck "待确认"
// card. The fix: skip persistence (and capture) when the responseMessage still carries an
// `approval-requested` tool part; only the resume (merged, complete responseMessage) persists.
//
// Pure-Node (no chat_db / better-sqlite3): makePersistOnFinish is a pure function over an injected
// AiGatewayConfig — mirror auto_capture.test.ts's harness.

import { describe, expect, test } from 'vitest'

import {
  makePersistOnFinish,
  responseMessageAwaitsApproval,
  type PreparedChatRun
} from '../../src/ai-gateway/chatRun'
import type {
  AiGatewayConfig,
  IslandApprovalAnnounce,
  PersistTurnInput
} from '../../src/ai-gateway/config'
import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import type { GatewayToolAuditEntry } from '../../src/ai-gateway/tools/types'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

// A draft-reply turn PAUSED at its approval gate: email_get already resolved, the write tool is
// awaiting approval (state 'approval-requested'). This is the initial request's responseMessage.
const draftPending = {
  id: 'a-partial',
  role: 'assistant',
  parts: [
    {
      type: 'tool-email_get',
      toolCallId: 't1',
      state: 'output-available',
      output: { subject: 'x' }
    },
    {
      type: 'tool-email_draft_reply',
      toolCallId: 't2',
      state: 'approval-requested',
      approval: { id: 'ap1' }
    }
  ]
} as unknown as MailAgentUIMessage

// The SAME turn after approve → resume: the write executed (output-available) + the closing text. This
// is the resume request's responseMessage (merged full turn via pipeUIMessageStreamToResponse's
// originalMessages). No tool is awaiting approval → this is the real, complete turn.
const draftDone = {
  id: 'a-complete',
  role: 'assistant',
  parts: [
    {
      type: 'tool-email_get',
      toolCallId: 't1',
      state: 'output-available',
      output: { subject: 'x' }
    },
    {
      type: 'tool-email_draft_reply',
      toolCallId: 't2',
      state: 'output-available',
      output: { draftId: 'd1' }
    },
    { type: 'text', text: '草稿已创建。' }
  ]
} as unknown as MailAgentUIMessage

const textOnly = {
  id: 'a-text',
  role: 'assistant',
  parts: [{ type: 'text', text: '好的' }]
} as unknown as MailAgentUIMessage

/** Minimal PreparedChatRun. `rawMessages` shapes the two HITL phases: a fresh turn ends with the user
 *  message; a resume ends with the approval-responded assistant message (but persistence keys off the
 *  responseMessage, not this). usage resolves undefined (the catch path). */
function makeRun(
  rawMessages: PreparedChatRun['rawMessages'],
  extra?: { auditEntries?: GatewayToolAuditEntry[]; originalBody?: Record<string, unknown> }
): PreparedChatRun {
  return {
    result: { usage: Promise.resolve(undefined) } as unknown as PreparedChatRun['result'],
    rawMessages,
    sessionId: 42,
    modelId: 'claude-sonnet-4-6',
    auditEntries: extra?.auditEntries ?? [],
    toolNames: [],
    ...(extra?.originalBody ? { originalBody: extra.originalBody } : {})
  }
}

/** An audit entry for a tool the one-shot guard.consume rejected with E_APPROVAL_USED (the OTHER
 *  surface already executed this approval — the renderer↔island approve race). */
function approvalUsedAudit(toolUseId: string): GatewayToolAuditEntry {
  return {
    toolUseId,
    toolName: 'email_draft_reply',
    inputJson: '{}',
    outputJson: JSON.stringify({ error: 'E_APPROVAL_USED', message: 'already executed' }),
    status: 'error',
    durationMs: 1,
    confirmationTier: 'edit',
    approvalStatus: 'rejected'
  } as unknown as GatewayToolAuditEntry
}

const USER = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: '帮我创建答复草稿' }]
} as const
const freshTurn = () => makeRun([USER] as unknown as PreparedChatRun['rawMessages'])
const resumeTurn = () =>
  makeRun([
    USER,
    { id: 'a-partial', role: 'assistant', parts: [] }
  ] as unknown as PreparedChatRun['rawMessages'])

function fire(
  onFinish: ReturnType<typeof makePersistOnFinish>,
  responseMessage: MailAgentUIMessage
): Promise<void> {
  return onFinish({ responseMessage, isAborted: false } as unknown as Parameters<
    typeof onFinish
  >[0])
}

describe('responseMessageAwaitsApproval — structural approval-gate detection', () => {
  test('true when any tool part is approval-requested', () => {
    expect(responseMessageAwaitsApproval(draftPending)).toBe(true)
  })
  test('false when all tools executed (output-available) / rejected', () => {
    expect(responseMessageAwaitsApproval(draftDone)).toBe(false)
  })
  test('false for a text-only reply', () => {
    expect(responseMessageAwaitsApproval(textOnly)).toBe(false)
  })
  test('false when parts is missing / not an array', () => {
    expect(
      responseMessageAwaitsApproval({ id: 'x', role: 'assistant' } as unknown as MailAgentUIMessage)
    ).toBe(false)
  })
})

describe('makePersistOnFinish — skip the approval-paused partial (dogfood #3)', () => {
  test('approval-requested responseMessage → NOT persisted, NOT captured', async () => {
    const persisted: PersistTurnInput[] = []
    const captured: PersistTurnInput[] = []
    const cfg = {
      persistTurn: (t: PersistTurnInput) => persisted.push(t),
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, freshTurn()), draftPending)
    expect(persisted).toHaveLength(0)
    expect(captured).toHaveLength(0)
  })

  test('complete responseMessage → persisted once with the user message', async () => {
    const persisted: PersistTurnInput[] = []
    const cfg = { persistTurn: (t: PersistTurnInput) => persisted.push(t) } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, resumeTurn()), draftDone)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].userMessage?.id).toBe('u1')
    expect(persisted[0].responseMessage.id).toBe('a-complete')
  })

  test('end-to-end HITL: initial pause + resume → persistTurn called EXACTLY once (no duplicate user)', async () => {
    const persisted: PersistTurnInput[] = []
    const cfg = { persistTurn: (t: PersistTurnInput) => persisted.push(t) } as AiGatewayConfig
    // Phase 1 — initial request finishes at the approval gate (skip).
    await fire(makePersistOnFinish(cfg, freshTurn()), draftPending)
    // Phase 2 — user approved → resume finishes with the executed draft (persist).
    await fire(makePersistOnFinish(cfg, resumeTurn()), draftDone)
    expect(persisted).toHaveLength(1)
    // the ONE persisted turn is the complete one; the user message appears exactly once.
    expect(persisted[0].responseMessage.id).toBe('a-complete')
    expect(persisted.filter((t) => t.userMessage != null)).toHaveLength(1)
  })

  test('plain text turn is unaffected (still persisted)', async () => {
    const persisted: PersistTurnInput[] = []
    const cfg = { persistTurn: (t: PersistTurnInput) => persisted.push(t) } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, freshTurn()), textOnly)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].responseMessage.id).toBe('a-text')
  })
})

// Part B (harness 上岛) — cross-surface single-resolver side effects in makePersistOnFinish (codex
// findings 1 + 2). All gated by islandAgentEnabled → flag-off is byte-identical.
describe('makePersistOnFinish — Part B cross-surface side effects', () => {
  // A renderer RESUME whose incoming history ends with the paused tool part transitioned to
  // approval-responded + approved:false (the user rejected in-app).
  const rejectedResumeRaw = [
    USER,
    {
      id: 'a-rej',
      role: 'assistant',
      parts: [
        {
          type: 'tool-email_draft_reply',
          toolCallId: 't2',
          state: 'approval-responded',
          approval: { id: 'ap1', approved: false }
        }
      ]
    }
  ] as unknown as PreparedChatRun['rawMessages']
  // The completed reply after the denial (NOT awaiting approval → a real, complete turn).
  const rejectDone = {
    id: 'a-rej-done',
    role: 'assistant',
    parts: [{ type: 'text', text: '已取消。' }]
  } as unknown as MailAgentUIMessage

  test('finding 1 — a renderer reject tombstones the guard (rejectApproval called), turn still persists', async () => {
    const persisted: PersistTurnInput[] = []
    const rejected: string[] = []
    const cfg = {
      islandAgentEnabled: true,
      persistTurn: (t: PersistTurnInput) => persisted.push(t),
      rejectApproval: (tc: string) => rejected.push(tc)
    } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, makeRun(rejectedResumeRaw)), rejectDone)
    expect(rejected).toEqual(['t2']) // the in-app reject tombstoned t2 (blocks a later island approve)
    expect(persisted).toHaveLength(1) // the denial reply is a real turn — still persisted
  })

  test('finding 1 — flag OFF → no tombstone even with a rejected part (byte-identical)', async () => {
    const rejected: string[] = []
    const cfg = {
      persistTurn: () => {},
      rejectApproval: (tc: string) => rejected.push(tc)
    } as AiGatewayConfig
    await fire(makePersistOnFinish(cfg, makeRun(rejectedResumeRaw)), rejectDone)
    expect(rejected).toHaveLength(0)
  })

  // codex re-review edge case — a reject-of-A whose resume IMMEDIATELY re-pauses on approval-B must
  // STILL tombstone A (the tombstone derives from the incoming history, so it runs BEFORE the re-pause
  // early return). Otherwise a stale island approve of A would slip through.
  test('finding 1 — a reject that RE-PAUSES on another approval still tombstones the rejected one', async () => {
    const persisted: PersistTurnInput[] = []
    const rejected: string[] = []
    const cfg = {
      islandAgentEnabled: true,
      persistTurn: (t: PersistTurnInput) => persisted.push(t),
      rejectApproval: (tc: string) => rejected.push(tc)
    } as AiGatewayConfig
    // history: approval A rejected in-app; responseMessage: the resume immediately asks approval B.
    const rejAThenRaw = [
      USER,
      {
        id: 'a-rejA',
        role: 'assistant',
        parts: [
          {
            type: 'tool-email_draft_reply',
            toolCallId: 'tA',
            state: 'approval-responded',
            approval: { id: 'apA', approved: false }
          }
        ]
      }
    ] as unknown as PreparedChatRun['rawMessages']
    const repausedOnB = {
      id: 'a-B-pending',
      role: 'assistant',
      parts: [
        {
          type: 'tool-email_prepare_send',
          toolCallId: 'tB',
          state: 'approval-requested',
          approval: { id: 'apB' }
        }
      ]
    } as unknown as MailAgentUIMessage
    await fire(makePersistOnFinish(cfg, makeRun(rejAThenRaw)), repausedOnB)
    expect(rejected).toEqual(['tA']) // A tombstoned EVEN THOUGH the turn re-paused on B
    expect(persisted).toHaveLength(0) // re-paused → not persisted
  })

  test('finding 2 — E_APPROVAL_USED in the audit (lost the approve race) → NOT persisted', async () => {
    const persisted: PersistTurnInput[] = []
    const captured: PersistTurnInput[] = []
    const cfg = {
      islandAgentEnabled: true,
      persistTurn: (t: PersistTurnInput) => persisted.push(t),
      captureTurnMemory: (t: PersistTurnInput) => captured.push(t)
    } as AiGatewayConfig
    const run = makeRun(resumeTurn().rawMessages, { auditEntries: [approvalUsedAudit('t2')] })
    await fire(makePersistOnFinish(cfg, run), draftDone)
    expect(persisted).toHaveLength(0) // the winning surface already persisted the authoritative turn
    expect(captured).toHaveLength(0)
  })

  test('finding 2 — flag OFF → E_APPROVAL_USED audit does NOT skip persist (byte-identical)', async () => {
    const persisted: PersistTurnInput[] = []
    const cfg = { persistTurn: (t: PersistTurnInput) => persisted.push(t) } as AiGatewayConfig
    const run = makeRun(resumeTurn().rawMessages, { auditEntries: [approvalUsedAudit('t2')] })
    await fire(makePersistOnFinish(cfg, run), draftDone)
    expect(persisted).toHaveLength(1)
  })

  test('finding 3 — a resume that RE-PAUSES re-stashes + re-announces a fresh island card (no persist)', async () => {
    const persisted: PersistTurnInput[] = []
    const announced: IslandApprovalAnnounce[] = []
    const stash = new ApprovalRunStash()
    const cfg = {
      islandAgentEnabled: true,
      approvalStash: stash,
      persistTurn: (t: PersistTurnInput) => persisted.push(t),
      announceApprovalToIsland: (info: IslandApprovalAnnounce) => announced.push(info)
    } as AiGatewayConfig
    // A resume whose responseMessage is ITSELF paused at the next approval gate (draftPending).
    const run = makeRun(resumeTurn().rawMessages, {
      originalBody: { messages: [USER], model: 'claude-sonnet-4-6', sessionId: 42 }
    })
    await fire(makePersistOnFinish(cfg, run), draftPending)
    expect(persisted).toHaveLength(0) // a paused turn is never persisted
    expect(stash.size()).toBe(1) // the next approval is stashed for its own server-side resume
    expect(announced).toHaveLength(1) // …and announced as a NEW island card (serve-api must not complete)
    expect(announced[0].toolCallId).toBe('t2')
  })
})
