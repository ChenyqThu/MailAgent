import { afterEach, describe, expect, test } from 'vitest'

import { agentRunContextFromSpec } from '../../src/ai-gateway/agentRun'
import { ApprovalGuard } from '../../src/ai-gateway/security/approval'
import {
  connectorCatalogForRun,
  createConnectorTools,
  parseConnectorToolGrants,
  projectConnectorCatalog,
  type ConnectorToolManifestEntry
} from '../../src/ai-gateway/tools/connector'
import { resetRuntimeToolClasses } from '../../src/ai-gateway/tools/policy'
import type { AgentRunSpec } from '../../src/shared/api/types'
import { mockDomain, okEnvelope } from './tools/_helpers'

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
    mode: 'auto',
    orphan: false,
    ...over
  }
}

function makeSpec(toolPolicy?: AgentRunSpec['toolPolicy']): AgentRunSpec {
  return {
    jobId: 101,
    agentId: 'agent-p5',
    agentTitle: 'Phase 5 Agent',
    trigger: { kind: 'cron', firedAt: '2026-11-17T00:00:00Z' },
    prompt: { taskPrompt: 'Inspect Notion updates' },
    budget: { maxRunSeconds: 300 },
    sessionTitle: 'Phase 5 Run',
    toolPolicy
  }
}

describe('Phase 5 WP-5B.2 + WP-5B.3 — grantConnectorTools & disabledConnectors', () => {
  test('parseConnectorToolGrants normalizes valid entries, preserves [], and drops junk', () => {
    expect(parseConnectorToolGrants(undefined)).toBeUndefined()
    expect(parseConnectorToolGrants([])).toBeUndefined()
    expect(parseConnectorToolGrants({})).toBeUndefined()

    expect(
      parseConnectorToolGrants({
        notion: [' search ', 'fetch', 'search', '', 42 as unknown as string],
        slack: [],
        invalid: 'not-an-array',
        '': ['ignored']
      })
    ).toEqual({
      notion: ['search', 'fetch'],
      slack: []
    })
  })

  test('agentRunContextFromSpec projects modeGrants.connectorTools only when present', () => {
    const withoutToolGrants = agentRunContextFromSpec(
      makeSpec({
        allowedTools: [],
        skills: [],
        grantConnectors: { notion: 'write' }
      })
    )
    expect(withoutToolGrants.modeGrants?.connectors).toEqual({ notion: 'write' })
    expect('connectorTools' in (withoutToolGrants.modeGrants ?? {})).toBe(false)

    const withToolGrants = agentRunContextFromSpec(
      makeSpec({
        allowedTools: [],
        skills: [],
        grantConnectors: { notion: 'write' },
        grantConnectorTools: { notion: ['notion-fetch'] }
      })
    )
    expect(withToolGrants.modeGrants?.connectorTools).toEqual({ notion: ['notion-fetch'] })

    const withExplicitEmpty = agentRunContextFromSpec(
      makeSpec({
        allowedTools: [],
        skills: [],
        grantConnectors: { notion: 'write' },
        grantConnectorTools: { notion: [] }
      })
    )
    expect(withExplicitEmpty.modeGrants?.connectorTools).toEqual({ notion: [] })
  })

  test('headless createConnectorTools and connectorCatalogForRun honor connectorToolGrants allowlist and explicit []', () => {
    const manifest: ConnectorToolManifestEntry[] = [
      entry({ connectorId: 'notion', toolName: 'notion-fetch', crudType: 'read' }),
      entry({ connectorId: 'notion', toolName: 'notion-search', crudType: 'read' }),
      entry({ connectorId: 'notion', toolName: 'notion-create-page', crudType: 'write', mode: 'ask' }),
      entry({ connectorId: 'atlassian', connectorName: 'Atlassian', toolName: 'jira-get', crudType: 'read' })
    ]
    const catalog = projectConnectorCatalog(manifest)
    const domain = mockDomain(() => okEnvelope({}))

    const narrowedTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
      contextMode: 'cron_headless',
      agentId: 'agent-p5',
      connectorGrants: { notion: 'write', atlassian: 'read' },
      connectorToolGrants: { notion: ['notion-fetch'] }
    })
    expect(Object.keys(narrowedTools).sort()).toEqual([
      'mcp__atlassian__jira_get',
      'mcp__notion__notion_fetch'
    ])

    const catalogKeep = connectorCatalogForRun(
      catalog,
      'untrusted_trigger',
      true,
      { notion: 'write', atlassian: 'read' },
      { connectorToolGrants: { notion: ['notion-fetch'] } }
    )
    expect(catalogKeep?.map((r) => r.connectorId)).toEqual(['notion', 'atlassian'])

    // Explicit empty allowlist [] blocks that connector completely in both tools & catalog.
    resetRuntimeToolClasses()
    const blockedTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
      contextMode: 'untrusted_trigger',
      agentId: 'agent-p5',
      connectorGrants: { notion: 'write', atlassian: 'read' },
      connectorToolGrants: { notion: [] }
    })
    expect(Object.keys(blockedTools)).toEqual(['mcp__atlassian__jira_get'])

    const catalogBlocked = connectorCatalogForRun(
      catalog,
      'cron_headless',
      true,
      { notion: 'write', atlassian: 'read' },
      { connectorToolGrants: { notion: [] } }
    )
    expect(catalogBlocked?.map((r) => r.connectorId)).toEqual(['atlassian'])
  })

  test('disabledConnectors filters manual_chat tools & catalog while headless runs ignore it', () => {
    const manifest: ConnectorToolManifestEntry[] = [
      entry({ connectorId: 'notion', toolName: 'notion-fetch', crudType: 'read' }),
      entry({ connectorId: 'atlassian', connectorName: 'Atlassian', toolName: 'jira-get', crudType: 'read' })
    ]
    const catalog = projectConnectorCatalog(manifest)
    const domain = mockDomain(() => okEnvelope({}))

    const manualTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
      contextMode: 'manual_chat',
      disabledConnectors: ['notion']
    })
    expect(Object.keys(manualTools)).toEqual(['mcp__atlassian__jira_get'])

    const manualCatalog = connectorCatalogForRun(catalog, 'manual_chat', false, undefined, {
      disabledConnectors: ['notion']
    })
    expect(manualCatalog?.map((r) => r.connectorId)).toEqual(['atlassian'])

    const allDisabledCatalog = connectorCatalogForRun(catalog, 'manual_chat', false, undefined, {
      disabledConnectors: ['notion', 'atlassian']
    })
    expect(allDisabledCatalog).toBeNull()

    // Non-manual / headless runs do not apply manual_chat session mutes.
    resetRuntimeToolClasses()
    const headlessTools = createConnectorTools(domain, [], new ApprovalGuard(), manifest, {
      contextMode: 'cron_headless',
      agentId: 'agent-p5',
      connectorGrants: { notion: 'read', atlassian: 'read' },
      disabledConnectors: ['notion']
    })
    expect(Object.keys(headlessTools).sort()).toEqual([
      'mcp__atlassian__jira_get',
      'mcp__notion__notion_fetch'
    ])

    const headlessCatalog = connectorCatalogForRun(
      catalog,
      'cron_headless',
      true,
      { notion: 'read', atlassian: 'read' },
      { disabledConnectors: ['notion'] }
    )
    expect(headlessCatalog?.map((r) => r.connectorId)).toEqual(['notion', 'atlassian'])
  })
})
