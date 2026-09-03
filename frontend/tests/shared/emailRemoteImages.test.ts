// @vitest-environment happy-dom
//
// emailRemoteImages — 邮件正文远程图片「默认拦截 / 显式放行」改写的纯函数单测。
// 规则来源: frontend/src/shared/lib/emailRemoteImages.ts 头注释。
//
// 🔴 本文件的重心是 0903 返工批 B1/B3 那批**实测能穿过 DOMPurify 并真发 GET** 的写法:
// srcset / <source srcset> / video poster / [background] / CSS url() / 单斜杠 http:/host。
// 判据一律走 `new URL(value, base)` 归一, 不是字面前缀 —— 每个向量各一条用例。
//
// 🔴 两点时效说明（0903 返工批三）:
//   1. 本文件只跑 `rewriteRemoteImages` 一层, **不经过 DOMPurify**。返工批三把 <video>/<audio>/
//      <track> 移进了 EMAIL_PURIFY_OPTS 的 FORBID_TAGS（减面优先），所以下面 video/<source> 那
//      几条用例在生产里根本走不到消毒之后 —— 它们留着是这一层的 defense in depth（万一消毒配置
//      回退，改写层仍然不放行），不是「这些标签还活着」的证据。
//   2. 判据形态本身（逐属性的存在性断言）只能证明**已知**向量被处理。default-deny 的那张
//      「输出里不存在任何绝对 http(s) URL」向量表在 tests/shared/emailRemoteVectors.test.ts，
//      新向量漏了那边自动红 —— 加新向量请加到那张表，别只在这里补一条属性断言。

import { describe, expect, it } from 'vitest'

import {
  REMOTE_PLACEHOLDER_CLASS,
  REMOTE_SRC_ATTR,
  rewriteRemoteImages
} from '@shared/lib/emailRemoteImages'

const PROXY = 'http://127.0.0.1:8200/api/email/remote-image'
/** 打包态的 base: renderer 从 file:// 加载, srcdoc 继承它。默认用这个基准。 */
const BASE = 'file:///Applications/MailAgent.app/Contents/Resources/index.html'
/** 远程 web 构建的 base: 代理与正文同源, 相对路径也解析成 https。 */
const WEB_BASE = 'https://mail.chenge.ink/app/'
const WEB_PROXY = '/api/email/remote-image'
const LABEL = '已拦截的远程图片'

function block(html: string, base = BASE, proxyBase = PROXY) {
  return rewriteRemoteImages(html, {
    allow: false,
    baseUrl: base,
    proxyBase,
    placeholderLabel: LABEL
  })
}

/** 放行 = 先扫一遍拿 URL 清单 → 换签名 → 带票重写。与 EmailBodyFrame 的真实两趟一致。 */
function allow(html: string, base = BASE, proxyBase = PROXY) {
  const scan = block(html, base, proxyBase)
  const grants = new Map(scan.remoteUrls.map((u) => [u, grantFor(u)]))
  return rewriteRemoteImages(html, {
    allow: true,
    baseUrl: base,
    proxyBase,
    grants,
    placeholderLabel: LABEL
  })
}

function grantFor(url: string): string {
  return `url=${encodeURIComponent(url)}&exp=4102444800&sig=deadbeef`
}

function proxied(url: string, proxyBase = PROXY): string {
  return `${proxyBase}?${grantFor(url)}`
}

/** 解析结果 HTML 取第一个 <img>，方便按属性断言（比对字符串太脆）。 */
function firstImg(html: string): HTMLImageElement {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const img = doc.body.querySelector('img')
  if (!img) throw new Error('no <img> in result')
  return img as HTMLImageElement
}

function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body
}

// ── 默认拦截 ────────────────────────────────────────────────────────────

