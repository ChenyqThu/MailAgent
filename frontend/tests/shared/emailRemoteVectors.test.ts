// @vitest-environment happy-dom
//
// 邮件正文远程图片 —— **向量表 + 缺席断言**（0903 返工批三 R4）。
//
// 🔴 为什么另起一张表，而不是继续往 emailRemoteImages.test.ts 里加用例：
// 那份文件的判据形态是**逐属性的存在性断言**（「srcset 被摘掉了」「poster 被摘掉了」），
// 只能证明**已知**向量被处理 —— 新写法一律照过。三轮复核换了三种 markup 就绕过三次
// （第二轮找出 5 个向量，修完第三轮又找出 6 个），继续打地鼠不会收敛。
//
// 这里的判据是 default-deny 的：
//   ① `allow=false` 时，输出里**不存在任何绝对 http(s) URL** —— 扫描全部元素的全部属性值
//      （内联 `style` 也是属性值）**加** `<style>` 文本，而不是只看某几个属性名。
//      ⇒ **新向量只要漏了这条自动红**，不需要有人预先想到它。
//   ② 有远程引用就必须计数（`remoteCount >= 1`），否则提示条不出现 = 用户没有放行入口。
//   ③ `allow=true` 时这些位置全部变成带签名的代理引用：既没有残留的原始 URL，也没有被摘成空。
//
// 表里每条向量声明自己走哪条腿：
//   - `proxy`：能力保留，走「拦截 → 用户同意 → 代理」三段（①②③ 全查）。
//   - `drop`：能力**整个删掉**（减面优先，见 emailSanitize.ts / emailRemoteImages.ts 头注释）。
//     两种模式下都不该有任何绝对 URL，也没有东西可计数 ⇒ 查 ① + `remoteCount === 0`。
//
// 走的是**生产同款两段管线**：`sanitizeEmailHtml`（DOMPurify，减面那一半在这里）
// → `rewriteRemoteImages`（判据那一半在这里）。只测后者会漏掉 FORBID_TAGS 的贡献。

import { describe, expect, it } from 'vitest'

import { REMOTE_SRC_ATTR, rewriteRemoteImages } from '@shared/lib/emailRemoteImages'
import { sanitizeEmailHtml } from '@shared/lib/emailSanitize'

/** 打包态：renderer 从 file:// 加载，代理在 127.0.0.1 —— 任何 http(s) 都是远程。 */
const BASE = 'file:///Applications/MailAgent.app/Contents/Resources/index.html'
const PROXY = 'http://127.0.0.1:8200/api/email/remote-image'
/** 远程 web 构建：代理与正文**同源**，「指向自家代理」的判据在这里才有戏。 */
const WEB_BASE = 'https://mail.chenge.ink/app/'
const WEB_PROXY = '/api/email/remote-image'
const LABEL = '已拦截的远程图片'

// ── 缺席扫描器 ──────────────────────────────────────────────────────────

/** 绝对 http(s) URL。终止在空白与 HTML/CSS 的定界符上。 */
const ABSOLUTE_URL_RE = /https?:\/\/[^\s'"(){}<>\\]+/gi

/**
 * 协议相对写法 `//host/x`，以及 WHATWG URL 眼里与它等价的反斜杠写法 `\\host/x`。
 * 它们不是字面上的绝对 URL，但浏览器解析后就是 —— 留一条在输出里同样是真出网，所以与绝对
 * URL 同罪。扫描时先把绝对 URL 抠掉，`https://` 自带的双斜杠才不会被重复计一次。
 */
const SCHEME_RELATIVE_RE = /[/\\]{2}[a-z0-9][^\s'"(){}<>]*/gi

/**
 * 输出里所有可能承载加载源的文本：**每个元素的每个属性值** + 每个 `<style>` 的文本。
 * 刻意不按属性名过滤 —— 一按名字过滤就退回「枚举已知向量」，正是本轮要换掉的判据形态。
 */
function scanCorpus(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: string[] = []
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      // 唯一的例外：`data-mailagent-remote-src` 是被拦下的原始 URL 的**惰性**存档（占位框的
      // 可诊断信息），不是任何元素的加载源，浏览器永远不会去取它。下面「白名单与惰性存档」
      // 一组钉住它确实只出现在占位 <img> 上、且逐字等于原始 URL。
      if (attr.name === REMOTE_SRC_ATTR) continue
      out.push(attr.value)
    }
  })
  doc.body.querySelectorAll('style').forEach((el) => out.push(el.textContent ?? ''))
  return out
}

