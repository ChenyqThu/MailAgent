// Sandboxed iframe + DOMPurify body renderer. Three security layers:
//   1. `sandbox="allow-same-origin"` (no `allow-scripts`) — even if a script
//      tag leaks past sanitizing, it cannot execute.
//   2. DOMPurify default config — strips <script>, on*= handlers, <iframe>,
//      <object>, <embed>, javascript: URLs, dangerous SVG sinks.
//   3. CSP on the host page (index.html `default-src 'self'`) — backstop
//      against the iframe trying to phone home.
//
// `cid:` rewrite: HTML email bodies reference inline images as `cid:<id>`.
// We map them to file:// URLs via the attachment:localPath IPC. Each cid is
// resolved with its own useQuery so the cache survives sidebar navigation.
//
// Data flow uses TanStack Query end-to-end — no manual fetch/setState in
// effect (the React 19 rule set-state-in-effect would reject that pattern).

import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import DOMPurify from 'dompurify'

import { useMailApi } from '@shared/hooks/useMailApi'
import type { EmailDetail } from '@shared/api/types'

interface Props {
  internalId: number
  attachments: NonNullable<EmailDetail['attachments']>
}

export function EmailBodyFrame({ internalId, attachments }: Props): React.ReactElement {
  const mailApi = useMailApi()

  // Body (HTML) — Sprint 1 IPC returns null content if email_body is missing.
  const bodyQ = useQuery({
    queryKey: ['email', internalId, 'body', 'html'],
    queryFn: () => mailApi.email.body(internalId, { format: 'html' }),
    // Body content doesn't change for a given internal_id (immutable post-sync),
    // so keep it fresh forever — only invalidated by user action.
    staleTime: Infinity
  })

  // Resolve every inline attachment's local path in parallel, one query
  // each so the cache hits survive remounts.
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
    let sanitized = DOMPurify.sanitize(html, {
      // Defense-in-depth: curated HTML profile (explicit allowlist) + an
      // additional FORBID_TAGS for tags that DOMPurify's html profile may
      // re-introduce in a future minor version. allowlist > denylist for
      // body content from an untrusted source.
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button'],
      FORBID_ATTR: ['target', 'onerror', 'onclick', 'onload']
    })
    for (const entry of inlineMap) {
      const cidEscaped = entry.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`(["'])cid:${cidEscaped}\\1`, 'gi')
      const fileUrl = `file://${encodeURI(entry.localPath)}`
      sanitized = sanitized.replace(pattern, `$1${fileUrl}$1`)
    }
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; padding: 0; color: #E8EAEE; background: transparent;
         font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
         font-size: 14px; line-height: 1.6; }
  html[data-theme="light"] body { color: #1A1D22; }
  a { color: #6FA8DC; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; max-width: 100%; }
  blockquote { border-left: 3px solid rgba(255,255,255,0.15); margin: 1em 0; padding-left: 1em; color: rgba(232,234,238,0.7); }
  pre, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
</style>
</head>
<body>${sanitized}</body>
</html>`
  }, [bodyQ.data, inlineMap])

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
      className="w-full h-[60vh] border-0 bg-transparent"
    />
  )
}
