// Agent profile tools (PR6) — let the Custom AI read + (under confirmation) edit its
// own Standing Context docs (SOUL/AGENT/RULES/USER) via the injected platform →
// serve-api /api/agent/profile/*. Reads are silent; apply_patch is an EDIT confirmation
// (the user sees + can tweak the proposed content in ConfirmToolDialog); rollback is a
// PREVIEW confirmation. The agent can NEVER silently change its identity/rules — and
// RULES.md edits additionally pass a backend safety validator (the immutable
// PRODUCT_SAFETY_FLOOR is prepended in code regardless, so the floor can't be weakened).

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

const EDITABLE = ['soul', 'agent', 'rules', 'user']

export function createAgentProfileTools(platform: ChatToolPlatform): ToolDef[] {
  const listDocs: ToolDef = {
    name: 'agent_profile_list_docs',
    description:
      'List the Standing Context documents that shape this assistant: soul (identity), ' +
      'agent (working style), rules (hard limits), user (preferences) — plus the read-only ' +
      'memory + skills projections. Returns metadata (name, editable, last update); use ' +
      'agent_profile_read_doc to read a document’s full content.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (): Promise<ToolResult> => {
      const start = Date.now()
      try {
        const docs = await platform.listProfileDocs()
        return ok(
          {
            count: docs.length,
            docs: docs.map((d) => ({
              docName: d.docName,
              editable: d.editable,
              updatedBy: d.updatedBy,
              updatedAt: d.updatedAt,
              contentHash: d.contentHash
            }))
          },
          start
        )
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const readDoc: ToolDef = {
    name: 'agent_profile_read_doc',
    description:
      'Read one Standing Context document’s full content by name (soul / agent / rules / ' +
      'user / memory / skills). Read silently before proposing an edit so you patch the ' +
      'current version.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'doc name' } },
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
        return ok(await platform.readProfileDoc(name), start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const history: ToolDef = {
    name: 'agent_profile_history',
    description:
      'List the version history of a Standing Context document (newest first) so you can ' +
      'show the user what changed or pick a version to roll back to (use the newHash as the ' +
      'rollback target).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'optional doc name filter' } },
      required: []
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input): Promise<ToolResult> => {
      const start = Date.now()
      try {
        const entries = await platform.listProfileHistory(
          asStr((input as Record<string, unknown>)?.name)
        )
        return ok({ count: entries.length, history: entries }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const applyPatch: ToolDef = {
    name: 'agent_profile_apply_patch',
    description:
      'Propose new FULL content for an editable Standing Context document (soul / agent / ' +
      'rules / user). The user MUST review and confirm (and may edit) the proposed content ' +
      'before it is saved — you can never change your identity or rules silently. Pass the ' +
      'complete new document in `content` (not a diff). RULES edits also pass a safety ' +
      'validator; the built-in safety floor always applies and cannot be weakened here.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'soul | agent | rules | user' },
        content: { type: 'string', description: 'the complete new document content' }
      },
      required: ['name', 'content']
    },
    confirmationTier: 'edit',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 8000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (effective(input, ctx) ?? {}) as Record<string, unknown>
      const name = asStr(i.name)
      const content = asStr(i.content)
      if (!name || !EDITABLE.includes(name)) {
        return err('E_INVALID_ARG', `name must be one of ${EDITABLE.join(' / ')}`, start)
      }
      if (!content) return err('E_INVALID_ARG', 'content is required (non-empty)', start)
      try {
        const doc = await platform.setProfileDoc({
          name,
          content,
          updatedBy: 'agent_proposed',
          sessionId: ctx.sessionId
        })
        return ok({ saved: true, docName: doc.docName, contentHash: doc.contentHash }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const rollback: ToolDef = {
    name: 'agent_profile_rollback',
    description:
      'Roll a Standing Context document back to a previous version (identified by the ' +
      'newHash from agent_profile_history). The user confirms the rollback (preview tier).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'soul | agent | rules | user' },
        target_hash: { type: 'string', description: 'the version hash to restore' }
      },
      required: ['name', 'target_hash']
    },
    confirmationTier: 'preview',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 8000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (effective(input, ctx) ?? {}) as Record<string, unknown>
      const name = asStr(i.name)
      const targetHash = asStr(i.target_hash)
      if (!name || !EDITABLE.includes(name)) {
        return err('E_INVALID_ARG', `name must be one of ${EDITABLE.join(' / ')}`, start)
      }
      if (!targetHash) return err('E_INVALID_ARG', 'target_hash is required', start)
      try {
        const doc = await platform.rollbackProfileDoc({
          name,
          targetHash,
          updatedBy: 'agent_proposed',
          sessionId: ctx.sessionId
        })
        return ok({ restored: true, docName: doc.docName, contentHash: doc.contentHash }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  return [listDocs, readDoc, history, applyPatch, rollback]
}