function absoluteUrls(html: string): string[] {
  const found: string[] = []
  for (const text of scanCorpus(html)) {
    found.push(...(text.match(ABSOLUTE_URL_RE) ?? []))
    found.push(...(text.replace(ABSOLUTE_URL_RE, ' ').match(SCHEME_RELATIVE_RE) ?? []))
  }
  return found
}

/** 输出里出现了几条走代理的引用（代理 base 在 web 构建下是相对路径，不能靠绝对 URL 数）。 */
function proxyRefCount(html: string, proxyBase: string): number {
  const needle = `${proxyBase}?url=`
  return scanCorpus(html).reduce((n, text) => n + (text.split(needle).length - 1), 0)
}

// ── 生产同款两段管线 ────────────────────────────────────────────────────

interface RunOpts {
  base: string
  proxyBase: string
}

function grantFor(url: string): string {
  return `url=${encodeURIComponent(url)}&exp=4102444800&sig=deadbeef`
}

function block(html: string, { base, proxyBase }: RunOpts) {
  return rewriteRemoteImages(sanitizeEmailHtml(html), {
    allow: false,
    baseUrl: base,
    proxyBase,
    placeholderLabel: LABEL
  })
}

/** 放行 = 先扫一遍拿 URL 清单 → 换签名 → 带票重写，与 EmailBodyFrame 的真实两趟一致。 */
function allow(html: string, opts: RunOpts) {
  const scan = block(html, opts)
  return rewriteRemoteImages(sanitizeEmailHtml(html), {
    allow: true,
    baseUrl: opts.base,
    proxyBase: opts.proxyBase,
    grants: new Map(scan.remoteUrls.map((u) => [u, grantFor(u)])),
    placeholderLabel: LABEL
  })
}

// ── 向量表 ──────────────────────────────────────────────────────────────

interface Vector {
  name: string
  html: string
  /** `proxy` = 保留能力走放行腿；`drop` = 能力整个删掉。 */
  lane: 'proxy' | 'drop'
  /** proxy 腿：放行后应当出现几条代理引用（= 本来有几个位置引用远程资源）。 */
  slots?: number
  base?: string
  proxyBase?: string
}

const T = 'https://tracker.example'

