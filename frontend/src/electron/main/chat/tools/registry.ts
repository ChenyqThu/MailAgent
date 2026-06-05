// Sprint 19 PR-1a — Agent harness foundation: ToolRegistry interface and
// empty singleton. Business logic (actual tool implementations) lands in
// PR-1b (read tools) + PR-1d (write tools). This PR is types/schema only
// so it can merge fast and unblock parallel work on the streaming layer.
//
// Design doc: docs/agent-harness-design.md §4.1.
// Plan: ~/.claude/plans/subagent-plan-lexical-moler.md (D5: tool dispatch
// surface = IPC handler direct for reads, IPC direct writes [D1 收编后改经
// 本机 daemon serve-api], CLI subprocess only for long tasks).
//
// Why a fresh module rather than extending `chat/registry.ts`:
//   `chat/registry.ts` is the backend registry (notion-agent / custom-api),
//   wired at boot via `registerChatBackend()`. Tool registry is a different
//   axis (per-message dispatch of LLM-proposed actions) — keeping them in
//   sibling modules avoids overloading the "registry" word and lets tests
//   mock one without touching the other.

import type { BackendToolDescriptor } from '@shared/chat/types'

/** Coarse grouping used for filtering the catalog when advertising to the
 *  LLM. The harness can show all tools at once (M1) or curate by category
 *  later (M3+, "tool discovery" meta-tool). */
export type ToolCategory = 'read' | 'write' | 'notion' | 'meta' | 'wiki'

/** Where the tool actually runs. Drives latency budgeting + audit trail. */
export type ToolSurface = 'ipc' | 'cli' | 'webhook'

/** Three-tier confirmation model (design doc §4.6).
 *   silent  = pure read / no side effect → execute immediately
 *   preview = reversible write / low stake → dialog with input + summary, OK/Cancel
 *   edit    = outbound / irreversible → dialog with editable input, OK/Cancel
 *
 *  Per-tool default; the harness escalates to `preview` automatically if
 *  the tool is the first invocation of a write-class scope (e.g. first
 *  `wiki_write` to a new path), and falls back to `silent` for trusted
 *  scopes the user has already approved.
 */
export type ConfirmationTier = 'silent' | 'preview' | 'edit'

/** Tool dispatch context. The handler reads `signal` for abort propagation
 *  (must thread it into any `fetch()` / DB query), and reads
 *  `userEditedInput` when the tier was `'edit'` and the user changed the
 *  proposed input via the ConfirmToolDialog.
 *
 *  `emailId` is the email the chat session is anchored to (null for the
 *  rare "global agent mode" sessions). Handlers can use this as a default
 *  scope (e.g. `email_search` may filter to the same thread when emailId
 *  is set + the prompt is ambiguous). */
export interface ToolExecCtx {
  sessionId: number
  emailId: number | null
  signal: AbortSignal
  userEditedInput?: unknown
}

/** Result envelope. `ok:true` returns `output` (handler-specific shape);
 *  `ok:false` returns a structured error (`code` matches the `E_*` enum in
 *  `docs/cli-schema/error-codes.md` when applicable) so the LLM can read
 *  it and self-correct. `durationMs` always populated. */
export type ToolResult<O = unknown> =
  | { ok: true; output: O; durationMs: number; truncated?: boolean }
  | { ok: false; code: string; message: string; durationMs: number }

/** A tool the LLM may call. Registered at boot (`registerBuiltinTools`)
 *  for production, on-the-fly in tests. Shape mirrors Anthropic's tool
 *  schema with extra metadata fields for the harness (confirmation tier,
 *  throttle, timeout, surface). */
export interface ToolDef<I = unknown, O = unknown> {
  /** snake_case identifier. Used verbatim as Anthropic `name`. MUST be
   *  unique within a registry. */
  name: string
  /** What the LLM sees before deciding to call this. Keep ≤ 80 token,
   *  actionable ("Use when user asks X"), no implementation detail. */
  description: string
  /** JSON Schema (Draft-07 subset Anthropic accepts) for the LLM's input.
   *  The harness validates against this before invoking `handler`. */
  inputSchema: Record<string, unknown>
  /** Optional — used for renderer preview cards and post-hoc validation. */
  outputSchema?: Record<string, unknown>
  confirmationTier: ConfirmationTier
  category: ToolCategory
  surface: ToolSurface
  /** Per-call upper bound. Handler aborted on timeout, harness emits
   *  `ToolResult { ok:false, code:'E_TIMEOUT' }`. Default 10000. */
  timeoutMs?: number
  /** Soft rate-limit per session per minute. Default 30. Exceeding emits
   *  `E_THROTTLED` so the LLM sees it and can back off. */
  throttlePerMinute?: number
  /** The actual implementation. MUST propagate `ctx.signal` to fetch/DB. */
  handler: (input: I, ctx: ToolExecCtx) => Promise<ToolResult<O>>
}

/** Catalog of registered tools. Mostly a typed `Map<name, ToolDef>` with
 *  helpers to emit upstream-API-shaped tool arrays.
 *
 *  Concurrency: instances are NOT thread-safe (which is fine — the main
 *  process owns a single registry, all dispatches go through one thread).
 */
export class ToolRegistry {
  private byName = new Map<string, ToolDef>()

  /** Register a tool. Throws on duplicate name to fail loud at boot. */
  register(def: ToolDef): void {
    if (this.byName.has(def.name)) {
      throw new Error(
        `Tool "${def.name}" already registered. Each tool name must be unique ` +
          `across the registry (Anthropic uses it as the call identifier).`
      )
    }
    this.byName.set(def.name, def)
  }

  /** Look up by name. Returns `undefined` for unknown — caller decides
   *  whether that's an error (typical when the LLM hallucinates a name). */
  get(name: string): ToolDef | undefined {
    return this.byName.get(name)
  }

  /** Enumerate (optionally filtered by category). Order is insertion order. */
  list(filter?: { categories?: ToolCategory[] }): ToolDef[] {
    const all = [...this.byName.values()]
    if (!filter?.categories || filter.categories.length === 0) return all
    const set = new Set(filter.categories)
    return all.filter((t) => set.has(t.category))
  }

  /** Emit the array that Anthropic `/v1/messages` expects under `tools`.
   *  Returns `[]` when nothing's registered; the backend strips the field
   *  in that case (Anthropic rejects empty `tools` arrays). */
  toAnthropicSchema(filter?: { categories?: ToolCategory[] }): BackendToolDescriptor[] {
    return this.list(filter).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }))
  }

  /** Emit the OpenAI Chat Completions function-calling shape. Used for the
   *  CRS `gpt-*` fallback model path (planned for M2). M1 only exercises
   *  `toAnthropicSchema()`. */
  toOpenAISchema(filter?: { categories?: ToolCategory[] }): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }> {
    return this.list(filter).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }))
  }

  /** Diagnostic — list of registered tool names. */
  names(): string[] {
    return [...this.byName.keys()]
  }

  /** Test-only — drop everything between specs. */
  __reset(): void {
    this.byName.clear()
  }
}

/** Production singleton. Tools register here at app boot
 *  (`frontend/src/electron/main/index.ts` → `registerBuiltinTools()`).
 *  Tests should prefer `createToolRegistry()` to avoid global state. */
export const defaultToolRegistry = new ToolRegistry()

/** Factory for tests + future per-feature registries (e.g. if we ever
 *  curate tools by user permission level). */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry()
}
