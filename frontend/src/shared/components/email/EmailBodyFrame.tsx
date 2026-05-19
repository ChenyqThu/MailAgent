// Sandboxed iframe + DOMPurified HTML body. Three security layers:
//   1. iframe `sandbox="allow-same-origin"` (no allow-scripts) — any
//      script tag that slipped past DOMPurify still can't execute.
//   2. DOMPurify `USE_PROFILES: { html: true }` + extra FORBID list.
//   3. Page-level CSP (index.html `default-src 'self'`).
//
// The iframe srcdoc inlines the mockup §<style> `.mail-body` rules so the
// content renders with the same h1/h2/p/strong/code/pre/blockquote tone
// the design uses for prose emails. We inject CSS variables for the
// current accent + ink-* tokens so theme/accent swaps re-tint the iframe
// content too.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import DOMPurify from 'dompurify'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useAppearance } from '@shared/state/appearance'
import type { EmailDetail } from '@shared/api/types'

interface Props {
  internalId: number
  attachments: NonNullable<EmailDetail['attachments']>
}

// DOMPurify URI regex — allow data: ONLY for image MIME types (so an
// attacker can't slip `data:text/html` payloads), plus the usual safe
// schemes. Without this, the default regex strips `data:image/png;base64,...`
// even though we wrote it ourselves to fix the inline-image rendering.
const SAFE_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|data:image\/(?:png|jpe?g|gif|webp|svg\+xml|heic)):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

const PURIFY_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['target', 'onerror', 'onclick', 'onload'],
  ALLOWED_URI_REGEXP: SAFE_URI_REGEXP
}

const BODY_CSS = `
  :root {
    --ink-0: 14 16 19;
    --ink-fg: 232 234 238;
    --ink-fg-1: 164 169 179;
    --ink-fg-2: 107 112 122;
    --ink-border: 44 50 59;
    --c-accent: 229 101 75;
  }
  :root[data-theme='light'] {
    --ink-0: 250 250 250;
    --ink-fg: 26 29 34;
    --ink-fg-1: 91 97 107;
    --ink-fg-2: 122 127 138;
    --ink-border: 214 217 221;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    /* Sprint 13 — body width follows the iframe (which is w-full of
       the detail column). Long tables / fixed-width newsletter layouts
       would otherwise overflow horizontally; force every block
       container to live within the available width. */
    max-width: 100%;
    overflow-wrap: break-word;
    word-break: break-word;
    /* Sprint 13 round 7 user feedback: single scroll container. The
       iframe element itself follows body.scrollHeight via postMessage,
       so the iframe viewport is always sized to the content - but the
       OS still reserves a scrollbar gutter inside the iframe document
       when overflow is auto/visible and the WebKit renderer decides
       to paint one on the height transition. Forcing overflow:hidden
       on the inner document guarantees only the OUTER scroll
       container (the email pane) ever paints a scrollbar. */
    overflow: hidden;
    height: auto;
  }
  body {
    color: rgb(var(--ink-fg-1));
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    font-feature-settings: 'ss01', 'cv11';
  }
  /* Defensive: every direct block should respect parent width so a
     newsletter <div style="width: 800px"> doesn't blow out the iframe. */
  body * { max-width: 100%; }
  h1, h2, h3 {
    color: rgb(var(--ink-fg));
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 18px 0 8px;
  }
  h1 { font-size: 18px; }
  h2 { font-size: 16px; }
  h3 { font-size: 15px; }
  p  { margin: 0 0 12px; }
  strong { color: rgb(var(--ink-fg)); font-weight: 600; }
  em { font-style: italic; }
  code {
    font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 12.5px;
    background: rgba(232, 155, 74, 0.12);
    padding: 1px 6px;
    border-radius: 4px;
    color: #E89B4A;
  }
  pre {
    font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 12.5px;
    /* Match mockup .mail-body pre — ink-fg tint at 6% so the glass-3
       parent still bleeds through; ink-0/0.5 (older value) read as a
       solid dark slab in dark mode and washed out everything behind. */
    background: rgb(var(--ink-fg) / 0.06);
    border: 1px solid rgb(var(--ink-border));
    border-radius: 6px;
    padding: 14px 16px;
    overflow-x: auto;
    color: rgb(var(--ink-fg-1));
    line-height: 1.6;
    margin: 12px 0;
  }
  pre code { background: transparent; padding: 0; color: inherit; }
  /* mockup §2210 stack-trace spans — used when a sender ships HTML with
     these semantic classes (Sentry, Bugsnag, GitHub PR diffs). Safe to
     keep around — selectors are no-ops on plain-text bodies. */
  pre .err { color: #E36262; }
  pre .num { color: rgb(var(--ink-fg-2)); }
  pre .key { color: #6FA8DC; }
  a {
    color: rgb(var(--c-accent));
    text-decoration: underline;
    text-decoration-color: rgb(var(--c-accent) / 0.40);
    text-underline-offset: 3px;
  }
  a:hover { text-decoration-color: rgb(var(--c-accent)); }
  blockquote {
    border-left: 2px solid rgb(var(--ink-border));
    padding-left: 14px;
    color: rgb(var(--ink-fg-2));
    margin: 14px 0;
  }
  ul, ol { padding-left: 22px; margin: 0 0 12px; }
  li { margin-bottom: 4px; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  /* Override <table width="600"> attributes (common in HTML newsletter
     boilerplate) so the email body re-flows when the user shrinks the
     column. !important wins over inline style="width:600px" from the
     senders MUA. */
  table { border-collapse: collapse; max-width: 100% !important; width: auto !important; table-layout: auto; }
  table td, table th {
    border: 1px solid rgb(var(--ink-border));
    padding: 6px 10px; font-size: 13px;
    word-break: break-word;
  }
  hr {
    border: 0;
    border-top: 1px solid rgb(var(--ink-border));
    margin: 16px 0;
  }
`

