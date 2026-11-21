import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronRight,
  ExternalLink,
  FileText,
  FolderKanban,
  Globe,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Mail,
  Paperclip,
  Plug,
  Search,
  Sparkles,
  User,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useActiveEmail } from '@shared/state/active-email'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { formatTokens } from '@shared/assistant/components/modelDetailCard.lib'
import { sessionKeyForId, useSessionDisabledConnectors } from '@shared/assistant/sessionConnectors'
import type {
  WorkspaceArtifact,
  WorkspaceArtifactKind,
  WorkspaceSource,
  WorkspaceSourceKind
} from './deriveSessionWorkspace'
import type { SessionInspectorContextValue } from './inspectorContext'
import { useSessionInspector } from './inspectorContext'
import { InspectorArtifactPreview } from './InspectorArtifactPreview'

function artifactIcon(kind: WorkspaceArtifactKind): React.ReactElement {
  switch (kind) {
    case 'image':
      return <ImageIcon size={14} className="shrink-0 text-coral" />
    case 'draft':
      return <Mail size={14} className="shrink-0 text-info" />
    case 'plan':
      return <ListChecks size={14} className="shrink-0 text-ai" />
    case 'matter':
      return <FolderKanban size={14} className="shrink-0 text-ok" />
    case 'report':
    case 'library':
    default:
      return <FileText size={14} className="shrink-0 text-coral" />
  }
}

function sourceIcon(kind: WorkspaceSourceKind): React.ReactElement {
  switch (kind) {
    case 'email':
      return <Mail size={14} className="shrink-0 text-info" />
    case 'matter':
      return <FolderKanban size={14} className="shrink-0 text-ok" />
    case 'contact':
      return <User size={14} className="shrink-0 text-ai" />
    case 'attachment':
      return <Paperclip size={14} className="shrink-0 text-ink-fg-2" />
    case 'kos':
      return <Sparkles size={14} className="shrink-0 text-coral" />
    case 'library':
    default:
      return <FileText size={14} className="shrink-0 text-coral" />
  }
}

function InspectorSection({
  title,
  count,
  defaultExpanded = true,
  children
}: {
  readonly title: string
  readonly count: number
  readonly defaultExpanded?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div className="border-b border-ink-border-soft py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-left transition-colors duration-fast hover:bg-ink-2 rounded"
      >
        <ChevronRight
          size={13}
          className={cn(
            'shrink-0 text-ink-fg-3 transition-transform duration-fast',
            expanded && 'rotate-90'
          )}
        />
        <span className="min-w-0 flex-1 truncate text-aux font-medium text-ink-fg">{title}</span>
        <span className="shrink-0 rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta tabular-nums text-ink-fg-2">
          {count}
        </span>
      </button>
      <CollapsibleRegion expanded={expanded} bodyClassName="mt-1 space-y-1">
        {children}
      </CollapsibleRegion>
    </div>
  )
}

