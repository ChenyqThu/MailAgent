// task 09-02 — ImageGenCard: the generate_image tool part, three live faces + the approval face.
//
//   generating  a 1:1 (or `size`-shaped) placeholder with a soft blurred glow + pulse, the prompt in
//               small text, the requested resolution as a corner badge. `prefers-reduced-motion`
//               drops the pulse (the CSS class is gated on the hook, not only on the media query,
//               so the reduced branch is unit-testable).
//   complete    the image(s) from the gateway file route (`<img src>` — the tool result carries only
//               `{file_id, url}`), click → the existing ImageLightbox (zoom / rotate / pan), a
//               「下载」action that fetches the bytes and hands them to the browser as a download
//               (a cross-origin `<a download>` is ignored by Chromium, and in the packaged app the
//               renderer is file:// → the loopback gateway IS cross-origin — so blob first).
//   error       the localized failure line + the tool's error detail + 「重试」, which re-sends the
//               same prompt as a fresh user message through ThreadPrimitive.Suggestion (rendered
//               only on a live composer surface — the read-only transcript has nothing to send to).
//   pending     (owner set the per-tool tier to `ask`) the prompt for review + approve / reject.
//               Without this branch an ask-tier part would fall through to the buttonless
//               ToolTraceCard spinner — the v1.5.0 deadlock, a fourth time.
//
// ComponentRegistry key only (a2ui.ts componentForTool returns null): the card reads the tool
// part's args / result directly. MailAgent tokens only (ink-* surfaces, --c-accent glow, --r-card
// frame via CardFrame); `text-meta` is reserved for the numeric resolution badge (DESIGN.md:
// mono / English-only), everything CJK-capable is `text-aux`.

import { useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { useChatComposerControls } from '../../components/composerControlsContext'
import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase, toolErrorDetail } from '../_cardShell.lib'
import {
  absoluteImageUrl,
  buildRetryPrompt,
  placeholderAspect,
  readImageGenInput,
  readImageGenOutput
} from './imageGenCard.lib'

async function downloadImage(url: string, fileName: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const blob = await response.blob()
  if (typeof URL.createObjectURL !== 'function') {
    window.open(url, '_blank', 'noopener')
    return
  }
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}

function ResolutionBadge({ label }: { label: string | null }): React.JSX.Element | null {
  if (!label) return null
  return (
    <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-md bg-ink-1/80 px-1.5 py-0.5 font-mono text-meta tabular-nums text-ink-fg-2">
      {label}
    </span>
  )
}

export function ImageGenCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, argsText, result, respondToApproval } = props
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const controls = useChatComposerControls()
  const phase = deriveCardPhase(props)
  const input = readImageGenInput(args, argsText)
  const images = phase === 'done' ? readImageGenOutput(result) : []
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const editing = input.sourceCount > 0
  const title = t(editing ? 'chat.imageGenCard.titleEdit' : 'chat.imageGenCard.title')
  const requestedLabel = input.size ? input.size.replace('x', '×') : null
  const errorDetail = phase === 'error' ? toolErrorDetail(result) : null

  const promptLine =
    input.prompt.length > 0 ? (
      <p className="mt-1.5 line-clamp-3 break-words text-aux text-ink-fg-2" title={input.prompt}>
        {input.prompt}
      </p>
    ) : null

  return (
    <CardFrame icon={<ImageIcon size={13} strokeWidth={2} />} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {editing
              ? t('chat.imageGenCard.pendingLabelEdit', { count: input.sourceCount })
              : t('chat.imageGenCard.pendingLabel')}
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-aux text-ink-fg">
            {input.prompt}
          </div>
        </>
      ) : null}

      {phase === 'authorized' ? (
        <>
          <div
            data-testid="imagegen-placeholder"
            role="status"
            aria-label={t(editing ? 'chat.imageGenCard.editing' : 'chat.imageGenCard.generating')}
            className={cn(
              'relative w-full max-w-[280px] overflow-hidden rounded-lg border border-ink-border-soft bg-ink-3',
              !reduce && 'animate-pulse'
            )}
            style={{ aspectRatio: placeholderAspect(input.size) }}
          >
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgb(var(--c-accent)/0.35),transparent_60%)] blur-2xl"
            />
            <span className="absolute inset-0 grid place-items-center text-aux text-ink-fg-2">
              {t(editing ? 'chat.imageGenCard.editing' : 'chat.imageGenCard.generating')}
            </span>
            <ResolutionBadge label={requestedLabel} />
          </div>
          {promptLine}
        </>
      ) : null}

      {phase === 'done' ? (
        <>
          <div className="flex flex-wrap gap-2">
            {images.map((image) => {
              const src = absoluteImageUrl(image.url)
              const dims =
                image.width != null && image.height != null
                  ? `${image.width}×${image.height}`
                  : requestedLabel
              return (
                <figure
                  key={image.fileId}
                  className="m-0 flex max-w-[min(320px,100%)] flex-col gap-1"
                >
                  <div className="relative">
                    <img
                      src={src}
                      alt={input.prompt || t('chat.imageGenCard.imageAlt')}
                      role="button"
                      tabIndex={0}
                      aria-label={t('chat.imageGenCard.preview')}
                      onClick={() => setPreviewSrc(src)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setPreviewSrc(src)
                        }
                      }}
                      className="max-h-72 max-w-full cursor-zoom-in rounded-lg border border-ink-border bg-ink-3"
                    />
                    <ResolutionBadge label={dims} />
                  </div>
                  <figcaption className="flex items-center justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setDownloadError(null)
                        void downloadImage(src, image.fileId).catch((e: unknown) =>
                          setDownloadError(e instanceof Error ? e.message : String(e))
                        )
                      }}
                      className="rounded-md px-1.5 py-0.5 text-aux text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
                    >
                      {t('chat.imageGenCard.download')}
                    </button>
                  </figcaption>
                </figure>
              )
            })}
          </div>
          {downloadError ? (
            <div className="mt-1 text-aux text-fail">
              {t('chat.imageGenCard.downloadFailed', { error: downloadError })}
            </div>
          ) : null}
          {editing ? (
            <div className="mt-1 text-aux text-ink-fg-3">
              {t('chat.imageGenCard.sources', { count: input.sourceCount })}
            </div>
          ) : null}
          {promptLine}
        </>
      ) : null}

      {phase === 'error' ? (
        <>
          <div className="text-aux text-fail">{t('chat.imageGenCard.error')}</div>
          {errorDetail ? (
            <div className="mt-1 break-words text-aux text-ink-fg-2">{errorDetail}</div>
          ) : null}
          {promptLine}
          {controls && input.prompt.length > 0 ? (
            <div className="mt-2 flex justify-end">
              <ThreadPrimitive.Suggestion
                prompt={buildRetryPrompt(t, input.prompt)}
                autoSend
                disabled={controls.sendDisabled === true}
                className={cn(
                  'inline-flex h-7 items-center rounded-md border border-ink-border-soft bg-ink-2 px-2.5 text-aux leading-none text-ink-fg',
                  'transition-colors duration-fast hover:bg-ink-3 disabled:opacity-40'
                )}
              >
                {t('chat.imageGenCard.retry')}
              </ThreadPrimitive.Suggestion>
            </div>
          ) : null}
        </>
      ) : null}

      <ApprovalActions
        onApprove={() => respondToApproval({ approved: true })}
        onReject={() => respondToApproval({ approved: false })}
      />
      {phase === 'rejected' || phase === 'expired' ? <TerminalBanner phase={phase} /> : null}
      {previewSrc !== null ? (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      ) : null}
    </CardFrame>
  )
}
