// P2a (task 06-18-custom-ai-harness-agent Phase 2) — Skill manifest → TS ToolDef
// mapper + shadow parity.
//
// Phase 1 made `GET /api/skills` the single authoritative Skill manifest (Python
// `src/skills/registry.py`). Phase 2 lets the Custom AI harness consume that same
// manifest instead of the hand-wired `createBuiltinTools(platform)` catalog. This
// module is the SHADOW-MODE step: it types the manifest, maps each manifest tool
// to a harness `ToolDef`, and diffs the manifest catalog against the legacy
// builtin catalog so we can prove parity (tool names / input schema / confirmation
// tier) BEFORE cutting the production registry over (P2g).
//
// Zero Electron/Node import (invariant 1, pnpm build:web).

import type { ConfirmationTier, ToolCategory, ToolDef, ToolExecCtx, ToolResult } from './registry'

// ── manifest wire types (mirror src/skills/models.py, snake_case JSON) ──────────

/** Python ConfirmationTier — note 'none' (vs the harness's 'silent'). */
export type ManifestConfirmationTier = 'none' | 'preview' | 'edit'
export type ManifestSideEffect = 'read' | 'write' | 'external_call' | 'send'
export type ManifestHandlerKind = 'service' | 'repository' | 'subprocess' | 'api'

export interface ManifestToolHandler {
  kind: ManifestHandlerKind
  target: string
}

export interface ManifestToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  confirmation_tier: ManifestConfirmationTier
  side_effect: ManifestSideEffect
  auth_scopes: string[]
  mcp_exposed: boolean
  handler: ManifestToolHandler
  timeout_ms?: number | null
  rate_limit?: Record<string, unknown> | null
}

export interface ManifestSkillAvailability {
  available: boolean
  reason?: string | null
}

export interface ManifestSkillDef {
  name: string
  version: string
  title: string
  description: string
  default_enabled: boolean
  availability: ManifestSkillAvailability
  prompt_fragment: string
  docs_path: string
  tools: ManifestToolDef[]
}

export interface SkillManifest {
  manifest_version?: string
  generated_at: string
  server_version: string
  capabilities: Record<string, unknown>
  skills: ManifestSkillDef[]
}

// ── generic invoke signature ────────────────────────────────────────────────

/** Generic skill-tool invoker injected into the mapped handler. Production wires
 *  this to `platform.invokeSkillTool(skill, tool, input)` → serve-api
 *  POST /api/skills/invoke; tests pass a stub. The handler shape matches the
 *  harness `ToolDef.handler` so a mapped tool is directly registrable. */
export type SkillToolInvoker = (
  skill: string,
  tool: string,
  input: unknown,
  ctx: ToolExecCtx
) => Promise<ToolResult>

// ── mapping ──────────────────────────────────────────────────────────────────

/** Python 'none' → harness 'silent'; preview/edit pass through. Centralised so a
 *  manifest tier that's neither is caught at the seam rather than silently
 *  downgraded. */
export function mapConfirmationTier(t: ManifestConfirmationTier): ConfirmationTier {
  switch (t) {
    case 'none':
      return 'silent'
    case 'preview':
      return 'preview'
    case 'edit':
      return 'edit'
    default:
      // Forward-compat: an unknown tier is treated as the safest (most-gated).
      return 'edit'
  }
}

/** Coarse category from the manifest side_effect (the manifest doesn't carry the
 *  harness's read/write/notion/meta/wiki axis directly). read → 'read'; every
 *  side-effecting class → 'write'. Used only for catalog filtering / parity
 *  reporting, not for confirmation (that's the tier). */
export function categoryFromSideEffect(s: ManifestSideEffect): ToolCategory {
  return s === 'read' ? 'read' : 'write'
}