describe('rewriteRemoteImages — 默认拦截', () => {
  it('摘掉 http/https 图片的 src，原 URL 存进 data 属性并加占位类', () => {
    const out = block('<p>hi</p><img src="https://tracker.example/px.gif?uid=42" alt="promo">')
    expect(out.remoteCount).toBe(1)
    expect(out.remoteUrls).toEqual(['https://tracker.example/px.gif?uid=42'])
    const img = firstImg(out.html)
    // 🔴 必须是「没有 src 属性」而不是 src=""：空串会被解析成文档自身 URL 并真发一次请求。
    expect(img.hasAttribute('src')).toBe(false)
    expect(img.getAttribute(REMOTE_SRC_ATTR)).toBe('https://tracker.example/px.gif?uid=42')
    expect(img.classList.contains(REMOTE_PLACEHOLDER_CLASS)).toBe(true)
    expect(img.getAttribute('aria-label')).toBe(LABEL)
    // 作者自己的 alt 不动。
    expect(img.getAttribute('alt')).toBe('promo')
    // 正文其余部分原样保留。
    expect(out.html).toContain('<p>hi</p>')
  })

  it('协议相对 //host/x 也算远程', () => {
    const out = block('<img src="//cdn.example/a.png">')
    expect(out.remoteCount).toBe(1)
    // 🔴 打包态 base 是 file://，交给 new URL(v, base) 会归成 file://cdn.example/a.png
    // （scheme 不是 http(s) ⇒ 漏判，而 CSP 的 img-src 放行 file:）。按 https 补齐。
    expect(out.remoteUrls).toEqual(['https://cdn.example/a.png'])
    expect(firstImg(out.html).hasAttribute('src')).toBe(false)
  })

  it('多张图片各自计数', () => {
    const out = block(
      '<img src="https://a.example/1.png"><img src="http://b.example/2.png">' +
        '<img src="data:image/png;base64,AAAA">'
    )
    expect(out.remoteCount).toBe(2)
  })

  it('摘掉 img 的 srcset（否则浏览器优先用它，绕过被摘掉的 src）', () => {
    const out = block('<img src="https://a.example/1.png" srcset="https://a.example/2x.png 2x">')
    expect(firstImg(out.html).hasAttribute('srcset')).toBe(false)
  })

  it('摘掉 <picture><source> 的远程 srcset（否则 <img> 的处理被绕过）', () => {
    const out = block(
      '<picture><source srcset="https://a.example/w.webp" type="image/webp">' +
        '<img src="https://a.example/w.png"></picture>'
    )
    expect(parse(out.html).querySelector('source')?.hasAttribute('srcset')).toBe(false)
  })
})

// ── 🔴 B1：字面前缀判据漏掉的向量（逐个实测过能穿 DOMPurify 并真发 GET）──────

