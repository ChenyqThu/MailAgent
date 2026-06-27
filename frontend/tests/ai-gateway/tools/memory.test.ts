// chat-panel post-cutover M0 — memory-tool registry gate + needsApproval + parity.
//
// The restore contract: the four memory tools (lost at the v0.20.0 cutover) come back on the
// gateway, but (a) ONLY when MAILAGENT_AI_SDK_MEMORY_TOOLS is on AND a guard is supplied, so
// flag-off the gateway tool set is byte-identical to the cutover set; (b) memory_write/delete
// ALWAYS request approval (preview tier — never a silent durable write); (c) every tool's output
// matches the legacy memory tool given the SAME store row (parity). We drive both implementations
// from one fixture: the legacy ToolDef (createMemoryTools over a mock ChatToolPlatform) and the
// gateway tool (createMemoryTools over a mockDomain returning the SAME data), then compare.

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { createMemoryTools as createLegacyMemoryTools } from '@shared/chat/tools/builtin/memory'
import type { ChatToolPlatform } from '@shared/chat/platform'
import type { AgentMemoryEntry } from '@shared/chat/model'
import type { ToolDef, ToolExecCtx } from '@shared/chat/tools/registry'

import { buildGatewayTools, GATEWAY_READ_TOOL_NAMES } from '../../../src/ai-gateway/tools'
import { createMemoryTools, GATEWAY_MEMORY_TOOL_NAMES } from '../../../src/ai-gateway/tools/memory'
import { GATEWAY_WRITE_TOOL_NAMES } from '../../../src/ai-gateway/tools/write'
import { GATEWAY_SEND_TOOL_NAMES } from '../../../src/ai-gateway/tools/send'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope, runTool } from './_helpers'

// Legacy ctx: sessionId=0 (the legacy memory_write stamps source.session_id from it). The gateway
// has no sessionId at the tool layer → it stamps null; the parity tests below compare outputs
// over a FIXED returned row, so this input-provenance difference doesn't affect the output massage.
const CTX: ToolExecCtx = { sessionId: 0, emailId: null, signal: new AbortController().signal }

/** Minimal ChatToolPlatform — only the memory primitives the migrated tools call. */
function mockPlatform(over: Partial<ChatToolPlatform>): ChatToolPlatform {
  return over as unknown as ChatToolPlatform
}

/** Run a legacy memory ToolDef and unwrap its ToolResult.output (throws on ok:false). */
async function legacyOutput(tools: ToolDef[], name: string, input: unknown): Promise<unknown> {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`legacy tool ${name} not found`)
  const r = await def.handler(input, CTX)
  if (!r.ok) throw new Error(`legacy ${name} failed: ${r.code}`)
  return r.output
}

/** Drive a gateway write-memory tool's HITL two-call shape: needsApproval → execute. */
async function approveAndRun(tool: Tool, input: unknown): Promise<unknown> {
  const toolCallId = 'tc-m1'
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

/** A canned agent_memory_kv row both implementations get back from the store (so the parity
 *  comparison is over the output MASSAGE, not the provenance inputs). */
const ROW: AgentMemoryEntry = {
  scope: 'user',
  key: 'reply_language',
  value_json: '"English"',
  source_wiki_path: null,
  source_session_id: null,
  source_message_id: null,
  source_tool_use_id: 'tc-m1',
  priority: 0,
  created_at: 111,
  updated_at: 222
}

describe('memory tools — flag gating (buildGatewayTools)', () => {
  test('memoryToolsEnabled off → no memory tools (byte-identical to the cutover set)', () => {
    // The cutover tool set with everything master-on = reads + writes + send (NO memory).
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      sendToolEnabled: true,
      sendSigningSecret: 'secret'
      // memoryToolsEnabled intentionally unset
    })
    const expected = [
      ...GATEWAY_READ_TOOL_NAMES,
      ...GATEWAY_WRITE_TOOL_NAMES,
      ...GATEWAY_SEND_TOOL_NAMES
    ].sort()
    expect(Object.keys(tools).sort()).toEqual(expected)
    for (const m of GATEWAY_MEMORY_TOOL_NAMES) expect(Object.keys(tools)).not.toContain(m)
  })

  test('memoryToolsEnabled on but NO guard → still no memory tools (a write tool needs its guard)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      memoryToolsEnabled: true
    })
    for (const m of GATEWAY_MEMORY_TOOL_NAMES) expect(Object.keys(tools)).not.toContain(m)
  })

  test('memoryToolsEnabled on + guard → the four memory tools are added alongside reads', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      memoryToolsEnabled: true,
      approvalGuard: new ApprovalGuard()
    })
    const names = Object.keys(tools)
    for (const m of GATEWAY_MEMORY_TOOL_NAMES) expect(names).toContain(m)
    for (const r of GATEWAY_READ_TOOL_NAMES) expect(names).toContain(r)
  })

  test('memory flag is independent of writeToolsEnabled (on with writes off)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope({})),
      writeToolsEnabled: false,
      memoryToolsEnabled: true,
      approvalGuard: new ApprovalGuard()
    })
    const names = Object.keys(tools)
    for (const m of GATEWAY_MEMORY_TOOL_NAMES) expect(names).toContain(m)
    for (const w of GATEWAY_WRITE_TOOL_NAMES) expect(names).not.toContain(w)
  })
})

