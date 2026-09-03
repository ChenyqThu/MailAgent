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
import { qk } from '@shared/lib/queryKeys'
import { useTranslation } from 'react-i18next'
import DOMPurify from 'dompurify'
import { Minus, Plus, RotateCw, X } from 'lucide-react'

import { request } from '@shared/api/http_client'
import { useMailApi } from '@shared/hooks/useMailApi'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { useAppearance, type BodyFont } from '@shared/state/appearance'
import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'
import { adaptHtmlForDarkMode } from '@shared/lib/emailDarkMode'
import { rewriteRemoteImages } from '@shared/lib/emailRemoteImages'
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
  /** 直接渲染这段 HTML (跳过按 internalId 拉正文的 query)。compose draft-edit 的
   *  引用区用: marker 拆分后编辑器已有回复段, 引用区只渲染 quote 段, 按 id 全量
   *  重拉会视觉重复。仍走同一 sanitize + cid 重写 + 暗色适配管线。 */
  htmlOverride?: string | null
}

// 消毒配置已抽到 @shared/lib/emailSanitize (EMAIL_PURIFY_OPTS) —— 阅读区与 compose
// 发送拼回引用块共用同一套硬化规则。独立断言见 tests/components/dompurify_xss.test.ts。

/** `POST /api/email/remote-image/grant` 回的一张放行票 (后端 HMAC 签发)。 */
interface RemoteImageGrant {
  url: string
  exp: number
  sig: string
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
  /* 表格宽度: 只压上限, 不改写作者的宽度。此前这里是
       table { border-collapse: collapse; max-width:100% !important; width:auto !important; ... }
     而新闻信的排版骨架就是「固定 600px 居中 + 多层嵌套表格」—— width:auto
     !important 把每一层作者写的宽度全部作废, 嵌套一塌, 正文被挤成中间一窄条
     (0903 owner 反馈, 同一封在 Outlook 里正常)。留 max-width:100% 防超宽表格撑破
     详情列; 真正压不下去的宽数据表由 .mailagent-table-scroll 容器横向滚动兜底 (见下)。
     border-collapse 一并撤掉: 它只服务于下面那圈 1px 网格线 (现在只画给作者声明了
     边框的数据表格), 全局 collapse 反而会吃掉作者用 cellspacing 做的栏间距 —— 那是
     排版被压扁的另一半。浏览器默认的 separate 与 Outlook / 各家 webmail 一致。 */
  table { max-width: 100% !important; table-layout: auto; }
  /* 布局表格不画边框。HTML 邮件几乎全部用表格排版 (role="presentation" /
     border="0" / 嵌套若干层), 原来那条无差别的 table td, table th 边框规则
     把每一层布局表格的每一格都描了框 = owner 截图里满屏莫名其妙的方框。
     判据不能一刀切, 只有「作者自己声明了边框」的数据表格才补网格线:
       ① HTML border 属性非 0;
       ② 表格或它自己的某个单元格 inline style 里有真实 border 声明。
     判定在 post-processing 做 (hasAuthorBorder → .mailagent-table-bordered), 不用纯
     CSS 的 [style*="border"]: newsletter 模板里 border-collapse:collapse /
     border-spacing:0 / border-radius 满地都是, 子串匹配会把布局表格重新全部框起来。
     padding / font-size / word-break 不影响布局, 无差别保留。 */
  table td, table th {
    padding: 6px 10px; font-size: 13px;
    word-break: break-word;
  }
  /* 只作用于被判定表自己的单元格 (子孙组合器会让「外层容器表写了一条
     border-top」把整封信的嵌套单元格重新框起来 —— 那就是原 bug 复发)。 */
  table.mailagent-table-bordered { border-collapse: collapse; }
  table.mailagent-table-bordered > thead > tr > td,
  table.mailagent-table-bordered > thead > tr > th,
  table.mailagent-table-bordered > tbody > tr > td,
  table.mailagent-table-bordered > tbody > tr > th,
  table.mailagent-table-bordered > tfoot > tr > td,
  table.mailagent-table-bordered > tfoot > tr > th {
    border: 1px solid rgb(var(--ink-border));
  }
  /* #8 宽表格横向滚动: 后处理把每个 <table> 包进 .mailagent-table-scroll 容器。
     容器 max-width:100% 填满 body 宽 (不撑破 body — body overflow:hidden 只裁自身),
     overflow-x:auto 让超宽表格在容器内左右滚动。**刻意保留上面 table{max-width:100%}
     不动** (零回归): 可 reflow 的 newsletter 布局表 (width="600" 等) 照常缩到 100%,
     min-content < 容器 → 无溢出无滚动条; 含不可压缩宽内容的数据表 min-content 超过
     100% (max-width 压不过 min-content) → 在容器内溢出 → 出横向滚动条 (取代旧的
     body overflow:hidden 直接截断看不到)。容器高度=表格高度, 不影响 scrollHeight 测高。 */
  .mailagent-table-scroll { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
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
  /* H3 远程图片占位。默认拦截时 <img> 的 src 被摘走存进 data-mailagent-remote-src
     (改写在 shared/lib/emailRemoteImages.ts), 这里只负责"留出位置": 尺寸从 img 自己的
     width/height 属性或 inline style 推导后写进 --ma-remote-w/h 两个变量, 推不出时用
     一个低调的小方块。
     🔴 height 必须带 !important 且选择器比裸 img 更具体 —— 上面 img{height:auto
     !important} 会盖掉任何 inline height, 占位框当场塌成 0 高, 版式照塌。
     只给底色不描边: 追踪像素常是 1x1 / 20x1 的 spacer, 描边会把它们变成满屏虚线点。 */
  img.mailagent-remote-image {
    width: var(--ma-remote-w, 28px);
    height: var(--ma-remote-h, 28px) !important;
    background: rgb(var(--ink-fg) / 0.06);
    cursor: default;
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
  translations,
  htmlOverride
}: Props): React.ReactElement {
  const hasOverride = typeof htmlOverride === 'string' && htmlOverride.length > 0
  const mailApi = useMailApi()
  const { t } = useTranslation()
  const [expandedInternalId, setExpandedInternalId] = useState<number | null>(null)
  const showFullBody = expandedInternalId === internalId
  // H3 远程图片放行的作用域 = **这封邮件的这次查看**。存 internalId 而不是 boolean, 与上面
  // 的 expandedInternalId 同一手法: 本组件切邮件时不重挂载 (只有 BodyIframe 有 key),
  // 一个 boolean 会把上一封的"已同意"带到下一封。不做持久化, 也没有"总是信任该发件人"
  // (那是后续项)。
  //
  // 🔴 放行态 = **后端签发的放行票**, 不是一个本地 boolean (0903 返工批 B2): 代理只认
  // 签名, 所以"已同意"这件事必须是一份正文伪造不出来的凭据。拿不到票 = 不放行。
  //
  // `missing` = 送上去换票、但没换回票的条数（后端对脏 URL 静默不签，超过签发上限的也丢掉）。
  // 放行后这些位置仍是占位，用户会看到「有几张就是出不来」—— 得说清楚，别让它像个 bug。
  const [remoteGrants, setRemoteGrants] = useState<{
    id: number
    map: ReadonlyMap<string, string>
    missing: number
  } | null>(null)
  const [remoteGrantPendingFor, setRemoteGrantPendingFor] = useState<number | null>(null)
  const [remoteGrantFailedFor, setRemoteGrantFailedFor] = useState<number | null>(null)
  const remoteImagesAllowed = remoteGrants !== null && remoteGrants.id === internalId
  const resolvedTheme = useAppearance((s) => s.resolvedTheme)
  // 正文外观 (设置面板「正文外观」可调) — 注入 srcDoc <html> 的 CSS 变量。
  const bodyFont = useAppearance((s) => s.bodyFont)
  const bodyFontSize = useAppearance((s) => s.bodyFontSize)
  const bodyLineHeight = useAppearance((s) => s.bodyLineHeight)

  const previewBodyQ = useQuery({
    queryKey: qk.email.bodyPreview(internalId, 'html'),
    queryFn: async () => {
      const htmlBody = await mailApi.email.body(internalId, { format: 'html', mode: 'preview' })
      if (typeof htmlBody?.content === 'string' && htmlBody.content.length > 0) {
        return htmlBody
      }

      const markdownBody = await mailApi.email.body(internalId, {
        format: 'markdown',
        mode: 'preview'
      })
      if (typeof markdownBody?.content !== 'string' || markdownBody.content.length === 0) {
        return htmlBody ?? markdownBody
      }

      // text-only fallback 必须和 translate.ts 共用 plaintextToHtml 产物；
      // 译文注入按 shared run/text 匹配，任一端单独改 DOM 都会错位。
      const content = plaintextToHtml(markdownBody.content)
      if (content.length === 0) return htmlBody ?? markdownBody
      return { ...markdownBody, format: 'html' as const, content }
    },
    // htmlOverride 直供内容 → 不拉正文 (compose draft-edit 引用区)。
    enabled: !hasOverride,
    staleTime: Infinity
  })
  const fullBodyQ = useQuery({
    queryKey: qk.email.body(internalId, 'html'),
    queryFn: async () => {
      const htmlBody = await mailApi.email.body(internalId, { format: 'html', mode: 'full' })
      if (typeof htmlBody?.content === 'string' && htmlBody.content.length > 0) {
        return htmlBody
      }
      const markdownBody = await mailApi.email.body(internalId, {
        format: 'markdown',
        mode: 'full'
      })
      if (typeof markdownBody?.content !== 'string' || markdownBody.content.length === 0) {
        return htmlBody ?? markdownBody
      }
      const content = plaintextToHtml(markdownBody.content)
      if (content.length === 0) return htmlBody ?? markdownBody
      return { ...markdownBody, format: 'html' as const, content }
    },
    enabled: showFullBody && !hasOverride,
    staleTime: Infinity
  })
  const bodyQ = showFullBody && fullBodyQ.data ? fullBodyQ : previewBodyQ

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
      queryKey: qk.attachment.dataUrl(a.id),
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

  // srcDoc 与「这封信里有几张远程图片」是同一趟改写算出来的 —— 提示条要不要出、出几张,
  // 判据只能是真正被拦下的那些 img, 所以一起返回而不是另开一遍扫描。
  const { srcDoc, remoteImageCount, remoteImageUrls } = useMemo<{
    srcDoc: string | null
    remoteImageCount: number
    remoteImageUrls: string[]
  }>(() => {
    const html = hasOverride ? htmlOverride : bodyQ.data?.content
    if (typeof html !== 'string' || html.length === 0) {
      return { srcDoc: null, remoteImageCount: 0, remoteImageUrls: [] }
    }
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
    // H3 — 远程 http(s) 图片默认拦成占位, 用户点过「加载图片」并换到放行票后改写成走本机
    // 代理 (页面 CSP 的 img-src 只放行 127.0.0.1, 运行时改不了 CSP)。cid: / data: /
    // attachments 相对路径不受影响, 判据 (含 srcset / poster / background / CSS url())
    // 见 emailRemoteImages.ts。
    // baseUrl 传 document.baseURI: srcdoc 文档继承父文档的 base, 归一化必须用同一个基准,
    // 否则 `//host/x` 与 `http:/host/x` 这类写法在打包态 (file://) 会算出别的结果。
    const remote = rewriteRemoteImages(sanitized, {
      allow: remoteImagesAllowed,
      baseUrl: document.baseURI,
      proxyBase: `${resolveApiBaseUrl()}/email/remote-image`,
      grants: remoteGrants?.map,
      placeholderLabel: t('emailDetail.remoteImages.placeholderAlt')
    })
    sanitized = remote.html
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
    return {
      srcDoc: `<!doctype html>
<html data-theme="${resolvedTheme}">
<head>
  <meta charset="utf-8" />
  <style>${BODY_CSS}
:root { --ma-body-font: ${BODY_FONT_STACK[bodyFont]}; --ma-body-size: ${bodyFontSize}px; --ma-body-lh: ${bodyLineHeight}; }</style>
</head>
<body>${sanitized}</body>
</html>`,
      remoteImageCount: remote.remoteCount,
      remoteImageUrls: remote.remoteUrls
    }
  }, [
    hasOverride,
    htmlOverride,
    bodyQ.data,
    byCid,
    byBaseName,
    internalId,
    resolvedTheme,
    bodyFont,
    bodyFontSize,
    bodyLineHeight,
    remoteImagesAllowed,
    remoteGrants,
    t
  ])

  // 「加载图片」= 用一次**已鉴权**的写请求把这封信里的远程 URL 换成签名放行票, 再重渲染。
  // 正文自己发不出这个请求 (iframe 无 allow-scripts), 所以票据是正文伪造不出来的。
  // 一条票都没换到 (全部 URL 被后端判为签不了) 也算失败 —— 否则会静默地什么都不显示。
  const loadRemoteImages = useCallback(async (): Promise<void> => {
    if (remoteImageUrls.length === 0) return
    setRemoteGrantPendingFor(internalId)
    setRemoteGrantFailedFor(null)
    try {
      const res = await request<{ grants?: RemoteImageGrant[] }>(
        resolveApiBaseUrl(),
        'POST',
        '/email/remote-image/grant',
        { body: { urls: remoteImageUrls } }
      )
      const map = new Map<string, string>()
      for (const g of res.grants ?? []) {
        map.set(
          g.url,
          `url=${encodeURIComponent(g.url)}&exp=${g.exp}&sig=${encodeURIComponent(g.sig)}`
        )
      }
      if (map.size === 0) setRemoteGrantFailedFor(internalId)
      else
        setRemoteGrants({
          id: internalId,
          map,
          missing: Math.max(0, remoteImageUrls.length - map.size)
        })
    } catch {
      setRemoteGrantFailedFor(internalId)
    } finally {
      setRemoteGrantPendingFor(null)
    }
  }, [internalId, remoteImageUrls])

  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const handleImageClick = useCallback((src: string) => setPreviewSrc(src), [])
  const closePreview = useCallback(() => setPreviewSrc(null), [])

  if (previewBodyQ.isError || fullBodyQ.isError) {
    const bodyError = fullBodyQ.error ?? previewBodyQ.error
    return (
      <div className="text-aux text-fail">
        {bodyError instanceof Error ? bodyError.message : 'Body load failed.'}
      </div>
    )
  }
  if (previewBodyQ.isLoading) {
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
      {remoteImageCount > 0 && !remoteImagesAllowed && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-ink-border-soft bg-ink-2/40 px-4 py-3">
          <p className="text-aux text-ink-fg-2">
            {remoteGrantFailedFor === internalId
              ? t('emailDetail.remoteImages.loadFailed')
              : t('emailDetail.remoteImages.notice', { n: remoteImageCount })}
          </p>
          <button
            type="button"
            className="shrink-0 rounded-md border border-ink-border-soft px-3 py-1.5 text-aux text-ink-fg transition-colors hover:bg-ink-3 disabled:cursor-wait disabled:opacity-60"
            disabled={remoteGrantPendingFor === internalId}
            onClick={() => {
              void loadRemoteImages()
            }}
          >
            {t('emailDetail.remoteImages.load')}
          </button>
        </div>
      )}
      {remoteImagesAllowed && (remoteGrants?.missing ?? 0) > 0 && (
        // 换到票的已经显示了, 这几张换不到票 (脏 URL / 超过签发上限) 仍是占位 —— 说清有几张,
        // 别让「点了加载但有图出不来」看着像个 bug。
        <div className="mb-4 rounded-lg border border-ink-border-soft bg-ink-2/40 px-4 py-3">
          <p className="text-aux text-ink-fg-2">
            {t('emailDetail.remoteImages.partial', { n: remoteGrants?.missing ?? 0 })}
          </p>
        </div>
      )}
      <BodyIframe
        srcDoc={srcDoc}
        key={internalId}
        translations={translations ?? null}
        onImageClick={handleImageClick}
      />
      {previewBodyQ.data?.truncated && !fullBodyQ.data && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-ink-border-soft bg-ink-2/40 px-4 py-3">
          <p className="text-aux text-ink-fg-2">{t('emailDetail.bodyPreviewTruncated')}</p>
          <button
            type="button"
            className="shrink-0 rounded-md border border-ink-border-soft px-3 py-1.5 text-aux text-ink-fg transition-colors hover:bg-ink-3 disabled:cursor-wait disabled:opacity-60"
            disabled={fullBodyQ.isFetching}
            onClick={() => setExpandedInternalId(internalId)}
          >
            {fullBodyQ.isFetching
              ? t('emailDetail.bodyLoadingFull')
              : t('emailDetail.bodyShowFull')}
          </button>
        </div>
      )}
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

/** 会画出线的 border 属性 (border / border-top / border-left-width / border-style …)。
 *  刻意不含 border-collapse / border-spacing / border-radius / border-image —— 那些是
 *  布局与圆角声明, newsletter 模板里满地都是, 算进来就等于给所有布局表格描框。
 *  也不含 border-color: 单独一条 border-color 不画线 (border-style 默认 none)。 */
const BORDER_PROP_RE = /^border(-(top|right|bottom|left))?(-(width|style))?$/

/** inline style 字符串里是否有真实的边框声明。`border: 0` / `border: 1px none #ccc` /
 *  `border-style: hidden` 是作者显式「不要边框」, 不算。 */
function declaresBorder(style: string | null | undefined): boolean {
  if (!style) return false
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) continue
    const prop = decl.slice(0, colon).trim().toLowerCase()
    if (!BORDER_PROP_RE.test(prop)) continue
    const value = decl
      .slice(colon + 1)
      .trim()
      .toLowerCase()
    if (value === '') continue
    if (/(^|\s)(none|hidden)(\s|$)/.test(value)) continue
    if (/^0(\.0+)?(px|pt|em|rem|%)?$/.test(value)) continue
    return true
  }
  return false
}

