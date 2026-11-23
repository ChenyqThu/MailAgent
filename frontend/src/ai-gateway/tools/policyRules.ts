// Context-mode policy tool-class vocabulary and dynamic tool registry.
import type { ToolSet } from 'ai'

/** Policy class of a gateway tool (ADR-001 D2, 'web' split out of 'outbound' by ADR-004 rev3.1
 *  §3.1) — orthogonal to the approval tier.
 *
 *  'connector_write' (stage 1 PR2, harness-expansion epic — grill Q5=A原案; 08-05 WP-10 改判): the
 *  write/update tools of an MCP connector (`mcp__<connector>__<tool>`, runtime-registered — never
 *  in the static map below). manual_chat: registered; the approval shape follows the OWNER'S
 *  per-tool tier since 08-05 — 'ask' → the edit-tier card (the pre-08-05 恒 HITL behaviour),
 *  'auto' → card-free via the policyEvaluate seam (audit 'auto_tool_mode'), 'off' → not
 *  registered at all (WP-11's built-in per-tool registry never contains dynamic names —
 *  the CONNECTOR tier, not the built-in tier map, is how a connector write goes card-free). Outside
 *  manual (PR3): the per-connector grant key `connectors` lifts the row for
 *  untrusted_trigger/cron_headless when ANY granted ceiling is write-capable ('write'/'update');
 *  no grants → the fail-closed `return false`. im_chat (stage 2 PR-1, 08-04 拍板「connector 对
 *  im_chat 全开放」; 08-05 场地二: tiers apply like manual — ask 走飞书卡 / auto 免卡): grants
 *  are still never consulted (the venue is owner-present, not a granted headless run). Connector
 *  READ tools map to the existing 'read' (silent on the default 'auto' tier; an owner-demoted
 *  'ask' read registers approval-gated in owner-present venues); the load seam
 *  (shouldLoadConnectorTools) still keeps headless runs WITHOUT connector grants at zero fetches. */
export const GATEWAY_TOOL_CLASS_VALUES = [
  'read',
  'artifact',
  'domain_write',
  'capability_change',
  'exec',
  'web',
  'outbound',
  'connector_write'
] as const
export type GatewayToolClass = (typeof GATEWAY_TOOL_CLASS_VALUES)[number]

// ---- Stage 0b (harness-expansion epic) — runtime tool-class registry for DYNAMIC tools --------
//
// Stage 1 introduces connector tools whose names are only known at runtime
// (`mcp__<connector>__<tool>`): the static GATEWAY_TOOL_CLASSES record is structurally blind to
// them (fail-close to 'exec' would strip them from every headless run) and the static catalog
// gates have zero coverage. 0b lands the MECHANISM only (stage 1 fills the contents): a dynamic
// source must REGISTER each tool's class here before assembly; admitDynamicTools() refuses any
// dynamic tool without a registration (fail-closed), and classOfTool() resolves registered names
// so the SAME matrix / runtime modeDenied / auto-approve predicates govern them. With zero
// registrations (today) every path below is byte-identical to the static behaviour.

const RUNTIME_TOOL_CLASSES = new Map<string, GatewayToolClass>()

/** Stage 2 PR-4 (task 08-01 messenger) — the DESTRUCTIVE bit of a runtime-registered tool, kept
 *  in a SIBLING map on purpose: it is a *presentation* fact (render a red warning), NOT a policy
 *  input. Nothing in the matrix / auto-approve predicates reads it, so widening the class map's
 *  value type (and every consumer of it) would have been the larger change.
 *
 *  Why it must live here at all: at approval-stash time (`chatRun.maybeStashAndAnnounceApproval`)
 *  the only tool fact in scope is the composed name — the connector manifest lives in the
 *  Electron lifecycle's TTL cache and is not reachable through `AiGatewayConfig`. The desktop
 *  McpApprovalCard sidesteps this by re-fetching `/api/connector/{id}/tools` from the renderer;
 *  an out-of-app surface (Feishu) has no such renderer, so the bit has to ride the stash. */
