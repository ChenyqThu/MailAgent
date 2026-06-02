// Phase C — folder 邮件正文 sandboxed iframe. EmailBodyFrame 的契约是按
// internalId 从 email_metadata fetch body, folder_email 不在那张表 (body_html
// 已随 folder.get 返回), 所以这里做一个轻量版: 直接吃 html string + DOMPurify
// + 同款 sandbox iframe + body CSS。inline 图 (cid:) 解析 Phase D 再做 — 当前
// folder 正文里的 cid 引用会渲染成 broken-image glyph (可接受)。
//
// 安全三层与 EmailBodyFrame 一致: iframe sandbox(allow-same-origin, 无
// allow-scripts) + DOMPurify + 页面级 CSP。高度走 body.scrollHeight 测量。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify from 'dompurify'

import { useAppearance } from '@shared/state/appearance'

interface Props {
  html: string | null
}

const PURIFY_OPTS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['target', 'onerror', 'onclick', 'onload']
}

// 复刻 EmailBodyFrame 的 BODY_CSS 核心 (prose tone + 主题变量); 去掉沉浸式
// 翻译相关样式 (folder 不翻译)。
const BODY_CSS = `
  :root {
    --ink-0: 14 16 19; --ink-fg: 232 234 238; --ink-fg-1: 164 169 179;
    --ink-fg-2: 107 112 122; --ink-border: 44 50 59; --c-accent: 229 101 75;
  }
  :root[data-theme='light'] {
    --ink-0: 250 250 250; --ink-fg: 26 29 34; --ink-fg-1: 91 97 107;
    --ink-fg-2: 122 127 138; --ink-border: 214 217 221;
  }
  html, body {
    margin: 0; padding: 0; background: transparent; max-width: 100%;
    overflow-wrap: break-word; word-break: break-word; overflow: hidden; height: auto;
  }
  body {
    color: rgb(var(--ink-fg-1));
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
    font-size: 14px; line-height: 1.7; font-feature-settings: 'ss01', 'cv11';
  }
  body * { max-width: 100%; }
  h1, h2, h3 { color: rgb(var(--ink-fg)); font-weight: 600; letter-spacing: -0.01em; margin: 18px 0 8px; }
  h1 { font-size: 18px; } h2 { font-size: 16px; } h3 { font-size: 15px; }
  p { margin: 0 0 12px; }
  strong { color: rgb(var(--ink-fg)); font-weight: 600; }
  em { font-style: italic; }
  code {
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12.5px;
    background: rgba(232, 155, 74, 0.12); padding: 1px 6px; border-radius: 4px; color: #E89B4A;
  }
  pre {
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12.5px;
    background: rgb(var(--ink-fg) / 0.06); border: 1px solid rgb(var(--ink-border));
    border-radius: 6px; padding: 14px 16px; overflow-x: auto;
    color: rgb(var(--ink-fg-1)); line-height: 1.6; margin: 12px 0;
  }
  pre code { background: transparent; padding: 0; color: inherit; }
  a {
    color: rgb(var(--c-accent)); text-decoration: underline;
    text-decoration-color: rgb(var(--c-accent) / 0.40); text-underline-offset: 3px;
  }
  blockquote {
    border-left: 2px solid rgb(var(--ink-border)); padding-left: 14px;
    color: rgb(var(--ink-fg-2)); margin: 14px 0;
  }
  ul, ol { padding-left: 22px; margin: 0 0 12px; }
  li { margin-bottom: 4px; }
  img { max-width: 100%; height: auto !important; object-fit: contain; border-radius: 6px; }
  table { border-collapse: collapse; max-width: 100% !important; width: auto !important; table-layout: auto; }
  table td, table th { border: 1px solid rgb(var(--ink-border)); padding: 6px 10px; font-size: 13px; word-break: break-word; }
  hr { border: 0; border-top: 1px solid rgb(var(--ink-border)); margin: 16px 0; }
`

export function FolderBodyFrame({ html }: Props): React.ReactElement {
  const { t } = useTranslation()
  const resolvedTheme = useAppearance((s) => s.resolvedTheme)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(200)

  const srcDoc = useMemo(() => {
    if (typeof html !== 'string' || html.length === 0) return null
    const sanitized = DOMPurify.sanitize(html, PURIFY_OPTS)
    return `<!doctype html>
<html data-theme="${resolvedTheme}">
<head><meta charset="utf-8" /><style>${BODY_CSS}</style></head>
<body>${sanitized}</body>
</html>`
  }, [html, resolvedTheme])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    let ro: ResizeObserver | null = null
    function measure(): void {
      const body = iframe!.contentDocument?.body
      const h = body?.scrollHeight ?? 0
      if (h > 0) setHeight(Math.max(120, Math.min(Math.round(h), 80000)))
    }
    function onLoad(): void {
      const body = iframe!.contentDocument?.body
      if (!body) return
      ro?.disconnect()
      ro = new ResizeObserver(() => measure())
      ro.observe(body)
      iframe!.contentDocument?.querySelectorAll('img').forEach((img) => {
        const el = img as HTMLImageElement
        if (!el.complete) {
          el.addEventListener('load', measure, { once: true })
          el.addEventListener('error', measure, { once: true })
        }
      })
      measure()
    }
    iframe.addEventListener('load', onLoad)
    if (iframe.contentDocument?.readyState === 'complete') onLoad()
    return () => {
      iframe.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [srcDoc])

  if (srcDoc === null) {
    return <div className="text-aux text-ink-fg-2">{t('folder.emptyBody')}</div>
  }
  return (
    <iframe
      ref={iframeRef}
      title="folder-email-body"
      sandbox="allow-same-origin"
      scrolling="no"
      srcDoc={srcDoc}
      style={{ height: `${height}px` }}
      className="w-full border-0 bg-transparent block"
    />
  )
}
