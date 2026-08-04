// Stage 1 PR2 (harness-expansion epic) — MCP connector dynamic tools: naming, manifest fetch
// degradation, registration rules, runtime class fail-closed matrix, headless zero-call seam.
//
// Pins (task 08-01 PR2 contract):
//   1. name mapping (mcpToolName.ts — the ONE source both gateway + renderer card consume);
//   2. fetchConnectorManifest NEVER throws: list failure → null (silent degradation), a single
//      connector's tools failure skips just that connector;
//   3. createConnectorTools registration rules: enabled+non-orphan+non-delete only, read→'read',
//      write/update→'connector_write', unknown crud skipped, static-name collision skipped;
//   4. connector_write is fail-closed in the matrix: manual only, DENIED in every non-manual mode
//      under ANY grants (the PR3 grant key does not exist yet — 漏配即 deny);
//   5. shouldLoadConnectorTools — the manual-chat-only seam (headless = zero calls, not
//      fetch-then-deny);
//   6. read results are UNTRUSTED_MCP_TOOL-fenced + truncation surfaced; write tools register the
//      approval record (edit tier) and never执行 without the guard.

import { afterEach, describe, expect, test } from 'vitest'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  classOfTool,
  hasRuntimeToolClass,
  isToolClassAllowedInMode,
  resetRuntimeToolClasses,
  type AgentModeGrants
} from '../../../src/ai-gateway/tools/policy'
import {
  createConnectorTools,
  fetchConnectorManifest,
  shouldLoadConnectorTools,
  type ConnectorToolManifestEntry
} from '../../../src/ai-gateway/tools/connector'
import {
  isMcpToolName,
  mcpGatewayToolName,
  normalizeMcpNamePart,
  parseMcpToolName
} from '../../../src/shared/assistant/tools/mcpToolName'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import type { GatewayToolAuditCollector } from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope, errEnvelope, runTool } from './_helpers'

afterEach(() => resetRuntimeToolClasses())

function entry(over: Partial<ConnectorToolManifestEntry> = {}): ConnectorToolManifestEntry {
  return {
    connectorId: 'notion',
    connectorName: 'Notion',
    toolName: 'notion-fetch',
    description: 'Fetch a page',
    inputSchemaJson: '{"type":"object","properties":{"id":{"type":"string"}}}',
    crudType: 'read',
    destructive: false,
    effectiveEnabled: true,
    orphan: false,
    ...over
  }
}

function build(
  manifest: ConnectorToolManifestEntry[],
  opts: Parameters<typeof createConnectorTools>[4] = { contextMode: 'manual_chat' },
  collector: GatewayToolAuditCollector = []
) {
  const domain = mockDomain((url) => {
    if (/\/invoke$/.test(url)) {
      return okEnvelope({
        connector_id: 'notion',
        tool_name: 'notion-fetch',
        content: 'PAGE CONTENT',
        is_error: false,
        truncated: true,
        elapsed_ms: 5
      })
    }
    return okEnvelope({})
  })
  return createConnectorTools(domain, collector, new ApprovalGuard(), manifest, opts)
}

// ── 1. name mapping (single source) ─────────────────────────────────────────────

describe('mcpToolName — the shared naming source', () => {
  test('normalize + compose + parse round-trip', () => {
    expect(normalizeMcpNamePart('notion-fetch')).toBe('notion_fetch')
    expect(mcpGatewayToolName('notion', 'notion-update-page')).toBe(
      'mcp__notion__notion_update_page'
    )
    expect(parseMcpToolName('mcp__notion__notion_update_page')).toEqual({
      connectorId: 'notion',
      toolSlug: 'notion_update_page'
    })
    expect(isMcpToolName('mcp__notion__x1')).toBe(true)
    expect(isMcpToolName('email_get')).toBe(false)
  })

  test('degenerate parts / overlong names → null (caller skips, never mints a broken name)', () => {
    expect(mcpGatewayToolName('', 'x')).toBeNull()
    expect(mcpGatewayToolName('notion', '---')).toBeNull()
    expect(mcpGatewayToolName('notion', 'x'.repeat(200))).toBeNull()
    expect(parseMcpToolName('mcp__broken')).toBeNull()
    expect(parseMcpToolName('not_a_connector_tool')).toBeNull()
  })
})

// ── 2. manifest fetch — silent degradation ──────────────────────────────────────

describe('fetchConnectorManifest — never throws', () => {
  test('list failure → null (no connector tools this run)', async () => {
    const domain = mockDomain(() => errEnvelope('E_CONNECTOR_DISABLED', 'off', 409))
    await expect(fetchConnectorManifest(domain)).resolves.toBeNull()
  })

  test('connected+enabled connectors only; a single tools failure skips that connector', async () => {
    const domain = mockDomain((url) => {
      if (url.endsWith('/connector')) {
        return okEnvelope({
          connectors: [
            { connector_id: 'notion', display_name: 'Notion', status: 'connected', enabled: true },
            { connector_id: 'atlassian', display_name: 'Jira', status: 'connected', enabled: true },
            { connector_id: 'ghost', display_name: null, status: 'disconnected', enabled: true }
          ]
        })
      }
      if (url.includes('/connector/notion/tools')) {
        return okEnvelope({
          connector_id: 'notion',
          tools: [
            {
              name: 'notion-fetch',
              description: 'd',
              input_schema_json: null,
              crud_type: 'read',
              destructive: false,
              effective_enabled: true,
              orphan: false
            }
          ]
        })
      }
      return errEnvelope('E_CONNECTOR_TIMEOUT', 'slow', 504) // atlassian tools fail
    })
    const manifest = await fetchConnectorManifest(domain)
    expect(manifest).not.toBeNull()
    expect(manifest!.map((e) => `${e.connectorId}/${e.toolName}`)).toEqual(['notion/notion-fetch'])
  })
})