describe('memory tools — approval tiers (reads silent, writes need approval)', () => {
  test('memory_list / memory_get are silent (no needsApproval); memory_write / delete need approval', () => {
    const tools = createMemoryTools(
      mockDomain(() => okEnvelope([])),
      [],
      new ApprovalGuard()
    )
    expect((tools.memory_list as { needsApproval?: unknown }).needsApproval).toBeUndefined()
    expect((tools.memory_get as { needsApproval?: unknown }).needsApproval).toBeUndefined()
    expect(tools.memory_write.needsApproval).toBeTruthy()
    expect(tools.memory_delete.needsApproval).toBeTruthy()
  })

  test('memory_write.execute without prior approval fails closed (E_APPROVAL_NOT_FOUND)', async () => {
    // Call execute directly (skip needsApproval/register) → the shared ApprovalGuard.verify finds
    // no record and fails closed, so a durable memory write can't bypass the HITL gate.
    const tools = createMemoryTools(
      mockDomain(() => okEnvelope(ROW)),
      [],
      new ApprovalGuard()
    )
    await expect(runTool(tools.memory_write, { key: 'k', value: 'v' })).rejects.toMatchObject({
      code: 'E_APPROVAL_NOT_FOUND'
    })
  })
})

describe('memory tools — parity (legacy harness ⋈ AI SDK Gateway)', () => {
  test('memory_list — legacy {count, entries} === gateway', async () => {
    const ENTRIES = [ROW, { ...ROW, key: 'signature', value_json: '"— Lucien"' }]
    const legacy = createLegacyMemoryTools(mockPlatform({ listMemory: async () => ENTRIES }))
    const gateway = createMemoryTools(
      mockDomain(() => okEnvelope(ENTRIES)),
      [],
      new ApprovalGuard()
    )
    const input = { scope: 'user' }
    const legacyOut = await legacyOutput(legacy, 'memory_list', input)
    const gatewayOut = await runTool(gateway.memory_list, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toEqual({ count: 2, entries: ENTRIES })
  })

  test('memory_get found → both {found:true, ...entry}; defaults scope=user', async () => {
    const legacy = createLegacyMemoryTools(mockPlatform({ getMemory: async () => ROW }))
    const gateway = createMemoryTools(
      mockDomain(() => okEnvelope(ROW)),
      [],
      new ApprovalGuard()
    )
    const input = { key: 'reply_language' } // no scope → both default to 'user'
    const legacyOut = await legacyOutput(legacy, 'memory_get', input)
    const gatewayOut = await runTool(gateway.memory_get, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({ found: true, key: 'reply_language', scope: 'user' })
  })

  test('memory_get not-found → both {found:false, key}', async () => {
    const legacy = createLegacyMemoryTools(mockPlatform({ getMemory: async () => null }))
    const gateway = createMemoryTools(
      mockDomain(() => okEnvelope(null)),
      [],
      new ApprovalGuard()
    )
    const input = { key: 'missing' }
    const legacyOut = await legacyOutput(legacy, 'memory_get', input)
    const gatewayOut = await runTool(gateway.memory_get, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toEqual({ found: false, key: 'missing' })
  })

  test('memory_write — legacy output === gateway output (over the SAME returned row)', async () => {
    const legacy = createLegacyMemoryTools(mockPlatform({ writeMemory: async () => ROW }))
    const gateway = createMemoryTools(
      mockDomain(() => okEnvelope(ROW)),
      [],
      new ApprovalGuard()
    )
    const input = { key: 'reply_language', value: 'English' }
    const legacyOut = await legacyOutput(legacy, 'memory_write', input)
    const gatewayOut = await approveAndRun(gateway.memory_write, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toMatchObject({
      saved: true,
      scope: 'user',
      key: 'reply_language',
      priority: 0,
      updated_at: 222,
      source: { session_id: null, message_id: null, tool_use_id: 'tc-m1' },
      user_edited: false
    })
  })

  test('memory_delete — legacy {deleted, key} === gateway', async () => {
    const legacy = createLegacyMemoryTools(mockPlatform({ deleteMemory: async () => 1 }))
    const gateway = createMemoryTools(
      mockDomain(() => okEnvelope({ deleted: 1 })),
      [],
      new ApprovalGuard()
    )
    const input = { key: 'reply_language' }
    const legacyOut = await legacyOutput(legacy, 'memory_delete', input)
    const gatewayOut = await approveAndRun(gateway.memory_delete, input)
    expect(gatewayOut).toEqual(legacyOut)
    expect(gatewayOut).toEqual({ deleted: 1, key: 'reply_language' })
  })

  test('memory_write — value required (E_INVALID_ARG) after approval, like legacy', async () => {
    const gateway = createMemoryTools(
      mockDomain(() => okEnvelope(ROW)),
      [],
      new ApprovalGuard()
    )
    // No `value` → the run throws E_INVALID_ARG (surfaced as a tool-error part).
    await expect(approveAndRun(gateway.memory_write, { key: 'k' })).rejects.toMatchObject({
      code: 'E_INVALID_ARG'
    })
  })
})

describe('memory tools — wire provenance (best-effort: all null on the gateway path)', () => {
  test('memory_write nulls the provenance the gateway tool layer cannot reach', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const domain = mockDomain((url, body) => {
      if (url.includes('/chat/memory') && body) bodies.push(JSON.parse(body))
      return okEnvelope(ROW)
    })
    const gateway = createMemoryTools(domain, [], new ApprovalGuard())
    await approveAndRun(gateway.memory_write, { key: 'reply_language', value: 'English' })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      scope: 'user',
      key: 'reply_language',
      valueJson: '"English"',
      sourceSessionId: null,
      sourceMessageId: null,
      sourceToolUseId: null,
      sourceWikiPath: null
    })
  })
})
