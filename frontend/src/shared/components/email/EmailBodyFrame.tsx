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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import DOMPurify from 'dompurify'
import { Minus, Plus, RotateCw, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { useAppearance, type BodyFont } from '@shared/state/appearance'
import { adaptHtmlForDarkMode } from '@shared/lib/emailDarkMode'
import { EMAIL_PURIFY_OPTS } from '@shared/lib/emailSanitize'
import { plaintextToHtml } from '@shared/lib/plaintext_html'
import type { EmailDetail, TranslationSegment } from '@shared/api/types'

import { injectTranslations } from './emailTranslationInjection'

interface Props {
  internalId: number
  attachments: NonNullable<EmailDetail['attachments']>
  /** Immersive translation segments. When non-null, the iframe DOM is mutated
   *  in-place to insert a translated `<div>` after each matched block. Switch
   *  to null to clear all injected translations and show the original. */
  translations?: TranslationSegment[] | null
}

// 消毒配置已抽到 @shared/lib/emailSanitize (EMAIL_PURIFY_OPTS) —— 阅读区与 compose
// 发送拼回引用块共用同一套硬化规则。独立断言见 tests/components/dompurify_xss.test.ts。

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
    /* 字体族 / 字号 / 行高 由设置面板「正文外观」控制 — 经 <html> inline CSS
       变量注入 (appearance store)。fallback 值 = 旧默认, 保证 store 未注入 /
       Web target 时仍可读 (行高 fallback 也已从 1.7 收紧到 1.15)。 */
    font-family: var(--ma-body-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif);
    font-size: var(--ma-body-size, 14px);
    line-height: var(--ma-body-lh, 1.15);
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
  /* Sprint 18 — preserve aspect ratio + open lightbox on click.
     Outlook / Gmail templates often inline width="600" height="400" on
     <img> tags; when max-width:100% kicks in and only width shrinks,
     the inline height attribute keeps the image stretched. height:auto
     !important overrides the inline attribute so the browser re-computes
     height from the intrinsic ratio. object-fit:contain is a belt-and-
     suspenders guard for cases where both width and height are set as
     inline style. cursor:zoom-in hints clickability. */
  img {
    max-width: 100%;
    height: auto !important;
    object-fit: contain;
    border-radius: 6px;
    cursor: zoom-in;
  }
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
  /* Sprint Immersive-Translate — inline 译文块。沉浸式插件标志样式: 蓝色
     斜体 + 左侧蓝线 + 浅蓝背景, 跟原文 (ink-fg) 视觉对比明显。颜色复用
     EmailBodyFrame 已有的 #6FA8DC (pre .key 也用这个), 跟整体 light/dark
     主题相容。背景透明度低 (0.06) 不抢眼但仍能区分段落。 */
  .mailagent-translation {
    font-style: italic;
    color: #6FA8DC;
    border-left: 2px solid rgb(111 168 220 / 0.6);
    padding: 4px 0 4px 14px;
    margin: 4px 0 12px;
    line-height: 1.65;
    font-size: 13.5px;
    background: rgb(111 168 220 / 0.06);
    border-radius: 2px;
  }
  /* 译文块内常见 inline 节点继承上下文颜色, 别让 a 抢眼 */
  .mailagent-translation a { color: inherit; text-decoration-color: rgb(111 168 220 / 0.4); }
  /* table 单元格里的译文用 block 形态会撑爆 td; 强制 display:block 并
     在内部加微 margin 让单元格能容纳。 */
  td > .mailagent-translation,
  th > .mailagent-translation {
    display: block;
    margin: 4px 0 0;
  }
  /* li 里同理 — 跟原 list-item bullet 对齐 */
  li > .mailagent-translation {
    display: block;
    margin: 2px 0 6px;
  }
`

/** 正文字体族 (appearance store 的 bodyFont 枚举 → CSS font 栈)。注入 <html>
 *  的 --ma-body-font 变量。三档覆盖常见偏好: 系统无衬线 / 衬线 / 等宽。 */
const BODY_FONT_STACK: Record<BodyFont, string> = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, "PingFang SC", monospace'
}

export function EmailBodyFrame({
  internalId,
  attachments,
  translations
}: Props): React.ReactElement {
  const mailApi = useMailApi()
  const resolvedTheme = useAppearance((s) => s.resolvedTheme)
  // 正文外观 (设置面板「正文外观」可调) — 注入 srcDoc <html> 的 CSS 变量。
  const bodyFont = useAppearance((s) => s.bodyFont)
  const bodyFontSize = useAppearance((s) => s.bodyFontSize)
  const bodyLineHeight = useAppearance((s) => s.bodyLineHeight)

  const bodyQ = useQuery({
    queryKey: ['email', internalId, 'body', 'html'],
    queryFn: async () => {
      const htmlBody = await mailApi.email.body(internalId, { format: 'html' })
      if (typeof htmlBody?.content === 'string' && htmlBody.content.length > 0) {
        return htmlBody
      }

      const markdownBody = await mailApi.email.body(internalId, { format: 'markdown' })
      if (typeof markdownBody?.content !== 'string' || markdownBody.content.length === 0) {
        return htmlBody ?? markdownBody
      }

      // text-only fallback 必须和 translate.ts 共用 plaintextToHtml 产物；
      // 译文注入按 shared run/text 匹配，任一端单独改 DOM 都会错位。
      const content = plaintextToHtml(markdownBody.content)
      if (content.length === 0) return htmlBody ?? markdownBody
      return { ...markdownBody, format: 'html' as const, content }
    },
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
    let sanitized = DOMPurify.sanitize(html, EMAIL_PURIFY_OPTS)
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
    // Sprint 14 round 17 — terminal-fix for inline images.
    // `src/repository/storage_payload_builder.py` rewrites the
    // original `cid:xxx` href to `attachments/{internal_id}/{filename}`
    // before saving body_html to SQLite.  The renderer never sees the
    // `cid:` prefix anymore, only the relative path.  Resolve that
    // relative path against the data-URL map (byBaseName) here so the
    // iframe gets a real renderable src — independent of how broken
    // the original Content-ID header was.
    const localPathPattern = new RegExp(
      `(?<attr>src|href)=(?<q>["'])attachments/${internalId}/(?<file>[^"']+)\\k<q>`,
      'gi'
    )
    sanitized = sanitized.replace(localPathPattern, (_whole, ...rest) => {
      const groups = rest[rest.length - 1] as Record<string, string>
      const fn = (groups.file ?? '').toLowerCase()
      const attr = groups.attr ?? 'src'
      const q = groups.q ?? '"'
      let hit = byBaseName.get(fn)
      if (!hit) {
        const dot = fn.lastIndexOf('.')
        if (dot > 0) hit = byBaseName.get(fn.slice(0, dot))
      }
      if (hit) return `${attr}=${q}${hit}${q}`
      // No matching attachment loaded yet (or filename mismatch) —
      // leave the original ref so the user still sees a broken-image
      // glyph rather than the data:URL pipeline failing silently.
      return _whole
    })
    // dogfood round 3 — 深色主题下邮件自带 inline color/bgcolor 覆盖 BODY_CSS
    // token (黑字配深底不可读)。保色相亮度翻转 (HSL 只翻 L, 蓝仍是蓝), 亮背景
    // 移除露主题底, 发件人 authored 深底配色整树保留。详见 emailDarkMode.ts。
    if (resolvedTheme === 'dark') {
      sanitized = adaptHtmlForDarkMode(sanitized)
    }
    // Sprint 14 round 15 — no inline <script>.  iframe sandbox is
    // `allow-same-origin` *without* `allow-scripts`, so any inline
    // script we put inside srcDoc would never execute and the iframe
    // height would stay frozen at its initial value (= long emails
    // got clipped).  Instead the parent measures `contentDocument
    // .body.scrollHeight` directly (allowed by same-origin) and runs
    // its own ResizeObserver against it.
    // 正文外观 CSS 变量走独立 :root <style> 块 (不是 <html style="..."> attr) —
    // BODY_FONT_STACK 含双引号 (如 "SF Pro Text"), 放进 HTML style attribute 会
    // 截断 attr 导致变量残缺; 放进 CSS 文本里双引号合法。size/lh 是 clamp 后的
    // number, 拼接安全。
    return `<!doctype html>
<html data-theme="${resolvedTheme}">
<head>
  <meta charset="utf-8" />
  <style>${BODY_CSS}
:root { --ma-body-font: ${BODY_FONT_STACK[bodyFont]}; --ma-body-size: ${bodyFontSize}px; --ma-body-lh: ${bodyLineHeight}; }</style>
</head>
<body>${sanitized}</body>
</html>`
  }, [
    bodyQ.data,
    byCid,
    byBaseName,
    internalId,
    resolvedTheme,
    bodyFont,
    bodyFontSize,
    bodyLineHeight
  ])

  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const handleImageClick = useCallback((src: string) => setPreviewSrc(src), [])
  const closePreview = useCallback(() => setPreviewSrc(null), [])

  if (bodyQ.isError) {
    return (
      <div className="text-aux text-fail">
        {bodyQ.error instanceof Error ? bodyQ.error.message : 'Body load failed.'}
      </div>
    )
  }
  if (bodyQ.isLoading) {
    // 正文加载骨架: 模拟段落 + 留白的占位, 比单行 "Loading…" 更接近最终布局,
    // 减少加载→正文的跳变感。Skeleton 自带 animate-pulse motion-reduce:animate-none。
    return (
      <div className="py-1 space-y-4" aria-label="loading email body" aria-busy="true">
        <Skeleton rows={3} />
        <Skeleton rows={4} width="full" />
        <Skeleton rows={2} />
      </div>
    )
  }
  if (srcDoc === null) {
    return <div className="text-aux text-ink-fg-2">(empty body)</div>
  }
  return (
    <>
      <BodyIframe
        srcDoc={srcDoc}
        key={internalId}
        translations={translations ?? null}
        onImageClick={handleImageClick}
      />
      {previewSrc !== null && <ImageLightbox src={previewSrc} onClose={closePreview} />}
    </>
  )
}