// ── 3. registration rules ───────────────────────────────────────────────────────

describe('createConnectorTools — registration rules', () => {
  test('read→read (silent), write/update→connector_write; classes registered at runtime', () => {
    const tools = build([
      entry(),
      entry({ toolName: 'notion-create-pages', crudType: 'write' }),
      entry({ toolName: 'notion-move-pages', crudType: 'update' })
    ])
    expect(Object.keys(tools).sort()).toEqual([
      'mcp__notion__notion_create_pages',
      'mcp__notion__notion_fetch',
      'mcp__notion__notion_move_pages'
    ])
    expect(classOfTool('mcp__notion__notion_fetch')).toBe('read')
    expect(classOfTool('mcp__notion__notion_create_pages')).toBe('connector_write')
    expect(classOfTool('mcp__notion__notion_move_pages')).toBe('connector_write')
  })

  test('disabled / orphan / delete-class / unknown-crud tools are never registered', () => {
    const tools = build([
      entry({ toolName: 'disabled-tool', effectiveEnabled: false }),
      entry({ toolName: 'orphan-tool', orphan: true }),
      entry({ toolName: 'delete-tool', crudType: 'delete' }),
      // even a lying manifest row (delete + effectiveEnabled=true) never registers
      entry({ toolName: 'lying-delete', crudType: 'delete', effectiveEnabled: true }),
      entry({ toolName: 'junk-crud', crudType: 'purge' })
    ])
    expect(Object.keys(tools)).toEqual([])
    expect(hasRuntimeToolClass('mcp__notion__delete_tool')).toBe(false)
    expect(hasRuntimeToolClass('mcp__notion__lying_delete')).toBe(false)
  })

  test('a name colliding with a static gateway tool or a duplicate slug is skipped', () => {
    // 'email__get' normalizes to mcp__notion__email__get — craft a REAL static collision instead:
    // registerRuntimeToolClass rejects static names, so force one via a manifest whose composed
    // name equals a static tool. Static names have no mcp__ prefix, so compose can't hit them —
    // pin the duplicate-slug branch (two remote names normalizing identically) instead.
    const tools = build([
      entry({ toolName: 'notion-fetch' }),
      entry({ toolName: 'notion_fetch', crudType: 'write' }) // same slug after normalization
    ])
    expect(Object.keys(tools)).toEqual(['mcp__notion__notion_fetch'])
    // first entry won: it stays the read tool
    expect(classOfTool('mcp__notion__notion_fetch')).toBe('read')
  })

  test('unrepresentable remote names are skipped (no broken tool minted)', () => {
    const tools = build([entry({ toolName: '★★★' })])
    expect(Object.keys(tools)).toEqual([])
  })
})

// ── 4. matrix fail-closed for connector_write ──────────────────────────────────

describe('connector_write — fail-closed in every non-manual mode (PR3 grant does not exist)', () => {
  const JUNK_GRANTS: Array<AgentModeGrants | undefined> = [
    undefined,
    {},
    { exec: true },
    { web: 'open' },
    { exec: true, web: 'open' },
    { connector: 'write' } as unknown as AgentModeGrants,
    { connector_write: true } as unknown as AgentModeGrants
  ]

  test('manual allowed; untrusted_trigger / cron_headless / im_chat denied under ANY grants', () => {
    expect(isToolClassAllowedInMode('connector_write', 'manual_chat')).toBe(true)
    for (const mode of ['untrusted_trigger', 'cron_headless', 'im_chat'] as const) {
      for (const grants of JUNK_GRANTS) {
        expect(
          isToolClassAllowedInMode('connector_write', mode, grants),
          `${mode} × ${JSON.stringify(grants)}`
        ).toBe(false)
      }
    }
  })

  test('assembled connector write tool is stripped from a headless ToolSet even via dynamicTools', () => {
    const manifest = [
      entry({ toolName: 'notion-update-page', crudType: 'write', destructive: true })
    ]
    const collector: GatewayToolAuditCollector = []
    const domain = mockDomain(() => okEnvelope({}))
    const name = 'mcp__notion__notion_update_page'
    for (const mode of ['untrusted_trigger', 'cron_headless', 'im_chat'] as const) {
      const dynamicTools = createConnectorTools(domain, collector, new ApprovalGuard(), manifest, {
        contextMode: mode
      })
      const built = buildGatewayTools({
        domain,
        writeToolsEnabled: true,
        approvalGuard: new ApprovalGuard(),
        contextMode: mode,
        dynamicTools,
        ...(mode !== 'im_chat'
          ? {
              agentRunContext: {
                agentId: 'a',
                allowedTools: [],
                modeGrants: { exec: true, web: 'open' }
              }
            }
          : {})
      })
      expect(built[name], `${name} must be stripped in ${mode}`).toBeUndefined()
    }
    // manual: registered.
    const manualDynamic = createConnectorTools(domain, collector, new ApprovalGuard(), manifest, {
      contextMode: 'manual_chat'
    })
    const manual = buildGatewayTools({
      domain,
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      dynamicTools: manualDynamic
    })
    expect(manual[name]).toBeDefined()
  })

  test('a registered connector READ tool rides the read row (registers even headless when fed)', () => {
    const manifest = [entry()]
    const domain = mockDomain(() => okEnvelope({}))
    const dynamicTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
      contextMode: 'cron_headless'
    })
    const built = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'cron_headless',
      dynamicTools
    })
    // The CLASS row would admit it — the PR2 guarantee that headless never sees connector tools
    // lives in the shouldLoadConnectorTools seam (zero fetch), pinned below.
    expect(built.mcp__notion__notion_fetch).toBeDefined()
  })
})

