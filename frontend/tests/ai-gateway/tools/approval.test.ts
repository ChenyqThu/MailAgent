// chat-panel P4 Phase 03b — HITL approval guard + write-tool execution gate.
//
// Covers the domain ApprovalGuard (id/hash/expiry, layered on ai@6's signed approval) and
// the write tool's two-call execution gate (needsApproval registers → execute verifies):
//   - needsApproval registers a keep-first record; execute with the approved input runs the
//     domain write + audits approval_status='approved' + approval_hash;
//   - NO record (execute without a prior approval) → E_APPROVAL_NOT_FOUND, the domain write
//     never runs (no silent write), audit approval_status='rejected';
//   - a directly-changed exec input (ANY tier) → E_APPROVAL_HASH_MISMATCH (no write);
//   - an edit-tier UI edit via applyEdit → executes the edited input, audit approval_status='edited';
//   - expired approval → E_APPROVAL_EXPIRED.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import {
  ApprovalError,
  ApprovalGuard,
  hashApprovalInput
} from '../../../src/ai-gateway/security/approval'
import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import type { GatewayToolAuditEntry } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

// ── ApprovalGuard unit ──────────────────────────────────────────────────────

describe('ApprovalGuard — register / verify', () => {
  test('register stamps a record; verify with the same input passes (not edited)', () => {
    const g = new ApprovalGuard()
    const rec = g.register('tc1', 'email_flag', 'preview', { internal_id: 9, is_flagged: true })
    expect(rec.approvalId).toMatch(/^apr-/)
    expect(rec.inputHash).toMatch(/^[0-9a-f]{64}$/)
    const v = g.verify('tc1', { internal_id: 9, is_flagged: true })
    expect(v.userEdited).toBe(false)
    expect(v.record.approvalId).toBe(rec.approvalId)
  })

  test('register is keep-first (a second register for the same toolCallId is a no-op)', () => {
    const g = new ApprovalGuard()
    const first = g.register('tc1', 'email_flag', 'preview', { internal_id: 9 })
    const second = g.register('tc1', 'email_flag', 'preview', { internal_id: 999 }) // swapped input
    expect(second).toBe(first)
    expect(second.inputHash).toBe(first.inputHash) // original hash preserved
  })

  test('hashApprovalInput is key-order independent', () => {
    expect(hashApprovalInput({ a: 1, b: 2 })).toBe(hashApprovalInput({ b: 2, a: 1 }))
    expect(hashApprovalInput({ a: 1 })).not.toBe(hashApprovalInput({ a: 2 }))
  })

  test('verify with no record → E_APPROVAL_NOT_FOUND', () => {
    const g = new ApprovalGuard()
    expect(() => g.verify('missing', { internal_id: 1 })).toThrow(ApprovalError)
    try {
      g.verify('missing', { internal_id: 1 })
    } catch (e) {
      expect((e as ApprovalError).code).toBe('E_APPROVAL_NOT_FOUND')
    }
  })

  test('preview-tier input swap → E_APPROVAL_HASH_MISMATCH', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'email_flag', 'preview', { internal_id: 9, is_flagged: true })
    try {
      g.verify('tc1', { internal_id: 9, is_flagged: false }) // swapped
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalError)
      expect((e as ApprovalError).code).toBe('E_APPROVAL_HASH_MISMATCH')
    }
  })

  test('edit-tier directly-changed exec input (no applyEdit) → E_APPROVAL_HASH_MISMATCH (M4b HIGH-1)', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'email_draft_reply', 'edit', { internal_id: 9, body_markdown: 'draft a' }, [
      'body_markdown'
    ])
    // A raw changed exec input is NOT a sanctioned edit (edits go via applyEdit) → rejected.
    try {
      g.verify('tc1', { internal_id: 9, body_markdown: 'draft b (direct swap)' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalError)
      expect((e as ApprovalError).code).toBe('E_APPROVAL_HASH_MISMATCH')
    }
  })

  test('edit-tier UI edit via applyEdit → verify (replayed unchanged input) runs the edited input', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'email_draft_reply', 'edit', { internal_id: 9, body_markdown: 'draft a' }, [
      'body_markdown'
    ])
    g.applyEdit('tc1', { body_markdown: 'draft b (user edited)' })
    // The ai@6 history input is replayed UNCHANGED (hashes to the approved input); the override wins.
    const v = g.verify('tc1', { internal_id: 9, body_markdown: 'draft a' })
    expect(v.userEdited).toBe(true)
    expect((v.effectiveInput as { body_markdown: string }).body_markdown).toBe(
      'draft b (user edited)'
    )
  })

  test('edit-tier identity retarget via direct exec input → rejected (M4b HIGH-1: update_system_md doc_name)', () => {
    const g = new ApprovalGuard()
    g.register('tc1', 'update_system_md', 'edit', { doc_name: 'user', content: 'pref' })
    // approve {doc_name:'user'} then try to execute {doc_name:'rules'} → must NOT retarget.
    try {
      g.verify('tc1', { doc_name: 'rules', content: 'weaken safety' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ApprovalError).code).toBe('E_APPROVAL_HASH_MISMATCH')
    }
  })

  test('expired approval → E_APPROVAL_EXPIRED', () => {
    let clock = 1_000
    const g = new ApprovalGuard({ ttlMs: 100, now: () => clock })
    g.register('tc1', 'email_flag', 'preview', { internal_id: 9 })
    clock = 1_000 + 101 // past expiry
    try {
      g.verify('tc1', { internal_id: 9 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalError)
      expect((e as ApprovalError).code).toBe('E_APPROVAL_EXPIRED')
    }
  })
})