// Sprint 13 — separate component so the postMessage listener + height
// state live in one place, and remounting on email switch (via `key=`)
// resets height cleanly. The iframe inner script (see srcDoc above)
// reports `{ type: 'mailagent:body-height', h: number }` whenever its
// body resizes (ResizeObserver) or images finish loading.
interface BodyIframeProps {
  srcDoc: string
  /** Immersive translation segments to inject after each matching block.
   *  null clears any prior injection. */
  translations: TranslationSegment[] | null
  /** Called with the resolved data: URL when the user clicks an <img>.
   *  Parent opens a lightbox with that URL. */
  onImageClick: (src: string) => void
}

/** Remove any previously-injected translation nodes from the iframe doc. */
function clearInjectedTranslations(doc: Document): void {
  doc.querySelectorAll('.mailagent-translation').forEach((n) => n.remove())
}

function BodyIframe({ srcDoc, translations, onImageClick }: BodyIframeProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // 400px initial keeps the layout from flashing tiny while the iframe
  // measures itself; once `measure()` lands the height jumps to the
  // real value.
  const [height, setHeight] = useState<number>(400)
  // Track whether the iframe document is ready so the translations-only
  // effect can run inject without waiting for srcDoc to change.
  const [docReady, setDocReady] = useState(false)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    function readScrollHeight(): number | null {
      // 只读 body.scrollHeight: documentElement (html) 在 iframe 内是
      // viewport-locked (至少 fill iframe 当前 height), 用它会自锁导致
      // iframe 永远缩不下来。body 是 height:auto, 才反映真实内容。
      const body = iframe!.contentDocument?.body
      const h = body?.scrollHeight ?? 0
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
    let clickDoc: Document | null = null
    // 正文链接点击 → 系统默认浏览器。必须在渲染层拦截 (而非依赖主进程
    // will-frame-navigate): iframe 的 <a> 被 DOMPurify 剥掉 target, 点击会在
    // iframe 内原地导航, 而页面 CSP (frame-src 'self') 把外部导航拦成空白页 —
    // 用户看到正文消失。这里捕获阶段拦截, 导航发生前 preventDefault, 再用
    // shell:openExternal 调系统浏览器/邮件客户端。父 renderer 持有 window.electron
    // (iframe sandbox 无 allow-scripts, 但父层经 allow-same-origin 可挂监听)。
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Element | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      const rawHref = anchor.getAttribute('href') ?? ''
      // 页内锚点 (#...) 留给 iframe 自己滚动; 空 href 忽略 (不拦, 走默认)。
      if (rawHref === '' || rawHref.startsWith('#')) return
      // anchor.href 已被浏览器解析为绝对 URL (about:srcdoc 基准下的 https/mailto 等)。
      const url = anchor.href || rawHref
      if (!/^(?:https?|mailto|tel|callto|sms):/i.test(url)) return
      e.preventDefault()
      e.stopPropagation()
      const invoke = (
        window as unknown as {
          electron?: { ipcRenderer?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } }
        }
      ).electron?.ipcRenderer?.invoke
      void invoke?.('shell:openExternal', url)
    }
    function setupObservers(): void {
      const doc = iframe!.contentDocument
      const body = doc?.body
      if (!body) return
      // 链接拦截 — 捕获阶段确保先于默认导航; removeEventListener 先清防重复绑定
      // (setupObservers 可能被 load + readyState 两路各调一次)。
      doc.removeEventListener('click', onDocClick, true)
      doc.addEventListener('click', onDocClick, true)
      clickDoc = doc
      // ResizeObserver 保留 — 用于图片 / 字体异步加载完成后的高度刷新。
      // 不处理 translation inject/clear (那是显式 React 事件, 直接在
      // useEffect 里同步 setHeight 就够了, 不需要 observer 间接触发)。
      ro?.disconnect()
      // rAF 包裹: measure() 会 setHeight → iframe 重排 → body resize → RO 再触发,
      // 同步回调会形成 "ResizeObserver loop completed with undelivered notifications"
      // 警告 (良性但刷屏)。延到下一帧测量打断同步环, 高度仍在一帧内收敛。
      ro = new ResizeObserver(() => {
        requestAnimationFrame(() => measure())
      })
      ro.observe(body)
      // Sprint 18 — every <img> gets:
      //   1. load/error listener → re-measure height when async decode lands
      //   2. click listener → open lightbox preview with resolved src
      // Iframe sandbox blocks scripts, so the listeners must be attached
      // from the parent (allowed by allow-same-origin). preventDefault on
      // click matters because some senders wrap <img> in <a> for tracking;
      // sandbox blocks the popup anyway and we want predictable preview.
      doc!.querySelectorAll('img').forEach((img) => {
        const el = img as HTMLImageElement
        if (!el.complete) {
          el.addEventListener('load', measure, { once: true })
          el.addEventListener('error', measure, { once: true })
        }
        el.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          const src = el.currentSrc || el.src
          if (src) onImageClick(src)
        })
      })
      measure()
      setDocReady(true)
    }

    function onLoad(): void {
      setupObservers()
    }
    iframe.addEventListener('load', onLoad)
    if (iframe.contentDocument?.readyState === 'complete') {
      setupObservers()
    }

    return (): void => {
      iframe.removeEventListener('load', onLoad)
      ro?.disconnect()
      clickDoc?.removeEventListener('click', onDocClick, true)
      setDocReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: 此 effect 是 iframe 文档生命周期, 只能跟 srcDoc; onImageClick 列入会让正文 iframe 整个重挂。
  }, [srcDoc])

  // Translation inject — 用户切换译文/原文时同步:
  //   1) mutate DOM
  //   2) void offsetHeight 强制 sync reflow
  //   3) 读 scrollHeight 拿 layout 后真实值
  //   4) imperative iframe.style.height = ... 直接写 (bypass React state +
  //      re-render 调度时序), 同时 setHeight 让 state 跟 DOM 同步避免
  //      ResizeObserver 后续 measure 拿到 stale state 又 setHeight 回大值。
  //
  // 为什么 imperative: 此前 setHeight + React re-render 链路实测没让 iframe
  // 视觉高度缩 — 用户验证 "切回原文底部留大片空白"。imperative 写 DOM 在当前
  // 帧立即生效, 不依赖 React 调度 / 不依赖任何 observer fire 时机。
  useEffect(() => {
    if (!docReady) return
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument
    if (!iframe || !doc?.body) return
    if (!translations || translations.length === 0) {
      clearInjectedTranslations(doc)
    } else {
      injectTranslations(doc, translations)
    }
    void doc.body.offsetHeight
    // BUG ROOT CAUSE (诊断 console log 抓到):
    //   原 measure 算法用 Math.max(html.scrollHeight, body.scrollHeight,
    //   html.offsetHeight, body.offsetHeight)。html (documentElement) 在
    //   iframe 内是 **viewport-locked** — 至少撑满 iframe element 视口高度,
    //   所以 html.scrollHeight === 当前 iframe.style.height 形成自锁:
    //     - inject 后 iframe = 1858, body = 1858, html = 1858 → ok 写 1858
    //     - clear 后 body shrinks 到 954, BUT html 仍 = 1858 (跟 viewport),
    //       Math.max(1858, 954, ...) = 1858 → iframe 永远缩不下来
    //   只读 body.scrollHeight (body 是 height:auto, 真实跟内容) 才对。
    const next = Math.max(120, Math.min(Math.round(doc.body.scrollHeight), 80000))
    iframe.style.height = `${next}px`
    setHeight(next)
  }, [translations, docReady, srcDoc])

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

