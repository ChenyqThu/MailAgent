// WS-2 Plane 1 (computer-use-mcp epic §3.1) — LLM Schema Lazy Loading (`tool_search`).
//
// Why this exists:
//   - Keeping 100+ external MCP tools (`mcp__<connector>__*`) permanently in Step 0 `tools` bloats
//     every prompt, wastes provider cache prefixes, and degrades tool selection.
//   - Meanwhile, AI SDK v7 replays history through `convertToModelMessages(messages, { tools })`
//     AND rejects tool calls whose names are missing from `streamText({ tools })`.
//   - So the gateway registers the FULL admitted `ToolSet` on BOTH `convertToModelMessages` and
//     `streamText`, and hides non-pinned long-tail tools via `activeTools` + `prepareStep`.
//   - When the model calls `tool_search`, matched deferred tools are added to `activatedTools`;
//     `prepareStep` reads `activatedTools` before step `k + 1` so those tools immediately enter
//     the active tool schemas within the SAME multi-step `streamText` run.
//
// Security invariant:
//   - The candidate universe is strictly the deferred subset of the ALREADY-admitted `ToolSet`
//     (post skill-gating, `admitDynamicTools`, `applyContextModePolicy`, `stripOwnerDeniedTools`,
//     per-tool `'off'`/`'deny'`, `grantConnectors`, and `disabledConnectors`). Blocked tools are
//     never indexed, never returned, and never activated.

import type { Tool, ToolSet } from 'ai'

import { TOOL_DISPLAY_NAMES_ZH } from '../../shared/assistant/toolDisplayNames'
import {
  isMcpToolName,
  normalizeMcpNamePart,
  parseMcpToolName
} from '../../shared/assistant/tools/mcpToolName'
import { DomainError } from '../python/domainClient'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import { toolSearchSchema, type ToolSearchInput } from './schemas'

/** Catalog source-of-truth array inspected by `tests/agent_eval/runner/validate_catalog.py`. */
export const GATEWAY_TOOL_SEARCH_TOOL_NAMES = ['tool_search'] as const

/** Eager-pin threshold: when total admitted `mcp__*` tools <= 5, expose all of them in Step 0
 *  without hiding them behind `tool_search` (saves an extra search round-trip for tiny setups). */
export const LAZY_EAGER_PIN_THRESHOLD = 5

const MAX_SUMMARY_CHARS = 160

export type ToolSearchCategory = 'all' | 'connector' | 'builtin'

export interface ToolSearchMatch {
  name: string
  connector_id?: string
  category: 'connector' | 'builtin'
  display_name?: string
  summary: string
  activated: boolean
  score: number
}

export interface ToolSearchResult {
  activated_tools: string[]
  remaining_deferred: number
  matches: ToolSearchMatch[]
}

export interface LazyToolPartition {
  /** Tool names exposed on Step 0 (`streamText({ activeTools })`). */
  initialActiveTools: string[]
  /** Deferred tool names omitted from Step 0 and discoverable via `tool_search`. */
  deferredToolNames: string[]
  /** Deferred-eligible tool names pinned because they appeared in history / pending approvals. */
  historyPinnedTools: string[]
  /** Mutable set shared between `tool_search.execute` and `prepareStep`. */
  activatedTools: Set<string>
}

export interface PartitionLazyToolsOpts {
  eagerPinThreshold?: number
  deferredBuiltinToolNames?: Iterable<string>
  toolSearchEnabled?: boolean
}

export interface ToolSearchController {
  deferredTools: ToolSet
  activatedTools: Set<string>
}

export interface CreateToolSearchOpts {
  deferredTools?: ToolSet
  activatedTools?: Set<string>
}

/** Module-level binding keyed by `tool.execute` so cloning tool metadata in `applyToolDisplayNames`
 *  or filtering in `wrapCfgForAgentRun` keeps the controller reachable without adding extra fields
 *  onto the AI SDK `Tool` object. */
const toolSearchControllers = new WeakMap<object, ToolSearchController>()

/** Extract every tool name referenced in UIMessages (or ModelMessages) so multi-turn replay and
 *  pending tool-approval resumes unconditionally pin those tools into `initialActiveTools`. */
export function extractReferencedToolNames(messages: readonly unknown[]): Set<string> {
  const referenced = new Set<string>()
  const recordName = (raw: unknown): void => {
    if (typeof raw === 'string' && raw.length > 0) referenced.add(raw)
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const parts = (msg as { parts?: unknown }).parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        const p = part as { type?: unknown; toolName?: unknown }
        if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
          if (
            p.type !== 'tool-call' &&
            p.type !== 'tool-result' &&
            p.type !== 'tool-approval-request' &&
            p.type !== 'tool-approval-response' &&
            p.type !== 'tool-invocation'
          ) {
            recordName(p.type.slice(5))
          }
        }
        recordName(p.toolName)
      }
    }
    const content = (msg as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue
        recordName((item as { toolName?: unknown }).toolName)
      }
    }
  }
  return referenced
}