export function EmailBodyFrame({ internalId, attachments }: Props): React.ReactElement {
  const mailApi = useMailApi()
  const resolvedTheme = useAppearance((s) => s.resolvedTheme)

  const bodyQ = useQuery({
    queryKey: ['email', internalId, 'body', 'html'],
    queryFn: () => mailApi.email.body(internalId, { format: 'html' }),
    staleTime: Infinity
  })

  // Sprint 13 — every image-typed attachment is a *candidate* for inline
  // replacement, not just rows with is_inline=true. Reader sometimes
  // mis-tags is_inline (Apple Mail's Content-Disposition is unreliable)
  // and — separately — DB content_id can collide on a single Apple-Mail
  // GUID across attachments (backend bug; Sprint 14 reader.py rework).
  // We therefore (a) widen the candidate set, (b) pre-fetch all data
  // URLs, and (c) match by content_id first then fall back to filename
  // basename (cid:image001.png@xxx → filename "image001.png").
  const imageCandidates = useMemo(
    () =>
      attachments.filter((a) => {
        if (typeof a.content_id === 'string' && a.content_id.length > 0) return true
        const ct = (a.content_type ?? '').toLowerCase()
        if (ct.startsWith('image/')) return true
        const name = a.filename.toLowerCase()
        return /\.(png|jpe?g|gif|webp|svg|heic)$/.test(name)
      }),
    [attachments]
  )

  const dataUrlQueries = useQueries({
    queries: imageCandidates.map((a) => ({
      queryKey: ['attachment', a.id, 'dataUrl'],
      queryFn: () => mailApi.attachment.readDataUrl(a.id),
      staleTime: Infinity
    }))
  })

  // Build two lookup tables for the cid → dataUrl resolver:
  //   - byCid (primary): exact `Content-ID` match
  //   - byBaseName (fallback): filename without extension (lowercase)
  //     for use when reader gave every attachment the same wrong GUID
  const { byCid, byBaseName } = useMemo(() => {
    const byCid = new Map<string, string>()
    const byBaseName = new Map<string, string>()
    for (let i = 0; i < imageCandidates.length; i++) {
      const att = imageCandidates[i]!
      const url = dataUrlQueries[i]?.data
      if (typeof url !== 'string' || url.length === 0) continue
      if (typeof att.content_id === 'string' && att.content_id.length > 0) {
        byCid.set(att.content_id.toLowerCase(), url)
      }
      // Filename can be `image001.png` or `image001` — index both forms
      // so HTML refs like `cid:image001.png@01D...` and `cid:image001@xxx`
      // resolve.
      const filename = att.filename.toLowerCase()
      byBaseName.set(filename, url)
      const dot = filename.lastIndexOf('.')
      if (dot > 0) byBaseName.set(filename.slice(0, dot), url)
    }
    return { byCid, byBaseName }
  }, [imageCandidates, dataUrlQueries])

  const srcDoc = useMemo(() => {
    const html = bodyQ.data?.content
    if (typeof html !== 'string' || html.length === 0) return null
    let sanitized = DOMPurify.sanitize(html, PURIFY_OPTS)
    // Sprint 13 — single-pass rewrite of EVERY `cid:...` in the body so
    // we don't depend on the backend's content_id mapping (which is
    // broken for Apple-Mail-shaped GUIDs across attachments). For each
    // match, try content_id exact match first, then filename basename,
    // then leave the cid: in place (image will render as broken-glyph
    // and the user can see something is wrong).
    const cidRefPattern = /cid:([^"'\s>)]+)/gi
    sanitized = sanitized.replace(cidRefPattern, (whole, rawCid: string) => {
      const cid = rawCid.toLowerCase()
      // 1) exact content_id
      const direct = byCid.get(cid)
      if (direct) return direct
      // 2) strip `@<domain>` suffix → match filename basename
      const before = cid.split('@')[0]
      if (before) {
        const hit = byBaseName.get(before)
        if (hit) return hit
        // 3) sometimes refs include only the basename without the extension
        const dot = before.lastIndexOf('.')
        if (dot > 0) {
          const noExt = before.slice(0, dot)
          const hit2 = byBaseName.get(noExt)
          if (hit2) return hit2
        }
      }
      return whole
    })
    // Sprint 14 round 15 — no inline <script>.  iframe sandbox is
    // `allow-same-origin` *without* `allow-scripts`, so any inline
    // script we put inside srcDoc would never execute and the iframe
    // height would stay frozen at its initial value (= long emails
    // got clipped).  Instead the parent measures `contentDocument
    // .body.scrollHeight` directly (allowed by same-origin) and runs
    // its own ResizeObserver against it.
    return `<!doctype html>
<html data-theme="${resolvedTheme}">
<head>
  <meta charset="utf-8" />
  <style>${BODY_CSS}</style>
</head>
<body>${sanitized}</body>
</html>`
  }, [bodyQ.data, byCid, byBaseName, resolvedTheme])

  if (bodyQ.isError) {
    return (
      <div className="text-aux text-fail">
        {bodyQ.error instanceof Error ? bodyQ.error.message : 'Body load failed.'}
      </div>
    )
  }
  if (bodyQ.isLoading) {
    return <div className="text-aux text-ink-fg-2 animate-pulse">Loading body…</div>
  }
  if (srcDoc === null) {
    return <div className="text-aux text-ink-fg-2">(empty body)</div>
  }
  return <BodyIframe srcDoc={srcDoc} key={internalId} />
}

// Sprint 13 — separate component so the postMessage listener + height
// state live in one place, and remounting on email switch (via `key=`)
// resets height cleanly. The iframe inner script (see srcDoc above)
// reports `{ type: 'mailagent:body-height', h: number }` whenever its
// body resizes (ResizeObserver) or images finish loading.
interface BodyIframeProps {
  srcDoc: string
}

function BodyIframe({ srcDoc }: BodyIframeProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // 400px initial keeps the layout from flashing tiny while the iframe
  // measures itself; once `measure()` lands the height jumps to the
  // real value.
  const [height, setHeight] = useState<number>(400)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    function readScrollHeight(): number | null {
      const doc = iframe!.contentDocument
      if (!doc) return null
      const html = doc.documentElement
      const body = doc.body
      const h = Math.max(
        html?.scrollHeight ?? 0,
        body?.scrollHeight ?? 0,
        html?.offsetHeight ?? 0,
        body?.offsetHeight ?? 0
      )
      return h > 0 ? h : null
    }

    function measure(): void {
      const h = readScrollHeight()
      if (h === null) return
      // Clamp to a sane range. 80_000 covers very long marketing
      // newsletters or stack-trace blobs; we still rely on the OUTER
      // scroll container to actually scroll past the visible region.
      const next = Math.max(120, Math.min(Math.round(h), 80000))
      setHeight((prev) => (Math.abs(prev - next) < 2 ? prev : next))
    }

    let ro: ResizeObserver | null = null
    function setupObservers(): void {
      const doc = iframe!.contentDocument
      const body = doc?.body
      if (!body) return
      ro?.disconnect()
      ro = new ResizeObserver(() => measure())
      ro.observe(body)
      // Re-measure when images / fonts finish loading inside the doc.
      doc!.querySelectorAll('img').forEach((img) => {
        if (img.complete) return
        img.addEventListener('load', measure, { once: true })
        img.addEventListener('error', measure, { once: true })
      })
      measure()
    }

    function onLoad(): void {
      setupObservers()
    }
    iframe.addEventListener('load', onLoad)
    // Same-origin srcDoc may already have its document parsed before
    // React attaches the load listener; cover that case explicitly.
    if (iframe.contentDocument?.readyState === 'complete') {
      setupObservers()
    }

    return (): void => {
      iframe.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [srcDoc])

  return (
    <iframe
      ref={iframeRef}
      title="email-body"
      // Sprint 14 round 15 — sandbox stays `allow-same-origin` (no
      // `allow-scripts`).  Parent measures body height directly via
      // contentDocument so the iframe doesn't need to run any code
      // of its own.
      sandbox="allow-same-origin"
      // Sprint 13 round 7 — `scrolling="no"` is the legacy-but-still-
      // honoured signal to suppress the iframe scrollbar even if our
      // height under-shoots the body by a pixel.  Modern Chromium
      // reads it and matches our overflow:hidden inside the document.
      scrolling="no"
      srcDoc={srcDoc}
      style={{ height: `${height}px` }}
      className="w-full border-0 bg-transparent block"
    />
  )
}
