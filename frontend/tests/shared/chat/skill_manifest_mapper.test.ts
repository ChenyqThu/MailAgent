// P2a — Skill manifest → TS ToolDef mapper + shadow parity.
//
// Verifies: confirmation-tier mapping ('none' → 'silent'), side-effect → category,
// one manifest tool → harness ToolDef (incl. handler dispatching to the generic
// invoker), flatten, and the shadow-parity diff against the legacy builtin catalog
// (createBuiltinTools). Zero serve-api — the manifest is a fixture, the invoker a stub.

import { describe, expect, test, vi } from 'vitest'

import { createBuiltinTools } from '../../../src/shared/chat/tools/builtin'
import type { ChatToolPlatform } from '../../../src/shared/chat/platform'
import type { ToolDef, ToolExecCtx } from '../../../src/shared/chat/tools/registry'
import {
  categoryFromSideEffect,
  mapConfirmationTier,
  mapManifestToToolDefs,
  mapManifestToolToToolDef,
  shadowParity,
  type ManifestToolDef,
  type SkillManifest
} from '../../../src/shared/chat/tools/manifest'

function manifestTool(over: Partial<ManifestToolDef> = {}): ManifestToolDef {
  return {
    name: 'email_search',
    description: 'Search emails',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    output_schema: { type: 'object' },
    confirmation_tier: 'none',
    side_effect: 'read',
    auth_scopes: ['email:read'],
    mcp_exposed: true,
    handler: { kind: 'service', target: 'MailReadService.search' },
    ...over
  }
}

const ctx: ToolExecCtx = { sessionId: 1, emailId: null, signal: new AbortController().signal }

describe('manifest mapper — tier + category', () => {
  test("confirmation tier 'none' → 'silent', others pass through", () => {
    expect(mapConfirmationTier('none')).toBe('silent')
    expect(mapConfirmationTier('preview')).toBe('preview')
    expect(mapConfirmationTier('edit')).toBe('edit')
  })

  test('side_effect → category (read → read, side-effecting → write)', () => {
    expect(categoryFromSideEffect('read')).toBe('read')
    expect(categoryFromSideEffect('write')).toBe('write')
    expect(categoryFromSideEffect('send')).toBe('write')
    expect(categoryFromSideEffect('external_call')).toBe('write')
  })
})

describe('manifest mapper — tool → ToolDef', () => {
  test('maps fields + handler dispatches to the generic invoker', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, output: { hits: [] }, durationMs: 1 }))
    const def = mapManifestToolToToolDef('email', manifestTool({ timeout_ms: 5000 }), invoke)
    expect(def.name).toBe('email_search')
    expect(def.confirmationTier).toBe('silent')
    expect(def.category).toBe('read')
    expect(def.surface).toBe('ipc')
    expect(def.timeoutMs).toBe(5000)
    expect(def.inputSchema).toEqual(manifestTool().input_schema)

    const res = await def.handler({ query: 'q' }, ctx)
    expect(invoke).toHaveBeenCalledWith('email', 'email_search', { query: 'q' }, ctx)
    expect(res).toEqual({ ok: true, output: { hits: [] }, durationMs: 1 })
  })

  test('subprocess handler → cli surface; edit tier preserved', () => {
    const def = mapManifestToolToToolDef(
      'notion_agent',
      manifestTool({
        name: 'notion_agent_chat',
        side_effect: 'external_call',
        confirmation_tier: 'edit',
        handler: { kind: 'subprocess', target: 'notion_agent.run' }
      }),
      async () => ({ ok: true, output: null, durationMs: 1 })
    )
    expect(def.surface).toBe('cli')
    expect(def.confirmationTier).toBe('edit')
    expect(def.category).toBe('write')
  })

  test('flattens every skill tool', () => {
    const manifest: SkillManifest = {
      generated_at: 'x',
      server_version: '3.0.0',
      capabilities: {},
      skills: [
        {
          name: 'email',
          version: '1',
          title: 'Email',
          description: '',
          default_enabled: true,
          availability: { available: true },
          prompt_fragment: '',
          docs_path: '',
          tools: [manifestTool(), manifestTool({ name: 'email_get' })]
        },
        {
          name: 'report',
          version: '1',
          title: 'Report',
          description: '',
          default_enabled: true,
          availability: { available: true },
          prompt_fragment: '',
          docs_path: '',
          tools: [manifestTool({ name: 'report_run', side_effect: 'external_call' })]
        }
      ]
    }
    const defs = mapManifestToToolDefs(manifest, async () => ({
      ok: true,
      output: null,
      durationMs: 1
    }))
    expect(defs.map((d) => d.name)).toEqual(['email_search', 'email_get', 'report_run'])
  })
})