const VECTORS: Vector[] = [
  // ── 保留能力、走放行腿 ────────────────────────────────────────────────
  { name: 'img[src]', html: `<img src="${T}/1.png">`, lane: 'proxy', slots: 1 },
  {
    name: 'img[srcset] 多候选（src 是 cid 也必须清）',
    html: `<img src="cid:a@b" srcset="${T}/1.png 1x, ${T}/2.png 2x">`,
    lane: 'proxy',
    slots: 2
  },
  {
    // blocker #3：按逗号裸切会把这条 URL 切成两半 —— 拦截态凭空造出一条相对请求，
    // 放行态图永远显示不出来且后端为不存在的 URL 签了票。
    name: 'img[srcset] URL 内部含逗号的 CDN 变换参数',
    html: `<img srcset="https://res.cloudinary.com/demo/image/upload/w_100,h_100/a.png 2x">`,
    lane: 'proxy',
    slots: 1
  },
  {
    // 规范：URL 取到第一个空白为止 ⇒ 中间没有空白的这一串**整体是一条 URL**。
    // 按逗号裸切会切成两条，后半段变成一条凭空造出来的相对请求。
    name: 'img[srcset] 两个 URL 之间没有空白（整串是一条 URL）',
    html: `<img srcset="${T}/1.png,${T}/2.png 2x">`,
    lane: 'proxy',
    slots: 1
  },
  {
    // 规范：只有**结尾**的逗号才是分隔符，剥掉后这条候选没有描述符。
    name: 'img[srcset] 候选 URL 以逗号结尾 + 整串以逗号收尾',
    html: `<img srcset="${T}/1.png, ${T}/2.png 2x,">`,
    lane: 'proxy',
    slots: 2
  },
  {
    name: 'picture>source[srcset]',
    html: `<picture><source srcset="${T}/w.webp"><img src="cid:x@y"></picture>`,
    lane: 'proxy',
    slots: 1
  },
  {
    name: 'td[background]',
    html: `<table><tr><td background="${T}/b.png">x</td></tr></table>`,
    lane: 'proxy',
    slots: 1
  },
  {
    name: '内联 style 的 background-image:url()',
    html: `<div style="background-image:url(${T}/c.png);color:red">x</div>`,
    lane: 'proxy',
    slots: 1
  },
  {
    // blocker #1：裸字符串候选不写在 url() 里，只认 url(...) 的判据一条都匹配不到。
    name: '内联 style 的 image-set() 裸字符串',
    html: `<div style="background-image:image-set('${T}/1x.png' 1x, '${T}/2x.png' 2x)">x</div>`,
    lane: 'proxy',
    slots: 2
  },
  {
    name: '内联 style 的 -webkit-image-set()（大小写变体 + 内嵌空白）',
    html: `<div style="background:-WEBKIT-IMAGE-SET(  \n  '${T}/1x.png'  1x )">x</div>`,
    lane: 'proxy',
    slots: 1
  },
  {
    name: 'image-set() 里混用 url() 与裸字符串',
    html: `<div style="background:image-set(url('${T}/a.png') 1x, '${T}/b.png' 2x)">x</div>`,
    lane: 'proxy',
    slots: 2
  },
  {
    name: '<style> 块里的 url()',
    html: `<p>x</p><style>.hero{background-image:url(${T}/h.png)}</style>`,
    lane: 'proxy',
    slots: 1
  },
  {
    name: '<style> 块里的 image-set() 裸字符串',
    html: `<style>.hero{background-image:image-set("${T}/h.png" 1x)}</style>`,
    lane: 'proxy',
    slots: 1
  },
  {
    name: '<style> 块里的 @font-face src:url()',
    html: `<style>@font-face{font-family:x;src:url(${T}/f.woff2)}</style>`,
    lane: 'proxy',
    slots: 1
  },
  {
    // 打包态 base 是 file://，浏览器会把单斜杠归一成双斜杠再取。
    name: '单斜杠 http:/host',
    html: '<img src="http:/tracker.example/p.png">',
    lane: 'proxy',
    slots: 1
  },
  {
    // 打包态 base 是 file://，交给 new URL(v, base) 会归成 file://host/x（scheme 不是 http(s)
    // ⇒ 漏判），而 CSP 的 img-src 放行 file:。判据按 https 补齐。
    name: '协议相对 //host',
    html: '<img src="//tracker.example/p.png">',
    lane: 'proxy',
    slots: 1
  },
  {
    // WHATWG URL 对 special scheme 把 `\` 当 `/` ⇒ 与 //host/x 是同一个地址。
    name: '反斜杠 \\\\host（协议相对的反斜杠写法）',
    html: '<img src="\\\\tracker.example/p.png">',
    lane: 'proxy',
    slots: 1
  },
  {
    name: '大小写变体 HTTPS://HOST',
    html: '<img src="HTTPS://TRACKER.example/P.PNG">',
    lane: 'proxy',
    slots: 1
  },
  {
    name: '属性值内嵌前后空白',
    html: `<img src="  ${T}/1.png  ">`,
    lane: 'proxy',
    slots: 1
  },
  {
    name: 'url( 带引号与空白 )',
    html: `<div style="background-image:url( '${T}/c.png' )">x</div>`,
    lane: 'proxy',
    slots: 1
  },
  {
    // blocker #4：真 app 实测 403（= 已经进到 handler 了），字面判等却把它当同源本地资源放行。
    name: '代理路径的百分号编码变体 %72emote-image（web 同源）',
    html: `<img src="/api/email/%72emote-image?url=${T}/p.png">`,
    lane: 'proxy',
    slots: 1,
    base: WEB_BASE,
    proxyBase: WEB_PROXY
  },
  {
    // blocker #4：实测 307 跟随到同一个端点。
    name: '代理路径的尾斜杠变体（web 同源）',
    html: `<img src="/api/email/remote-image/?url=${T}/p.png">`,
    lane: 'proxy',
    slots: 1,
    base: WEB_BASE,
    proxyBase: WEB_PROXY
  },
  {
    name: '代理路径的大小写 + 相对段变体（web 同源）',
    html: `<img src="/api/email/./Remote-Image?url=${T}/p.png">`,
    lane: 'proxy',
    slots: 1,
    base: WEB_BASE,
    proxyBase: WEB_PROXY
  },

  // ── 能力整个删掉（减面优先）────────────────────────────────────────────
  { name: 'video[src]', html: `<video src="${T}/v.mp4"></video>`, lane: 'drop' },
  { name: 'video[poster]', html: `<video poster="${T}/p.jpg"></video>`, lane: 'drop' },
  { name: 'audio[src]', html: `<audio src="${T}/a.mp3"></audio>`, lane: 'drop' },
  {
    name: 'video > source[src] + track[src]',
    html: `<video><source src="${T}/v.mp4"><track src="${T}/t.vtt"></video>`,
    lane: 'drop'
  },
  {
    name: '独立的 source[src]（媒体元素被删后留下的裸壳）',
    html: `<source src="${T}/v.mp4">`,
    lane: 'drop'
  },
  { name: '独立的 track[src]', html: `<track src="${T}/t.vtt">`, lane: 'drop' },
  {
    // <body> 的属性在 fragment 消毒里活不下来（srcDoc 的 body 是我们自己拼的）。
    name: 'body[background]',
    html: `<body background="${T}/b.png">x</body>`,
    lane: 'drop'
  },
  {
    // blocker #6：以前把 URL 位置换成 none ⇒ `@import none;`，Chromium 真去取 <base>/none。
    name: '<style> 的 @import 裸字符串',
    html: `<style>@import "${T}/i.css"; .x{color:red}</style>`,
    lane: 'drop'
  },
  {
    name: '<style> 的 @import url()',
    html: `<style>@import url("${T}/i.css") screen;</style>`,
    lane: 'drop'
  },
  {
    name: '<style> 的 @IMPORT（大写 + 无结尾分号）',
    html: `<style>@IMPORT '${T}/i.css'</style>`,
    lane: 'drop'
  },
  { name: 'link[rel=stylesheet]', html: `<link rel="stylesheet" href="${T}/s.css">`, lane: 'drop' },
  { name: 'base[href]', html: `<base href="${T}/">`, lane: 'drop' },
  {
    name: 'meta[http-equiv=refresh]',
    html: `<meta http-equiv="refresh" content="0;url=${T}/">`,
    lane: 'drop'
  },
  { name: 'object[data]', html: `<object data="${T}/o.swf"></object>`, lane: 'drop' },
  { name: 'embed[src]', html: `<embed src="${T}/e.swf">`, lane: 'drop' },
  { name: 'iframe[src]', html: `<iframe src="${T}/i.html"></iframe>`, lane: 'drop' },
  {
    name: 'input[type=image][src]',
    html: `<input type="image" src="${T}/i.png">`,
    lane: 'drop'
  },
  { name: 'svg image[href]', html: `<svg><image href="${T}/s.png"/></svg>`, lane: 'drop' },
  { name: 'svg use[href]', html: `<svg><use href="${T}/s.svg#i"/></svg>`, lane: 'drop' },
  {
    name: 'svg feImage[href]',
    html: `<svg><filter><feImage href="${T}/f.png"/></filter></svg>`,
    lane: 'drop'
  }
]

