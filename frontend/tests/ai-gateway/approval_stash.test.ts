// Part B (harness 上岛) — ApprovalRunStash unit tests.
//
// The stash is the server-side resume source: it holds a paused approval run keyed by toolCallId,
// hands out an unguessable resumeToken, and claim()s it ONE-SHOT (single-use, token- + expiry-gated)
// so an island decision resumes at most once. Pure Node — no ai / http / electron.

import { describe, expect, test } from 'vitest'

import { ApprovalRunStash } from '../../src/ai-gateway/approvalStash'
import type { MailAgentUIMessage } from '../../src/shared/assistant/uiMessage'

const RESP = { id: 'a1', role: 'assistant', parts: [] } as unknown as MailAgentUIMessage

function makeInput(toolCallId = 'tc1') {
  return {
    toolCallId,
    approvalId: 'ap1',
    toolName: 'email_draft_reply',
    sessionId: 42,
    body: { messages: [{ id: 'u1', role: 'user', parts: [] }], model: 'claude-sonnet-4-6' },
    responseMessage: RESP,
    // S2 W0 — the pause-time trusted mode is frozen into the stash (required field).
    contextMode: 'manual_chat' as const
  }
}

describe('ApprovalRunStash — stash + one-shot claim', () => {
  test('stash returns a non-empty resumeToken and claim with it returns the entry once', () => {
    const s = new ApprovalRunStash()
    const token = s.stash(makeInput())
    expect(token).toBeTruthy()
    expect(s.size()).toBe(1)
    const claimed = s.claim('tc1', token)
    expect(claimed).not.toBeNull()
    expect(claimed!.toolName).toBe('email_draft_reply')
    expect(claimed!.approvalId).toBe('ap1')
    // one-shot: a second claim finds nothing
    expect(s.claim('tc1', token)).toBeNull()
    expect(s.size()).toBe(0)
  })

  test('wrong token → null WITHOUT consuming (no grief)', () => {
    const s = new ApprovalRunStash()
    const token = s.stash(makeInput())
    expect(s.claim('tc1', 'wrong-token')).toBeNull()
    // entry still there → the legitimate token still works
    expect(s.size()).toBe(1)
    expect(s.claim('tc1', token)).not.toBeNull()
  })

  test('missing toolCallId → null (fail-closed: gateway restarted / never stashed)', () => {
    const s = new ApprovalRunStash()
    expect(s.claim('never', 'x')).toBeNull()
  })

  test('expired entry → claim returns null and drops it', () => {
    let clock = 1_000
    const s = new ApprovalRunStash({ ttlMs: 100, now: () => clock })
    const token = s.stash(makeInput())
    clock = 1_000 + 101 // past expiry
    expect(s.claim('tc1', token)).toBeNull()
    expect(s.size()).toBe(0)
  })

  test('peek is read-only (does not consume / does not expire)', () => {
    const s = new ApprovalRunStash()
    const token = s.stash(makeInput())
    expect(s.peek('tc1')?.resumeToken).toBe(token)
    expect(s.peek('tc1')?.resumeToken).toBe(token) // still there
    expect(s.size()).toBe(1)
  })

  test('re-stash same toolCallId → fresh token, keep-latest (old token no longer claims)', () => {
    const s = new ApprovalRunStash()
    const t1 = s.stash(makeInput())
    const t2 = s.stash(makeInput())
    expect(t2).not.toBe(t1)
    expect(s.size()).toBe(1)
    expect(s.claim('tc1', t1)).toBeNull() // old token stale
    // re-stash to claim with the latest
    const t3 = s.stash(makeInput())
    expect(s.claim('tc1', t3)).not.toBeNull()
  })

  test('gc drops expired rows on stash', () => {
    let clock = 0
    const s = new ApprovalRunStash({ ttlMs: 100, now: () => clock })
    s.stash(makeInput('a'))
    clock = 200 // 'a' now expired
    s.stash(makeInput('b')) // stash() runs gc first
    expect(s.peek('a')).toBeNull()
    expect(s.peek('b')).not.toBeNull()
  })

  test('deterministic token generator injectable (for other tests)', () => {
    let n = 0
    const s = new ApprovalRunStash({ genToken: () => `tok-${n++}` })
    expect(s.stash(makeInput('a'))).toBe('tok-0')
    expect(s.stash(makeInput('b'))).toBe('tok-1')
  })
})

// GET /api/ai/approval/pending backing probe — read-only per-session lookup.
describe('ApprovalRunStash — peekBySession (reloaded-session pending probe)', () => {
  test('returns the live entry for the session; other sessions → null; never consumes', () => {
    const s = new ApprovalRunStash()
    const token = s.stash(makeInput())
    expect(s.peekBySession(42)?.toolName).toBe('email_draft_reply')
    expect(s.peekBySession(42)?.resumeToken).toBe(token)
    expect(s.peekBySession(99)).toBeNull()
    // read-only: repeated probes leave the entry claimable
    expect(s.peekBySession(42)).not.toBeNull()
    expect(s.size()).toBe(1)
    expect(s.claim('tc1', token)).not.toBeNull()
  })

  test('expired entry → null (skipped, NOT deleted — no gc on the read path)', () => {
    let clock = 0
    const s = new ApprovalRunStash({ ttlMs: 100, now: () => clock })
    s.stash(makeInput())
    clock = 200
    expect(s.peekBySession(42)).toBeNull()
    expect(s.size()).toBe(1) // still stored; claim/stash own the cleanup
  })

  test('repause chain → keep-latest: the most recently stashed approval wins', () => {
    let clock = 0
    const s = new ApprovalRunStash({ now: () => clock })
    s.stash({ ...makeInput('tc-hop1'), toolName: 'email_draft_reply' })
    clock = 10
    s.stash({ ...makeInput('tc-hop2'), toolName: 'email_prepare_send' })
    expect(s.peekBySession(42)?.toolCallId).toBe('tc-hop2')
    expect(s.peekBySession(42)?.toolName).toBe('email_prepare_send')
  })
})