describe('manifest mapper — shadow parity', () => {
  const tdef = (name: string, tier: ToolDef['confirmationTier'], schema: object): ToolDef => ({
    name,
    description: '',
    inputSchema: schema as Record<string, unknown>,
    confirmationTier: tier,
    category: 'read',
    surface: 'ipc',
    handler: async () => ({ ok: true, output: null, durationMs: 1 })
  })

  test('classifies common / only-builtin / only-manifest', () => {
    const builtin = [tdef('a', 'silent', {}), tdef('b', 'silent', {})]
    const manifest = [tdef('b', 'silent', {}), tdef('c', 'silent', {})]
    const r = shadowParity(builtin, manifest)
    expect(r.common).toEqual(['b'])
    expect(r.onlyBuiltin).toEqual(['a'])
    expect(r.onlyManifest).toEqual(['c'])
  })

  test('reports tier + schema mismatches on common tools', () => {
    const builtin = [tdef('x', 'silent', { a: 1 }), tdef('y', 'preview', { p: 1 })]
    const manifest = [tdef('x', 'edit', { a: 1 }), tdef('y', 'preview', { p: 2 })]
    const r = shadowParity(builtin, manifest)
    expect(r.tierMismatches.map((d) => d.name)).toEqual(['x'])
    expect(r.tierMismatches[0]).toMatchObject({ builtinTier: 'silent', manifestTier: 'edit' })
    expect(r.schemaMismatches.map((d) => d.name)).toEqual(['y'])
  })

  test('schema compare is key-order insensitive', () => {
    const builtin = [tdef('x', 'silent', { a: 1, b: 2 })]
    const manifest = [tdef('x', 'silent', { b: 2, a: 1 })]
    expect(shadowParity(builtin, manifest).schemaMismatches).toHaveLength(0)
  })
})

describe('manifest mapper — shadow parity vs the real builtin catalog', () => {
  test('a manifest tool that names a builtin tool is reported as common', () => {
    // Real builtin catalog (KOS off → 20 tools). Construction only reads
    // kosConfig(); handlers are never invoked, so a minimal stub suffices.
    const stub = {
      kosConfig: () => ({ configured: false, timeDecayEnabled: false })
    } as unknown as ChatToolPlatform
    const builtin = createBuiltinTools(stub)
    const builtinNames = new Set(builtin.map((t) => t.name))
    expect(builtinNames.has('email_search')).toBe(true)

    const manifest = [
      mapManifestToolToToolDef('email', manifestTool({ name: 'email_search' }), async () => ({
        ok: true,
        output: null,
        durationMs: 1
      })),
      // a skill tool the builtin catalog doesn't have → onlyManifest
      mapManifestToolToToolDef(
        'calendar',
        manifestTool({ name: 'calendar_events', side_effect: 'read' }),
        async () => ({ ok: true, output: null, durationMs: 1 })
      )
    ]
    const r = shadowParity(builtin, manifest)
    expect(r.common).toContain('email_search')
    expect(r.onlyManifest).toContain('calendar_events')
    // Builtin-only tools (e.g. KOS-independent fulltext variant) surface as
    // onlyBuiltin — proving the shadow report flags the not-yet-skill-ified gap.
    expect(r.onlyBuiltin.length).toBeGreaterThan(0)
  })
})
