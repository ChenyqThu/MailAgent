import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, Copy, ExternalLink } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { useLibraryApi } from '@shared/components/library/hooks'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import type { WorkspaceArtifact } from './deriveSessionWorkspace'

export interface InspectorArtifactPreviewProps {
  readonly artifact: WorkspaceArtifact
  readonly onBack: () => void
}

/**
 * Wide (520px) in-place preview for a clicked session Artifact (library document, generated image,
 * email draft, report, matter summary, or latest PlanCard), reusing safe existing renderers.
 */
export function InspectorArtifactPreview({
  artifact,
  onBack
}: InspectorArtifactPreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const libraryApi = useLibraryApi()
  const [copied, setCopied] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  const liveTextQ = useQuery({
    queryKey: ['library', 'inspector-preview', artifact.fileId ?? 'none'],
    queryFn: () => libraryApi.text(artifact.fileId as number),
    enabled: artifact.kind === 'library' && artifact.fileId != null,
    staleTime: 30_000
  })

  const effectiveContent =
    (typeof liveTextQ.data?.markdown === 'string' && liveTextQ.data.markdown) ||
    artifact.content ||
    ''

  const copyPayload =
    artifact.kind === 'plan' && artifact.plan
      ? [
          artifact.plan.goal,
          ...artifact.plan.steps.map((s, idx) => `${idx + 1}. [${s.status}] ${s.title}`)
        ].join('\n')
      : artifact.kind === 'image'
        ? (artifact.content || artifact.imageUrl || '')
        : effectiveContent

  const canOpenLibrary = artifact.kind === 'library' && artifact.fileId != null
  const canOpenMatter = artifact.kind === 'matter' && artifact.matterPublicId != null

  const handleCopy = (): void => {
    if (!copyPayload || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(copyPayload).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  const handleOpenOriginal = (): void => {
    if (canOpenLibrary && artifact.fileId != null) {
      void navigate({ to: '/library', search: { file: artifact.fileId } })
      return
    }
    if (canOpenMatter && artifact.matterPublicId) {
      useMatterNavigation.getState().open(artifact.matterPublicId)
      void navigate({ to: '/matters' })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-border-soft px-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-aux text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <ArrowLeft size={14} strokeWidth={1.8} />
          <span>{t('chat.inspector.backToOverview')}</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
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
              className="inline-flex items-center gap-1 rounded-md border border-ink-border-soft bg-ink-2 px-2 py-1 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
            >
              <ExternalLink size={13} />
              <span>{t('chat.inspector.openOriginal')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        <div>
          <h3 className="break-words text-body font-medium text-ink-fg">{artifact.title}</h3>
          {artifact.virtualPath && (
            <div className="mt-1 truncate font-mono text-aux text-ink-fg-3">
              {artifact.virtualPath}
            </div>
          )}
          {artifact.to && (
            <div className="mt-1 break-words text-aux text-ink-fg-2">
              To: {artifact.to}
            </div>
          )}
          {artifact.subtitle && artifact.subtitle !== artifact.to && (
            <div className="mt-1 text-aux text-ink-fg-2">{artifact.subtitle}</div>
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
                {step.note && (
                  <p className="mt-1 text-aux text-ink-fg-3">{step.note}</p>
                )}
              </li>
            ))}
          </ol>
        )}

        {(artifact.kind === 'library' ||
          artifact.kind === 'draft' ||
          artifact.kind === 'report' ||
          artifact.kind === 'matter') && (
          <>
            {artifact.kind === 'library' && liveTextQ.isLoading && !effectiveContent ? (
              <p className="text-aux text-ink-fg-3">{t('chat.inspector.loadingPreview')}</p>
            ) : effectiveContent.length > 0 ? (
              <div
                className={cn(
                  'rounded-lg border border-ink-border-soft bg-ink-2 p-3 text-body text-ink-fg'
                )}
              >
                {artifact.isMarkdown !== false ? (
                  <TranslatedBody text={effectiveContent} />
                ) : (
                  <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words font-mono text-aux leading-relaxed text-ink-fg-1">
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