describe('rewriteRemoteImages — 归一化判据覆盖全部出网向量', () => {
  // 这些写法过去全部漏判：`isRemote` 只认 img[src] 且字面以 http:// / https:// / // 开头。
  // 值统一用「指向我们自己代理」的形态 —— 正是复核实测出的零点击出网链路。
  const EVIL = `${PROXY}?url=https%3A%2F%2Ftracker.example%2Fp.png`

  it.each([
    ['img[srcset]（src 不是远程时也必须清）', `<img src="cid:local@x" srcset="${EVIL}">`, 'img'],
    ['source[srcset]', `<video><source srcset="${EVIL}"></video>`, 'source'],
    ['video[poster]', `<video poster="${EVIL}"></video>`, 'video'],
    ['[background] 属性', `<table><tr><td background="${EVIL}">x</td></tr></table>`, 'td']
  ])('%s：默认不出网且计数', (_label, html, selector) => {
    const out = block(html)
    expect(out.remoteCount).toBe(1)
    expect(out.remoteUrls).toEqual([EVIL])
    const el = parse(out.html).querySelector(selector)
    expect(el).not.toBeNull()
    // 属性被摘干净：结果 HTML 里一个可加载的代理引用都不剩。
    expect(el?.getAttribute('srcset')).toBeNull()
    expect(el?.getAttribute('poster')).toBeNull()
    expect(el?.getAttribute('background')).toBeNull()
  })

  it('inline style 的 url(...)：默认换成 none 且计数', () => {
    const out = block(`<div style="background-image:url(${EVIL});color:red">x</div>`)
    expect(out.remoteCount).toBe(1)
    const style = parse(out.html).querySelector('div')?.getAttribute('style') ?? ''
    expect(style).not.toContain('remote-image')
    expect(style).toContain('none')
    // 同一条 style 里的其它声明不受影响。
    expect(style).toContain('red')
  })

  it('<style> 块里的 url(...)：默认换成 none 且计数', () => {
    const out = block(`<p>x</p><style>.hero{background-image:url(${EVIL})}</style>`)
    expect(out.remoteCount).toBe(1)
    const css = parse(out.html).querySelector('style')?.textContent ?? ''
    expect(css).not.toContain('remote-image')
    expect(css).toContain('none')
  })

  it('单斜杠 http:/host —— 浏览器会归一成双斜杠，判据必须跟着归一', () => {
    const out = block('<img src="http:/127.0.0.1:8200/api/email/remote-image?url=x">')
    expect(out.remoteCount).toBe(1)
    expect(out.remoteUrls).toEqual(['http://127.0.0.1:8200/api/email/remote-image?url=x'])
    expect(firstImg(out.html).hasAttribute('src')).toBe(false)
  })

  it('🔴 指向我们自己代理的 URL 一律算远程（不因为 host 是 127.0.0.1 就放行）', () => {
    const out = block(`<img src="${PROXY}?url=https%3A%2F%2Ftracker.example%2Fp.png">`)
    expect(out.remoteCount).toBe(1)
    expect(firstImg(out.html).hasAttribute('src')).toBe(false)
  })

  it('🔴 远程 web 构建：同源相对路径指向代理也算远程，同源的其它本地资源不算', () => {
    const out = block(
      `<img src="${WEB_PROXY}?url=https://tracker.example/p.png"><img src="attachments/53675/logo.png">`,
      WEB_BASE,
      WEB_PROXY
    )
    expect(out.remoteCount).toBe(1)
    expect(out.remoteUrls).toEqual([
      'https://mail.chenge.ink/api/email/remote-image?url=https://tracker.example/p.png'
    ])
    const imgs = parse(out.html).querySelectorAll('img')
    expect(imgs[0]?.hasAttribute('src')).toBe(false)
    // 附件相对路径在 web 构建下也解析成 https，但同源 ⇒ 本地资源，逐字不变。
    expect(imgs[1]?.getAttribute('src')).toBe('attachments/53675/logo.png')
  })

  it('提示条能出来：整封信的远程图只在 <source> 里时 remoteCount 也不为 0', () => {
    const out = block('<picture><source srcset="https://cdn.example/w.webp"></picture>')
    expect(out.remoteCount).toBe(1)
  })

  it('<picture> 整组只算一张（多个 source + 回落 img 是同一张图）', () => {
    const out = block(
      '<picture><source srcset="https://cdn.example/w.webp"><source srcset="https://cdn.example/w.avif">' +
        '<img src="https://cdn.example/w.png"></picture>'
    )
    expect(out.remoteCount).toBe(1)
    expect(out.remoteUrls).toHaveLength(3)
  })
})

// ── 🔴 非远程图片一个字不动（cid / 附件相对路径 / data:）─────────────────

