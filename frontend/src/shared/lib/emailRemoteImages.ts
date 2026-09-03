// 邮件正文远程图片的「默认拦截 / 显式放行」改写 —— 纯函数，输入输出都是 body fragment
// HTML 字符串（与 emailDarkMode.adaptHtmlForDarkMode 同形，串在 EmailBodyFrame 的同一条
// srcDoc 管线上）。
//
// 为什么拦：远程图片是追踪像素的主要载体，「打开邮件 = 告诉发信人你读了、什么时候读的、
// 从哪读的」。默认拦截是**要保留的隐私默认**，缺的是 Outlook 那套「提示条 + 用户显式同意
// 后放行」。
//
// 为什么改在这里（srcDoc 组装期）而不是 iframe 加载后的 post-processing：
//   - DOMParser 造出来的文档是 inert 的，解析这一步**不会发起任何资源请求**；等文档进了
//     iframe 再摘 src，浏览器已经试着取过一次了。
//   - 放行也走同一条路：srcDoc 重建一次，不需要在活 DOM 上做增量还原。
//
// 🔴 判据是**归一化后的 URL**，不是字面前缀（0903 返工批 B1）。原先只认「`img[src]` 且字面
//    以 http:// / https:// / // 开头」，下面这些写法实测全都穿过 DOMPurify 并真的发出 GET：
//      <img srcset>            <source srcset>          <video poster>
//      <td background>         style="background-image:url(…)"      <style>…url(…)…</style>
//      <img src="http:/host/…">（单斜杠；打包态 base 是 file://，浏览器归一成双斜杠）
//    只补其中一两个是打地鼠 —— 一律 `new URL(value, base)` 归一后判 scheme / origin。
//
// 🔴 **减面优先，覆盖其次**（0903 返工批三）。「枚举哪些属性可能带远程 URL」这个判据形态被
//    三轮复核各绕过一次，所以先删能力再谈覆盖：
//      - `<video>` / `<audio>` / `<track>` 已在 `EMAIL_PURIFY_OPTS` 里 FORBID（连子树一起删），
//        本模块只补一条：独立的 `<source src>` 无条件摘掉（媒体元素已不存在，`<picture>` 里的
//        source 用 srcset，src 本就被浏览器忽略 ⇒ 摘掉零损失）。
//      - CSS 的 `@import` at-rule **整条删除**：把 URL 位置替换成 `none` 会造出 `@import none;`，
//        Chromium 当它是相对 URL 真去取 —— 改写动作自己制造了一条请求。
//    剩下必须覆盖的（`url()` / `image-set()` 裸字符串 / srcset / 代理身份）判据在下面，配套的
//    「输出里不存在任何绝对 http(s) URL」缺席断言在 tests/shared/emailRemoteVectors.test.ts ——
//    新向量漏了那张表自动红，不需要有人预先想到它。
//
// 🔴 指向**我们自己那台代理**的 URL 一律算远程（哪怕 host 是 127.0.0.1 / 同源）：renderer 的
//    CSP 放行了 `http://127.0.0.1:*`，主进程又对该端口的所有请求无条件注入本地 token
//    ⇒ 正文里硬编码一条代理 URL 就是零点击出网。判据在这里挡第一道，后端的签名闸
//    （`src/api/routers/email_remote_image.py`，正文伪造不出签名）挡第二道 —— **结构性的那道
//    是后端**，这里只保证提示条数得对、默认不发请求。
//
// 🔴 `cid:` 内联图片、`attachments/{id}/{file}` 相对路径、`data:` URI 行为逐字不变：
//    scheme 不是 http(s) 的一律不碰；归一后落在页面自身 origin 的（远程 web 构建下的
//    `attachments/…`）也不碰。

/** 被拦下的原始远程 URL 存这里（inert 属性，只为可诊断；浏览器不会用它加载）。 */
export const REMOTE_SRC_ATTR = 'data-mailagent-remote-src'

/** 占位样式钩子；对应规则在 EmailBodyFrame 的 BODY_CSS。 */
export const REMOTE_PLACEHOLDER_CLASS = 'mailagent-remote-image'