// ── 5. the manual-chat-only load seam (headless = zero calls) ──────────────────

describe('shouldLoadConnectorTools — the ONE seam', () => {
  test('true ONLY for flag on + manual_chat + no agentRunContext', () => {
    expect(shouldLoadConnectorTools(true, 'manual_chat', false)).toBe(true)
    // flag off → never
    expect(shouldLoadConnectorTools(false, 'manual_chat', false)).toBe(false)
    // headless / im / unknown modes → never
    expect(shouldLoadConnectorTools(true, 'untrusted_trigger', false)).toBe(false)
    expect(shouldLoadConnectorTools(true, 'cron_headless', false)).toBe(false)
    expect(shouldLoadConnectorTools(true, 'im_chat', false)).toBe(false)
    expect(shouldLoadConnectorTools(true, undefined, false)).toBe(false)
    // a manual-looking run that carries an agentRunContext → never
    expect(shouldLoadConnectorTools(true, 'manual_chat', true)).toBe(false)
  })
})

// ── 6. execution: fence + truncation + approval registration ───────────────────

describe('connector tool execution', () => {
  test('read tool: silent execute, UNTRUSTED_MCP_TOOL fence + truncated surfaced + audit entry', async () => {
    const collector: GatewayToolAuditCollector = []
    const tools = build([entry()], { contextMode: 'manual_chat' }, collector)
    const out = (await runTool(tools.mcp__notion__notion_fetch, { id: 'p1' })) as {
      content: string
      truncated: boolean
      is_error: boolean
    }
    expect(out.content).toContain('UNTRUSTED_MCP_TOOL_START')
    expect(out.content).toContain('PAGE CONTENT')
    expect(out.content).toContain('UNTRUSTED_MCP_TOOL_END')
    expect(out.truncated).toBe(true)
    expect(out.is_error).toBe(false)
    expect(collector).toHaveLength(1)
    expect(collector[0].toolName).toBe('mcp__notion__notion_fetch')
    expect(collector[0].status).toBe('ok')
    // silent read — no approval tier on the audit entry
    expect(collector[0].confirmationTier).toBeUndefined()
  })

  test('write tool: needsApproval registers the guard record (edit tier); execute without approval rejects', async () => {
    const collector: GatewayToolAuditCollector = []
    const guard = new ApprovalGuard()
    const domain = mockDomain(() => okEnvelope({}))
    const tools = createConnectorTools(
      domain,
      collector,
      guard,
      [entry({ toolName: 'notion-update-page', crudType: 'write', destructive: true })],
      { contextMode: 'manual_chat' }
    )
    const tool = tools.mcp__notion__notion_update_page
    expect(tool).toBeDefined()
    const needs = tool.needsApproval as (i: unknown, o: unknown) => boolean | Promise<boolean>
    // 恒 HITL in manual under the default approval mode.
    await expect(
      Promise.resolve(needs({ page: 'x' }, { toolCallId: 'tc-w1', messages: [] }))
    ).resolves.toBe(true)
    expect(guard.peek('tc-w1')?.risk).toBe('edit')
    // execute for an UNKNOWN toolCallId (never registered/approved) → guard rejection, no write.
    await expect(
      (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(
        { page: 'x' },
        { toolCallId: 'tc-never-registered', messages: [] }
      )
    ).rejects.toThrow()
    const err = collector.find((c) => c.status === 'error')
    expect(err?.approvalStatus).toBe('rejected')
  })

  test('write tool description carries the contract surface (Q9=A): approval + fence + destructive', () => {
    const tools = build([
      entry({ toolName: 'notion-update-page', crudType: 'write', destructive: true })
    ])
    const desc = String(tools.mcp__notion__notion_update_page.description)
    expect(desc).toContain('UNTRUSTED_MCP_TOOL')
    expect(desc).toContain('DESTRUCTIVE')
    expect(desc).toContain('always asks')
  })
})
