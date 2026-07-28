// issue #67 item 1 — email_flag must not report success for an email that doesn't exist.
//
// set_flags is the ONE write op with a SOFT not-found: serve-api returns HTTP 200 with
// {updated_ids: [], not_found: [id]} and writes nothing (every other write op raises 404).
// The gateway's DomainFlagResult used to omit not_found entirely, so the tool projected
// `applied: {...}` + `updated_ids: []` — which a model reads as "flagged, done".
//
// Two halves are pinned here:
//   1. the happy path stays byte-identical (no new key leaks into the success shape —
//      write_preview.test.ts pins the same snapshot; this is the second lock),
//   2. the not-found path is unmistakable: ok:false + not_found, and NO `applied` key.

import { describe, expect, test } from 'vitest'

import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { Tool } from 'ai'
import { mockDomain, okEnvelope } from './_helpers'

async function approveAndRun(tool: Tool, input: unknown): Promise<unknown> {
  const toolCallId = 'tc-nf1'
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(input, { toolCallId, messages: [], abortSignal: undefined })
}

function flagToolReturning(data: unknown): Tool {
  return createWriteTools(
    mockDomain(() => okEnvelope(data)),
    [],
    new ApprovalGuard()
  ).email_flag
}

describe('email_flag — soft not-found is never reported as success', () => {
  test('not_found non-empty → ok:false + not_found, and no `applied` key to misread', async () => {
    const out = (await approveAndRun(
      flagToolReturning({ updated_ids: [], not_found: [999], outbox_entries: [] }),
      { internal_id: 999, is_flagged: true }
    )) as Record<string, unknown>

    expect(out.ok).toBe(false)
    expect(out.not_found).toEqual([999])
    expect(out.updated_ids).toEqual([])
    // The key that used to state the REQUESTED patch as though it had landed must be gone.
    expect(out).not.toHaveProperty('applied')
    // The requested patch is still reported, under a name that cannot be read as "applied".
    expect(out.requested).toEqual({
      is_read: undefined,
      is_flagged: true,
      processing_status: undefined
    })
  })

  test('happy path is byte-identical — no not_found/ok keys leak into the success shape', async () => {
    const out = (await approveAndRun(
      flagToolReturning({ updated_ids: [9], outbox_entries: [{ kind: 'mailapp' }] }),
      { internal_id: 9, is_flagged: true }
    )) as Record<string, unknown>

    expect(out).toEqual({
      internal_id: 9,
      applied: { is_read: undefined, is_flagged: true, processing_status: undefined },
      updated_ids: [9],
      outbox_entries: [{ kind: 'mailapp' }],
      user_edited: false
    })
  })

  test('Python omits not_found when empty → absent key must stay on the success path', async () => {
    // Mirrors src/services/mail_write.py: "not_found 恒为 list; CLI 适配器仅在非空时把它
    //放进 emit 的 data". An explicit empty array must behave exactly like an absent key.
    const out = (await approveAndRun(
      flagToolReturning({ updated_ids: [9], not_found: [], outbox_entries: [] }),
      { internal_id: 9, is_read: true }
    )) as Record<string, unknown>

    expect(out).not.toHaveProperty('ok')
    expect(out).not.toHaveProperty('not_found')
    expect(out.applied).toEqual({
      is_read: true,
      is_flagged: undefined,
      processing_status: undefined
    })
  })
})
