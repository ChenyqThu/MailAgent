import type { TFunction } from 'i18next'

import { isSuggestFollowupsPart } from '@shared/assistant/followups'
import type { TurnStagePart } from '@shared/assistant/runtime/useTurnStage'
import { toolTitleKey } from '@shared/components/chat/tool_steps'

const ARG_PREVIEW_MAX_CHARS = 42

const PRIORITY_ARG_KEYS: readonly string[] = [
  'toolSummary',
  'status_hint',
  'goal',
  'query',
  'q',
  'keyword',
  'keywords',
  'search_query',
  'subject',
  'filename',
  'file_name',
  'path',
  'file_path',
  'url',
  'uri',
  'title',
  'name',
  'folder',
  'mailbox',
  'from',
  'to',
  'sender',
  'recipient',
  'command',
  'cmd',
  'prompt'
]

const NOISE_ARG_KEYS: ReadonlySet<string> = new Set([
  'limit',
  'offset',
  'page',
  'top_k',
  'max_results',
  'mode',
  'internal_id',
  'email_id',
  'thread_id',
  'attachment_id',
  'session_id',
  'account_id',
  'include_body',
  'format'
])

const MCP_SERVER_LABELS: Record<string, string> = {
  notion: 'Notion',
  github: 'GitHub',
  slack: 'Slack',
  linear: 'Linear',
  google_calendar: 'Google Calendar',
  gmail: 'Gmail',
  feishu: 'Feishu',
  nowledge_mem: 'Nowledge Mem'
}

const RESULT_ARRAY_KEYS: readonly string[] = [
  'items',
  'emails',
  'results',
  'hits',
  'matches',
  'files',
  'documents',
  'events',
  'messages'
]

function asPlainObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function safeParseObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    return asPlainObject(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

function truncateText(value: string, maxChars = ARG_PREVIEW_MAX_CHARS): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed
}

/**
 * Extract the single most informative argument string for a tool call, prioritizing semantic
 * query/target keys and skipping internal IDs, pagination limits, and formatting flags.
 */
export function extractRepresentativeArg(
  _toolName: string,
  args: unknown,
  argsText?: string
): string {
  const obj = asPlainObject(args) ?? safeParseObject(argsText)
  if (!obj) return ''

  for (const key of PRIORITY_ARG_KEYS) {
    const val = obj[key]
    if (typeof val === 'string') {
      const cleaned = truncateText(val)
      if (cleaned) return cleaned
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (NOISE_ARG_KEYS.has(key)) continue
    if (typeof val === 'string') {
      const cleaned = truncateText(val)
      if (cleaned) return cleaned
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (NOISE_ARG_KEYS.has(key)) continue
    if (typeof val === 'number' && Number.isFinite(val)) return String(val)
  }

  return ''
}

function formatServerLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase()
  const mapped = MCP_SERVER_LABELS[normalized]
  if (mapped) return mapped
  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Parse dynamic MCP tool names (`mcp__<server>__<tool>`) into human-readable server + action labels.
 */
export function prettifyMcpToolName(
  toolName: string
): { readonly server: string; readonly action: string } | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName)
  if (!match) return null
  const server = formatServerLabel(match[1] ?? '')
  const rawAction = match[2] ?? ''
  const action = rawAction.replace(/[_-]+/g, ' ').trim()
  if (!server || !action) return null
  return { server, action }
}

/**
 * Resolve localized tool display name, gracefully formatting `mcp__*` connectors before falling back
 * to the raw identifier.
 */
export function formatToolDisplayTitle(toolName: string, t: TFunction): string {
  const key = toolTitleKey(toolName)
  if (key !== null) return t(key)
  const mcp = prettifyMcpToolName(toolName)
  if (mcp) return `${mcp.server} · ${mcp.action}`
  return toolName
}

/**
 * Layer 2 deterministic programmatic tool narration combining localized tool title with its most
 * informative live argument (e.g. `"正在全文搜索邮件「redis」…"`).
 */
export function narrateToolCall(
  input: { readonly toolName: string; readonly args?: unknown; readonly argsText?: string },
  t: TFunction
): string {
  const displayTitle = formatToolDisplayTitle(input.toolName, t)
  const arg = extractRepresentativeArg(input.toolName, input.args, input.argsText)
  if (arg.length >= 2) {
    return t('chat.turnNarration.callingWithArg', { tool: displayTitle, arg })
  }
  return t('chat.runStatus.callingTool', { tool: displayTitle })
}

/**
 * Deduplicate and summarize tool calls inside a collapsed/group header, collapsing repeated actions
 * (e.g. `"全文搜索邮件 ×2 · 读取邮件正文 ×3"`).
 */
export function summarizeToolActions(parts: readonly TurnStagePart[], t: TFunction): string {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const part of parts) {
    if (part.type !== 'tool-call' || isSuggestFollowupsPart(part)) continue
    const rawName = part.toolName ?? ''
    if (!rawName) continue
    const title = formatToolDisplayTitle(rawName, t)
    const prev = counts.get(title) ?? 0
    if (prev === 0) order.push(title)
    counts.set(title, prev + 1)
  }
  if (order.length === 0) return ''

  const visible = order.slice(0, 3).map((action) => {
    const count = counts.get(action) ?? 1
    return count > 1
      ? t('chat.processTimeline.actionCount', { action, count })
      : action
  })
  if (order.length > 3) {
    visible.push(t('chat.processTimeline.moreActions', { n: order.length - 3 }))
  }
  return visible.join(' · ')
}

/**
 * Extract a concise structured summary (result count + top sample titles/subjects) from common
 * search/list/read tool outputs so users don't have to scan raw JSON first.
 */
export function summarizeToolResult(
  result: unknown
): { readonly count: number; readonly samples: readonly string[] } | null {
  const obj = asPlainObject(result)
  if (!obj) return null

  let list: unknown[] | null = null
  for (const key of RESULT_ARRAY_KEYS) {
    const candidate = obj[key]
    if (Array.isArray(candidate)) {
      list = candidate
      break
    }
  }
  if (!list) return null

  const samples: string[] = []
  for (const item of list) {
    if (samples.length >= 3) break
    const rec = asPlainObject(item)
    if (!rec) continue
    const label =
      (typeof rec.subject === 'string' && rec.subject.trim()) ||
      (typeof rec.title === 'string' && rec.title.trim()) ||
      (typeof rec.filename === 'string' && rec.filename.trim()) ||
      (typeof rec.name === 'string' && rec.name.trim()) ||
      (typeof rec.path === 'string' && rec.path.trim()) ||
      ''
    if (label) samples.push(truncateText(label, 48))
  }

  return { count: list.length, samples }
}