const RUNTIME_TOOL_DESTRUCTIVE = new Map<string, boolean>()

/** Register the policy class of a runtime-discovered (dynamic) tool. Fail-closed guards: a
 *  static GATEWAY_TOOL_CLASSES name can never be shadowed (the compile-time map stays the single
 *  source of truth for built-in tools), and only real GatewayToolClass literals are accepted
 *  (junk from a connector manifest must not mint a policy class).
 *
 *  `destructive` (optional, stage 2 PR-4) is presentation-only — see RUNTIME_TOOL_DESTRUCTIVE.
 *  Omitting it registers `false`, which is byte-identical to the pre-PR-4 behaviour. */
export function registerDynamicToolClass(
  staticClasses: Record<string, GatewayToolClass>,
  name: string,
  toolClass: GatewayToolClass,
  destructive?: boolean
): void {
  if (!name) throw new Error('registerRuntimeToolClass: empty tool name')
  if (staticClasses[name] !== undefined) {
    throw new Error(`registerRuntimeToolClass: '${name}' is a static gateway tool (unshadowable)`)
  }
  if (!(GATEWAY_TOOL_CLASS_VALUES as readonly string[]).includes(toolClass)) {
    throw new Error(`registerRuntimeToolClass: invalid tool class '${String(toolClass)}'`)
  }
  RUNTIME_TOOL_CLASSES.set(name, toolClass)
  RUNTIME_TOOL_DESTRUCTIVE.set(name, destructive === true)
}

/** Is this runtime-registered tool marked destructive by its MCP server? Unknown name → false
 *  (fail-quiet: an absent registration means "no warning", never a fabricated one). */
export function isRuntimeToolDestructive(name: string): boolean {
  return RUNTIME_TOOL_DESTRUCTIVE.get(name) === true
}

/** Is this name a runtime-registered dynamic tool? (assembly gate + tests) */
export function hasRuntimeToolClass(name: string): boolean {
  return RUNTIME_TOOL_CLASSES.has(name)
}

/** Test-only: clear the registry (module-level state would otherwise leak across tests). */
export function resetRuntimeToolClasses(): void {
  RUNTIME_TOOL_CLASSES.clear()
  RUNTIME_TOOL_DESTRUCTIVE.clear()
}

/** Stage-0b assembly gate: admit DYNAMIC tools into an assembled ToolSet. A dynamic tool with NO
 *  runtime classification is NOT admitted — without a class the matrix could only fail-close it
 *  to 'exec' (silently stripped headless, catalog gates blind), so the miss is made loud at the
 *  one seam stage 1 owns. A name colliding with an already-assembled tool never clobbers it
 *  (defense in depth on top of the registry's static-shadow rejection). `dynamic` absent/empty →
 *  the SAME base object (identity — every current caller, byte-identical). buildGatewayTools runs
 *  this BEFORE applyContextModePolicy so admitted tools are still mode-filtered by their
 *  registered class. */
export function admitDynamicTools(base: ToolSet, dynamic?: ToolSet): ToolSet {
  if (!dynamic) return base
  const entries = Object.entries(dynamic)
  if (entries.length === 0) return base
  const out: ToolSet = { ...base }
  for (const [name, t] of entries) {
    if (Object.prototype.hasOwnProperty.call(base, name)) continue
    if (!RUNTIME_TOOL_CLASSES.has(name)) continue
    out[name] = t
  }
  return out
}

/** Resolve a tool's policy class: runtime registry first (dynamic tools; can never shadow a
 *  static name — registerRuntimeToolClass rejects those), then the static map. Missing/unknown
 *  name fail-closes to 'exec' (strictest class: manual-only registration + never auto-approved)
 *  — a new tool that forgot to classify itself degrades toward safety AND trips the completeness
 *  test. */
export function resolveToolClass(
  staticClasses: Record<string, GatewayToolClass>,
  name: string
): GatewayToolClass {
  return RUNTIME_TOOL_CLASSES.get(name) ?? staticClasses[name] ?? 'exec'
}