/** 这张表是不是「作者自己声明了边框」的数据表格 —— 判据与顺序见 BODY_CSS 里 table
 *  那段注释。`role="presentation"` / `border="0"` / 没有任何边框声明的排版表格恒 false,
 *  于是不再被我们无差别描框。 */
function hasAuthorBorder(table: HTMLTableElement): boolean {
  const attr = table.getAttribute('border')?.trim()
  if (attr !== undefined && attr !== '' && attr !== '0') return true
  if (declaresBorder(table.getAttribute('style'))) return true
  // 作者只在单元格上写 border 的数据表。先用子串把候选缩到极少数, 再逐条按声明判定
  // (子串会命中 border-collapse 之类, 不能直接采信); 嵌套表的单元格归它自己那层。
  const cells = table.querySelectorAll('td[style*="border"], th[style*="border"]')
  return Array.from(cells).some(
    (cell) => cell.closest('table') === table && declaresBorder(cell.getAttribute('style'))
  )
}

function BodyIframe({ srcDoc, translations, onImageClick }: BodyIframeProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // 400px initial keeps the layout from flashing tiny while the iframe
  // measures itself; once `measure()` lands the height jumps to the
  // real value.
  const [height, setHeight] = useState<number>(400)
  // iframe 文档「换代计数」—— 每次 setupObservers() 成功接管一份文档就 +1。
  //
  // 🔴 为什么不是 boolean（原 docReady 的真 bug）：切邮件时 srcDoc 变 → 文档生命周期
  // effect 的 cleanup `setDocReady(false)` 与新一轮 `setupObservers()` 里的
  // `setDocReady(true)` 落在**同一个 React 批次**里（`:643` 的 readyState==='complete'
  // 分支在刚设完 srcDoc 时读到的往往还是上一封的 contentDocument，于是同步就跑了），
  // false→true 净变化为零 ⇒ 不产生重渲染 ⇒ 下面的注入 effect 收不到「文档换代了」这个
  // 信号。它先前那次注入打在旧/半加载文档上，会被 iframe 真正的 `load` 冲掉，而 load
  // 之后再没有任何依赖变化能让它重跑 —— 表现为「翻译按钮亮着但正文没译文，手动关一次
  // 再开就好了」（toggle 让 translations 走 segments→null→segments，依赖真的变了）。
  //
  // 单调递增的计数不会被批处理吞掉：无论中间经过多少次 false/true，计数一定变。
  const [docGeneration, setDocGeneration] = useState(0)

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
      // #8 宽表格横向滚动: 把每个 <table> 包进 overflow-x:auto 容器 (见 BODY_CSS
      // .mailagent-table-scroll)。超宽数据表格不再被 body overflow:hidden 截断, 而是
      // 在容器内左右滚动。幂等 (已包裹则跳过), 在 measure() 前跑使测高基于最终布局。
      doc!.querySelectorAll('table').forEach((tbl) => {
        // 只给作者声明了边框的数据表格补网格线, 布局表格保持无边框 (判据见 BODY_CSS
        // 里 table 那段注释)。classList.add 幂等, 放在下面的「已包裹则跳过」之前,
        // 使同一份文档被接管两次时也一定标到。
        if (hasAuthorBorder(tbl)) tbl.classList.add('mailagent-table-bordered')
        const parent = tbl.parentElement
        if (parent && parent.classList.contains('mailagent-table-scroll')) return
        const wrap = doc!.createElement('div')
        wrap.className = 'mailagent-table-scroll'
        tbl.replaceWith(wrap)
        wrap.appendChild(tbl)
      })

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
      // load 与 readyState 两路都可能走到这里（同一份文档被接管两次）→ 计数 +2 →
      // 注入 effect 跑两次。幂等无害：injectTranslations 首行就是 clear。
      setDocGeneration((g) => g + 1)
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
      // 不复位 docGeneration —— 计数只增不减正是它能穿透 React 批处理的原因（见其声明处）。
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
    // 0 = 还没有任何一份文档被接管过（iframe 未 load）。
    if (docGeneration === 0) return
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
    // srcDoc 已不在 deps：它变化必然导致文档换代 → docGeneration +1 → 本 effect 重跑。
    // 留着只会让 effect 在新文档尚未 load 时对旧文档多跑一次（无害但无意义）。
  }, [translations, docGeneration])

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

// Exported so the attachment surfaces (AttachmentList / ThreadAttachmentBar)
// reuse the exact same zoom/rotate/pan lightbox for image previews instead of
// forking a second one.
export function ImageLightbox({ src, onClose }: ImageLightboxProps): React.ReactPortal | null {
  const { t } = useTranslation()
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  // The image can fail to decode (corrupt / unsupported like some HEIC). Show a
  // dismissable error instead of a broken-image glyph. Reset when `src` changes
  // (render-phase reset per React docs — no effect, no cascading-render lint) so
  // reusing the lightbox for a good image recovers.
  const [imgError, setImgError] = useState(false)
  const [imgErrorSrc, setImgErrorSrc] = useState(src)
  if (src !== imgErrorSrc) {
    setImgErrorSrc(src)
    setImgError(false)
  }
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
      {imgError ? (
        <div
          role="alert"
          className="px-6 text-center text-aux text-ink-fg-1"
          onClick={(e) => e.stopPropagation()}
        >
          {t('emailDetail.lightbox.loadError')}
        </div>
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setImgError(true)}
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
      )}
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
