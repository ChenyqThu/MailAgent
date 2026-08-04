// Stage 1 PR2 (harness-expansion epic) — MCP connector gateway-tool naming, ONE source.
//
// A connector tool's gateway name is `mcp__<connector>__<slug>` (PRD Q3拍板 — the prefix is how
// classOfTool / the card fallback recognize a connector tool). The remote tool name (e.g. Notion's
// `notion-update-page`) is normalized into a model-safe slug (`notion_update_page`). BOTH sides
// consume this module — the gateway assembly (ai-gateway/tools/connector.ts, builds + registers
// the names) and the renderer approval-card fallback (McpApprovalCard, parses a part's toolName
// back into connector + slug and matches manifest rows) — so the mapping can never drift into two
// hand-copies (跨边界手抄常量纪律). 🔴 Pure TS, zero imports: safe for the gateway core (tsx
// harness) and the renderer bundle alike.

/** The connector-tool name prefix (`mcp__<connector>__<slug>`). */
export const MCP_TOOL_PREFIX = 'mcp__'

/** Max gateway tool-name length (provider tool-name limits are 64-128; stay under the floor). */
const MAX_TOOL_NAME_LEN = 128

/** Normalize one name part into a model-safe slug: every char outside [A-Za-z0-9_] becomes '_'
 *  (Notion's `notion-update-page` → `notion_update_page`). Returns '' for a part with no usable
 *  characters at all. */
export function normalizeMcpNamePart(part: string): string {
  const slug = part.replace(/[^A-Za-z0-9_]/g, '_')
  return /[A-Za-z0-9]/.test(slug) ? slug : ''
}

/** Compose the gateway tool name for a connector tool, or null when it cannot be represented
 *  (empty/degenerate parts, or over the provider name-length floor) — the caller SKIPS such a
 *  tool with a warning instead of minting a broken name. */
export function mcpGatewayToolName(connectorId: string, remoteToolName: string): string | null {
  const cid = normalizeMcpNamePart(connectorId)
  const slug = normalizeMcpNamePart(remoteToolName)
  if (!cid || !slug) return null
  const name = `${MCP_TOOL_PREFIX}${cid}__${slug}`
  return name.length <= MAX_TOOL_NAME_LEN ? name : null
}

/** Is this gateway tool name a connector tool? (prefix check — the recognition seam of both the
 *  runtime class registry and the renderer card fallback.) */
export function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
}

/** Split a connector gateway tool name back into { connectorId, toolSlug }, or null when the
 *  shape doesn't match (defense — never throw on a hostile/legacy name). */
export function parseMcpToolName(name: string): { connectorId: string; toolSlug: string } | null {
  if (!isMcpToolName(name)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep >= rest.length - 2) return null
  return { connectorId: rest.slice(0, sep), toolSlug: rest.slice(sep + 2) }
}
