// Skill management tools (PR6) — let the Custom AI inspect the installed skills and,
// under confirmation, enable/disable/install/uninstall them via the injected platform →
// serve-api /api/agent/skills. Reads are silent; every mutation is a PREVIEW confirmation
// that shows the action (and, for install, the source + requested scopes) — the agent can
// NEVER silently install a skill or widen its own capabilities. Installs are limited to
// document / local_folder / skill_pack sources (arbitrary-code plugins are not supported);
// granted scopes are validated against the known catalog backend-side.

import type { ToolDef, ToolResult, ToolExecCtx } from '../registry'
import type { ChatToolPlatform } from '../../platform'

function ok<O>(output: O, start: number): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start }
}
function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}
function fail(e: unknown, start: number): ToolResult {
  return err(
    (e as { code?: string }).code ?? 'E_INTERNAL',
    e instanceof Error ? e.message : String(e),
    start
  )
}
function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}
function effective(input: unknown, ctx: ToolExecCtx): unknown {
  return ctx.userEditedInput !== undefined ? ctx.userEditedInput : input
}

const INSTALL_SOURCES = ['document', 'local_folder', 'skill_pack']

export function createSkillManagementTools(platform: ChatToolPlatform): ToolDef[] {
  const listInstalled: ToolDef = {
    name: 'skill_list_installed',
    description:
      'List the skills available to this assistant (builtin + user-installed), with their ' +
      'enabled state, source, tool count, and scopes. Use this to see what you can currently ' +
      'do, or before proposing to enable/disable a skill.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (): Promise<ToolResult> => {
      const start = Date.now()
      try {
        const skills = await platform.listAgentSkills()
        return ok({ count: skills.length, skills }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const read: ToolDef = {
    name: 'skill_read',
    description:
      'Read one skill’s detail (title, description, enabled state, source, tools, scopes) by ' +
      'name. Use before proposing to enable or uninstall it so you explain exactly what it does.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill name' } },
      required: ['name']
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input): Promise<ToolResult> => {
      const start = Date.now()
      const name = asStr((input as Record<string, unknown>)?.name)
      if (!name) return err('E_INVALID_ARG', 'name is required', start)
      try {
        const skill = (await platform.listAgentSkills()).find((s) => s.name === name)
        if (!skill) return ok({ found: false, name }, start)
        return ok({ found: true, ...skill }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  function toggle(enabled: boolean): ToolDef {
    return {
      name: enabled ? 'skill_enable' : 'skill_disable',
      description: enabled
        ? 'Enable a skill so its tools + guidance are available to you. The user confirms ' +
          '(preview tier) — you cannot silently widen your own capabilities.'
        : 'Disable a skill so its tools + guidance are no longer loaded. The user confirms ' +
          '(preview tier).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'skill name' } },
        required: ['name']
      },
      confirmationTier: 'preview',
      category: 'meta',
      surface: 'ipc',
      timeoutMs: 6000,
      handler: async (input, ctx): Promise<ToolResult> => {
        const start = Date.now()
        const n = asStr((effective(input, ctx) as Record<string, unknown>)?.name)
        if (!n) return err('E_INVALID_ARG', 'name is required', start)
        try {
          await platform.setAgentSkillEnabled(n, enabled)
          return ok({ name: n, enabled }, start)
        } catch (e) {
          return fail(e, start)
        }
      }
    }
  }

  const install: ToolDef = {
    name: 'skill_install',
    description:
      'Install a user skill from a document / local_folder / skill_pack source. The user MUST ' +
      'confirm (preview tier) — the proposal shows the FULL install risk: source URI, package ' +
      'hash, trusted flag, requested scopes, and your reason / risk summary. Always fill ' +
      'source_uri / package_hash (when the skill comes from a folder or pack), reason, and ' +
      'risk_summary so the user can make an informed decision. Requested scopes are validated ' +
      'against the known catalog; arbitrary-code plugins are NOT supported.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill name (unique slug)' },
        source_type: { type: 'string', description: 'document | local_folder | skill_pack' },
        manifest: {
          type: 'object',
          description: 'skill manifest (name/title/prompt_fragment/tools…)'
        },
        version: { type: 'string' },
        granted_scopes: { type: 'array', items: { type: 'string' } },
        source_uri: {
          type: 'string',
          description: 'where the skill comes from (folder path / pack URL); shown to the user'
        },
        package_hash: {
          type: 'string',
          description: 'content hash of the package for integrity, when known'
        },
        trusted: {
          type: 'boolean',
          description: 'mark the source as trusted (default false; the user confirms)'
        },
        reason: { type: 'string', description: 'why you are installing this skill' },
        risk_summary: {
          type: 'string',
          description: 'a 1-line summary of what this skill can do / its risk'
        }
      },
      required: ['name', 'source_type']
    },
    confirmationTier: 'preview',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 8000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (effective(input, ctx) ?? {}) as Record<string, unknown>
      const name = asStr(i.name)
      const sourceType = asStr(i.source_type)
      if (!name) return err('E_INVALID_ARG', 'name is required', start)
      if (!sourceType || !INSTALL_SOURCES.includes(sourceType)) {
        return err(
          'E_INVALID_ARG',
          `source_type must be one of ${INSTALL_SOURCES.join(' / ')}`,
          start
        )
      }
      try {
        // R9 — forward the full install risk metadata so the backend persists
        // source_uri / package_hash / trusted (reason / risk_summary are display-only:
        // they ride in the tool input the ConfirmToolDialog already renders).
        const res = await platform.installAgentSkill({
          name,
          sourceType,
          manifest: (i.manifest as Record<string, unknown>) ?? undefined,
          version: asStr(i.version),
          grantedScopes: Array.isArray(i.granted_scopes)
            ? (i.granted_scopes as string[])
            : undefined,
          sourceUri: asStr(i.source_uri),
          packageHash: asStr(i.package_hash),
          trusted: typeof i.trusted === 'boolean' ? i.trusted : undefined
        })
        return ok({ installed: true, ...res }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const uninstall: ToolDef = {
    name: 'skill_uninstall',
    description:
      'Uninstall a user skill (or clear a builtin’s enable override) by name. The user confirms ' +
      '(preview tier). Idempotent.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill name' } },
      required: ['name']
    },
    confirmationTier: 'preview',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const name = asStr((effective(input, ctx) as Record<string, unknown>)?.name)
      if (!name) return err('E_INVALID_ARG', 'name is required', start)
      try {
        return ok(await platform.uninstallAgentSkill(name), start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  return [listInstalled, read, toggle(true), toggle(false), install, uninstall]
}