// Sprint 18 — inline-image lightbox.
//
// Renders a full-viewport overlay (portal'd to body so parent transforms
// don't break fixed positioning) with the clicked image centered and a
// toolbar for zoom / rotate / reset / close.
//
// Controls:
//   - wheel        zoom toward cursor (cap 0.1 .. 8)
//   - drag         pan when zoomed in (cursor: grab/grabbing)
//   - +/- buttons  ±25 % zoom
//   - rotate btn   +90° step
//   - reset btn    restore scale/rotation/pan
//   - Esc          close
//
// We render with `position: fixed` outside any clipping ancestor — the
// email pane has overflow-hidden via the iframe styling, so a same-tree
// modal would get clipped. createPortal sidesteps that.

const SCALE_MIN = 0.1
const SCALE_MAX = 8

interface ImageLightboxProps {
  src: string
  onClose: () => void
}

function ImageLightbox({ src, onClose }: ImageLightboxProps): React.ReactPortal | null {
  const { t } = useTranslation()
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null
  )

  const reset = useCallback(() => {
    setScale(1)
    setRotation(0)
    setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === '+' || e.key === '=') {
        setScale((s) => Math.min(SCALE_MAX, s * 1.25))
      } else if (e.key === '-' || e.key === '_') {
        setScale((s) => Math.max(SCALE_MIN, s / 1.25))
      } else if (e.key === 'r' || e.key === 'R') {
        setRotation((r) => (r + 90) % 360)
      } else if (e.key === '0') {
        reset()
      }
    }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [onClose, reset])

  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    setScale((s) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, s * factor)))
  }

  function onPointerDown(e: React.PointerEvent<HTMLImageElement>): void {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
  }
  function onPointerMove(e: React.PointerEvent<HTMLImageElement>): void {
    const d = dragRef.current
    if (!d) return
    setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) })
  }
  function onPointerUp(e: React.PointerEvent<HTMLImageElement>): void {
    if (dragRef.current && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }

  // Click on the backdrop (not the image / not the toolbar) closes the
  // lightbox — common UX pattern.
  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose()
  }

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('emailDetail.lightbox.ariaLabel')}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-0/85 backdrop-blur-sm"
      onClick={onBackdropClick}
      onWheel={onWheel}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${rotation}deg)`,
          // eslint-disable-next-line react-hooks/refs -- lightbox 拖拽时即时跟手(transition:none)、松手恢复 120ms 过渡。dragRef 存拖拽态避免每次 pointermove re-render（性能）；render 读 ref 决定 transition 是有意权衡。真重构 ref→state 会每拖拽帧 re-render。React Compiler 迁移债。
          transition: dragRef.current ? 'none' : 'transform 120ms ease',
          maxWidth: '92vw',
          maxHeight: '88vh',
          cursor: scale > 1 ? 'grab' : 'default',
          userSelect: 'none',
          willChange: 'transform'
        }}
      />
      <div
        className="pointer-events-auto absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-ink-border-soft bg-ink-1/85 px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-md"
        onClick={(e) => e.stopPropagation()}
      >
        <LightboxBtn
          label={`${t('emailDetail.lightbox.zoomOut')} (-)`}
          onClick={() => setScale((s) => Math.max(SCALE_MIN, s / 1.25))}
        >
          <Minus className="size-4" />
        </LightboxBtn>
        <span className="min-w-[3.5rem] text-center font-mono text-aux text-ink-fg-1 tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <LightboxBtn
          label={`${t('emailDetail.lightbox.zoomIn')} (+)`}
          onClick={() => setScale((s) => Math.min(SCALE_MAX, s * 1.25))}
        >
          <Plus className="size-4" />
        </LightboxBtn>
        <span className="mx-1 h-5 w-px bg-ink-border-soft" />
        <LightboxBtn
          label={`${t('emailDetail.lightbox.rotate')} (R)`}
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <RotateCw className="size-4" />
        </LightboxBtn>
        <button
          type="button"
          onClick={reset}
          className="rounded-md px-2 py-1 text-aux text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
          aria-label={`${t('emailDetail.lightbox.reset')} (0)`}
        >
          {t('emailDetail.lightbox.reset')}
        </button>
        <span className="mx-1 h-5 w-px bg-ink-border-soft" />
        <LightboxBtn label={`${t('emailDetail.lightbox.close')} (Esc)`} onClick={onClose}>
          <X className="size-4" />
        </LightboxBtn>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(node, document.body)
}

function LightboxBtn({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus:outline-none focus:ring-2 focus:ring-coral/70"
    >
      {children}
    </button>
  )
}
