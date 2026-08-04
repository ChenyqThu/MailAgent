// Stage 0b (harness-expansion epic) — runtime tool-class registry + dynamic-tool assembly gate.
//
// Stage 1 will introduce connector tools whose names are only known at runtime
// (`mcp__<connector>__<tool>`). 0b lands the MECHANISM only; these tests pin the four contract
// points while the registry is guaranteed empty in production:
//   1. an unknown STATIC name still fail-closes to 'exec' (pre-0b behaviour, unchanged);
//   2. a REGISTERED dynamic tool resolves its class and rides the same context-mode matrix
//      (including the grants axis, and the im_chat hard floor);
//   3. an UNREGISTERED dynamic tool is refused at assembly (never enters the ToolSet);
//   4. with zero registrations the assembled ToolSet is structurally identical to the pre-0b
//      assembly (identity pass-through when no dynamicTools input is given).

import { afterEach, describe, expect, test } from 'vitest'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  GATEWAY_TOOL_CLASSES,
  admitDynamicTools,
  applyContextModePolicy,
  classOfTool,
  hasRuntimeToolClass,
  registerRuntimeToolClass,
  resetRuntimeToolClasses,
  type GatewayToolClass
} from '../../../src/ai-gateway/tools/policy'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

import type { ToolSet } from 'ai'

// The module-level registry must never leak across tests.
afterEach(() => resetRuntimeToolClasses())

/** A representative assembled set (read + write families) under an explicit mode. */
function buildBase(
  contextMode: 'manual_chat' | 'untrusted_trigger' | 'cron_headless' | 'im_chat',
  extra?: Partial<Parameters<typeof buildGatewayTools>[0]>
): ToolSet {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    writeToolsEnabled: true,
    approvalGuard: new ApprovalGuard(),
    contextMode,
    ...extra
  })
}

describe('runtime tool-class registry — fail-closed', () => {
  test('an unregistered name still fail-closes to exec (pre-0b behaviour unchanged)', () => {
    expect(hasRuntimeToolClass('mcp__notion__query')).toBe(false)
    expect(classOfTool('mcp__notion__query')).toBe('exec')
  })

  test('register → classOfTool resolves the registered class; reset restores the fail-close', () => {
    registerRuntimeToolClass('mcp__notion__query', 'read')
    expect(hasRuntimeToolClass('mcp__notion__query')).toBe(true)
    expect(classOfTool('mcp__notion__query')).toBe('read')
    resetRuntimeToolClasses()
    expect(hasRuntimeToolClass('mcp__notion__query')).toBe(false)
    expect(classOfTool('mcp__notion__query')).toBe('exec')
  })

  test('a static GATEWAY_TOOL_CLASSES name can never be shadowed', () => {
    expect(() => registerRuntimeToolClass('email_prepare_send', 'read')).toThrow(/unshadowable/)
    expect(classOfTool('email_prepare_send')).toBe('outbound')
    // every static classification stays byte-identical while unrelated registrations exist
    registerRuntimeToolClass('mcp__notion__query', 'read')
    for (const [name, cls] of Object.entries(GATEWAY_TOOL_CLASSES)) {
      expect(classOfTool(name), name).toBe(cls)
    }
  })

  test('junk class values / empty names are rejected and register nothing', () => {
    expect(() =>
      registerRuntimeToolClass('mcp__x__y', 'root' as unknown as GatewayToolClass)
    ).toThrow(/invalid tool class/)
    expect(hasRuntimeToolClass('mcp__x__y')).toBe(false)
    expect(() => registerRuntimeToolClass('', 'read')).toThrow(/empty tool name/)
  })
})

describe('admitDynamicTools — the assembly gate', () => {
  test("no dynamic input → the SAME object (identity: today's assembly is byte-identical)", () => {
    const base = buildBase('manual_chat')
    expect(admitDynamicTools(base)).toBe(base)
    expect(admitDynamicTools(base, undefined)).toBe(base)
    expect(admitDynamicTools(base, {})).toBe(base)
  })

  test('an UNREGISTERED dynamic tool is refused (not admitted into the ToolSet)', () => {
    const base = buildBase('manual_chat')
    const out = admitDynamicTools(base, { mcp__notion__query: base.email_get })
    expect(out.mcp__notion__query).toBeUndefined()
    expect(Object.keys(out)).toEqual(Object.keys(base))
  })

  test('a REGISTERED dynamic tool is admitted', () => {
    registerRuntimeToolClass('mcp__notion__query', 'read')
    const base = buildBase('manual_chat')
    const out = admitDynamicTools(base, { mcp__notion__query: base.email_get })
    expect(out.mcp__notion__query).toBeDefined()
    expect(Object.keys(out)).toEqual([...Object.keys(base), 'mcp__notion__query'])
  })

  test('a name colliding with an already-assembled tool never clobbers it', () => {
    registerRuntimeToolClass('mcp__x__y', 'read')
    const keep = { description: 'keep' } as ToolSet[string]
    const clobber = { description: 'clobber' } as ToolSet[string]
    const out = admitDynamicTools({ mcp__x__y: keep }, { mcp__x__y: clobber })
    expect(out.mcp__x__y).toBe(keep)
  })
})

