import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  Smartphone,
  UploadCloud
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { isElectronIpcAvailable } from '@shared/ipc/client'
import { errorMessage } from '@shared/lib/ipcErrors'
import { buildLibraryPreviewUrl } from '@shared/libraryIpcContract'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { openExternal } from '@shared/components/connectors/consoleShared'
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
  return isElectronIpcAvailable()
}

function normalizePublishSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned || 'artifact'
}

function triggerBlobDownload(filename: string, blob: Blob): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
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

function triggerHtmlDownload(filename: string, html: string): void {
  triggerBlobDownload(filename, new Blob([html], { type: 'text/html;charset=utf-8' }))
}

function parseArtifactBundleTarget(
  virtualPath: string | undefined,
  fallbackSlug: string | undefined,
  fallbackVersion: number | undefined
): { slug: string; version?: number } | null {
  if (virtualPath) {
    const match = /^agent-docs\/artifacts\/([^/]+)\/v(\d+)(?:\/|$)/.exec(virtualPath)
    if (match) {
      return { slug: match[1], version: Number(match[2]) }
    }
  }
  if (fallbackSlug) {
    return fallbackVersion !== undefined
      ? { slug: fallbackSlug, version: fallbackVersion }
      : { slug: fallbackSlug }
  }
  return null
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
  const mailApi = useMailApi()
  const [copied, setCopied] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [openingBrowser, setOpeningBrowser] = useState(false)
  const [publishedByKey, setPublishedByKey] = useState<
    Record<string, { readonly reviewUrl: string; readonly shareUrl?: string; readonly version?: number }>
  >({})
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
    setShareCopied(false)
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

  const connectorsQ = useQuery({
    queryKey: qk.connectors(),
    queryFn: () => mailApi.connector.list(),
    enabled: isHtmlArtifact && typeof mailApi?.connector?.list === 'function',
    staleTime: 30_000,
    retry: false
  })
  const artifactServerConnected = (connectorsQ.data ?? []).some(
    (c) => c.connector_id === 'artifact_server' && c.enabled && c.status === 'connected'
  )

  const publishStateKey = `${artifact.id}:v${activeVersionEntry?.version ?? artifact.version ?? 1}`
  const matchingArtifactRemote =
    artifact.remoteUrl &&
    (artifact.remoteVersion == null ||
      activeVersionEntry == null ||
      artifact.remoteVersion === activeVersionEntry.version)
      ? {
          reviewUrl: artifact.remoteUrl,
          shareUrl: artifact.shareUrl,
          version: artifact.remoteVersion
        }
      : null
  const activeRemote = publishedByKey[publishStateKey] ?? matchingArtifactRemote

  const liveTextQ = useQuery({
    queryKey: ['library', 'inspector-preview', activeFileId ?? 'none'],
    queryFn: () => libraryApi.text(activeFileId as number),
    enabled: !isHtmlArtifact && artifact.kind === 'library' && activeFileId != null,
    staleTime: 30_000
  })

  const previewUrl =
    isHtmlArtifact &&
    isElectronPreviewAvailable() &&
    activeFileId != null &&
    activeVirtualPath
      ? buildLibraryPreviewUrl(activeVirtualPath)
      : null

  const liveHtmlFileQ = useQuery({
    queryKey: ['library', 'inspector-html', activeFileId ?? 'none'],
    queryFn: () => libraryApi.file(activeFileId as number),
    enabled:
      isHtmlArtifact &&
      activeFileId != null &&
      !activeContentFallback &&
      typeof libraryApi.file === 'function' &&
      (htmlMode === 'source' || previewUrl === null),
    staleTime: 30_000
  })

  const effectiveContent = isHtmlArtifact
    ? activeContentFallback ||
      (typeof liveHtmlFileQ.data?.content === 'string' ? liveHtmlFileQ.data.content : '')
    : (typeof liveTextQ.data?.markdown === 'string' && liveTextQ.data.markdown) ||
      activeContentFallback

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
  const bundleTarget = parseArtifactBundleTarget(
    activeVirtualPath,
    artifact.slug,
    activeVersionEntry?.version ?? artifact.version
  )
  const prefersBundlePublish =
    Boolean(bundleTarget) && typeof libraryApi.publishArtifactBundle === 'function'
  const canInvokeSinglePublish =
    effectiveContent.length > 0 && typeof mailApi?.connector?.invokeTool === 'function'
  const canDownloadHtml =
    isHtmlArtifact &&
    (effectiveContent.length > 0 ||
      (activeFileId != null && typeof libraryApi.inlineUrl === 'function'))
  const canOpenInBrowser =
    isHtmlArtifact &&
    bundleTarget !== null &&
    typeof libraryApi.issueArtifactPreviewToken === 'function'
  const canShowCloudControl =
    isHtmlArtifact &&
    (hasHtmlRenderSource || (Boolean(bundleTarget) && typeof libraryApi.publishArtifactBundle === 'function'))
  const isFullHeightHtmlRender =
    isHtmlArtifact && htmlMode === 'rendered' && hasHtmlRenderSource

  const handleCopy = (): void => {
    if (!copyPayload || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(copyPayload).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  const handleDownloadHtml = async (): Promise<void> => {
    const baseName = artifact.slug
      ? activeVersionEntry
        ? `${artifact.slug}-v${activeVersionEntry.version}.html`
        : `${artifact.slug}.html`
      : artifact.title.endsWith('.html')
        ? artifact.title
        : `${artifact.title}.html`
    let fetchError: unknown = null
    if (
      activeFileId != null &&
      typeof libraryApi.inlineUrl === 'function' &&
      typeof fetch === 'function'
    ) {
      try {
        const resp = await fetch(libraryApi.inlineUrl(activeFileId), { credentials: 'include' })
        if (resp.ok) {
          const blob = await resp.blob()
          triggerBlobDownload(baseName, blob)
          return
        }
        fetchError = new Error(`HTTP ${resp.status}`)
      } catch (err) {
        fetchError = err
      }
    }
    if (!effectiveContent) {
      toastError(t('chat.inspector.downloadHtml'), errorMessage(fetchError ?? 'Download failed'))
      return
    }
    triggerHtmlDownload(baseName, effectiveContent)
  }

  const handleOpenInBrowser = async (): Promise<void> => {
    if (openingBrowser || !bundleTarget || typeof libraryApi.issueArtifactPreviewToken !== 'function') {
      return
    }
    setOpeningBrowser(true)
    try {
      const res = await libraryApi.issueArtifactPreviewToken({
        slug: bundleTarget.slug,
        ...(bundleTarget.version !== undefined ? { version: bundleTarget.version } : {})
      })
      if (!res?.preview_url) {
        throw new Error('Preview URL unavailable')
      }
      openExternal(res.preview_url)
    } catch (err) {
      toastError(t('chat.inspector.openInSystemBrowser'), errorMessage(err))
    } finally {
      setOpeningBrowser(false)
    }
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

  const handleOpenCloudSettings = (): void => {
    void navigate({
      to: '/settings',
      search: { tab: 'connectors', item: 'preset:artifact_server' }
    })
  }

  const handleCopyShareLink = (): void => {
    const target = activeRemote?.shareUrl ?? activeRemote?.reviewUrl
    if (!target || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(target).then(() => {
      setShareCopied(true)
      window.setTimeout(() => setShareCopied(false), 1800)
    })
  }

  const handlePublishCloud = async (): Promise<void> => {
    if (publishing) return
    const useBundleApi =
      prefersBundlePublish && bundleTarget && typeof libraryApi.publishArtifactBundle === 'function'
    if (!useBundleApi && (!effectiveContent || !mailApi?.connector?.invokeTool)) return
    setPublishing(true)
    try {
      let reviewUrl: string | undefined
      let shareUrl: string | undefined
      let publishedVersion: number | undefined

      if (useBundleApi && bundleTarget) {
        const res = await libraryApi.publishArtifactBundle({
          slug: bundleTarget.slug,
          ...(bundleTarget.version !== undefined ? { version: bundleTarget.version } : {}),
          title: artifact.title,
          artifact_type: artifact.artifactType ?? 'app',
          ...(activeVersionEntry?.changeNote ? { change_note: activeVersionEntry.changeNote } : {})
        })
        reviewUrl = res.review_url ?? res.share_url
        shareUrl = res.share_url
        publishedVersion = typeof res.version === 'number' ? res.version : undefined
      } else if (mailApi?.connector?.invokeTool) {
        const slug = artifact.slug || normalizePublishSlug(artifact.title)
        const res = await mailApi.connector.invokeTool('artifact_server', 'artifact_publish', {
          slug,
          title: artifact.title,
          artifact_type: artifact.artifactType ?? 'app',
          html: effectiveContent,
          ...(activeVersionEntry?.changeNote ? { change_note: activeVersionEntry.changeNote } : {})
        })
        if (res.is_error) {
          throw new Error(res.content || 'Publish failed')
        }
        const parsed = JSON.parse(res.content) as {
          ok?: boolean
          message?: string
          version?: number
          review_url?: string
          share_url?: string
          links?: { review_url?: string; share_url?: string }
        }
        if (parsed.ok === false) {
          throw new Error(parsed.message || 'Publish failed')
        }
        reviewUrl = parsed.review_url ?? parsed.links?.review_url ?? parsed.share_url
        shareUrl = parsed.share_url ?? parsed.links?.share_url
        publishedVersion = typeof parsed.version === 'number' ? parsed.version : undefined
      }

      if (!reviewUrl) {
        throw new Error('Artifact Server did not return a review URL')
      }
      setPublishedByKey((prev) => ({
        ...prev,
        [publishStateKey]: {
          reviewUrl,
          shareUrl,
          version: publishedVersion
        }
      }))
      toastSuccess(t('chat.inspector.cloud.publishSuccess'))
    } catch (err) {
      toastError(t('chat.inspector.cloud.publishFailed'), errorMessage(err))
    } finally {
      setPublishing(false)
    }
  }

  const loadingPreview =
    (!isHtmlArtifact && artifact.kind === 'library' && activeFileId != null && liveTextQ.isLoading) ||
    (isHtmlArtifact &&
      activeFileId != null &&
      !activeContentFallback &&
      (htmlMode === 'source' || previewUrl === null) &&
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
            </>
          )}
          {canOpenInBrowser && (
            <button
              type="button"
              onClick={() => void handleOpenInBrowser()}
              disabled={openingBrowser}
              aria-label={t('chat.inspector.openInSystemBrowser')}
              title={t('chat.inspector.openInSystemBrowser')}
              className="grid size-7 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 disabled:opacity-60"
            >
              {openingBrowser ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
            </button>
          )}
          {canDownloadHtml && (
            <button
              type="button"
              onClick={() => void handleDownloadHtml()}
              aria-label={t('chat.inspector.downloadHtml')}
              title={t('chat.inspector.downloadHtml')}
              className="grid size-7 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
            >
              <Download size={13} />
            </button>
          )}
          {canShowCloudControl &&
            (artifactServerConnected && (prefersBundlePublish || canInvokeSinglePublish) ? (
              <button
                type="button"
                onClick={() => void handlePublishCloud()}
                disabled={publishing}
                aria-label={
                  publishing
                    ? t('chat.inspector.cloud.publishing')
                    : activeRemote
                      ? t('chat.inspector.cloud.updateCloud')
                      : t('chat.inspector.cloud.publish')
                }
                className="inline-flex items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1 text-aux font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3 disabled:opacity-60"
              >
                {publishing ? (
                  <Loader2 size={13} className="animate-spin text-coral" />
                ) : (
                  <UploadCloud size={13} className="text-coral" />
                )}
                <span>
                  {publishing
                    ? t('chat.inspector.cloud.publishing')
                    : activeRemote
                      ? t('chat.inspector.cloud.updateCloud')
                      : t('chat.inspector.cloud.publish')}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleOpenCloudSettings}
                aria-label={t('chat.inspector.cloud.connectTitle')}
                title={t('chat.inspector.cloud.connectTitle')}
                className="grid size-7 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
              >
                <Cloud size={13} />
              </button>
            ))}
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
          {activeRemote !== null && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-1.5">
              <span className="inline-flex items-center gap-1 text-aux font-medium text-ink-fg">
                <Cloud size={13} className="text-ok" />
                <span>{t('chat.inspector.cloud.badge')}</span>
                {activeRemote.version != null && (
                  <span className="font-mono text-meta tabular-nums text-ink-fg-2">
                    v{activeRemote.version}
                  </span>
                )}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openExternal(activeRemote.reviewUrl)}
                  className="inline-flex items-center gap-1 rounded border border-ink-border-soft bg-ink-1 px-2 py-0.5 text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-3"
                >
                  <ExternalLink size={12} />
                  <span>{t('chat.inspector.cloud.openReview')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyShareLink}
                  className="inline-flex items-center gap-1 rounded border border-ink-border-soft bg-ink-1 px-2 py-0.5 text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-3"
                >
                  {shareCopied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                  <span>
                    {shareCopied
                      ? t('chat.inspector.cloud.shareCopied')
                      : t('chat.inspector.cloud.copyShareLink')}
                  </span>
                </button>
              </div>
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
