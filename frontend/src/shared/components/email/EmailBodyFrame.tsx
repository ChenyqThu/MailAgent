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

import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import DOMPurify from 'dompurify'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useAppearance } from '@shared/state/appearance'
import type { EmailDetail } from '@shared/api/types'

interface Props {
  internalId: number
  attachments: NonNullable<EmailDetail['attachments']>
}

const PURIFY_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['target', 'onerror', 'onclick', 'onload']
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
  body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: rgb(var(--ink-fg-1));
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    font-feature-settings: 'ss01', 'cv11';
  }
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
  table { border-collapse: collapse; max-width: 100%; }
  table td, table th {
    border: 1px solid rgb(var(--ink-border));
    padding: 6px 10px; font-size: 13px;
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

  const inlineAttachments = useMemo(
    () => attachments.filter((a) => a.is_inline && typeof a.content_id === 'string'),
    [attachments]
  )

  const localPathQueries = useQueries({
    queries: inlineAttachments.map((a) => ({
      queryKey: ['attachment', a.id, 'localPath'],
      queryFn: () => mailApi.attachment.localPath(a.id),
      staleTime: Infinity
    }))
  })

  const inlineMap = useMemo(() => {
    const entries: Array<{ cid: string; localPath: string }> = []
    for (let i = 0; i < inlineAttachments.length; i++) {
      const cid = inlineAttachments[i]!.content_id as string
      const path = localPathQueries[i]?.data
      if (typeof path === 'string' && path.length > 0) {
        entries.push({ cid, localPath: path })
      }
    }
    return entries
  }, [inlineAttachments, localPathQueries])

  const srcDoc = useMemo(() => {
    const html = bodyQ.data?.content
    if (typeof html !== 'string' || html.length === 0) return null
    let sanitized = DOMPurify.sanitize(html, PURIFY_OPTS)
    for (const entry of inlineMap) {
      const cidEscaped = entry.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`(["'])cid:${cidEscaped}\\1`, 'gi')
      const fileUrl = `file://${encodeURI(entry.localPath)}`
      sanitized = sanitized.replace(pattern, `$1${fileUrl}$1`)
    }
    return `<!doctype html>
<html data-theme="${resolvedTheme}">
<head>
  <meta charset="utf-8" />
  <style>${BODY_CSS}</style>
</head>
<body>${sanitized}</body>
</html>`
  }, [bodyQ.data, inlineMap, resolvedTheme])

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
  return (
    <iframe
      title="email-body"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      className="w-full min-h-[60vh] border-0 bg-transparent"
    />
  )
}