/** 尺寸推不出来时的占位边长 —— 只要"这里本来有张图"看得出来，不必抢眼。 */
const PLACEHOLDER_FALLBACK_PX = 28

/** 超过这个值的声明尺寸按坏值处理（`width="99999"` 之类），回落固定占位。 */
const MAX_DERIVED_PX = 5000

/** CSS 里的 `url(...)`（可带单/双引号）。用于 inline style 与 <style> 块。 */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi

/**
 * `@import` at-rule 的整条形态（`@import <url> <media>? ;`，url 可以是 `url()` 也可以是裸字符串）。
 * 到 `;` 为止；碰到 `{` 就停，把后面的普通规则留给 url() 那趟处理（少删比多删安全，且那些
 * 规则里的 url() 仍会被拦）。
 */
const CSS_IMPORT_RE = /@import\b[^;{]*(?:;|$)/gi

/** `image-set()` / `-webkit-image-set()` 的函数头 —— 括号里的**裸字符串**候选也是图片 URL。 */
const CSS_IMAGE_SET_RE = /(?:-webkit-)?image-set\(/gi

/** CSS 里的引号字符串（image-set 的裸字符串候选）。 */
const CSS_STRING_RE = /(['"])([^'"]*)\1/g

export interface RemoteImageOptions {
  /** true = 用户已对这封邮件的这次查看点过「加载图片」，且签名已换到手。 */
  allow: boolean
  /**
   * 归一化基准 = 承载 srcdoc 的那份文档的 base URL（srcdoc 文档继承父文档 base）。
   * 调用方传 `document.baseURI`。打包态是 `file://…`、dev 是 `http://localhost:5173/`、
   * 远程 web 是 `https://…/app/` —— 三者对「相对路径算不算远程」的答案不同，所以不能
   * 在本模块里猜。
   */
  baseUrl: string
  /** 代理端点地址，形如 `http://127.0.0.1:8200/api/email/remote-image` 或同源 `/api/…`。 */
  proxyBase: string
  /**
   * `allow=true` 时按**归一化后的 URL** 查后端签发的放行票（值 = 拼好的 query string，
   * 含 url/exp/sig）。查不到 = 这条没换到票 ⇒ 仍按拦截处理（fail-closed）。
   */
  grants?: ReadonlyMap<string, string>
  /** 占位框的 aria-label（i18n 文案由调用方给）。 */
  placeholderLabel: string
}

export interface RemoteImageResult {
  html: string
  /** 这封邮件里被拦下 / 放行的远程图片条数（按元素计；`<picture>` 整组算一条）。 */
  remoteCount: number
  /** 扫到的全部远程 URL（归一化 + 去重）= 用户点「加载图片」时要拿去换签名的清单。 */
  remoteUrls: string[]
}

interface Ctx {
  allow: boolean
  base: string
  /** 页面自身 origin：归一后同源的相对路径是本地资源，不算远程。`file://` 无可比 origin ⇒ null。 */
  localOrigin: string | null
  proxyBase: string
  /** 代理端点的 origin；`null` = proxyBase 解析不出来（判据退化成「同源即本地」）。 */
  proxyOrigin: string | null
  /** 代理端点归一化后的路径前缀（见 `normalizePathname`）。 */
  proxyPath: string | null
  grants: ReadonlyMap<string, string> | null
}

/**
 * 路径归一：解百分号编码 + 去尾斜杠 + 小写。
 * 🔴 字面比较不够（0903 返工批三 blocker #4）：`/api/email/%72emote-image?url=…`（真 app 实测
 * 403 ⇒ 已经进到 handler 了）与 `/api/email/remote-image/?url=…`（实测 307 跟随）都会打到同一个
 * 端点，字面判等却把它们当成同源本地资源放行，`remoteCount` 恒 0 ⇒ 提示条根本不出现。
 * 多层编码（`%2572`）逐层解到不动为止，上限 3 轮防病态输入。
 */
function normalizePathname(pathname: string): string {
  let decoded = pathname
  for (let i = 0; i < 3; i += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break
    }
    if (next === decoded) break
    decoded = next
  }
  return decoded.replace(/\/+$/, '').toLowerCase()
}

function makeCtx(opts: RemoteImageOptions): Ctx {
  let localOrigin: string | null = null
  try {
    const o = new URL(opts.baseUrl).origin
    // `file://` 的 origin 是字符串 'null'，跟任何东西都不该判等。
    localOrigin = o === 'null' ? null : o
  } catch {
    localOrigin = null
  }
  let proxyOrigin: string | null = null
  let proxyPath: string | null = null
  try {
    const p = new URL(opts.proxyBase, opts.baseUrl)
    proxyOrigin = p.origin === 'null' ? null : p.origin
    proxyPath = normalizePathname(p.pathname)
  } catch {
    proxyOrigin = null
    proxyPath = null
  }
  return {
    allow: opts.allow,
    base: opts.baseUrl,
    localOrigin,
    proxyBase: opts.proxyBase,
    proxyOrigin,
    proxyPath,
    grants: opts.grants ?? null
  }
}

/**
 * 这条 URL 是不是指向我们自己那台代理。
 * 判据是「同源 **且** 归一后的路径落在代理路径下」，不是字面相等 —— 宁可把真代理 URL 也当远程
 * 重新签一次（幂等、无害），也不能漏判（漏判 = 零点击出网，见模块头注释）。
 */
function isProxyRef(u: URL, ctx: Ctx): boolean {
  if (ctx.proxyOrigin === null || ctx.proxyPath === null) return false
  if (u.origin !== ctx.proxyOrigin) return false
  const path = normalizePathname(u.pathname)
  return path === ctx.proxyPath || path.startsWith(`${ctx.proxyPath}/`)
}

/** 归一化一个 URL 值：是远程图片引用则返回绝对 URL，否则 null（= 不碰）。 */
function normalizeRemote(raw: string, ctx: Ctx): string | null {
  const v = raw.trim()
  if (v.length === 0) return null
  let u: URL
  try {
    // 协议相对 `//host/x` 单独处理：交给 `new URL(v, base)` 的话，打包态 base 是 `file://`，
    // 它会归成 `file://host/x`（scheme 不是 http(s) ⇒ 漏判），而 CSP 的 img-src 放行了
    // `file:`。按 https 补齐既与 web/dev 下浏览器的行为一致，也是三种构建里最安全的一种。
    // 反斜杠 `\\host/x` 同理：WHATWG URL 对 special scheme 把 `\` 当 `/`，所以浏览器眼里它
    // 与 `//host/x` 是同一个地址，判据也必须一起归。
    u = /^[/\\]{2}/.test(v) ? new URL(`https:${v}`) : new URL(v, ctx.base)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // 顺序要紧：远程 web 构建下代理就在同源，必须先认出代理再谈同源放行。
  if (isProxyRef(u, ctx)) return u.href
  if (ctx.localOrigin !== null && u.origin === ctx.localOrigin) return null
  return u.href
}

/** 放行模式下这条 URL 该改写成什么；拿不到放行票返回 null（调用方按拦截处理）。 */
function proxySrc(abs: string, ctx: Ctx): string | null {
  if (!ctx.allow) return null
  const grant = ctx.grants?.get(abs)
  return grant === undefined ? null : `${ctx.proxyBase}?${grant}`
}

/** 从 width/height 属性或 inline style 推一个能当占位尺寸用的 CSS 长度；推不出返回 null。 */
function deriveLength(img: HTMLImageElement, axis: 'width' | 'height'): string | null {
  const candidates = [img.getAttribute(axis), img.style.getPropertyValue(axis)]
  for (const raw of candidates) {
    if (raw == null) continue
    const v = raw.trim().toLowerCase()
    if (v.length === 0) continue
    // 宽度收百分比（`width="100%"` 的通栏图占满一行仍然是对的）；高度不收 —— 父容器高度
    // 是 auto，百分比高度会算成 0，占位当场塌掉，正是这里要避免的。
    if (axis === 'width' && /^\d+(?:\.\d+)?%$/.test(v)) return v
    if (!v.endsWith('px') && !/^\d+(?:\.\d+)?$/.test(v)) continue
    const n = Number.parseFloat(v)
    if (!Number.isFinite(n) || n <= 0 || n > MAX_DERIVED_PX) continue
    return `${n}px`
  }
  return null
}

/** 把 `<img>` 改成占位框（原 URL 只留在 inert 的 data 属性里）。 */
function toPlaceholder(img: HTMLImageElement, rawSrc: string, label: string): void {
  img.setAttribute(REMOTE_SRC_ATTR, rawSrc)
  // 「src 置空」= **移除属性**：`src=""` 会被解析成文档自身 URL 并真发一次请求，
  // 不是「什么都不加载」。
  img.removeAttribute('src')
  img.classList.add(REMOTE_PLACEHOLDER_CLASS)
  img.setAttribute('aria-label', label)
  img.style.setProperty(
    '--ma-remote-w',
    deriveLength(img, 'width') ?? `${PLACEHOLDER_FALLBACK_PX}px`
  )
  img.style.setProperty(
    '--ma-remote-h',
    deriveLength(img, 'height') ?? `${PLACEHOLDER_FALLBACK_PX}px`
  )
}

type Note = (el: Element, abs: string) => void

interface SrcsetCandidate {
  url: string
  descriptor: string
}

const SRCSET_WS_RE = /[\t\n\f\r ]/

/**
 * 按 HTML 规范（"parse a srcset attribute"）拆 `srcset`。
 * 🔴 不能按逗号裸切（0903 返工批三 blocker #3）：规范里 **URL 取到第一个空白为止**，逗号可以出现
 * 在 URL 内部（Cloudinary 这类 `.../w_100,h_100/a.png` 变换参数就是），只有结尾的逗号才是分隔符。
 * 裸切的后果是双向的：拦截态把一条 URL 切成两半、后半段变成一条**凭空造出来的相对请求**；放行态
 * 图永远显示不出来，而后端还为一个不存在的 URL 签了票。
 */
function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = []
  let i = 0
  while (i < value.length) {
    // 前导空白与逗号一并跳过（规范的 "splitting loop"）。
    while (i < value.length && (SRCSET_WS_RE.test(value[i]) || value[i] === ',')) i += 1
    if (i >= value.length) break
    const urlStart = i
    while (i < value.length && !SRCSET_WS_RE.test(value[i])) i += 1
    const url = value.slice(urlStart, i)
    const stripped = url.replace(/,+$/, '')
    if (stripped.length !== url.length) {
      // URL 以逗号结尾 ⇒ 这条候选没有描述符，逗号本身是分隔符。
      out.push({ url: stripped, descriptor: '' })
      continue
    }
    while (i < value.length && SRCSET_WS_RE.test(value[i])) i += 1
    const descStart = i
    let depth = 0
    while (i < value.length) {
      const c = value[i]
      if (c === '(') depth += 1
      else if (c === ')') {
        if (depth > 0) depth -= 1
      } else if (c === ',' && depth === 0) break
      i += 1
    }
    out.push({ url, descriptor: value.slice(descStart, i).trim() })
    i += 1 // 吃掉分隔逗号（越界无害，循环条件会退出）
  }
  return out
}

/**
 * `srcset` 候选表（`url 描述符, url 描述符`）逐条处理。
 * 🔴 必须独立于 `src` 的判据跑：一个 `src="cid:…"` 配 `srcset="https://…"` 的 `<img>`，
 * 浏览器会优先用 srcset —— 把 srcset 的清理挂在「src 是远程」的分支里等于没清理。
 */
function rewriteSrcset(el: Element, ctx: Ctx, note: Note): void {
  const raw = el.getAttribute('srcset')
  if (raw === null) return
  const kept: string[] = []
  let touched = false
  for (const { url, descriptor } of parseSrcset(raw)) {
    const abs = normalizeRemote(url, ctx)
    if (abs === null) {
      kept.push(descriptor.length > 0 ? `${url} ${descriptor}` : url)
      continue
    }
    touched = true
    note(el, abs)
    const proxied = proxySrc(abs, ctx)
    // 拿不到放行票（默认拦截，或这条没换到）→ 丢掉该候选。
    if (proxied !== null) kept.push(descriptor.length > 0 ? `${proxied} ${descriptor}` : proxied)
  }
  if (!touched) return
  if (kept.length === 0) el.removeAttribute('srcset')
  else el.setAttribute('srcset', kept.join(', '))
}

/** 单值 URL 属性（`poster` / `background`）：放行改写、拦截摘掉。 */
function rewriteUrlAttr(el: Element, attr: string, ctx: Ctx, note: Note): void {
  const raw = el.getAttribute(attr)
  if (raw === null) return
  const abs = normalizeRemote(raw, ctx)
  if (abs === null) return
  note(el, abs)
  const proxied = proxySrc(abs, ctx)
  if (proxied !== null) el.setAttribute(attr, proxied)
  else el.removeAttribute(attr)
}

/** 从 `openIdx` 处的 `(` 找配对的 `)`（跳过字符串里的括号）；找不到返回 -1。 */
function matchingParen(text: string, openIdx: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i]
    if (quote !== null) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * `image-set()` / `-webkit-image-set()` 里的**裸字符串**候选。
 * 🔴 blocker #1：`image-set('URL' 1x)` 的 URL 不写在 `url()` 里，只认 `url(...)` 的判据一条都
 * 匹配不到 ⇒ `remoteCount` 恒 0、提示条不出现，而桌面态实测真发出了 GET。
 * 括号里 `url(...)` 形态的候选**跳过**，留给后面那趟统一处理（避免同一条 URL 被包两次）。
 */
function rewriteImageSets(
  css: string,
  el: Element,
  ctx: Ctx,
  note: Note,
  onTouch: () => void
): string {
  CSS_IMAGE_SET_RE.lastIndex = 0
  let out = ''
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = CSS_IMAGE_SET_RE.exec(css)) !== null) {
    const open = m.index + m[0].length - 1
    const close = matchingParen(css, open)
    if (close === -1) break
    const inner = css.slice(open + 1, close)
    const rewritten = inner.replace(
      CSS_STRING_RE,
      (whole, _quote: string, rawUrl: string, offset: number) => {
        if (/url\(\s*$/i.test(inner.slice(0, offset))) return whole
        const abs = normalizeRemote(rawUrl, ctx)
        if (abs === null) return whole
        onTouch()
        note(el, abs)
        const proxied = proxySrc(abs, ctx)
        // 拦截：`image-set(none 1x)` 不是合法候选 ⇒ 整条声明被 CSS 解析器丢掉，不发请求。
        return proxied === null ? 'none' : `"${proxied}"`
      }
    )
    out += css.slice(cursor, open + 1) + rewritten
    cursor = close
    CSS_IMAGE_SET_RE.lastIndex = close
  }
  return out + css.slice(cursor)
}

/**
 * CSS 文本里的远程引用。三趟：
 *   ① `@import` at-rule **整条删除**。🔴 blocker #6：以前把 URL 位置换成字面量 `none`，用在
 *      `@import` 上就成了 `@import none;` —— Chromium 当 `none` 是相对 URL **真去取**
 *      `<base>/none`，改写动作自己制造了一条正文可诱发的请求。邮件里 `@import` 没有任何客户端
 *      可靠支持，删掉零损失（这也是「减面优先」：不去覆盖它，直接把这条路拆了）。
 *   ② `image-set()` 的裸字符串候选（见 `rewriteImageSets`）。
 *   ③ `url(...)`。拦截时替换成 `none` 而不是删声明：`background-image:none` 合法，而
 *      `cursor:none, auto` 这类不合法的会被 CSS 解析器整条丢掉 —— 两种结局都是「不发请求」。
 * 返回改写后的文本；没有动过时返回 null（调用方据此决定动不动这个节点）。
 */
function rewriteCssText(css: string, el: Element, ctx: Ctx, note: Note): string | null {
  let touched = false
  const onTouch = (): void => {
    touched = true
  }
  let next = css.replace(CSS_IMPORT_RE, () => {
    touched = true
    return ''
  })
  next = rewriteImageSets(next, el, ctx, note, onTouch)
  next = next.replace(CSS_URL_RE, (whole, _quote: string, rawUrl: string) => {
    const abs = normalizeRemote(rawUrl, ctx)
    if (abs === null) return whole
    touched = true
    note(el, abs)
    const proxied = proxySrc(abs, ctx)
    // 代理 URL 经 encodeURIComponent，不含引号，`url("…")` 拼接安全。
    return proxied === null ? 'none' : `url("${proxied}")`
  })
  return touched ? next : null
}

/**
 * 改写正文里的远程图片。`allow=false`（默认）摘掉引用换占位；`allow=true` 把引用改写成
 * 走本机代理（带后端签发的放行票）。两种模式都从**原始 HTML** 单趟算出来，不需要先拦再还原。
 */
export function rewriteRemoteImages(html: string, opts: RemoteImageOptions): RemoteImageResult {
  if (html.length === 0) return { html, remoteCount: 0, remoteUrls: [] }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return { html, remoteCount: 0, remoteUrls: [] }
  }
  const body = doc.body
  if (!body) return { html, remoteCount: 0, remoteUrls: [] }

  const ctx = makeCtx(opts)
  // 计数按「视觉上的一张图」：`<picture>` 里的多条 <source> + 回落 <img> 是同一张，
  // 归到 picture 元素这一个键上；其余元素各算一条。
  const counted = new Set<Element>()
  const urls: string[] = []
  const seenUrls = new Set<string>()
  const note: Note = (el, abs) => {
    counted.add(el.closest('picture') ?? el)
    if (!seenUrls.has(abs)) {
      seenUrls.add(abs)
      urls.push(abs)
    }
  }

  // 减面：`<source src>` 无条件摘掉（不判远程、不计数）。它只对 `<video>`/`<audio>` 有意义，
  // 而那两个标签已在 EMAIL_PURIFY_OPTS 里 FORBID；`<picture>` 里的 source 用 srcset，src 会被
  // 浏览器忽略 ⇒ 摘掉零损失，也省掉「这条 src 算不算远程」这一整类判据。
  body.querySelectorAll('source[src]').forEach((el) => el.removeAttribute('src'))

  // srcset 先走一遍（<img> 自己的 + <picture><source> 的），与 src 的判据互不依赖。
  body.querySelectorAll('img[srcset], source[srcset]').forEach((el) => rewriteSrcset(el, ctx, note))

  body.querySelectorAll('img').forEach((node) => {
    const img = node as HTMLImageElement
    const raw = img.getAttribute('src') ?? ''
    const abs = normalizeRemote(raw, ctx)
    if (abs === null) return
    note(img, abs)
    const proxied = proxySrc(abs, ctx)
    if (proxied !== null) img.setAttribute('src', proxied)
    else toPlaceholder(img, raw, opts.placeholderLabel)
  })

  // 任意元素的 `background` 属性（Outlook 模板的 `<td background>` 常见）。
  // `[poster]` 只有 `<video>` 用，而 `<video>` 已经被消毒那层删掉了 —— 这一行留着是 defense in
  // depth（消毒配置一旦回退，改写层仍然不放行），不是「video 还活着」。
  body.querySelectorAll('[poster]').forEach((el) => rewriteUrlAttr(el, 'poster', ctx, note))
  body.querySelectorAll('[background]').forEach((el) => rewriteUrlAttr(el, 'background', ctx, note))

  // inline style 与 <style> 块里的 `url(...)`（background-image / list-style-image / …）。
  // 放在 <img> 之后：占位尺寸推导要读原始 inline width/height，别被这一步动过的文本影响。
  body.querySelectorAll('[style]').forEach((el) => {
    const next = rewriteCssText(el.getAttribute('style') ?? '', el, ctx, note)
    if (next !== null) el.setAttribute('style', next)
  })
  body.querySelectorAll('style').forEach((el) => {
    const next = rewriteCssText(el.textContent ?? '', el, ctx, note)
    if (next !== null) el.textContent = next
  })

  return { html: body.innerHTML, remoteCount: counted.size, remoteUrls: urls }
}
