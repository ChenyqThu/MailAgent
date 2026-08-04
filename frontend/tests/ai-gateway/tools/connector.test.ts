// Stage 1 PR2+PR3 (harness-expansion epic) — MCP connector dynamic tools: naming, manifest fetch
// degradation, registration rules, runtime class matrix, headless grant path.
//
// Pins (task 08-01 PR2 contract + PR3 grant key):
//   1. name mapping (mcpToolName.ts — the ONE source both gateway + renderer card consume);
//   2. fetchConnectorManifest NEVER throws: list failure → null (silent degradation), a single
//      connector's tools failure skips just that connector;
//   3. createConnectorTools registration rules: enabled+non-orphan+non-delete only, read→'read',
//      write/update→'connector_write', unknown crud skipped, static-name collision skipped;
//   4. connector_write matrix row (PR3): manual always; headless lifted ONLY by a real
//      `connectors` grant with a write-capable ceiling — every junk/forged shape still denies;
//      im_chat denies under any grants;
//   5. shouldLoadConnectorTools — the ONE load seam: manual chat (no agentRunContext), or a
//      headless run whose connector grants parse non-empty; everything else = zero calls;
//   6. read results are UNTRUSTED_MCP_TOOL-fenced + truncation surfaced; write tools register the
//      approval record (edit tier) and never执行 without the guard;
//   7. PR3 headless semantics: grant 内免卡直接执行 (audit auto_whitelist + rule_id null),
//      grant 外根本不注册 (connector absent / above-ceiling tools are never built), and the
//      invoke wire carries the caller annotation (mode + agent_id).

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

// ── 4. matrix — connector_write row is grants-aware (PR3), fail-closed for every junk shape ─────

describe('connector_write matrix row — PR3 grant key, fail-closed against junk', () => {
  /** Junk / forged / insufficient grant shapes that must ALL deny connector_write headless: the
   *  pre-PR3 shapes, wrong keys, the retired forged keys, 'read'-only ceilings (write not
   *  covered), 'delete'/'yes' junk values, empty keys, and non-object connectors. */
  const JUNK_GRANTS: Array<AgentModeGrants | undefined> = [
    undefined,
    {},
    { exec: true },
    { web: 'open' },
    { exec: true, web: 'open' },
    { connector: 'write' } as unknown as AgentModeGrants,
    { connector_write: true } as unknown as AgentModeGrants,
    { connectors: {} },
    { connectors: { notion: 'read' } },
    { connectors: { notion: 'delete' } } as unknown as AgentModeGrants,
    { connectors: { notion: 'yes' } } as unknown as AgentModeGrants,
    { connectors: { notion: true } } as unknown as AgentModeGrants,
    { connectors: { '': 'write' } },
    { connectors: 'write' } as unknown as AgentModeGrants,
    { connectors: ['write'] } as unknown as AgentModeGrants
  ]

  test('manual allowed; headless/im_chat denied under every junk/insufficient grant shape', () => {
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

  test('a write-capable ceiling lifts the headless rows; im_chat stays hard-denied', () => {
    for (const grants of [
      { connectors: { notion: 'write' } },
      { connectors: { notion: 'update' } },
      { connectors: { a: 'read', b: 'write' } } // ANY write-capable ceiling lifts the class row
    ] as AgentModeGrants[]) {
      for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
        expect(
          isToolClassAllowedInMode('connector_write', mode, grants),
          `${mode} × ${JSON.stringify(grants)}`
        ).toBe(true)
      }
      expect(isToolClassAllowedInMode('connector_write', 'im_chat', grants)).toBe(false)
    }
  })

  test('no-grants headless ToolSet strips a (manually-built) connector write even via dynamicTools', () => {
    const manifest = [
      entry({ toolName: 'notion-update-page', crudType: 'write', destructive: true })
    ]
    const collector: GatewayToolAuditCollector = []
    const domain = mockDomain(() => okEnvelope({}))
    const name = 'mcp__notion__notion_update_page'
    // Build under MANUAL (so the tool exists + its runtime class is registered), then force-feed
    // it into non-manual assemblies WITHOUT connector grants: the matrix must strip it even when
    // exec/web grants are present (they lift ONLY their own rows).
    const manualDynamic = createConnectorTools(domain, collector, new ApprovalGuard(), manifest, {
      contextMode: 'manual_chat'
    })
    for (const mode of ['untrusted_trigger', 'cron_headless', 'im_chat'] as const) {
      const built = buildGatewayTools({
        domain,
        writeToolsEnabled: true,
        approvalGuard: new ApprovalGuard(),
        contextMode: mode,
        dynamicTools: manualDynamic,
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
    const manual = buildGatewayTools({
      domain,
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat',
      dynamicTools: manualDynamic
    })
    expect(manual[name]).toBeDefined()
  })

  test('granted headless ToolSet admits BOTH the read and the write connector tool end-to-end', () => {
    const manifest = [
      entry(), // read
      entry({ toolName: 'notion-update-page', crudType: 'write' })
    ]
    const domain = mockDomain(() => okEnvelope({}))
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      resetRuntimeToolClasses()
      const dynamicTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
        contextMode: mode,
        connectorGrants: { notion: 'write' },
        agentId: 'dms'
      })
      const built = buildGatewayTools({
        domain,
        writeToolsEnabled: true,
        approvalGuard: new ApprovalGuard(),
        contextMode: mode,
        dynamicTools,
        agentRunContext: {
          agentId: 'dms',
          allowedTools: [],
          modeGrants: { exec: false, web: 'off', connectors: { notion: 'write' } }
        }
      })
      expect(built.mcp__notion__notion_fetch, `read tool in ${mode}`).toBeDefined()
      expect(built.mcp__notion__notion_update_page, `write tool in ${mode}`).toBeDefined()
    }
  })

  test('a registered connector READ tool rides the read row (matrix pin — the seam + grant filter are the real guards)', () => {
    const manifest = [entry()]
    const domain = mockDomain(() => okEnvelope({}))
    // Built under manual → registered; force-fed into a headless assembly the READ row admits it.
    const dynamicTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
      contextMode: 'manual_chat'
    })
    const built = buildGatewayTools({
      domain,
      approvalGuard: new ApprovalGuard(),
      contextMode: 'cron_headless',
      dynamicTools
    })
    expect(built.mcp__notion__notion_fetch).toBeDefined()
  })
})