function optsOf(v: Vector): RunOpts {
  return { base: v.base ?? BASE, proxyBase: v.proxyBase ?? PROXY }
}

describe('远程图片向量表 — ① allow=false 时输出里不存在任何绝对 http(s) URL', () => {
  it.each(VECTORS)('$name', (v) => {
    const out = block(v.html, optsOf(v))
    expect(absoluteUrls(out.html)).toEqual([])
  })
})

describe('远程图片向量表 — ② 有远程引用就必须计数（否则提示条不出现）', () => {
  it.each(VECTORS.filter((v) => v.lane === 'proxy'))('$name', (v) => {
    const out = block(v.html, optsOf(v))
    expect(out.remoteCount).toBeGreaterThanOrEqual(1)
    expect(out.remoteUrls.length).toBeGreaterThanOrEqual(1)
  })

  it.each(VECTORS.filter((v) => v.lane === 'drop'))('$name（已删除 ⇒ 无可计数）', (v) => {
    const out = block(v.html, optsOf(v))
    expect(out.remoteCount).toBe(0)
    expect(out.remoteUrls).toEqual([])
  })
})

describe('远程图片向量表 — ③ allow=true 时全部变成带签名的代理引用', () => {
  it.each(VECTORS.filter((v) => v.lane === 'proxy'))('$name', (v) => {
    const opts = optsOf(v)
    const out = allow(v.html, opts)
    // 没有一个被摘成空：本来有几个位置引用远程资源，放行后就有几条代理引用。
    expect(proxyRefCount(out.html, opts.proxyBase)).toBe(v.slots)
    // 没有一条残留的原始 URL：输出里剩下的绝对 URL 只可能是代理自己（相对代理 base 下一条都没有）。
    for (const u of absoluteUrls(out.html)) {
      expect(u.startsWith(`${opts.proxyBase}?url=`)).toBe(true)
      expect(u).toContain('&sig=')
    }
  })

  it.each(VECTORS.filter((v) => v.lane === 'drop'))('$name（删掉的东西点了也不会回来）', (v) => {
    const opts = optsOf(v)
    const out = allow(v.html, opts)
    expect(absoluteUrls(out.html)).toEqual([])
    expect(proxyRefCount(out.html, opts.proxyBase)).toBe(0)
  })
})

