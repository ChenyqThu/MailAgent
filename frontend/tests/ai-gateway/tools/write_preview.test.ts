// chat-panel P4 Phase 03b — write-tool registry + gate + needsApproval + parity.
//
// The migration contract (phase-03 §7, §10): a migrated write tool must (a) only exist when
// MAILAGENT_AI_SDK_WRITE_TOOLS is on AND a guard is supplied, (b) ALWAYS request approval
// (never silent), and (c) produce output identical to the legacy tool given the same domain
// data (parity). We drive both implementations from one fixture: the legacy ToolDef
// (createWriteTools over a mock ChatToolPlatform) and the gateway tool (createWriteTools over
// a mockDomain returning the SAME data), then compare the legacy ToolResult.output against
// the gateway tool's return value.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { createWriteTools as createLegacyWriteTools } from '@shared/chat/tools/builtin/write'
import type { ChatToolPlatform } from '@shared/chat/platform'
import type { ToolDef, ToolExecCtx } from '@shared/chat/tools/registry'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { createWriteTools, GATEWAY_WRITE_TOOL_NAMES } from '../../../src/ai-gateway/tools/write'
import { GATEWAY_READ_TOOL_NAMES } from '../../../src/ai-gateway/tools'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

const CTX: ToolExecCtx = { sessionId: 0, emailId: null, signal: new AbortController().signal }

/** Minimal ChatToolPlatform — only the write primitives the migrated tools call. */
function mockPlatform(over: Partial<ChatToolPlatform>): ChatToolPlatform {
  return over as unknown as ChatToolPlatform
}

/** Run a legacy write ToolDef and unwrap its ToolResult.output (throws on ok:false). */
async function legacyOutput(tools: ToolDef[], name: string, input: unknown): Promise<unknown> {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`legacy tool ${name} not found`)
  const r = await def.handler(input, CTX)
  if (!r.ok) throw new Error(`legacy ${name} failed: ${r.code}`)
  return r.output
}

/** Drive a gateway write tool's full HITL two-call shape: needsApproval (registers the
 *  approval record) → execute (verifies + runs). Returns the tool output. */
async function approveAndRun(
  tool: Tool,
  input: unknown,
  opts?: { toolCallId?: string; execInput?: unknown }
): Promise<unknown> {
  const toolCallId = opts?.toolCallId ?? 'tc-w1'
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(opts?.execInput ?? input, { toolCallId, messages: [], abortSignal: undefined })
}

describe('write tools — flag gating (buildGatewayTools)', () => {
  test('writeToolsEnabled off → read-only (no write tools)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: false
    })
    const names = Object.keys(tools)
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(names).not.toContain(w)
    for (const r of GATEWAY_READ_TOOL_NAMES) expect(names).toContain(r)
  })

  test('writeToolsEnabled on but NO guard → still read-only (a write tool cannot exist without its guard)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: true
    })
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(Object.keys(tools)).not.toContain(w)
  })

  test('writeToolsEnabled on + guard → the five write tools are added alongside reads', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard()
    })
    const names = Object.keys(tools)
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(names).toContain(w)
    for (const r of GATEWAY_READ_TOOL_NAMES) expect(names).toContain(r)
  })
})

describe('write tools — always need approval (never silent)', () => {
  test('every write tool declares needsApproval', () => {
    const tools = createWriteTools(
      mockDomain(() => okEnvelope({})),
      [],
      new ApprovalGuard()
    )
    for (const name of GATEWAY_WRITE_TOOL_NAMES) {
      const tool = tools[name]
      expect(tool, name).toBeDefined()
      // needsApproval is set (a function in our impl) → ai@6 will gate execution.
      expect(tool.needsApproval, name).toBeTruthy()
    }
  })
})

describe('write tools — parity (legacy harness ⋈ AI SDK Gateway)', () => {
  test('email_flag — legacy output === gateway output', async () => {
    const DATA = { updated_ids: [9], outbox_entries: [{ kind: 'mailapp' }] }
    const legacy = createLegacyWriteTools(mockPlatform({ flagEmail: async () => DATA }))
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const input = { internal_id: 9, is_flagged: true }
    const legacyOut = await legacyOutput(legacy, 'email_flag', input)
    const gatewayOut = await approveAndRun(gateway.email_flag, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({
      internal_id: 9,
      applied: { is_flagged: true },
      updated_ids: [9],
      user_edited: false
    })
  })

  test('email_archive — legacy output === gateway output', async () => {
    const DATA = { from_mailbox: '收件箱', to_mailbox: '存档', notion_updated: true }
    const legacy = createLegacyWriteTools(mockPlatform({ archiveEmail: async () => DATA }))
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const input = { internal_id: 9 }
    const legacyOut = await legacyOutput(legacy, 'email_archive', input)
    const gatewayOut = await approveAndRun(gateway.email_archive, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({ internal_id: 9, archived: true, to_mailbox: '存档' })
  })

  test('email_pin — legacy output === gateway output', async () => {
    const DATA = { is_pinned: true, changed: true }
    const legacy = createLegacyWriteTools(mockPlatform({ setPin: async () => DATA }))
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const input = { internal_id: 9, pinned: true }
    const legacyOut = await legacyOutput(legacy, 'email_pin', input)
    const gatewayOut = await approveAndRun(gateway.email_pin, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({ internal_id: 9, is_pinned: true, changed: true })
  })

  test('email_draft_reply — legacy output === gateway output', async () => {
    // Legacy platform.draftReply returns the projected ChatToolDraftResult; the gateway's
    // domain.draftReply projects the POST /email/draft data block to the SAME shape.
    const PROJECTED = {
      internalId: 9,
      mailbox: 'Drafts',
      accountName: null,
      draftId: 'reply_all_9'
    }
    const legacy = createLegacyWriteTools(mockPlatform({ draftReply: async () => PROJECTED }))
    const gateway = createWriteTools(
      mockDomain(() =>
        okEnvelope({ internal_id: 9, drafts_folder: 'Drafts', method: 'reply_all_9' })
      ),
      [],
      new ApprovalGuard()
    )
    const input = { internal_id: 9, body_markdown: 'thanks!' }
    const legacyOut = await legacyOutput(legacy, 'email_draft_reply', input)
    const gatewayOut = await approveAndRun(gateway.email_draft_reply, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({
      internal_id: 9,
      mailbox: 'Drafts',
      draft_id: 'reply_all_9',
      final_body_markdown: 'thanks!'
    })
  })

  test('email_resync — legacy output === gateway output', async () => {
    const DATA = { old_page_id: 'p-old', new_page_id: 'p-new', action: 'recreated' }
    const legacy = createLegacyWriteTools(mockPlatform({ resyncEmail: async () => DATA }))
    const gateway = createWriteTools(
      mockDomain(() => okEnvelope(DATA)),
      [],
      new ApprovalGuard()
    )
    const input = { internal_id: 9 }
    const legacyOut = await legacyOutput(legacy, 'email_resync', input)
    const gatewayOut = await approveAndRun(gateway.email_resync, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({ internal_id: 9, new_page_id: 'p-new', action: 'recreated' })
  })
})