// ── 4b. PR3 — headless registration filter (grant 外根本不注册) ─────────────────

describe('createConnectorTools — headless per-connector grant filter', () => {
  const MANIFEST = [
    entry(), // read
    entry({ toolName: 'notion-create-pages', crudType: 'write' }),
    entry({ toolName: 'notion-move-pages', crudType: 'update' }),
    entry({ toolName: 'notion-delete-page', crudType: 'delete' }), // never, any ceiling
    entry({ toolName: 'notion-purge', crudType: 'purge' }), // unknown crud — never
    entry({ connectorId: 'atlassian', connectorName: 'Jira', toolName: 'jira-get-issue' })
  ]

  function headlessBuild(grants: Record<string, 'read' | 'write' | 'update'> | undefined) {
    const domain = mockDomain(() => okEnvelope({}))
    return createConnectorTools(domain, [], new ApprovalGuard(), MANIFEST, {
      contextMode: 'cron_headless',
      connectorGrants: grants,
      agentId: 'dms'
    })
  }

  test('ceiling read → only the read tool of the granted connector registers', () => {
    expect(Object.keys(headlessBuild({ notion: 'read' })).sort()).toEqual([
      'mcp__notion__notion_fetch'
    ])
  })

  test('ceiling write → read + write register; update stays above the ceiling', () => {
    expect(Object.keys(headlessBuild({ notion: 'write' })).sort()).toEqual([
      'mcp__notion__notion_create_pages',
      'mcp__notion__notion_fetch'
    ])
  })

  test('ceiling update → read + write + update register; delete/unknown cruds STILL never', () => {
    expect(Object.keys(headlessBuild({ notion: 'update' })).sort()).toEqual([
      'mcp__notion__notion_create_pages',
      'mcp__notion__notion_fetch',
      'mcp__notion__notion_move_pages'
    ])
  })

  test('a connector absent from the grants registers NOTHING (whole family skipped)', () => {
    expect(Object.keys(headlessBuild({ atlassian: 'update' })).sort()).toEqual([
      'mcp__atlassian__jira_get_issue'
    ])
    expect(Object.keys(headlessBuild(undefined))).toEqual([])
  })

  test('junk grant entries are dropped per-entry (fail-closed re-parse inside the factory)', () => {
    expect(
      Object.keys(
        headlessBuild({ notion: 'delete', atlassian: 'read' } as unknown as Record<
          string,
          'read' | 'write' | 'update'
        >)
      ).sort()
    ).toEqual(['mcp__atlassian__jira_get_issue'])
  })

  test('manual (connectorGrants undefined) keeps the PR2 registration byte-identical', () => {
    const domain = mockDomain(() => okEnvelope({}))
    const tools = createConnectorTools(domain, [], new ApprovalGuard(), MANIFEST, {
      contextMode: 'manual_chat'
    })
    expect(Object.keys(tools).sort()).toEqual([
      'mcp__atlassian__jira_get_issue',
      'mcp__notion__notion_create_pages',
      'mcp__notion__notion_fetch',
      'mcp__notion__notion_move_pages'
    ])
  })
})