function SessionInspectorOpenPane({
  inspector,
  presentation,
  className
}: {
  readonly inspector: SessionInspectorContextValue
  readonly presentation: 'push' | 'overlay'
  readonly className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const reduce = useReducedMotion()
  const [filterText, setFilterText] = useState('')
  const { disabledIds, toggleConnector } = useSessionDisabledConnectors(
    sessionKeyForId(inspector.sessionId)
  )
  const disabledSet = useMemo(() => new Set(disabledIds), [disabledIds])

  const { snapshot, previewArtifactId, contextUsage } = inspector
  const activeArtifact: WorkspaceArtifact | null = useMemo(() => {
    if (!previewArtifactId) return null
    return snapshot.artifacts.find((a) => a.id === previewArtifactId) ?? null
  }, [previewArtifactId, snapshot.artifacts])

  const query = filterText.trim().toLowerCase()

  const filteredArtifacts = useMemo(() => {
    if (!query) return snapshot.artifacts
    return snapshot.artifacts.filter(
      (a) =>
        a.title.toLowerCase().includes(query) ||
        (a.virtualPath?.toLowerCase().includes(query) ?? false) ||
        (a.subtitle?.toLowerCase().includes(query) ?? false)
    )
  }, [snapshot.artifacts, query])

  const filteredExplicitSources = useMemo(() => {
    if (!query) return snapshot.sources.explicit
    return snapshot.sources.explicit.filter(
      (s) =>
        s.title.toLowerCase().includes(query) ||
        (s.virtualPath?.toLowerCase().includes(query) ?? false)
    )
  }, [snapshot.sources.explicit, query])

  const filteredConsultedSources = useMemo(() => {
    if (!query) return snapshot.sources.consulted
    return snapshot.sources.consulted.filter(
      (s) =>
        s.title.toLowerCase().includes(query) ||
        (s.virtualPath?.toLowerCase().includes(query) ?? false)
    )
  }, [snapshot.sources.consulted, query])

  const filteredLinks = useMemo(() => {
    if (!query) return snapshot.links
    return snapshot.links.filter(
      (l) => l.title.toLowerCase().includes(query) || l.hostname.toLowerCase().includes(query)
    )
  }, [snapshot.links, query])

  const filteredSkills = useMemo(() => {
    if (!query) return snapshot.skills
    return snapshot.skills.filter((s) => s.name.toLowerCase().includes(query))
  }, [snapshot.skills, query])

  const filteredConnectors = useMemo(() => {
    if (!query) return snapshot.connectorsUsed
    return snapshot.connectorsUsed.filter(
      (c) =>
        c.displayName.toLowerCase().includes(query) ||
        c.actions.some((a) => a.toLowerCase().includes(query))
    )
  }, [snapshot.connectorsUsed, query])

  const handleOpenSource = (src: WorkspaceSource): void => {
    if (src.kind === 'email' && src.internalId != null) {
      useActiveEmail.getState().setActive(src.internalId, { navTarget: true })
      void navigate({ to: '/' })
      return
    }
    if (src.kind === 'library' && src.fileId != null) {
      void navigate({ to: '/library', search: { file: src.fileId } })
      return
    }
    if (src.kind === 'matter' && src.matterPublicId) {
      useMatterNavigation.getState().open(src.matterPublicId)
      void navigate({ to: '/matters' })
      return
    }
    if (src.kind === 'contact' && src.contactId != null) {
      useContactNavigation.getState().open(src.contactId)
      void navigate({ to: '/contacts' })
    }
  }

  const sourcesTotal = filteredExplicitSources.length + filteredConsultedSources.length
  const totalFiltered =
    filteredArtifacts.length +
    sourcesTotal +
    filteredLinks.length +
    filteredSkills.length +
    filteredConnectors.length

  const paneWidthClass =
    activeArtifact !== null
      ? presentation === 'push'
        ? 'w-[520px]'
        : 'w-[440px] max-w-[94%]'
      : presentation === 'push'
        ? 'w-[300px]'
        : 'w-[300px] max-w-[90%]'

  const paneBody = (
    <aside
      data-testid="session-inspector-pane"
      aria-label={t('chat.inspector.title')}
      className={cn(
        'flex min-h-0 flex-col border-l border-ink-border bg-ink-1',
        !reduce && 'transition-[width] duration-base ease-standard',
        paneWidthClass,
        presentation === 'push' ? 'h-full shrink-0' : 'relative z-10 h-full shadow-sm',
        className
      )}
    >
      {activeArtifact !== null ? (
        <InspectorArtifactPreview
          artifact={activeArtifact}
          onBack={inspector.closeArtifactPreview}
        />
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-ink-border-soft px-3">
            <div className="flex min-w-0 items-center gap-2">
              <Layers size={14} strokeWidth={1.8} className="shrink-0 text-coral" aria-hidden />
              <span className="truncate text-body font-medium text-ink-fg">
                {t('chat.inspector.title')}
              </span>
              {snapshot.totalItems > 0 && (
                <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta tabular-nums text-ink-fg-2">
                  {snapshot.totalItems}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => inspector.setOpen(false)}
              aria-label={t('chat.inspector.close')}
              className="grid size-7 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>

          {snapshot.totalItems > 0 && (
            <div className="border-b border-ink-border-soft px-3 py-2">
              <label className="flex items-center gap-2 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-1.5">
                <Search size={13} className="shrink-0 text-ink-fg-3" aria-hidden />
                <input
                  type="text"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t('chat.inspector.filterPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
                />
              </label>
            </div>
          )}

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {snapshot.totalItems === 0 ? (
              <div className="px-2 py-8 text-center text-aux text-ink-fg-3">
                {t('chat.inspector.empty')}
              </div>
            ) : totalFiltered === 0 ? (
              <div className="px-2 py-8 text-center text-aux text-ink-fg-3">
                {t('chat.inspector.noMatches')}
              </div>
            ) : (
              <>
                {filteredArtifacts.length > 0 && (
                  <InspectorSection
                    title={t('chat.inspector.sections.artifacts')}
                    count={filteredArtifacts.length}
                  >
                    {filteredArtifacts.map((artifact) => (
                      <button
                        key={artifact.id}
                        type="button"
                        onClick={() => inspector.openArtifactPreview(artifact.id)}
                        className="flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors duration-fast hover:border-ink-border-soft hover:bg-ink-2"
                      >
                        <span className="mt-0.5">{artifactIcon(artifact.kind)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-aux font-medium text-ink-fg">
                            {artifact.title}
                          </span>
                          <span className="block truncate text-aux text-ink-fg-3">
                            {t(`chat.inspector.artifactKinds.${artifact.kind}`)}
                            {artifact.writeCount && artifact.writeCount > 1
                              ? ` · ${t('chat.inspector.writeCount', { count: artifact.writeCount })}`
                              : ''}
                          </span>
                        </span>
                      </button>
                    ))}
                  </InspectorSection>
                )}

                {sourcesTotal > 0 && (
                  <InspectorSection
                    title={t('chat.inspector.sections.sources')}
                    count={sourcesTotal}
                  >
                    {filteredExplicitSources.length > 0 && (
                      <div className="space-y-1">
                        <div className="px-2 pt-0.5 text-aux text-ink-fg-3">
                          {t('chat.inspector.sourcesExplicit')}
                        </div>
                        {filteredExplicitSources.map((src) => (
                          <button
                            key={src.key}
                            type="button"
                            onClick={() => handleOpenSource(src)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-fast hover:bg-ink-2"
                          >
                            {sourceIcon(src.kind)}
                            <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                              {src.title}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {filteredConsultedSources.length > 0 && (
                      <div className="space-y-1">
                        <div className="px-2 pt-1 text-aux text-ink-fg-3">
                          {t('chat.inspector.sourcesConsulted')}
                        </div>
                        {filteredConsultedSources.map((src) => (
                          <button
                            key={src.key}
                            type="button"
                            onClick={() => handleOpenSource(src)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-fast hover:bg-ink-2"
                          >
                            {sourceIcon(src.kind)}
                            <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                              {src.title}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </InspectorSection>
                )}

                {filteredLinks.length > 0 && (
                  <InspectorSection
                    title={t('chat.inspector.sections.links')}
                    count={filteredLinks.length}
                  >
                    {filteredLinks.map((link) => (
                      <button
                        key={link.url}
                        type="button"
                        onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-fast hover:bg-ink-2"
                      >
                        <Globe size={14} className="mt-0.5 shrink-0 text-info" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-aux text-ink-fg">{link.title}</span>
                          <span className="block truncate font-mono text-meta text-ink-fg-3">
                            {link.hostname}
                          </span>
                        </span>
                        <ExternalLink size={12} className="mt-1 shrink-0 text-ink-fg-3" />
                      </button>
                    ))}
                  </InspectorSection>
                )}

                {filteredSkills.length > 0 && (
                  <InspectorSection
                    title={t('chat.inspector.sections.skills')}
                    count={filteredSkills.length}
                  >
                    <div className="flex flex-wrap gap-1.5 px-1.5 py-1">
                      {filteredSkills.map((skill) => (
                        <span
                          key={skill.key}
                          className="inline-flex items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2 py-0.5 text-aux text-ink-fg-1"
                        >
                          <Sparkles size={12} className="text-coral" aria-hidden />
                          <span>{skill.name}</span>
                        </span>
                      ))}
                    </div>
                  </InspectorSection>
                )}

                {filteredConnectors.length > 0 && (
                  <InspectorSection
                    title={t('chat.inspector.sections.connectors')}
                    count={filteredConnectors.length}
                  >
                    {filteredConnectors.map((conn) => {
                      const muted = disabledSet.has(conn.connectorId)
                      return (
                        <div
                          key={conn.connectorId}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-ink-2"
                        >
                          <Plug size={14} className="shrink-0 text-ink-fg-2" />
                          <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                            {conn.displayName}
                          </span>
                          <span className="font-mono text-meta tabular-nums text-ink-fg-3">
                            ×{conn.callCount}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleConnector(conn.connectorId)}
                            className={cn(
                              'rounded px-1.5 py-0.5 text-aux transition-colors duration-fast',
                              muted
                                ? 'bg-ink-3 text-ink-fg-3 hover:text-ink-fg'
                                : 'bg-coral/15 text-coral hover:bg-coral/25'
                            )}
                          >
                            {muted
                              ? t('chat.inspector.unmuteForSession')
                              : t('chat.inspector.muteForSession')}
                          </button>
                        </div>
                      )
                    })}
                  </InspectorSection>
                )}
              </>
            )}
          </div>

          {contextUsage !== null && (
            <div className="shrink-0 border-t border-ink-border-soft px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-aux text-ink-fg-2">
                <span>{t('chat.inspector.contextBudget')}</span>
                <span className="font-mono text-meta tabular-nums text-ink-fg-1">
                  {contextUsage.limit !== null
                    ? `${formatTokens(contextUsage.used)} / ${formatTokens(contextUsage.limit)}`
                    : `~${formatTokens(contextUsage.used)}`}
                </span>
              </div>
              {contextUsage.ratio !== null && (
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-3">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-fast',
                      contextUsage.tone === 'danger'
                        ? 'bg-fail'
                        : contextUsage.tone === 'warn'
                          ? 'bg-warn'
                          : 'bg-coral/100'
                    )}
                    style={{ width: `${Math.round(contextUsage.ratio * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  )

  if (presentation === 'overlay') {
    return (
      <div className="absolute inset-0 z-30 flex justify-end">
        <div
          aria-hidden="true"
          className="flex-1 bg-ink-1/40"
          onClick={() => inspector.setOpen(false)}
        />
        {paneBody}
      </div>
    )
  }

  return paneBody
}

/**
 * Dual-mode right-side Session Workspace Inspector (`300px` overview ↔ `520px` Artifact preview).
 * Returns null unless an enclosing `InspectorProvider` is open.
 */
export function SessionInspectorPane({
  presentation,
  className
}: {
  readonly presentation: 'push' | 'overlay'
  readonly className?: string
}): React.JSX.Element | null {
  const inspector = useSessionInspector()
  if (!inspector || !inspector.open) return null
  return (
    <SessionInspectorOpenPane
      inspector={inspector}
      presentation={presentation}
      className={className}
    />
  )
}