// ── write tool execution gate (through the guard) ─────────────────────────────

interface Harness {
  tools: Record<string, Tool>
  collector: GatewayToolAuditEntry[]
  guard: ApprovalGuard
  domainCalls: string[]
}

function harness(data: unknown = { updated_ids: [9], outbox_entries: [] }): Harness {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domainCalls: string[] = []
  const domain = mockDomain((url) => {
    domainCalls.push(url)
    return okEnvelope(data)
  })
  const tools = createWriteTools(domain, collector, guard)
  return { tools, collector, guard, domainCalls }
}

const needsApprovalOf = (tool: Tool) =>
  tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
const executeOf = (tool: Tool) =>
  tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>

describe('write tool — approve → second call executes + audits approval', () => {
  test('needsApproval registers; execute writes; audit records approval_status + hash', async () => {
    const h = harness()
    const input = { internal_id: 9, is_flagged: true }
    const needs = await needsApprovalOf(h.tools.email_flag)(input, {
      toolCallId: 'tc1',
      messages: []
    })
    expect(needs).toBe(true) // write tools always need approval
    expect(h.domainCalls).toHaveLength(0) // first call does NOT execute the write

    const out = await executeOf(h.tools.email_flag)(input, { toolCallId: 'tc1', messages: [] })
    expect(out).toMatchObject({ internal_id: 9, user_edited: false })
    expect(h.domainCalls).toHaveLength(1) // second call executes the write
    expect(h.domainCalls[0]).toContain('/email/9/flag')

    expect(h.collector).toHaveLength(1)
    const audit = h.collector[0]
    expect(audit).toMatchObject({
      toolName: 'email_flag',
      status: 'ok',
      confirmationTier: 'preview',
      approvalStatus: 'approved'
    })
    expect(audit.approvalHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('write tool — no execution without a valid approval', () => {
  test('execute without a prior needsApproval (no record) → E_APPROVAL_NOT_FOUND, write never runs', async () => {
    const h = harness()
    await expect(
      executeOf(h.tools.email_flag)(
        { internal_id: 9, is_flagged: true },
        { toolCallId: 'orphan', messages: [] }
      )
    ).rejects.toThrow(/E_APPROVAL_NOT_FOUND/)
    expect(h.domainCalls).toHaveLength(0) // the domain write was NEVER called
    expect(h.collector[0]).toMatchObject({ status: 'error', approvalStatus: 'rejected' })
  })

  test('preview-tier input swap between approval and execute → E_APPROVAL_HASH_MISMATCH, no write', async () => {
    const h = harness()
    await needsApprovalOf(h.tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc1', messages: [] }
    )
    await expect(
      executeOf(h.tools.email_flag)(
        { internal_id: 9, is_flagged: false },
        { toolCallId: 'tc1', messages: [] }
      )
    ).rejects.toThrow(/E_APPROVAL_HASH_MISMATCH/)
    expect(h.domainCalls).toHaveLength(0)
    expect(h.collector[0]).toMatchObject({ status: 'error', approvalStatus: 'rejected' })
  })
})

describe('write tool — edit-tier executes the applyEdit-edited input + audits as edited', () => {
  test('email_draft_reply: approve body A, applyEdit→B, execute (replayed A) → writes B, approval_status=edited', async () => {
    const h = harness({ internal_id: 9, drafts_folder: 'Drafts', method: 'reply_all_9' })
    const proposed = { internal_id: 9, body_markdown: 'draft A' }
    await needsApprovalOf(h.tools.email_draft_reply)(proposed, { toolCallId: 'tc1', messages: [] })
    // The user edits the body on the card → applyEdit (resolve side-channel). The ai@6 history input
    // stays 'draft A' and is replayed UNCHANGED into execute; the applyEdit override is authoritative.
    h.guard.applyEdit('tc1', { body_markdown: 'draft B (edited)' })
    const out = (await executeOf(h.tools.email_draft_reply)(proposed, {
      toolCallId: 'tc1',
      messages: []
    })) as { user_edited: boolean; final_body_markdown: string }
    expect(out.user_edited).toBe(true)
    expect(out.final_body_markdown).toBe('draft B (edited)') // the applyEdit-edited body was written
    expect(h.domainCalls).toHaveLength(1)
    expect(h.collector[0]).toMatchObject({
      toolName: 'email_draft_reply',
      confirmationTier: 'edit',
      approvalStatus: 'edited',
      status: 'ok'
    })
    expect(h.collector[0].userEditedInputJson).toContain('draft B')
  })
})
