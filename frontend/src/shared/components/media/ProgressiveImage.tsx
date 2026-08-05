// ProgressiveImage — a reusable "progressive reveal" for images, adapted from beUI's
// `components/agents/image-generation.tsx` MEDIA_STATE table (see task research:
// `.trellis/tasks/08-04-dogfood-feedback-0804-connector-chatui-avatar/research/gap-beui-agent-components.md`
// §II-3). We have no generation pipeline (owner: not building one) — this borrows only the
// *state-table-driven reveal* mechanic and re-maps it onto a real `<img>` element's actual
// lifecycle.
//
// State mapping (beUI 5-state → our 4-state), and why:
//   queued + generating + refining  →  `loading`
//     A native <img> only ever tells us "haven't started" / "in flight" / "done" / "errored" via
//     onLoad/onError — there is no partial-bytes progress signal to justify three separate
//     "how far along" stages the way a generation pipeline (which reports queued→generating→
//     refining progress from a server) can. Collapsing them loses nothing we could observe anyway.
//   complete                        →  `loaded`
//   error                           →  `error`
//   (new) `idle`
//     Not in beUI's table. Added for callers whose `src` resolves asynchronously (e.g. an
//     attachment-thumbnail query still in flight upstream) — `src == null` renders the same
//     placeholder as `loading` without mounting an <img> or attempting a fetch.
//
// Dropped dimensions: beUI's table also varies `blur()` and `saturate()` per state. Both are CSS
// `filter` functions, and this codebase has a standing "filter is never transitioned" rule
// (DESIGN.md §8: "No blur — filter is never transitioned"; motion-gsap.md §9.2 calls it the
// "zero-filter red line" and needed an explicit carve-out for `mask-image` to bypass it — masks
// are not filters, blur is). So only `opacity` + `transform: scale()` survive here, which happens
// to match the GSAP-approved transform property allowlist already used everywhere else in this
// codebase (x/y/scale/rotation/autoAlpha — never filter).
//
// Sizing is the caller's responsibility (via `containerClassName`/`containerStyle`): this
// component does not infer or reserve space from the image's eventual natural dimensions, matching
// every other image consumer in this codebase (attachment thumbnails, avatars — all pre-sized).
//
// Not registered in motion-gsap.md's "beui 收编组件登记表": that table is specifically the
// AnimatePresence/spring allowlist for floating layers (drawers, popovers, ...). This component
// never mounts/unmounts on an overlay lifecycle and uses no `motion` — it is a plain CSS-transition
// state machine on a persistent element, so that registration doesn't apply.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageOff } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

export type ProgressiveImageState = 'idle' | 'loading' | 'loaded' | 'error'

/** opacity + scale per state (ported from beUI's MEDIA_STATE table, minus blur/saturate — see
 *  module header). No `error` entry: on error the <img> is unmounted in favour of the fallback UI
 *  rather than left rendered mid-fade (never "a permanently blurred ghost image"). Plain data
 *  constant co-located with (and only meaningful next to) the component it drives; also exported
 *  for direct assertions in ProgressiveImage.test.tsx (same precedent as AttachmentTray.tsx's
 *  `kindFromName`). */
// eslint-disable-next-line react-refresh/only-export-components
export const PROGRESSIVE_IMAGE_STYLE: Record<
  Exclude<ProgressiveImageState, 'error'>,
  { opacity: number; scale: number }
> = {
  idle: { opacity: 0, scale: 1.02 },
  loading: { opacity: 0, scale: 1.015 },
  loaded: { opacity: 1, scale: 1 }
}

export interface ProgressiveImageProps {
  /** Image URL. `null`/`undefined` renders the `idle` placeholder without mounting an <img> (no
   *  fetch attempted yet) — for callers whose src resolves asynchronously. */
  src: string | null | undefined
  alt: string
  loading?: 'lazy' | 'eager'
  /** Classes for the <img> itself (object-fit / border-radius / etc — NOT sizing of the reveal
   *  transition, which this component owns via inline style). */
  className?: string
  /** Extra inline styles for the <img>, merged under the state-driven opacity/transform (those
   *  always win — don't set opacity/transform here). */
  imgStyle?: React.CSSProperties
  /** Classes for the wrapping container. Caller owns sizing (width/height/aspect-ratio) — this
   *  component reserves no space for the image's eventual natural dimensions. */
  containerClassName?: string
  containerStyle?: React.CSSProperties
  onLoad?: () => void
  onError?: () => void
  /** Custom error UI. Defaults to a centred ImageOff icon over a muted background. */
  errorFallback?: React.ReactNode
}

export function ProgressiveImage({
  src,
  alt,
  loading = 'lazy',
  className,
  imgStyle,
  containerClassName,
  containerStyle,
  onLoad,
  onError,
  errorFallback
}: ProgressiveImageProps): React.ReactElement {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  // Keyed by src value (not a boolean flag) so switching to a *different* src re-enters `loading`
  // without an effect — a render-phase comparison, same trick as EmailBodyFrame's ImageLightbox
  // `imgErrorSrc` reset.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [erroredSrc, setErroredSrc] = useState<string | null>(null)

  const state: ProgressiveImageState =
    src == null ? 'idle' : src === erroredSrc ? 'error' : src === loadedSrc ? 'loaded' : 'loading'

  return (
    <div className={cn('relative overflow-hidden', containerClassName)} style={containerStyle}>
      {(state === 'idle' || state === 'loading') && (
        <div
          className="absolute inset-0 animate-pulse motion-reduce:animate-none bg-ink-3"
          aria-hidden
        />
      )}
      {state === 'error' ? (
        (errorFallback ?? (
          <div
            role="img"
            aria-label={t('common.imageLoadFailed', { defaultValue: 'Image failed to load' })}
            className="absolute inset-0 grid place-items-center bg-ink-3 text-ink-fg-3"
          >
            <ImageOff size={18} strokeWidth={1.8} />
          </div>
        ))
      ) : src != null ? (
        <img
          src={src}
          alt={alt}
          loading={loading}
          onLoad={() => {
            setLoadedSrc(src)
            onLoad?.()
          }}
          onError={() => {
            setErroredSrc(src)
            onError?.()
          }}
          style={{
            ...imgStyle,
            opacity: PROGRESSIVE_IMAGE_STYLE[state].opacity,
            transform: `scale(${PROGRESSIVE_IMAGE_STYLE[state].scale})`
          }}
          className={cn(
            reduceMotion
              ? 'transition-none'
              : 'transition-[opacity,transform] duration-base ease-standard',
            className
          )}
        />
      ) : null}
    </div>
  )
}