// ── 扫描器自检（正向哨兵）───────────────────────────────────────────────
//
// 缺席断言最危险的失效形态是「扫描器自己坏了 ⇒ 恒返回空数组 ⇒ 全表恒绿」。
// 这三条钉住扫描器在每一类载体上都真的看得见 URL。

describe('缺席扫描器本身有电', () => {
  it.each([
    ['属性值', `<img src="${T}/1.png">`],
    ['内联 style', `<div style="background-image:url(${T}/1.png)">x</div>`],
    ['<style> 文本', `<style>.x{background:url(${T}/1.png)}</style>`],
    ['非加载类属性也扫（alt 里塞 URL 一样看得见）', `<img alt="${T}/1.png">`]
  ])('%s 里的绝对 URL 扫得到', (_label, html) => {
    expect(absoluteUrls(html)).toEqual([`${T}/1.png`])
  })

  it.each([
    ['协议相对 //host', '<img src="//tracker.example/1.png">', '//tracker.example/1.png'],
    ['反斜杠 \\\\host', '<img src="\\\\tracker.example/1.png">', '\\\\tracker.example/1.png']
  ])('%s 也算命中（浏览器解析后就是绝对 URL）', (_label, html, expected) => {
    expect(absoluteUrls(html)).toEqual([expected])
  })

  it('绝对 URL 自带的双斜杠不被重复计一次', () => {
    expect(absoluteUrls(`<img src="${T}/1.png">`)).toHaveLength(1)
  })

  it('proxyRefCount 数得准', () => {
    const html = `<img src="${PROXY}?url=a"><div style="background:url(${PROXY}?url=b)">x</div>`
    expect(proxyRefCount(html, PROXY)).toBe(2)
  })
})

// ── 改写动作自己造出来的**相对**请求 ───────────────────────────────────
//
// 🔴 判据 ① 只看绝对 http(s)（含协议相对）URL，看不见「改写把一条远程引用切碎 / 替换成一个
// 会被当作相对 URL 解析的字面量」这类自伤 —— 那两条正是 blocker #3 / #6 的真实形态。
// 它们各自有独立用例钉住：输出里连**残骸**都不该剩。