describe('buildGatewayTools × dynamicTools — matrix integration', () => {
  test('zero registrations: passing an unregistered dynamicTools input changes nothing', () => {
    const withoutOpt = buildBase('manual_chat')
    const withOpt = buildBase('manual_chat', {
      dynamicTools: { mcp__notion__query: withoutOpt.email_get }
    })
    expect(Object.keys(withOpt)).toEqual(Object.keys(withoutOpt))
  })

  test('a registration alone (no dynamicTools input) adds nothing to the assembly', () => {
    registerRuntimeToolClass('mcp__notion__query', 'read')
    const built = buildBase('manual_chat')
    expect(built.mcp__notion__query).toBeUndefined()
    expect(Object.keys(built).every((n) => GATEWAY_TOOL_CLASSES[n] !== undefined)).toBe(true)
  })

  test('a registered read-class dynamic tool registers in every mode (read row of the matrix)', () => {
    registerRuntimeToolClass('mcp__notion__query', 'read')
    const donor = buildBase('manual_chat')
    for (const mode of ['manual_chat', 'untrusted_trigger', 'cron_headless', 'im_chat'] as const) {
      const built = buildBase(mode, { dynamicTools: { mcp__notion__query: donor.email_get } })
      expect(built.mcp__notion__query, `read-class dynamic tool in ${mode}`).toBeDefined()
    }
  })

  test('a registered exec-class dynamic tool follows the exec row: manual yes, headless only under the grant, im_chat never', () => {
    registerRuntimeToolClass('mcp__jira__delete_everything', 'exec')
    const donor = buildBase('manual_chat')
    const dynamicTools = { mcp__jira__delete_everything: donor.email_get }
    // manual — registered
    expect(buildBase('manual_chat', { dynamicTools }).mcp__jira__delete_everything).toBeDefined()
    // headless without a grant — stripped by the LAST assembly step
    expect(
      buildBase('cron_headless', { dynamicTools }).mcp__jira__delete_everything
    ).toBeUndefined()
    // headless with the per-agent exec grant — admitted (the grants axis reaches dynamic tools)
    expect(
      buildBase('cron_headless', {
        dynamicTools,
        agentRunContext: { agentId: 'a', allowedTools: [], modeGrants: { exec: true } }
      }).mcp__jira__delete_everything
    ).toBeDefined()
    // im_chat — hard floor, grants ignored (0b Q10=A; stage 2 PR-1 opens ONLY connector_write/web)
    const imFiltered = applyContextModePolicy(
      admitDynamicTools(buildBase('manual_chat'), dynamicTools),
      'im_chat',
      { exec: true, web: 'open' }
    )
    expect(imFiltered.mcp__jira__delete_everything).toBeUndefined()
  })

  test('a registered connector_write-class dynamic tool: manual + im_chat yes (owner-present), headless only under a write-capable grant', () => {
    // stage 2 PR-1 (08-04 拍板「connector 对 im_chat 全开放」) — the connector_write row is
    // venue-driven for im_chat: registered without grants (the write stays 恒 HITL at approval
    // time), while the headless legs keep the PR3 grant discipline byte-identical.
    registerRuntimeToolClass('mcp__notion__notion_update_page', 'connector_write')
    const donor = buildBase('manual_chat')
    const dynamicTools = { mcp__notion__notion_update_page: donor.email_get }
    expect(buildBase('manual_chat', { dynamicTools }).mcp__notion__notion_update_page).toBeDefined()
    expect(buildBase('im_chat', { dynamicTools }).mcp__notion__notion_update_page).toBeDefined()
    expect(
      buildBase('cron_headless', { dynamicTools }).mcp__notion__notion_update_page
    ).toBeUndefined()
    expect(
      buildBase('cron_headless', {
        dynamicTools,
        agentRunContext: {
          agentId: 'a',
          allowedTools: [],
          modeGrants: { connectors: { notion: 'write' } }
        }
      }).mcp__notion__notion_update_page
    ).toBeDefined()
  })
})
