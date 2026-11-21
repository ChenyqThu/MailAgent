import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import {
  Ban,
  ChevronRight,
  Code2,
  ExternalLink,
  File,
  FileText,
  FolderKanban,
  Globe,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Mail,
  Paperclip,
  Plug,
  RotateCcw,
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
import { openUrlInBuiltInBrowser } from '@shared/state/open-in-browser'
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
    case 'html':
      return <Code2 size={14} className="shrink-0 text-ai" />
    case 'image':
      return <ImageIcon size={14} className="shrink-0 text-coral" />
    case 'draft':
      return <Mail size={14} className="shrink-0 text-info" />
    case 'plan':
      return <ListChecks size={14} className="shrink-0 text-ai" />
    case 'matter':
      return <FolderKanban size={14} className="shrink-0 text-ok" />
    case 'file':
      return <File size={14} className="shrink-0 text-ink-fg-2" />
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

  const showFilter = snapshot.totalItems >= 8

  const paneWidthClass =
    activeArtifact !== null
      ? presentation === 'push'
        ? 'w-[520px]'
        : 'w-[440px] max-w-[94%]'
      : presentation === 'push'
        ? 'w-[280px]'
        : 'w-[280px] max-w-[90%]'

  const innerSurface = (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-ink-1',
        presentation === 'push'
          ? activeArtifact !== null
            ? 'h-full rounded-xl border border-ink-border-soft shadow-sm'
            : 'max-h-full rounded-xl border border-ink-border-soft shadow-sm'
          : 'h-full border-l border-ink-border shadow-sm'
      )}
    >
      {activeArtifact !== null ? (
        <InspectorArtifactPreview
          artifact={activeArtifact}
          onBack={inspector.closeArtifactPreview}
        />
      ) : (
        <>
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-ink-border-soft px-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <Layers size={13} strokeWidth={1.8} className="shrink-0 text-coral" aria-hidden />
              <span className="truncate text-aux font-medium text-ink-fg">
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
              className="grid size-6 place-items-center rounded-md text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>

          {showFilter && (
            <div className="border-b border-ink-border-soft px-2.5 py-2">
              <label className="flex items-center gap-2 rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1">
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

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5">
            {snapshot.totalItems === 0 ? (
              <div className="px-2 py-6 text-center text-aux text-ink-fg-3">
                {t('chat.inspector.empty')}
              </div>
            ) : totalFiltered === 0 ? (
              <div className="px-2 py-6 text-center text-aux text-ink-fg-3">
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

                {filteredSkills.length > 0 && (
                  <InspectorSection
                    title={t('chat.inspector.sections.skills')}
                    count={filteredSkills.length}
                  >
                    {filteredSkills.map((skill) => (
                      <div
                        key={skill.key}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-aux text-ink-fg-1"
                      >
                        <Sparkles size={13} className="shrink-0 text-coral" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                      </div>
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
                      <div
                        key={link.url}
                        className="group flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-fast hover:bg-ink-2"
                      >
                        <button
                          type="button"
                          title={t('chat.inspector.openInBuiltInBrowser')}
                          onClick={() => {
                            if (!openUrlInBuiltInBrowser(link.url)) {
                              window.open(link.url, '_blank', 'noopener,noreferrer')
                            }
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2 rounded px-1 py-1 text-left"
                        >
                          <Globe size={14} className="mt-0.5 shrink-0 text-info" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-aux text-ink-fg">{link.title}</span>
                            <span className="block truncate font-mono text-meta text-ink-fg-3">
                              {link.hostname}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`${t('chat.inspector.openInSystemBrowser')}: ${link.title}`}
                          title={t('chat.inspector.openInSystemBrowser')}
                          onClick={(e) => {
                            e.stopPropagation()
                            window.open(link.url, '_blank', 'noopener,noreferrer')
                          }}
                          className="grid size-6 shrink-0 place-items-center rounded text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
                        >
                          <ExternalLink size={12} />
                        </button>
                      </div>
                    ))}
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
                          <Plug
                            size={14}
                            className={cn(
                              'shrink-0',
                              muted ? 'text-ink-fg-3 opacity-60' : 'text-ink-fg-2'
                            )}
                          />
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate text-aux',
                              muted ? 'text-ink-fg-3 line-through opacity-75' : 'text-ink-fg'
                            )}
                          >
                            {conn.displayName}
                          </span>
                          <span className="font-mono text-meta tabular-nums text-ink-fg-3">
                            ×{conn.callCount}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleConnector(conn.connectorId)}
                            aria-label={
                              muted
                                ? t('chat.inspector.unmuteForSession')
                                : t('chat.inspector.muteForSession')
                            }
                            title={
                              muted
                                ? t('chat.inspector.unmuteForSession')
                                : t('chat.inspector.muteForSession')
                            }
                            className={cn(
                              'grid size-6 shrink-0 place-items-center rounded transition-colors duration-fast',
                              muted
                                ? 'bg-ink-3 text-ink-fg-2 hover:text-ink-fg'
                                : 'text-ink-fg-3 hover:bg-ink-3 hover:text-fail'
                            )}
                          >
                            {muted ? (
                              <RotateCcw size={13} strokeWidth={1.8} />
                            ) : (
                              <Ban size={13} strokeWidth={1.8} />
                            )}
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
    </div>
  )

  const paneBody = (
    <aside
      data-testid="session-inspector-pane"
      aria-label={t('chat.inspector.title')}
      className={cn(
        'flex min-h-0 flex-col',
        !reduce && 'transition-[width] duration-base ease-standard',
        paneWidthClass,
        presentation === 'push' ? 'h-full shrink-0 items-stretch py-3 pl-1 pr-4' : 'relative z-10 h-full',
        className
      )}
    >
      {innerSurface}
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