describe('rewriteRemoteImages — 非远程图片逐字不变', () => {
  it.each([
    ['cid:', '<img src="cid:image001.png@01D9ABCD.12345678">'],
    ['data: URI（cid 解析后的形态）', '<img src="data:image/png;base64,iVBORw0KGgo=">'],
    ['附件相对路径', '<img src="attachments/53675/image001.png">'],
    ['页内锚点式相对路径', '<img src="./logo.png">']
  ])('%s 不被改写、不计数', (_label, html) => {
    const out = block(html)
    expect(out.remoteCount).toBe(0)
    expect(out.remoteUrls).toEqual([])
    const img = firstImg(out.html)
    expect(img.getAttribute('src')).toBe(firstImg(html).getAttribute('src'))
    expect(img.hasAttribute(REMOTE_SRC_ATTR)).toBe(false)
    expect(img.classList.contains(REMOTE_PLACEHOLDER_CLASS)).toBe(false)
  })

  it('cid: 的 CSS / 属性形态同样不动', () => {
    const html =
      '<div style="background-image:url(cid:bg@x)"></div>' +
      '<table><tr><td background="attachments/1/b.png">y</td></tr></table>'
    const out = block(html)
    expect(out.remoteCount).toBe(0)
    expect(out.html).toContain('url(cid:bg@x)')
    expect(out.html).toContain('background="attachments/1/b.png"')
  })

  it('纯文本正文（无 img）原样返回、计数为 0', () => {
    const out = block('<p>没有图片的邮件</p>')
    expect(out.remoteCount).toBe(0)
    expect(out.html).toBe('<p>没有图片的邮件</p>')
  })

  it('空输入原样返回', () => {
    expect(block('')).toEqual({ html: '', remoteCount: 0, remoteUrls: [] })
  })
})

// ── 占位尺寸推导（目的是不塌版式）───────────────────────────────────────

describe('rewriteRemoteImages — 占位尺寸推导', () => {
  function vars(html: string): { w: string; h: string } {
    const img = firstImg(block(html).html)
    return {
      w: img.style.getPropertyValue('--ma-remote-w').trim(),
      h: img.style.getPropertyValue('--ma-remote-h').trim()
    }
  }

  it('从 width/height 属性推（Outlook 模板的常见形态）', () => {
    expect(vars('<img src="https://a.example/x.png" width="600" height="200">')).toEqual({
      w: '600px',
      h: '200px'
    })
  })

  it('从 inline style 推', () => {
    expect(vars('<img src="https://a.example/x.png" style="width:320px;height:180px">')).toEqual({
      w: '320px',
      h: '180px'
    })
  })

  it('width 收百分比（通栏图仍占满一行）、height 不收（父容器 auto 高会算成 0 塌掉）', () => {
    expect(vars('<img src="https://a.example/x.png" width="100%" height="50%">')).toEqual({
      w: '100%',
      h: '28px'
    })
  })

  it('推不出尺寸时回落固定小占位（两轴都 28px）', () => {
    expect(vars('<img src="https://a.example/x.png">')).toEqual({ w: '28px', h: '28px' })
  })

  it('荒谬 / 非法尺寸按推不出处理', () => {
    expect(vars('<img src="https://a.example/x.png" width="99999" height="auto">')).toEqual({
      w: '28px',
      h: '28px'
    })
    expect(vars('<img src="https://a.example/x.png" width="0" height="-5">')).toEqual({
      w: '28px',
      h: '28px'
    })
  })

  it('1x1 追踪像素保持 1x1（不会被撑成可见方块搞坏排版）', () => {
    expect(vars('<img src="https://t.example/p.gif" width="1" height="1">')).toEqual({
      w: '1px',
      h: '1px'
    })
  })
})

// ── 显式放行 ────────────────────────────────────────────────────────────