/** Partition an already-admitted `ToolSet` into Step 0 `initialActiveTools` and `deferredToolNames`. */
export function partitionToolsForLazyLoading(
  tools: ToolSet,
  messages: readonly unknown[] = [],
  opts: PartitionLazyToolsOpts = {}
): LazyToolPartition {
  const allNames = Object.keys(tools)
  if (opts.toolSearchEnabled === false) {
    return {
      initialActiveTools: allNames,
      deferredToolNames: [],
      historyPinnedTools: [],
      activatedTools: new Set(allNames)
    }
  }

  const threshold = opts.eagerPinThreshold ?? LAZY_EAGER_PIN_THRESHOLD
  const extraDeferred = new Set(opts.deferredBuiltinToolNames ?? [])
  const mcpCount = allNames.reduce((acc, name) => acc + (isMcpToolName(name) ? 1 : 0), 0)
  const deferMcp = mcpCount > threshold
  const referenced = extractReferencedToolNames(messages)

  const initialActiveTools: string[] = []
  const deferredToolNames: string[] = []
  const historyPinnedTools: string[] = []

  for (const name of allNames) {
    if (name === 'tool_search') continue
    const mcp = isMcpToolName(name)
    const eligibleToDefer = (mcp && deferMcp) || (!mcp && extraDeferred.has(name))
    if (!eligibleToDefer) {
      initialActiveTools.push(name)
      continue
    }
    if (referenced.has(name)) {
      historyPinnedTools.push(name)
      initialActiveTools.push(name)
    } else {
      deferredToolNames.push(name)
    }
  }

  // Expose `tool_search` ONLY when at least one deferred tool remains unreachable on Step 0.
  if (deferredToolNames.length > 0 && 'tool_search' in tools) {
    initialActiveTools.push('tool_search')
  }

  return {
    initialActiveTools,
    deferredToolNames,
    historyPinnedTools,
    activatedTools: new Set(initialActiveTools)
  }
}

/** Bind the live post-admission deferred subset and shared `activatedTools` set onto `tool_search`. */
export function bindToolSearchPartition(
  toolSearchTool: Tool | undefined,
  tools: ToolSet,
  partition: LazyToolPartition
): boolean {
  const execFn = toolSearchTool?.execute
  if (typeof execFn !== 'function') return false
  const controller = toolSearchControllers.get(execFn)
  if (!controller) return false
  const deferred: ToolSet = {}
  for (const name of partition.deferredToolNames) {
    if (name in tools) deferred[name] = tools[name]
  }
  controller.deferredTools = deferred
  controller.activatedTools = partition.activatedTools
  return true
}

/** Tokenize English camelCase/snake_case and Chinese text (unigrams + bigrams) cleanly. */
function tokenizeForSearch(text: string): string[] {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
  const tokens: string[] = []
  const asciiMatches = expanded.match(/[a-z0-9]+/g)
  if (asciiMatches) tokens.push(...asciiMatches)
  const cjkRuns = expanded.match(/[\u4e00-\u9fff]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (const ch of run) tokens.push(ch)
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2))
    }
  }
  return Array.from(new Set(tokens))
}

