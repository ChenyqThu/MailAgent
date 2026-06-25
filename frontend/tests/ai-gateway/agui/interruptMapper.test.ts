// chat-panel P4 Phase 05 — AG-UI interrupt ↔ ai@6 approval bridge tests.
//
// Proves the two-way translation AND the security invariant: the reverse path only flips a tool
// part's ai@6 state (approval-responded) — it never touches the signed input and never performs a
// write — so the resume runs through the SAME approval-gated tools (no bypass).

import { describe, expect, test } from 'vitest'
import type { UIMessage } from 'ai'

import { AgUiEventType } from '../../../src/ai-gateway/agui/events'
import {
  aguiInterruptResponseToApproval,
  applyApprovalResponseToMessages,
  approvalToAgUiInterrupt,
  interruptToAgUiEvents,
  type ToolApprovalRequestPayload
} from '../../../src/ai-gateway/agui/interruptMapper'

const REQ: ToolApprovalRequestPayload = {
  toolCallId: 'cs1',
  toolName: 'email_prepare_send',
  input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' },
  approval: {
    id: 'apr-1',
    risk: 'blocking',
    reason: 'send needs approval',
    expiresAt: '2026-06-25T00:05:00.000Z',
    contentHash: 'abc123'
  },
  a2ui: { protocol: 'a2ui.mailagent', component: 'SendApprovalCard' }
}

describe('agui interruptMapper — forward (request → interrupt)', () => {
  test('approvalToAgUiInterrupt maps the request to the AG-UI interrupt value (no secrets)', () => {
    const interrupt = approvalToAgUiInterrupt(REQ)
    expect(interrupt).toEqual({
      id: 'apr-1',
      name: 'email_prepare_send',
      payload: {
        toolCallId: 'cs1',
        input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' },
        risk: 'blocking',
        reason: 'send needs approval',
        expiresAt: '2026-06-25T00:05:00.000Z',
        a2ui: { protocol: 'a2ui.mailagent', component: 'SendApprovalCard' }
      }
    })
    // the signing secret / token is never part of the payload (only the public approval id).
    expect(JSON.stringify(interrupt)).not.toMatch(/token|secret|signature/i)
  })

  test('interruptToAgUiEvents → CUSTOM Interrupt then RUN_FINISHED(requires_action)', () => {
    const interrupt = approvalToAgUiInterrupt(REQ)
    const events = interruptToAgUiEvents(interrupt, { threadId: 'th-1', runId: 'rn-1' })
    expect(events).toEqual([
      { type: AgUiEventType.Custom, name: 'Interrupt', value: interrupt },
      {
        type: AgUiEventType.RunFinished,
        threadId: 'th-1',
        runId: 'rn-1',
        result: { status: 'requires_action', interrupt }
      }
    ])
  })
})

describe('agui interruptMapper — reverse (interrupt response → approval)', () => {
  test('approved / edited / rejected decisions normalize through', () => {
    expect(
      aguiInterruptResponseToApproval({ id: 'apr-1', toolCallId: 'cs1', decision: 'approved' })
    ).toMatchObject({ approvalId: 'apr-1', toolCallId: 'cs1', decision: 'approved' })
    expect(
      aguiInterruptResponseToApproval({
        id: 'apr-1',
        toolCallId: 'cs1',
        decision: 'edited',
        editedInput: { subject: 'edited' }
      })
    ).toMatchObject({ decision: 'edited', editedInput: { subject: 'edited' } })
    expect(
      aguiInterruptResponseToApproval({ id: 'apr-1', toolCallId: 'cs1', decision: 'rejected' })
    ).toMatchObject({ decision: 'rejected' })
  })

  test('an UNKNOWN decision is fail-closed to rejected (never silently approved)', () => {
    const out = aguiInterruptResponseToApproval({
      id: 'apr-1',
      toolCallId: 'cs1',
      decision: 'yolo' as unknown as 'approved'
    })
    expect(out.decision).toBe('rejected')
  })

  test('a missing id / toolCallId throws (a malformed response is never an approval)', () => {
    expect(() =>
      aguiInterruptResponseToApproval({ id: '', toolCallId: 'cs1', decision: 'approved' })
    ).toThrow(/approval id/)
    expect(() =>
      aguiInterruptResponseToApproval({ id: 'apr-1', toolCallId: '', decision: 'approved' })
    ).toThrow(/toolCallId/)
  })
})

describe('agui interruptMapper — applyApprovalResponseToMessages (resume bridge)', () => {
  /** A UIMessage history with one tool part awaiting approval (ai@6 `approval-requested` state). */
  function history(): UIMessage[] {
    return [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'send it' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-email_prepare_send',
            toolCallId: 'cs1',
            state: 'approval-requested',
            input: { to: ['a@b.test'], subject: 's', body_markdown: 'b' },
            approval: { id: 'apr-1', signature: 'sig-xyz' }
          }
        ]
      } as unknown as UIMessage
    ]
  }

  test('approved → transitions the part to approval-responded, keeps signature, leaves input intact', () => {
    const { messages, applied } = applyApprovalResponseToMessages(history(), {
      toolCallId: 'cs1',
      approvalId: 'apr-1',
      decision: 'approved'
    })
    expect(applied).toBe(true)
    const part = (messages[1].parts[0] ?? {}) as Record<string, unknown>
    expect(part.state).toBe('approval-responded')
    expect(part.approval).toEqual({ id: 'apr-1', approved: true, signature: 'sig-xyz' })
    // 🔴 the signed input is UNCHANGED — so ai@6's signature stays valid + the guard re-checks it.
    expect(part.input).toEqual({ to: ['a@b.test'], subject: 's', body_markdown: 'b' })
  })

  test('rejected → approved:false (ai@6 emits a denied output, execute never runs)', () => {
    const { messages, applied } = applyApprovalResponseToMessages(history(), {
      toolCallId: 'cs1',
      approvalId: 'apr-1',
      decision: 'rejected'
    })
    expect(applied).toBe(true)
    expect((messages[1].parts[0] as Record<string, unknown>).approval).toMatchObject({
      approved: false
    })
  })

  test('a non-matching approvalId leaves the history untouched (applied=false)', () => {
    const { applied } = applyApprovalResponseToMessages(history(), {
      toolCallId: 'cs1',
      approvalId: 'apr-OTHER',
      decision: 'approved'
    })
    expect(applied).toBe(false)
  })

  test('a toolCallId mismatch is not applied (binding is checked)', () => {
    const { applied } = applyApprovalResponseToMessages(history(), {
      toolCallId: 'cs-OTHER',
      approvalId: 'apr-1',
      decision: 'approved'
    })
    expect(applied).toBe(false)
  })
})