// ── 5. the load seam (manual chat, or a granted headless run) ──────────────────

describe('shouldLoadConnectorTools — the ONE seam', () => {
  test('manual shape: flag on + manual_chat + no agentRunContext (PR2, unchanged)', () => {
    expect(shouldLoadConnectorTools(true, 'manual_chat', false)).toBe(true)
    // flag off → never
    expect(shouldLoadConnectorTools(false, 'manual_chat', false)).toBe(false)
    // im / unknown modes → never
    expect(shouldLoadConnectorTools(true, 'im_chat', false)).toBe(false)
    expect(shouldLoadConnectorTools(true, undefined, false)).toBe(false)
    // a manual-looking run that carries an agentRunContext → never
    expect(shouldLoadConnectorTools(true, 'manual_chat', true)).toBe(false)
  })

  test('headless shape (PR3): flag on + headless mode + agentRunContext + NON-EMPTY parsed grants', () => {
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      expect(shouldLoadConnectorTools(true, mode, true, { notion: 'read' })).toBe(true)
      expect(shouldLoadConnectorTools(true, mode, true, { notion: 'write' })).toBe(true)
      // no grants / empty / junk-only grants → zero calls (the PR2 headless behaviour)
      expect(shouldLoadConnectorTools(true, mode, true, undefined)).toBe(false)
      expect(shouldLoadConnectorTools(true, mode, true, {})).toBe(false)
      expect(shouldLoadConnectorTools(true, mode, true, { notion: 'delete' })).toBe(false)
      expect(shouldLoadConnectorTools(true, mode, true, { notion: 'yes' })).toBe(false)
      expect(shouldLoadConnectorTools(true, mode, true, { '': 'write' })).toBe(false)
      // grants without an agentRunContext are incoherent → never
      expect(shouldLoadConnectorTools(true, mode, false, { notion: 'read' })).toBe(false)
      // flag off beats everything
      expect(shouldLoadConnectorTools(false, mode, true, { notion: 'update' })).toBe(false)
    }
    // im_chat: grants are never a lift (the stage-2 IM opt-in is a switch, not a grant)
    expect(shouldLoadConnectorTools(true, 'im_chat', true, { notion: 'update' })).toBe(false)
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

  test('manual invoke carries the caller annotation (context_mode only, no agent_id)', async () => {
    let invokeBody: Record<string, unknown> | null = null
    const domain = mockDomain((url, body) => {
      if (/\/invoke$/.test(url)) {
        invokeBody = body ? (JSON.parse(body) as Record<string, unknown>) : null
        return okEnvelope({ content: 'ok', is_error: false, truncated: false })
      }
      return okEnvelope({})
    })
    const tools = createConnectorTools(domain, [], new ApprovalGuard(), [entry()], {
      contextMode: 'manual_chat'
    })
    await runTool(tools.mcp__notion__notion_fetch, { id: 'p1' })
    expect(invokeBody).toMatchObject({
      arguments: { id: 'p1' },
      caller: { context_mode: 'manual_chat' }
    })
    expect((invokeBody!.caller as Record<string, unknown>).agent_id).toBeUndefined()
  })

  // ── PR3 — headless 免卡 semantics (mirror of grant_web 'open': grant-level auto_allow) ──────

  test('headless granted write tool: needsApproval resolves FALSE (no card) + audit auto_whitelist + rule_id NULL + caller carries mode/agent_id', async () => {
    let invokeBody: Record<string, unknown> | null = null
    const collector: GatewayToolAuditCollector = []
    const guard = new ApprovalGuard()
    const domain = mockDomain((url, body) => {
      if (/\/invoke$/.test(url)) {
        invokeBody = body ? (JSON.parse(body) as Record<string, unknown>) : null
        return okEnvelope({ content: 'UPDATED', is_error: false, truncated: false })
      }
      return okEnvelope({})
    })
    const tools = createConnectorTools(
      domain,
      collector,
      guard,
      [entry({ toolName: 'notion-update-page', crudType: 'write' })],
      { contextMode: 'cron_headless', connectorGrants: { notion: 'write' }, agentId: 'dms' }
    )
    const tool = tools.mcp__notion__notion_update_page
    expect(tool).toBeDefined()
    const needs = tool.needsApproval as (i: unknown, o: unknown) => boolean | Promise<boolean>
    // grant 内免卡: the grant-level verdict resolves auto_allow → no card…
    await expect(
      Promise.resolve(needs({ page: 'x' }, { toolCallId: 'tc-h1', messages: [] }))
    ).resolves.toBe(false)
    // …but the approval record IS registered (execute's guard.verify still runs).
    expect(guard.peek('tc-h1')?.risk).toBe('edit')
    await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      { page: 'x' },
      { toolCallId: 'tc-h1', messages: [] }
    )
    expect(collector).toHaveLength(1)
    expect(collector[0].status).toBe('ok')
    expect(collector[0].approvalStatus).toBe('auto_whitelist')
    expect(collector[0].whitelistRuleId).toBeNull() // grant-source, distinct from a rule id
    // the invoke wire carries the headless caller annotation
    expect(invokeBody).toMatchObject({
      caller: { context_mode: 'cron_headless', agent_id: 'dms' }
    })
    // and the description no longer promises a card that will never come (Q9=A product surface)
    expect(String(tool.description)).not.toContain('always asks')
    expect(String(tool.description)).toContain('pre-granted')
  })

  test('headless granted read tool executes silently and the manual write stays 恒 HITL (byte-parity)', async () => {
    const collector: GatewayToolAuditCollector = []
    const domain = mockDomain((url) =>
      /\/invoke$/.test(url)
        ? okEnvelope({ content: 'PAGE', is_error: false, truncated: false })
        : okEnvelope({})
    )
    const headless = createConnectorTools(domain, collector, new ApprovalGuard(), [entry()], {
      contextMode: 'untrusted_trigger',
      connectorGrants: { notion: 'read' },
      agentId: 'dms'
    })
    const out = (await runTool(headless.mcp__notion__notion_fetch, { id: 'p' })) as {
      content: string
    }
    expect(out.content).toContain('UNTRUSTED_MCP_TOOL_START')
    // manual write built in the SAME process still asks (PR2 parity — the grant path never
    // leaks into manual assemblies).
    resetRuntimeToolClasses()
    const manual = createConnectorTools(
      domain,
      [],
      new ApprovalGuard(),
      [entry({ toolName: 'notion-update-page', crudType: 'write' })],
      { contextMode: 'manual_chat' }
    )
    const needs = manual.mcp__notion__notion_update_page.needsApproval as (
      i: unknown,
      o: unknown
    ) => boolean | Promise<boolean>
    await expect(
      Promise.resolve(needs({ p: 1 }, { toolCallId: 'tc-m1', messages: [] }))
    ).resolves.toBe(true)
  })
})