function summarizeDescription(desc: unknown): string {
  const compact = String(desc ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (compact.length <= MAX_SUMMARY_CHARS) return compact
  return `${compact.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

interface SearchEntry {
  name: string
  category: 'connector' | 'builtin'
  connectorId?: string
  slug?: string
  displayName?: string
  summary: string
  descriptionLower: string
  nameTokens: Set<string>
  displayTokens: Set<string>
  descTokens: Set<string>
}

function buildSearchEntry(name: string, t: Tool): SearchEntry {
  const parsed = parseMcpToolName(name)
  const displayName = TOOL_DISPLAY_NAMES_ZH[name]
  const rawDesc = String(t.description ?? '')
  const slug = parsed?.toolSlug ?? name
  const connectorId = parsed?.connectorId
  const nameSource = [name, slug, connectorId ?? ''].join(' ')
  return {
    name,
    category: parsed ? 'connector' : 'builtin',
    connectorId,
    slug,
    displayName,
    summary: summarizeDescription(rawDesc),
    descriptionLower: rawDesc.toLowerCase(),
    nameTokens: new Set(tokenizeForSearch(nameSource)),
    displayTokens: new Set(tokenizeForSearch(displayName ?? '')),
    descTokens: new Set(tokenizeForSearch(rawDesc))
  }
}

/** Deterministic keyword / connector search over deferred candidate tools. */
export function searchDeferredTools(
  controller: ToolSearchController,
  input: ToolSearchInput
): ToolSearchResult {
  const rawQuery = typeof input.query === 'string' ? input.query.trim() : ''
  const rawConnectorId = typeof input.connector_id === 'string' ? input.connector_id.trim() : ''
  if (!rawQuery && !rawConnectorId) {
    throw new DomainError(
      'E_INVALID_ARG',
      'tool_search requires at least one of query or connector_id.'
    )
  }

  const category = (input.category ?? 'all') as ToolSearchCategory
  const limit = Math.min(25, Math.max(1, Math.trunc(input.limit ?? 10)))
  const targetCidLower = rawConnectorId.toLowerCase()
  const targetCidNorm = rawConnectorId ? normalizeMcpNamePart(rawConnectorId).toLowerCase() : ''

  const entries = Object.entries(controller.deferredTools)
    .map(([name, t]) => buildSearchEntry(name, t))
    .filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false
      if (!rawConnectorId) return true
      if (!entry.connectorId) return false
      const entryCidLower = entry.connectorId.toLowerCase()
      return entryCidLower === targetCidLower || (!!targetCidNorm && entryCidLower === targetCidNorm)
    })

  const queryLower = rawQuery.toLowerCase()
  const queryTokens = rawQuery ? tokenizeForSearch(rawQuery) : []

  // Simple IDF-like weight computed across the visible candidate universe so rare discriminating
  // tokens (e.g. "screenshot", "click") outrank generic verbs ("get", "list").
  const docFreq = new Map<string, number>()
  if (queryTokens.length > 0 && entries.length > 0) {
    for (const tok of queryTokens) {
      let df = 0
      for (const e of entries) {
        if (e.nameTokens.has(tok) || e.displayTokens.has(tok) || e.descTokens.has(tok)) df += 1
      }
      docFreq.set(tok, df)
    }
  }

  const scored: Array<{ entry: SearchEntry; score: number }> = []
  for (const entry of entries) {
    if (!rawQuery) {
      scored.push({ entry, score: 10 })
      continue
    }

    let score = 0
    const nameLower = entry.name.toLowerCase()
    const slugLower = (entry.slug ?? '').toLowerCase()
    if (nameLower === queryLower || slugLower === queryLower) {
      score += 100
    } else if (nameLower.includes(queryLower) || slugLower.includes(queryLower)) {
      score += 30
    }
    if (entry.displayName && entry.displayName.toLowerCase().includes(queryLower)) {
      score += 20
    } else if (entry.descriptionLower.includes(queryLower)) {
      score += 8
    }

    for (const tok of queryTokens) {
      const df = docFreq.get(tok) ?? 0
      if (df === 0) continue
      const idf = Math.log(1 + (entries.length + 0.5) / (df + 0.5)) + 0.5
      if (entry.nameTokens.has(tok)) score += 4.0 * idf
      if (entry.displayTokens.has(tok)) score += 3.5 * idf
      if (entry.descTokens.has(tok)) score += 1.5 * idf
    }

    if (score > 0) scored.push({ entry, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.entry.name.localeCompare(b.entry.name)
  })

  const top = scored.slice(0, limit)
  const activatedTools: string[] = []
  const matches: ToolSearchMatch[] = top.map(({ entry, score }) => {
    controller.activatedTools.add(entry.name)
    activatedTools.push(entry.name)
    return {
      name: entry.name,
      ...(entry.connectorId ? { connector_id: entry.connectorId } : {}),
      category: entry.category,
      ...(entry.displayName ? { display_name: entry.displayName } : {}),
      summary: entry.summary,
      activated: true,
      score: Math.round(score * 1000) / 1000
    }
  })

  let remainingDeferred = 0
  for (const name of Object.keys(controller.deferredTools)) {
    if (!controller.activatedTools.has(name)) remainingDeferred += 1
  }

  return {
    activated_tools: activatedTools,
    remaining_deferred: remainingDeferred,
    matches
  }
}

/** Build the gateway `tool_search` silent read tool (uses non-generic `auditedReadTool(` for
 *  `validate_catalog.py` AST/regex discovery). */
export function createToolSearchTool(
  opts: CreateToolSearchOpts = {},
  collector: GatewayToolAuditCollector = []
): Tool {
  const controller: ToolSearchController = {
    deferredTools: opts.deferredTools ?? {},
    activatedTools: opts.activatedTools ?? new Set<string>()
  }

  const built = auditedReadTool(
    {
      name: 'tool_search',
      description:
        'Search and activate deferred tools (such as external MCP connector tools omitted from the initial set) by keyword or connector_id. Matched tools become immediately callable on your next step.',
      inputSchema: toolSearchSchema,
      run: async (input: ToolSearchInput) => searchDeferredTools(controller, input)
    },
    collector
  )

  if (typeof built.execute === 'function') {
    toolSearchControllers.set(built.execute, controller)
  }
  return built
}
