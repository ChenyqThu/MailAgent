// Stage 1 PR2 (harness-expansion epic) — the generic MCP connector approval card + the dynamic
// tool-part fallback router.
//
// Connector tool names (`mcp__<connector>__<slug>`) are only known at RUNTIME, so they can never
// sit in the ComponentRegistry's static by_name map. Instead the registry's `tools.Fallback` slot
// is McpToolFallback (registerToolUIs.tsx): an approval-flow phase (pending / rejected / expired)
// of an `mcp__*` part renders THIS card — real approve/reject buttons, never the buttonless
// ToolTraceCard spinner (the 1.5.0 dogfood bug + 0.5-① G9 agent_profile_restore 教训, commit
// ec6b77aa lineage) — every other phase (and every non-connector tool) falls through to
// ToolTraceCard unchanged (silent connector reads + executed writes keep the generic trace UI).
//
// The card shows: connector name, tool name, an args JSON preview (clamped + scrollable), and —
// when the synced manifest marks the tool destructive — a red「破坏性操作」warning line. 🔴 The
// destructive fact is fetched LIVE from serve-api (GET /api/connector/{id}/tools, matched via the
// shared mcpToolName mapping) — never projected from model args (CalendarApprovalCard precedent:
// a model cannot spoof away the warning). Fetch failure degrades to no warning line (the approve
// surface itself never blocks on the lookup).

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plug } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'
import { ToolTraceCard } from './ToolTraceCard'
import { isMcpToolName, mcpGatewayToolName, parseMcpToolName } from '../mcpToolName'

// Resolve serve-api base URL for direct fetch calls (mirrors CalendarApprovalCard /
// CustomAgentApprovalCard — intentionally duplicated to avoid coupling a shared tool card to the
// settings module).
function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}

/** The manifest facts the card renders (matched by the SHARED name mapping — one source). */
interface ConnectorToolFacts {
  remoteName: string
  destructive: boolean
  crudType: string
}

async function fetchToolFacts(
  connectorId: string,
  gatewayToolName: string
): Promise<ConnectorToolFacts | null> {
  const resp = await fetch(
    `${resolveApiBaseUrl()}/connector/${encodeURIComponent(connectorId)}/tools`,
    { credentials: 'include' }
  )
  if (!resp.ok) throw new Error(`E_HTTP_${resp.status}`)
  const body = (await resp.json()) as {
    status?: string
    data?: { tools?: Array<Record<string, unknown>> }
  }
  if (body.status !== 'success' || !body.data?.tools) throw new Error('E_BAD_ENVELOPE')
  for (const row of body.data.tools) {
    const remoteName = typeof row.name === 'string' ? row.name : ''
    if (remoteName && mcpGatewayToolName(connectorId, remoteName) === gatewayToolName) {
      return {
        remoteName,
        destructive: row.destructive === true,
        crudType: typeof row.crud_type === 'string' ? row.crud_type : ''
      }
    }
  }
  return null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Compact args JSON preview (clamped — the review box scrolls, but a mega-payload must not
 *  balloon the DOM). Rendered as a DOM text node → React auto-escapes. */
const ARGS_PREVIEW_MAX = 4000
function argsPreview(args: unknown, argsText: string | undefined): string {
  const obj = asRecord(args)
  let text = ''
  if (obj && Object.keys(obj).length > 0) {
    try {
      text = JSON.stringify(obj, null, 2)
    } catch {
      text = String(argsText ?? '')
    }
  } else if (argsText && argsText.trim() !== '' && argsText.trim() !== '{}') {
    text = argsText
  }
  if (text.length > ARGS_PREVIEW_MAX) text = `${text.slice(0, ARGS_PREVIEW_MAX)}…`
  return text
}

export function McpApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, argsText, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const parsed = parseMcpToolName(toolName)
  const connectorId = parsed?.connectorId ?? ''
  const [facts, setFacts] = useState<ConnectorToolFacts | null>(null)

  useEffect(() => {
    if (phase !== 'pending' || !connectorId) return
    let cancelled = false
    fetchToolFacts(connectorId, toolName)
      .then((row) => {
        if (!cancelled) setFacts(row)
      })
      .catch(() => {
        /* facts unavailable → degrade to no destructive line (approve surface never blocks) */
      })
    return () => {
      cancelled = true
    }
  }, [phase, connectorId, toolName])

  const preview = argsPreview(args, argsText) || t('chat.mcpApprovalCard.noArgs')
  const toolLabel = facts?.remoteName ?? parsed?.toolSlug ?? toolName

  const onApprove = (): void => respondToApproval({ approved: true })
  const onReject = (): void => respondToApproval({ approved: false })

  return (
    <CardFrame
      icon={<Plug size={13} strokeWidth={2} />}
      title={t('chat.mcpApprovalCard.title')}
      phase={phase}
    >
      <div className="flex items-baseline gap-2 text-aux">
        <span className="shrink-0 text-ink-fg-2">{t('chat.mcpApprovalCard.connector')}</span>
        <span className="min-w-0 break-all font-medium text-ink-fg">{connectorId || '?'}</span>
      </div>
      <div className="flex items-baseline gap-2 text-aux">
        <span className="shrink-0 text-ink-fg-2">{t('chat.mcpApprovalCard.tool')}</span>
        <span className="min-w-0 break-all font-mono text-ink-fg">{toolLabel}</span>
      </div>
      {phase === 'pending' ? (
        <>
          {facts?.destructive === true ? (
            <div className="mt-1.5 text-aux font-medium text-fail">
              {t('chat.mcpApprovalCard.destructiveWarning')}
            </div>
          ) : null}
          <div className="mt-1.5 text-aux text-ink-fg-2">{t('chat.mcpApprovalCard.label')}</div>
          <div className="scrollbar-thin mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-ink-fg">
            {preview}
          </div>
          <ApprovalActions onApprove={onApprove} onReject={onReject} />
        </>
      ) : phase === 'rejected' || phase === 'expired' ? (
        <>
          <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-ink-fg-2">
            {preview}
          </div>
          <TerminalBanner phase={phase} />
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.mcpApprovalCard.error')}</div>
      ) : (
        // authorized / done — unreachable via McpToolFallback (those phases route to
        // ToolTraceCard); defensive echo for a direct mount.
        <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-ink-fg">
          {preview}
        </div>
      )}
    </CardFrame>
  )
}

/**
 * The `tools.Fallback` router (registerToolUIs.tsx): an approval-flow phase of a dynamic
 * `mcp__*` connector tool renders the actionable McpApprovalCard; everything else — every
 * non-connector tool AND a connector part in a running/done/error phase — falls through to the
 * generic ToolTraceCard byte-identically (silent reads / executed writes keep the trace UI).
 */
export function McpToolFallback(props: ToolCallMessagePartProps): React.JSX.Element {
  if (isMcpToolName(props.toolName)) {
    const phase = deriveCardPhase(props)
    if (phase === 'pending' || phase === 'rejected' || phase === 'expired') {
      return <McpApprovalCard {...props} />
    }
  }
  return <ToolTraceCard {...props} />
}