/** Map one manifest tool to a harness ToolDef bound to a generic invoker. */
export function mapManifestToolToToolDef(
  skillName: string,
  tool: ManifestToolDef,
  invoke: SkillToolInvoker
): ToolDef {
  const def: ToolDef = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
    outputSchema: tool.output_schema,
    confirmationTier: mapConfirmationTier(tool.confirmation_tier),
    category: categoryFromSideEffect(tool.side_effect),
    // The manifest doesn't carry a surface; subprocess handlers run out-of-process
    // (notion-agent CLI) → 'cli', everything else is the serve-api invoke seam → 'ipc'.
    surface: tool.handler.kind === 'subprocess' ? 'cli' : 'ipc',
    handler: (input, ctx) => invoke(skillName, tool.name, input, ctx)
  }
  if (typeof tool.timeout_ms === 'number') def.timeoutMs = tool.timeout_ms
  return def
}

/** Flatten every skill's tools into a single ToolDef[] (manifest catalog). */
export function mapManifestToToolDefs(
  manifest: SkillManifest,
  invoke: SkillToolInvoker
): ToolDef[] {
  const out: ToolDef[] = []
  for (const skill of manifest.skills) {
    for (const tool of skill.tools) {
      out.push(mapManifestToolToToolDef(skill.name, tool, invoke))
    }
  }
  return out
}

// ── shadow parity ─────────────────────────────────────────────────────────────

export interface ParityToolDiff {
  name: string
  builtinTier?: ConfirmationTier
  manifestTier?: ConfirmationTier
  schemaEqual: boolean
}

export interface ParityReport {
  /** Tool names present in both catalogs. */
  common: string[]
  /** Only in the legacy builtin catalog (manifest doesn't expose them — e.g.
   *  KOS tools, fulltext search variants not yet skill-ified). */
  onlyBuiltin: string[]
  /** Only in the manifest catalog (skill tools the builtin catalog lacks). */
  onlyManifest: string[]
  /** Common tools whose confirmation tier differs. */
  tierMismatches: ParityToolDiff[]
  /** Common tools whose input schema differs (stable JSON stringify). */
  schemaMismatches: ParityToolDiff[]
}

function stableStringify(value: unknown): string {
  // Order-insensitive JSON compare: recursively sort object keys so a schema
  // that's structurally equal but key-ordered differently still matches.
  const seen = new WeakSet<object>()
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return null
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(norm)
    const obj = v as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) sorted[k] = norm(obj[k])
    return sorted
  }
  return JSON.stringify(norm(value))
}

/** Diff the legacy builtin catalog against the manifest catalog by tool name.
 *  Pure (no I/O) so the shadow comparison can run at construction time and be
 *  unit-tested without a live serve-api. */
export function shadowParity(builtin: ToolDef[], manifest: ToolDef[]): ParityReport {
  const byBuiltin = new Map(builtin.map((t) => [t.name, t]))
  const byManifest = new Map(manifest.map((t) => [t.name, t]))

  const common: string[] = []
  const onlyBuiltin: string[] = []
  const onlyManifest: string[] = []
  const tierMismatches: ParityToolDiff[] = []
  const schemaMismatches: ParityToolDiff[] = []

  for (const name of byBuiltin.keys()) {
    if (byManifest.has(name)) common.push(name)
    else onlyBuiltin.push(name)
  }
  for (const name of byManifest.keys()) {
    if (!byBuiltin.has(name)) onlyManifest.push(name)
  }

  for (const name of common) {
    const b = byBuiltin.get(name)!
    const m = byManifest.get(name)!
    const schemaEqual = stableStringify(b.inputSchema) === stableStringify(m.inputSchema)
    if (b.confirmationTier !== m.confirmationTier) {
      tierMismatches.push({
        name,
        builtinTier: b.confirmationTier,
        manifestTier: m.confirmationTier,
        schemaEqual
      })
    }
    if (!schemaEqual) {
      schemaMismatches.push({
        name,
        builtinTier: b.confirmationTier,
        manifestTier: m.confirmationTier,
        schemaEqual
      })
    }
  }

  return {
    common: common.sort(),
    onlyBuiltin: onlyBuiltin.sort(),
    onlyManifest: onlyManifest.sort(),
    tierMismatches,
    schemaMismatches
  }
}
