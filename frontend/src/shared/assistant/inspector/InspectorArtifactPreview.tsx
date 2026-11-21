import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  Monitor,
  Smartphone
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { buildLibraryPreviewUrl } from '@shared/libraryIpcContract'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { HTML_PREVIEW_SANDBOX } from '@shared/components/library/HtmlPreview'
import { useLibraryApi } from '@shared/components/library/hooks'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import type { WorkspaceArtifact } from './deriveSessionWorkspace'

export interface InspectorArtifactPreviewProps {
  readonly artifact: WorkspaceArtifact
  readonly onBack: () => void
  readonly expanded?: boolean | undefined
  readonly onToggleExpand?: (() => void) | undefined
}

function isElectronPreviewAvailable(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { electron?: { ipcRenderer?: unknown } }
  return Boolean(w.electron?.ipcRenderer)
}

function triggerHtmlDownload(filename: string, html: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}

/**
 * Wide in-place studio preview for a clicked session Artifact (interactive HTML5 artifact via
 * `libpreview://`, library document, generated image, email draft, report, matter summary, or plan).
 */
export function InspectorArtifactPreview({
  artifact,
  onBack,
  expanded = false,
  onToggleExpand
}: InspectorArtifactPreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const libraryApi = useLibraryApi()
  const [copied, setCopied] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [htmlMode, setHtmlMode] = useState<'rendered' | 'source'>('rendered')
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop')
  const [prevArtifactId, setPrevArtifactId] = useState(artifact.id)
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)

  if (prevArtifactId !== artifact.id) {
    setPrevArtifactId(artifact.id)
    setSelectedVersion(null)
    setHtmlMode('rendered')
    setViewport('desktop')
  }

  const isHtmlArtifact = artifact.kind === 'html' || artifact.isHtml === true
  const versions = artifact.versions ?? []
  const activeVersionEntry =
    versions.length > 0
      ? ((selectedVersion !== null
          ? versions.find((v) => v.version === selectedVersion)
          : undefined) ?? versions[versions.length - 1])
      : null

  const activeFileId = activeVersionEntry?.fileId ?? artifact.fileId
  const activeVirtualPath = activeVersionEntry?.virtualPath ?? artifact.virtualPath
  const activeContentFallback = activeVersionEntry?.content ?? artifact.content ?? ''
  const activeSubtitle =
    activeVersionEntry?.changeNote ??
    (artifact.subtitle && artifact.subtitle !== artifact.to ? artifact.subtitle : undefined)

  const liveTextQ = useQuery({
    queryKey: ['library', 'inspector-preview', activeFileId ?? 'none'],
    queryFn: () => libraryApi.text(activeFileId as number),
    enabled: !isHtmlArtifact && artifact.kind === 'library' && activeFileId != null,
    staleTime: 30_000
  })

  const liveHtmlFileQ = useQuery({
    queryKey: ['library', 'inspector-html', activeFileId ?? 'none'],
    queryFn: () => libraryApi.file(activeFileId as number),
    enabled:
      isHtmlArtifact &&
      activeFileId != null &&
      !activeContentFallback &&
      typeof libraryApi.file === 'function',
    staleTime: 30_000
  })

  const effectiveContent = isHtmlArtifact
    ? activeContentFallback ||
      (typeof liveHtmlFileQ.data?.content === 'string' ? liveHtmlFileQ.data.content : '')
    : (typeof liveTextQ.data?.markdown === 'string' && liveTextQ.data.markdown) ||
      activeContentFallback

  const previewUrl =
    isHtmlArtifact &&
    isElectronPreviewAvailable() &&
    activeFileId != null &&
    activeVirtualPath
      ? buildLibraryPreviewUrl(activeVirtualPath)
      : null

  const copyPayload =
    artifact.kind === 'plan' && artifact.plan
      ? [
          artifact.plan.goal,
          ...artifact.plan.steps.map((s, idx) => `${idx + 1}. [${s.status}] ${s.title}`)
        ].join('\n')
      : artifact.kind === 'image'
        ? (artifact.content || artifact.imageUrl || '')
        : effectiveContent

  const canOpenLibrary =
    (artifact.kind === 'library' || artifact.kind === 'html') && activeFileId != null
  const canOpenMatter = artifact.kind === 'matter' && artifact.matterPublicId != null
  const hasHtmlRenderSource = previewUrl !== null || effectiveContent.length > 0
  const isFullHeightHtmlRender =
    isHtmlArtifact && htmlMode === 'rendered' && hasHtmlRenderSource

  const handleCopy = (): void => {
    if (!copyPayload || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(copyPayload).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  const handleDownloadHtml = (): void => {
    if (!effectiveContent) return
    const baseName = artifact.slug
      ? activeVersionEntry
        ? `${artifact.slug}-v${activeVersionEntry.version}.html`
        : `${artifact.slug}.html`
      : artifact.title.endsWith('.html')
        ? artifact.title
        : `${artifact.title}.html`
    triggerHtmlDownload(baseName, effectiveContent)
  }

  const handleOpenOriginal = (): void => {
    if (canOpenLibrary && activeFileId != null) {
      void navigate({ to: '/library', search: { file: activeFileId } })
      return
    }
    if (canOpenMatter && artifact.matterPublicId) {
      useMatterNavigation.getState().open(artifact.matterPublicId)
      void navigate({ to: '/matters' })
    }
  }

  const loadingPreview =
    (!isHtmlArtifact && artifact.kind === 'library' && activeFileId != null && liveTextQ.isLoading) ||
    (isHtmlArtifact &&
      activeFileId != null &&
      !activeContentFallback &&
      liveHtmlFileQ.isLoading)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-ink-border-soft px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-aux text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <ArrowLeft size={14} strokeWidth={1.8} />
          <span>{t('chat.inspector.backToOverview')}</span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          {isHtmlArtifact && hasHtmlRenderSource && (
            <>
              <div className="inline-flex rounded-md border border-ink-border-soft bg-ink-2 p-0.5">
                <button
                  type="button"
                  onClick={() => setHtmlMode('rendered')}
                  className={cn(
                    'rounded px-2 py-0.5 text-aux transition-colors duration-fast',
                    htmlMode === 'rendered'
                      ? 'bg-ink-1 font-medium text-ink-fg shadow-xs'
                      : 'text-ink-fg-2 hover:text-ink-fg'
                  )}
                >
                  {t('chat.inspector.previewRendered')}
                </button>
                <button
                  type="button"
                  onClick={() => setHtmlMode('source')}
                  className={cn(
                    'rounded px-2 py-0.5 text-aux transition-colors duration-fast',
                    htmlMode === 'source'
                      ? 'bg-ink-1 font-medium text-ink-fg shadow-xs'
                      : 'text-ink-fg-2 hover:text-ink-fg'
                  )}
                >
                  {t('chat.inspector.previewSource')}
                </button>
              </div>
              {htmlMode === 'rendered' && (
                <div className="inline-flex rounded-md border border-ink-border-soft bg-ink-2 p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewport('desktop')}
                    aria-label={t('chat.inspector.viewportDesktop')}
                    aria-pressed={viewport === 'desktop'}
                    title={t('chat.inspector.viewportDesktop')}
                    className={cn(
                      'grid size-6 place-items-center rounded transition-colors duration-fast',
                      viewport === 'desktop'
                        ? 'bg-ink-1 text-ink-fg shadow-xs'
                        : 'text-ink-fg-2 hover:text-ink-fg'
                    )}
                  >
                    <Monitor size={13} strokeWidth={1.8} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewport('mobile')}
                    aria-label={t('chat.inspector.viewportMobile')}
                    aria-pressed={viewport === 'mobile'}
                    title={t('chat.inspector.viewportMobile')}
                    className={cn(
                      'grid size-6 place-items-center rounded transition-colors duration-fast',
                      viewport === 'mobile'
                        ? 'bg-ink-1 text-ink-fg shadow-xs'
                        : 'text-ink-fg-2 hover:text-ink-fg'
                    )}
                  >
                    <Smartphone size={13} strokeWidth={1.8} />
                  </button>
                </div>
              )}
              {effectiveContent.length > 0 && (
                <button
                  type="button"
                  onClick={handleDownloadHtml}
                  aria-label={t('chat.inspector.downloadHtml')}
                  title={t('chat.inspector.downloadHtml')}
                  className="grid size-7 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
                >
                  <Download size={13} />
                </button>
              )}
            </>
          )}
          {copyPayload.length > 0 && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? t('chat.inspector.copied') : t('chat.inspector.copy')}
              className="inline-flex items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
            >
              {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
              <span>{copied ? t('chat.inspector.copied') : t('chat.inspector.copy')}</span>
            </button>
          )}
          {(canOpenLibrary || canOpenMatter) && (
            <button
              type="button"
              onClick={handleOpenOriginal}
              aria-label={t('chat.inspector.openOriginal')}
              title={t('chat.inspector.openOriginal')}
              className="inline-flex items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
            >
              <ExternalLink size={13} />
              <span>{t('chat.inspector.openOriginal')}</span>
            </button>
          )}
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-label={
                expanded ? t('chat.inspector.collapsePreview') : t('chat.inspector.expandPreview')
              }
              title={
                expanded ? t('chat.inspector.collapsePreview') : t('chat.inspector.expandPreview')
              }
              className="grid size-7 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
            >
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          )}
        </div>
      </div>

      <div
        className={cn(
          'min-h-0 flex-1 px-3.5 py-3',
          isFullHeightHtmlRender
            ? 'flex flex-col gap-2.5 overflow-hidden'
            : 'scrollbar-thin space-y-3 overflow-y-auto'
        )}
      >
        <div className="shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words text-body font-medium text-ink-fg">
              {artifact.title}
            </h3>
            {artifact.artifactType && (
              <span className="shrink-0 rounded bg-ink-3 px-2 py-0.5 text-aux text-ink-fg-2">
                {t(`chat.inspector.artifactTypes.${artifact.artifactType}`)}
              </span>
            )}
          </div>
          {activeVirtualPath && (
            <div className="mt-1 truncate font-mono text-meta text-ink-fg-3">
              {activeVirtualPath}
            </div>
          )}
          {artifact.to && (
            <div className="mt-1 break-words text-aux text-ink-fg-2">To: {artifact.to}</div>
          )}
          {activeSubtitle && <div className="mt-1 text-aux text-ink-fg-2">{activeSubtitle}</div>}
          {versions.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-aux text-ink-fg-3">{t('chat.inspector.versionLabel')}</span>
              {versions.map((ver) => {
                const isSelected = activeVersionEntry?.version === ver.version
                return (
                  <button
                    key={ver.version}
                    type="button"
                    onClick={() => setSelectedVersion(ver.version)}
                    aria-pressed={isSelected}
                    className={cn(
                      'rounded border px-2 py-0.5 font-mono text-meta tabular-nums transition-colors duration-fast',
                      isSelected
                        ? 'border-coral/40 bg-coral/15 font-medium text-coral'
                        : 'border-ink-border-soft bg-ink-2 text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg'
                    )}
                  >
                    v{ver.version}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {artifact.kind === 'image' && artifact.imageUrl && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setLightboxSrc(artifact.imageUrl ?? null)}
              className="block w-full overflow-hidden rounded-lg border border-ink-border-soft bg-ink-2"
            >
              <img
                src={artifact.imageUrl}
                alt={artifact.title}
                className="max-h-80 w-full object-contain"
              />
            </button>
            {artifact.content && (
              <p className="whitespace-pre-wrap break-words text-aux text-ink-fg-2">
                {artifact.content}
              </p>
            )}
          </div>
        )}

        {artifact.kind === 'plan' && artifact.plan && (
          <ol className="space-y-2">
            {artifact.plan.steps.map((step) => (
              <li
                key={step.id}
                className="rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-aux font-medium text-ink-fg">{step.title}</span>
                  <span className="shrink-0 rounded bg-ink-3 px-1.5 py-0.5 text-aux text-ink-fg-2">
                    {t(`chat.planCard.status.${step.status}`)}
                  </span>
                </div>
                {step.note && <p className="mt-1 text-aux text-ink-fg-3">{step.note}</p>}
              </li>
            ))}
          </ol>
        )}

        {(artifact.kind === 'library' ||
          artifact.kind === 'html' ||
          artifact.kind === 'file' ||
          artifact.kind === 'draft' ||
          artifact.kind === 'report' ||
          artifact.kind === 'matter') && (
          <>
            {loadingPreview && !hasHtmlRenderSource && !effectiveContent ? (
              <p className="text-aux text-ink-fg-3">{t('chat.inspector.loadingPreview')}</p>
            ) : isFullHeightHtmlRender ? (
              <div
                className={cn(
                  'flex min-h-0 flex-1 overflow-hidden rounded-lg border border-ink-border-soft',
                  viewport === 'mobile' ? 'justify-center bg-ink-2 p-3' : 'bg-white'
                )}
              >
                <iframe
                  key={previewUrl ?? 'srcdoc'}
                  title={artifact.title}
                  {...(previewUrl !== null ? { src: previewUrl } : { srcDoc: effectiveContent })}
                  sandbox={HTML_PREVIEW_SANDBOX}
                  className={cn(
                    'min-h-[360px] flex-1 bg-white',
                    viewport === 'mobile'
                      ? 'w-[390px] max-w-full flex-none rounded-md border border-ink-border-soft shadow-sm'
                      : 'h-full w-full'
                  )}
                />
              </div>
            ) : effectiveContent.length > 0 ? (
              <div className="rounded-lg border border-ink-border-soft bg-ink-2 p-3 text-body text-ink-fg">
                {!isHtmlArtifact && artifact.isMarkdown !== false ? (
                  <TranslatedBody text={effectiveContent} />
                ) : (
                  <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words font-mono text-meta leading-relaxed text-ink-fg-1">
                    {effectiveContent}
                  </pre>
                )}
              </div>
            ) : (
              <p className="text-aux text-ink-fg-3">{t('chat.inspector.previewUnavailable')}</p>
            )}
          </>
        )}
      </div>

      {lightboxSrc !== null && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  )
}