describe('blocker #3 / #6：改写动作不得凭空造出一条请求', () => {
  const OPTS = { base: BASE, proxyBase: PROXY }
  const CDN = 'https://res.cloudinary.com/demo/image/upload/w_100,h_100/a.png'

  it('#3 带逗号的 CDN URL：拦截态整条 srcset 摘干净，不留被切碎的相对候选', () => {
    const out = block(`<img srcset="${CDN} 2x">`, OPTS)
    const img = new DOMParser().parseFromString(out.html, 'text/html').body.querySelector('img')
    // 按逗号裸切会留下 `h_100/a.png 2x` —— 一条正文里根本不存在的相对请求。
    expect(img?.hasAttribute('srcset')).toBe(false)
    // 换票拿的是**整条** URL，不是被截断的前半段（否则后端为不存在的地址签票，图永远出不来）。
    expect(out.remoteUrls).toEqual([CDN])
  })

  it('#3 放行态：整条 URL 原封不动进代理的 url 参数', () => {
    const out = allow(`<img srcset="${CDN} 2x">`, OPTS)
    const img = new DOMParser().parseFromString(out.html, 'text/html').body.querySelector('img')
    const srcset = img?.getAttribute('srcset') ?? ''
    expect(srcset.endsWith(' 2x')).toBe(true)
    const qs = srcset.slice(srcset.indexOf('?') + 1, srcset.lastIndexOf(' '))
    expect(new URLSearchParams(qs).get('url')).toBe(CDN)
  })

  it.each([
    ['裸字符串', `<style>@import "${T}/i.css";</style>`],
    ['url() 形态', `<style>@import url("${T}/i.css");</style>`],
    ['大写 + 无结尾分号', `<style>@IMPORT '${T}/i.css'</style>`]
  ])('#6 @import（%s）整条删除，不留 `@import none;`', (_label, html) => {
    for (const mode of [block, allow]) {
      const css =
        new DOMParser()
          .parseFromString(mode(html, OPTS).html, 'text/html')
          .body.querySelector('style')?.textContent ?? ''
      // 老写法把 URL 位置换成字面量 none ⇒ `@import none;`，Chromium 当相对 URL 真去取。
      expect(css.toLowerCase()).not.toContain('@import')
      expect(css).not.toContain('none')
    }
  })

  it('#6 @import 删除不伤同一个 <style> 里的其它规则', () => {
    const out = block(`<style>@import "${T}/i.css"; .x{color:red}</style>`, OPTS)
    const css =
      new DOMParser().parseFromString(out.html, 'text/html').body.querySelector('style')
        ?.textContent ?? ''
    expect(css).toContain('.x{color:red}')
  })
})

// ── 白名单与惰性存档 ────────────────────────────────────────────────────

describe('白名单：cid / data: / 附件相对路径逐字未变', () => {
  it.each([
    ['cid:', '<img src="cid:image001.png@01D9ABCD.12345678">'],
    ['data:image', '<img src="data:image/png;base64,iVBORw0KGgo=">'],
    ['附件相对路径', '<img src="attachments/53675/image001.png">'],
    ['CSS 里的 cid:', '<div style="background-image:url(cid:bg@x)">x</div>'],
    ['属性里的附件相对路径', '<table><tr><td background="attachments/1/b.png">y</td></tr></table>']
  ])('%s', (_label, html) => {
    for (const mode of [block, allow]) {
      const out = mode(html, { base: BASE, proxyBase: PROXY })
      expect(out.remoteCount).toBe(0)
      expect(out.remoteUrls).toEqual([])
      // 逐字不变：消毒后的形态与改写后的形态一致（改写这一步一个字都没动）。
      expect(out.html).toBe(sanitizeEmailHtml(html))
    }
  })

  it('纯文本正文（无图）两种模式下都原样返回', () => {
    for (const mode of [block, allow]) {
      const out = mode('<p>没有图片的邮件</p>', { base: BASE, proxyBase: PROXY })
      expect(out.html).toBe('<p>没有图片的邮件</p>')
      expect(out.remoteCount).toBe(0)
    }
  })

  it('🔴 正文里的超链接不受影响（缺席断言不是靠「把绝对 URL 删光」达成的）', () => {
    const html = `<p><a href="${T}/landing?id=1">点这里</a></p>`
    const out = block(html, { base: BASE, proxyBase: PROXY })
    expect(out.remoteCount).toBe(0)
    // href 是点击才走的导航，不是加载源 —— 保留。所以扫描器在这里**必须**看得见它，
    // 向量表的用例才不会因为「什么都被删了」而恒绿。
    expect(absoluteUrls(out.html)).toEqual([`${T}/landing?id=1`])
  })

  it('被拦下的原始 URL 只存在 data-mailagent-remote-src 这一个惰性属性里', () => {
    const out = block(`<img src="${T}/1.png">`, { base: BASE, proxyBase: PROXY })
    const doc = new DOMParser().parseFromString(out.html, 'text/html')
    const img = doc.body.querySelector('img')
    expect(img?.hasAttribute('src')).toBe(false)
    expect(img?.getAttribute(REMOTE_SRC_ATTR)).toBe(`${T}/1.png`)
    // 它是扫描器唯一放过的属性 —— 去掉这个豁免后，全表就只剩它一条命中。
    expect(out.html).toContain(`${REMOTE_SRC_ATTR}="${T}/1.png"`)
  })
})
