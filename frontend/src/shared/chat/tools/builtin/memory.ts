// Memory tools (P2f) — let the Custom AI persist + recall durable user facts
// (preferences, writing style, mail-handling principles) across conversations,
// backed by ai_chat.db.agent_memory_kv via the injected platform → serve-api
// /chat/memory. Writes go through a PREVIEW confirmation (silent memory writes
// are a known risk — architecture §3.5); reads are silent. Provenance is
// recorded (source = "session:<id>") so a saved fact is traceable.

import type { ToolDef, ToolResult, ToolExecCtx } from '../registry'
import type { ChatToolPlatform } from '../../platform'

function ok<O>(output: O, start: number): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start }
}
function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}
function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}
function fail(e: unknown, start: number): ToolResult {
  return err(
    (e as { code?: string }).code ?? 'E_INTERNAL',
    e instanceof Error ? e.message : String(e),
    start
  )
}
function effective(input: unknown, ctx: ToolExecCtx): { resolved: unknown; userEdited: boolean } {
  if (ctx.userEditedInput !== undefined) return { resolved: ctx.userEditedInput, userEdited: true }
  return { resolved: input, userEdited: false }
}

/** Default scope when the model doesn't name one. 'user' = long-term personal facts. */
const DEFAULT_SCOPE = 'user'

/** Serialize an arbitrary `value` to value_json (a string becomes a JSON string). */
function toValueJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(String(value))
  }
}

export function createMemoryTools(platform: ChatToolPlatform): ToolDef[] {
  const memoryList: ToolDef = {
    name: 'memory_list',
    description:
      'List durable memory entries the assistant has saved about the user (preferences, ' +
      'writing style, recurring instructions). Optionally filter by scope ("user" = personal, ' +
      '"skill:<name>" = skill-specific). Use at the start of a task to recall what you already ' +
      'know before asking the user to repeat themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Optional scope filter (e.g. "user").' }
      },
      required: []
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      try {
        const entries = await platform.listMemory(asStr(i.scope))
        return ok({ count: entries.length, entries }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const memoryGet: ToolDef = {
    name: 'memory_get',
    description:
      'Fetch one memory entry by scope + key. Returns found:false if nothing is stored under ' +
      'that (scope, key). Use when you need the exact stored value for a known key.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Scope (default "user").' },
        key: { type: 'string', description: 'The memory key.' }
      },
      required: ['key']
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const key = asStr(i.key)
      if (!key) return err('E_INVALID_ARG', 'key is required (non-empty string)', start)
      try {
        const entry = await platform.getMemory(asStr(i.scope) ?? DEFAULT_SCOPE, key)
        if (!entry) return ok({ found: false, key }, start)
        return ok({ found: true, ...entry }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const memoryWrite: ToolDef = {
    name: 'memory_write',
    description:
      'Save (or overwrite) a durable fact about the user under a (scope, key). Use ONLY for ' +
      'genuinely long-lived facts the user stated or confirmed (e.g. "always reply in English", ' +
      'preferred signature, recurring project context) — NOT transient task state. The user ' +
      'confirms every write (preview tier). Keep keys short + stable so future turns can recall ' +
      'them; put the fact in `value`.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Scope (default "user"; "skill:<name>" for skill-specific).'
        },
        key: { type: 'string', description: 'Short stable key, e.g. "reply_language".' },
        value: { description: 'The fact to remember (string or JSON value).' }
      },
      required: ['key', 'value']
    },
    confirmationTier: 'preview',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const { resolved, userEdited } = effective(input, ctx)
      const i = (resolved ?? {}) as Record<string, unknown>
      const key = asStr(i.key)
      if (!key) return err('E_INVALID_ARG', 'key is required (non-empty string)', start)
      if (i.value === undefined) return err('E_INVALID_ARG', 'value is required', start)
      const scope = asStr(i.scope) ?? DEFAULT_SCOPE
      try {
        const entry = await platform.writeMemory({
          scope,
          key,
          valueJson: toValueJson(i.value),
          // traceable provenance — which chat session wrote this (architecture §3.5).
          sourceWikiPath: `session:${ctx.sessionId}`
        })
        return ok(
          { saved: true, scope: entry.scope, key: entry.key, user_edited: userEdited },
          start
        )
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  const memoryDelete: ToolDef = {
    name: 'memory_delete',
    description:
      'Forget a stored memory entry by scope + key. Use when the user asks you to forget a ' +
      'preference or it is no longer true. The user confirms (preview tier).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Scope (default "user").' },
        key: { type: 'string', description: 'The memory key to delete.' }
      },
      required: ['key']
    },
    confirmationTier: 'preview',
    category: 'meta',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const { resolved } = effective(input, ctx)
      const i = (resolved ?? {}) as Record<string, unknown>
      const key = asStr(i.key)
      if (!key) return err('E_INVALID_ARG', 'key is required (non-empty string)', start)
      try {
        const deleted = await platform.deleteMemory(asStr(i.scope) ?? DEFAULT_SCOPE, key)
        return ok({ deleted, key }, start)
      } catch (e) {
        return fail(e, start)
      }
    }
  }

  return [memoryList, memoryGet, memoryWrite, memoryDelete]
}