describe('rewriteRemoteImages — 放行', () => {
  it('src 改写成走带签名的本机代理，url 参数是 encode 过的原始地址', () => {
    const out = allow('<img src="https://cdn.example/a.png?x=1&amp;y=2">')
    expect(out.remoteCount).toBe(1)
    const src = firstImg(out.html).getAttribute('src') ?? ''
    expect(src.startsWith(`${PROXY}?url=`)).toBe(true)
    // 必须真 encode：`&y=2` 不转义就会被后端当成 remote-image 自己的第二个 query 参数，
    // url 参数在 `&` 处被截断 → 取到半截地址。
    expect(src).toContain('https%3A%2F%2Fcdn.example')
    expect(src).toContain('%26y%3D2')
    // 签名两参必须在 —— 后端不认没签名的请求。
    expect(src).toContain('&exp=')
    expect(src).toContain('&sig=')
    const url = new URLSearchParams(src.slice(src.indexOf('?') + 1)).get('url')
    expect(url).toBe('https://cdn.example/a.png?x=1&y=2')
    // 放行后不留占位痕迹。
    expect(firstImg(out.html).classList.contains(REMOTE_PLACEHOLDER_CLASS)).toBe(false)
  })

  it('协议相对地址补 https: 后再进代理（代理端只收 http/https 绝对地址）', () => {
    const out = allow('<img src="//cdn.example/a.png">')
    expect(firstImg(out.html).getAttribute('src')).toBe(proxied('https://cdn.example/a.png'))
  })

  it('🔴 没换到放行票的 URL 仍按拦截处理（fail-closed，不会裸着发出去）', () => {
    const out = rewriteRemoteImages('<img src="https://cdn.example/a.png">', {
      allow: true,
      baseUrl: BASE,
      proxyBase: PROXY,
      grants: new Map(),
      placeholderLabel: LABEL
    })
    const img = firstImg(out.html)
    expect(img.hasAttribute('src')).toBe(false)
    expect(img.classList.contains(REMOTE_PLACEHOLDER_CLASS)).toBe(true)
  })

  it('🔴 B3 <picture><source srcset> 放行后改写成代理（过去只摘不放 ⇒ 点了也是空的）', () => {
    const out = allow(
      '<picture><source srcset="https://cdn.example/w.webp 2x" type="image/webp">' +
        '<img src="https://cdn.example/w.png"></picture>'
    )
    const body = parse(out.html)
    expect(body.querySelector('source')?.getAttribute('srcset')).toBe(
      `${proxied('https://cdn.example/w.webp')} 2x`
    )
    expect(body.querySelector('img')?.getAttribute('src')).toBe(
      proxied('https://cdn.example/w.png')
    )
  })

  it('img 自己的 srcset 放行后也改写（描述符保留，多候选各自改）', () => {
    const out = allow(
      '<img src="https://a.example/1.png" srcset="https://a.example/1.png 1x, https://a.example/2x.png 2x">'
    )
    expect(firstImg(out.html).getAttribute('srcset')).toBe(
      `${proxied('https://a.example/1.png')} 1x, ${proxied('https://a.example/2x.png')} 2x`
    )
  })

  it('poster / background / CSS url() 放行后同样走代理', () => {
    const out = allow(
      '<video poster="https://a.example/p.jpg"></video>' +
        '<table><tr><td background="https://a.example/b.png">x</td></tr></table>' +
        '<div style="background-image:url(https://a.example/c.png)">y</div>'
    )
    const body = parse(out.html)
    expect(body.querySelector('video')?.getAttribute('poster')).toBe(
      proxied('https://a.example/p.jpg')
    )
    expect(body.querySelector('td')?.getAttribute('background')).toBe(
      proxied('https://a.example/b.png')
    )
    expect(body.querySelector('div')?.getAttribute('style')).toContain(
      `url("${proxied('https://a.example/c.png')}")`
    )
  })

  it('<style> 块里的 url() 放行后也走代理', () => {
    const out = allow('<p>x</p><style>.hero{background-image:url(https://a.example/h.png)}</style>')
    expect(parse(out.html).querySelector('style')?.textContent).toContain(
      `url("${proxied('https://a.example/h.png')}")`
    )
  })

  it('单斜杠形式放行后走的是归一化后的地址（浏览器实际会取的那个）', () => {
    const out = allow('<img src="http:/cdn.example/a.png">')
    expect(firstImg(out.html).getAttribute('src')).toBe(proxied('http://cdn.example/a.png'))
  })

  it('cid / 附件相对路径在放行模式下也一个字不动', () => {
    const out = allow('<img src="cid:img001@x"><img src="attachments/1/a.png">')
    expect(out.remoteCount).toBe(0)
    expect(out.html).toContain('src="cid:img001@x"')
    expect(out.html).toContain('src="attachments/1/a.png"')
  })
})
