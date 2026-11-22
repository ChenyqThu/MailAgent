// Exposed MCP tools matrix and recent audit call log sections.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'

import type { McpAuditEntry, McpExposedTool } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'

import { Row } from '../../parts/Row'
import { Section } from '../../parts/Section'
import { AUDIT_LIMIT, formatEpoch, joinLabels, useScopeText } from './mcpServiceUtils'

// ── 对外工具 ────────────────────────────────────────────────────────────────

interface ToolGroup {
  /** 排序后的 `auth_scopes` 连接串。 */
  id: string
  scopes: string[]
  /** 组里有任一写工具（非 readOnlyHint）。 */
  write: boolean
  items: McpExposedTool[]
}

/** 按所需权限分组：读组在前、写组在后，组内与组间都保持接口给的顺序。 */
function groupToolsByScope(tools: readonly McpExposedTool[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    const scopes = [...tool.auth_scopes].sort()
    const id = scopes.join(',')
    let group = groups.get(id)
    if (!group) {
      group = { id, scopes, write: false, items: [] }
      groups.set(id, group)
    }
    group.items.push(tool)
    if (!tool.annotations.readOnlyHint) group.write = true
  }
  const all = [...groups.values()]
  return [...all.filter((g) => !g.write), ...all.filter((g) => g.write)]
}

export function ToolsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const toolsQuery = useQuery({
    queryKey: qk.mcpService.tools(),
    queryFn: () => api.mcpService.tools()
  })
  // 与访问密钥一节同一个 query key，共用缓存，不多发请求。
  const keysQuery = useQuery({
    queryKey: qk.mcpService.keys(),
    queryFn: () => api.mcpService.listKeys()
  })

  const groups = groupToolsByScope(toolsQuery.data ?? [])
  const activeKeys = (keysQuery.data ?? []).filter((k) => k.active)

  return (
    <Section title={t('settings.mcp.tools.title')} helper={t('settings.mcp.tools.helper')}>
      {toolsQuery.isError ? (
        <Row
          label={t('settings.mcp.loadFailed')}
          helper={<span className="text-fail">{errorMessage(toolsQuery.error)}</span>}
        >
          <Button size="sm" variant="outline" onClick={() => void toolsQuery.refetch()}>
            {t('settings.mcp.retry')}
          </Button>
        </Row>
      ) : toolsQuery.isPending ? (
        <Row label={t('settings.mcp.loading')}>
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </Row>
      ) : (
        groups.map((g) => (
          <ToolGroupBlock
            key={g.id}
            group={g}
            keyCount={activeKeys.filter((k) => g.scopes.every((s) => k.scopes.includes(s))).length}
          />
        ))
      )}
    </Section>
  )
}

function ToolGroupBlock({
  group,
  keyCount
}: {
  group: ToolGroup
  keyCount: number
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const scopeText = useScopeText()
  // 写入组默认折叠：工具多，且读者通常先关心「有什么能读」。
  const [expanded, setExpanded] = React.useState(!group.write)
  const regionId = `mcp-tools-${group.id.replace(/[^a-zA-Z0-9]/g, '-') || 'none'}`
  const name =
    group.scopes.length > 0
      ? joinLabels(i18n.language, group.scopes.map(scopeText.label))
      : t('settings.mcp.tools.noScope')

  return (
    <div data-testid="mcp-tool-group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={regionId}
        className={cn(
          'flex w-full items-center gap-1.5 px-[var(--settings-tile-px,1rem)] py-2 text-left',
          'text-meta text-ink-fg-2 hover:bg-ink-3',
          'transition-colors duration-fast ease-standard'
        )}
      >
        <CollapseChevron expanded={expanded} />
        <span className="font-medium">
          {t('settings.mcp.tools.groupTitle', { name, count: group.items.length })}
        </span>
        <span className="ml-auto text-ink-fg-3">
          {t('settings.mcp.tools.groupKeys', { count: keyCount })}
        </span>
      </button>
      <CollapsibleRegion
        expanded={expanded}
        id={regionId}
        bodyClassName="border-t border-ink-border-soft divide-y divide-ink-border-soft"
      >
        {group.items.map((tool) => (
          <ToolRow key={tool.name} tool={tool} />
        ))}
      </CollapsibleRegion>
    </div>
  )
}

function ToolRow({ tool }: { tool: McpExposedTool }): React.ReactElement {
  const { t } = useTranslation()
  const readOnly = tool.annotations.readOnlyHint
  return (
    <Row
      compact
      label={tool.title || tool.name}
      helper={
        <span title={tool.description} className="font-mono">
          {tool.name}
        </span>
      }
    >
      <span className={cn('text-meta', readOnly ? 'text-ink-fg-2' : 'text-warn')}>
        {readOnly ? t('settings.mcp.tools.suggestAuto') : t('settings.mcp.tools.suggestAsk')}
      </span>
    </Row>
  )
}

// ── 最近调用 ────────────────────────────────────────────────────────────────

export function AuditSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const auditQuery = useQuery({
    queryKey: qk.mcpService.audit(AUDIT_LIMIT),
    queryFn: () => api.mcpService.audit(AUDIT_LIMIT)
  })
  const entries = auditQuery.data ?? []

  return (
    <Section
      title={t('settings.mcp.audit.title')}
      meta={
        <button
          type="button"
          onClick={() => void auditQuery.refetch()}
          disabled={auditQuery.isFetching}
          aria-label={t('settings.mcp.audit.refresh')}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md',
            'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
            'transition-colors duration-fast ease-standard',
            'disabled:opacity-40 disabled:pointer-events-none'
          )}
        >
          <RefreshCw className={cn('size-3.5', auditQuery.isFetching && 'animate-spin')} />
        </button>
      }
    >
      {auditQuery.isError ? (
        <Row
          label={t('settings.mcp.loadFailed')}
          helper={<span className="text-fail">{errorMessage(auditQuery.error)}</span>}
        >
          <span />
        </Row>
      ) : auditQuery.isPending ? (
        <Row label={t('settings.mcp.loading')}>
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </Row>
      ) : entries.length === 0 ? (
        <Row label={t('settings.mcp.audit.empty')}>
          <span />
        </Row>
      ) : (
        entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)
      )}
    </Section>
  )
}

function AuditRow({ entry }: { entry: McpAuditEntry }): React.ReactElement {
  const { t } = useTranslation()
  const ok = entry.status === 'ok'
  const helper = [
    formatEpoch(entry.created_at),
    entry.key_label ?? t('settings.mcp.audit.unknownKey'),
    entry.duration_ms != null ? `${entry.duration_ms} ms` : null
  ]
    .filter((x): x is string => Boolean(x))
    .join(' · ')
  return (
    <Row
      compact
      label={<span className="font-mono">{entry.tool ?? entry.route}</span>}
      helper={helper}
    >
      <span className={cn('text-meta font-mono', ok ? 'text-ok' : 'text-fail')}>
        {ok ? t('settings.mcp.audit.ok') : (entry.error_code ?? t('settings.mcp.audit.failed'))}
      </span>
    </Row>
  )
}
