// `libpreview://` —— 资料库 HTML 预览的自定义协议（design §2.6，owner 09-03 拍板「不做脚本限制，
// 就当在浏览器里打开」）。仓里第一个自定义协议。
//
// 为什么不是 srcdoc / blob: / loopback inline：
//   · srcdoc / blob: / data: 按 CSP 规范**继承创建方（renderer）的策略**，而 renderer 的
//     `script-src 'self'` + sha256 意味着内联脚本永不执行（`EmailBodyFrame` 第 416-418 行的
//     结论）；
//   · loopback `/inline` 的请求会被 `chat_local_bridge` 在 webRequest 层注入本机 token ——
//     被预览的 HTML（可能是不可信的邮件附件）就能拿这个 token 打 serve-api。
// 真实协议响应**不继承** renderer 的 CSP，脚本 / 样式照常执行；鉴权在主进程内完成，URL 里没有
// 任何 token；renderer 那侧 iframe 用 `sandbox="allow-scripts allow-popups allow-forms
// allow-modals"`（🔴 绝不加 allow-same-origin），页面拿到的是不透明源。
//
// 已知代价（有意接受，见 design §2.6）：这样渲染的 HTML 可以加载外部资源、发出网络请求。
// 日后要收紧的正确做法是给响应加 `Content-Security-Policy` 头 + 「允许外部内容」开关，
// **而不是**退回无脚本沙箱。

import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { protocol } from 'electron'

import { LIBRARY_PREVIEW_HOST, LIBRARY_PREVIEW_SCHEME } from '@shared/libraryIpcContract'
import { buildLibraryPathContext } from './handlers/library'
import { mimeForPath, resolveVirtualPath } from './library_paths'

/** 🔴 必须在 `app.whenReady()` **之前**调用（Electron 硬约束）。`standard` 让页面里的相对引用
 *  按 URL 规范在同一个根内解析；`secure` 让它享有 https 同等的安全上下文；`stream` 给流式响应。 */
export function registerLibraryPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LIBRARY_PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }
  ])
}

function notFound(): Response {
  return new Response(null, { status: 404 })
}

/** 把 `libpreview://library/<虚拟路径>` 解析成磁盘文件并流式响应。越界 / 不存在 / 目录 / 非常规
 *  文件一律 404（不区分原因 —— 给不可信页面的错误信息越少越好）。 */
export async function handleLibraryPreviewRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  if (url.host !== LIBRARY_PREVIEW_HOST) return notFound()
  let virtual: string
  try {
    virtual = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    return notFound()
  }
  try {
    const { absPath } = await resolveVirtualPath(virtual, await buildLibraryPathContext())
    // resolve → open 之间的 TOCTOU 窗：O_NOFOLLOW 拒 symlink，fstat 复核是常规文件。
    const handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile()) {
      await handle.close()
      return notFound()
    }
    // autoClose：流读完 / 出错时 FileHandle 一并关闭。
    const stream = handle.createReadStream({ autoClose: true })
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'content-type': mimeForPath(absPath),
        'content-length': String(stat.size),
        'cache-control': 'no-store'
      }
    })
  } catch {
    return notFound()
  }
}

/** `app.whenReady()` 之后调用。 */
export function installLibraryPreviewProtocol(): void {
  protocol.handle(LIBRARY_PREVIEW_SCHEME, handleLibraryPreviewRequest)
}