// ── 7. (PR5) invoke 失败的模型可读化 ────────────────────────────────────────────

describe('connector invoke errors — readable code + actionable follow-up (PR5)', () => {
  /** One connector read tool whose /invoke leg fails with the given envelope code. */
  function failing(code: string, message = 'boom', status = 409) {
    const domain = mockDomain((url) =>
      /\/invoke$/.test(url) ? errEnvelope(code, message, status) : okEnvelope({})
    )
    return createConnectorTools(domain, [], new ApprovalGuard(), [entry()], {
      contextMode: 'manual_chat'
    }).mcp__notion__notion_fetch
  }

  async function messageOf(code: string, message?: string): Promise<string> {
    try {
      await runTool(failing(code, message))
      throw new Error('expected the tool to reject')
    } catch (e) {
      return (e as Error).message
    }
  }

  // 🔴 The three codes an owner (not the model) must fix. Without the follow-up the model
  //    re-calls the same tool until the step budget runs out.
  test('E_CONNECTOR_NOT_CONNECTED → code in the message + "connect it in Settings" follow-up', async () => {
    const m = await messageOf('E_CONNECTOR_NOT_CONNECTED', 'no credentials')
    expect(m).toContain('E_CONNECTOR_NOT_CONNECTED')
    expect(m).toContain('no credentials')
    expect(m).toContain('Settings')
    expect(m).toContain('Retrying will not help')
  })

  test('E_CONNECTOR_OAUTH → code in the message + "needs re-authorization" follow-up', async () => {
    const m = await messageOf('E_CONNECTOR_OAUTH', 'refresh token revoked')
    expect(m).toContain('E_CONNECTOR_OAUTH')
    expect(m).toContain('refresh token revoked')
    expect(m).toContain('re-authorization')
    expect(m).toContain('Settings')
  })

  test('E_CONNECTOR_DISABLED → code in the message + "turned off on this machine" follow-up', async () => {
    const m = await messageOf('E_CONNECTOR_DISABLED', 'flag off')
    expect(m).toContain('E_CONNECTOR_DISABLED')
    expect(m).toContain('turned off')
    // 🔴 这一条**故意不说 Settings** —— MCP connector 总闸是 env flag，设置页里没有这个开关。
    // 指一个不存在的按钮比不指更糟（模型会照着编一句用户照做不了的话）。
    expect(m).toContain('enable them')
    expect(m).not.toContain('Settings')
  })

  test('every failure names the connector; an unlisted code still carries its code (no invented advice)', async () => {
    const m = await messageOf('E_UPSTREAM', 'remote 502')
    expect(m).toContain('E_UPSTREAM')
    expect(m).toContain('remote 502')
    expect(m).toContain('Notion')
    // No hint is fabricated for a code we have no owner action for.
    expect(m).not.toContain('Settings')
  })

  test('the audit entry keeps the structured code (the wrapper still normalizes it)', async () => {
    const collector: GatewayToolAuditCollector = []
    const domain = mockDomain((url) =>
      /\/invoke$/.test(url) ? errEnvelope('E_CONNECTOR_OAUTH', 'revoked', 401) : okEnvelope({})
    )
    const tools = createConnectorTools(domain, collector, new ApprovalGuard(), [entry()], {
      contextMode: 'manual_chat'
    })
    await expect(runTool(tools.mcp__notion__notion_fetch)).rejects.toThrow()
    expect(collector).toHaveLength(1)
    expect(collector[0].status).toBe('error')
    expect(collector[0].outputJson).toContain('E_CONNECTOR_OAUTH')
  })

  test('the success path is untouched (fence + truncated still surfaced)', async () => {
    const tools = build([entry()])
    const out = (await runTool(tools.mcp__notion__notion_fetch, { id: 'p1' })) as {
      content: string
      truncated: boolean
    }
    expect(out.content).toContain('UNTRUSTED_MCP_TOOL_START')
    expect(out.truncated).toBe(true)
  })
})
