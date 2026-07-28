// V2.1 阶段 3c — 本地 renderer 直连 loopback serve-api 的透明 token + CORS 注入（D-3c-2）。
//
// cutover 后 renderer 进程内跑 chat harness（ChatRuntime → HttpChatPlatform fetch
// 127.0.0.1:8200）。但 renderer：
//   1. 无本地 token —— token 是 main 进程 local_token.ts 的 per-session 单例，
//      renderer 进程拿不到（也不该拿到，留 main 更安全）；
//   2. 打包态是 file:// origin（fetch Origin 头 = 'null'），跨 origin 打 loopback
//      8200 → serve-api CORS 白名单（mail.chenge.ink）不含 'null' → preflight 失败。
//
// 解法：main 进程 webRequest 拦截发往 loopback 8200 的请求，对 renderer 透明：
//   - onBeforeSendHeaders：注入 X-MailAgent-Local-Token（auth.py 本地腿 compare_digest
//     放行本机身份）。dev/打包都注册（dev serve-api 没配 token 时该头被忽略，无害）。
//   - onHeadersReceived：注入 CORS 响应头让 Chromium 放行 file://（Origin: null）跨 origin
//     + OPTIONS preflight。**仅打包态**注册 —— dev renderer = localhost:5173 已在 serve-api
//     _DEV_CORS 白名单（serve-api 自己回正确 ACAO），覆盖反而坏 dev。
//
// 远程 web（mail.chenge.ink/app）不经此（CF cookie + 白名单 origin，不打 loopback）。
// main 进程自己的 daemonRequest（D1 写收编）走 Node fetch（不经 Chromium session
// webRequest）+ 显式加 token，不被本拦截器影响 —— 本拦截器只作用于 renderer 的 fetch。
//
// 🔴 http_client.request() 用 credentials:'include'（CF cookie 场景）→ CORS 规范禁止
//    ACAO='*'，必须 echo 具体 Origin。打包态 renderer 恒 file://（index.ts loadFile），
//    Origin 恒 'null' → ACAO 硬编码 'null'。**改 renderer 加载方式（app:// protocol /
//    loadURL）须同步改此处**。
// 🔴 Starlette CORSMiddleware 对白名单外 origin 的 OPTIONS preflight 返 400「Disallowed
//    CORS origin」→ 改 statusLine 200 让 Chromium 放行（CORS 头已由本拦截器注入；
//    Chromium 要求 preflight 2xx + ACAO 匹配）。

import { is } from '@electron-toolkit/utils'
import { session } from 'electron'

import { DEFAULT_API_PORT } from '@shared/lib/ports'
import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

// serve-api loopback 端口单源自 `@shared/lib/ports`（issue #68 —— 此前这里手抄 8200，
// 注释声称「与 daemon_api / backend_lifecycle 同源」但无任何机制保证）。

/** 发往本机 serve-api 的 URL 过滤器（127.0.0.1 + localhost 两别名，端口可 env 覆盖）。 */
function loopbackFilter(): { urls: string[] } {
  const raw = process.env.MAILAGENT_API_PORT
  const n = raw != null ? Number.parseInt(raw, 10) : NaN
  const port = Number.isFinite(n) && n > 0 ? n : DEFAULT_API_PORT
  return { urls: [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`] }
}

/**
 * 注册 chat 本地桥的 webRequest 拦截器（app.whenReady 后调一次，幂等由 caller 保证）。
 * 给 renderer 发往 loopback serve-api 的请求透明注入本地 token（请求腿）+ CORS 响应头
 * （响应腿，仅打包态）。3c-1 提前铺设；electron chat 切 ChatRuntime（3c-3）后才真正打 8200。
 */
export function registerChatLocalBridge(): void {
  const filter = loopbackFilter()
  const ses = session.defaultSession

  // ── 请求腿：注入本地 token（renderer 进程无此 token，main 单例补）──────────────
  // token 放在展开后覆盖 details 里可能存在的同名 header —— renderer 不持有真 token，
  // 即便伪造一个也以 main 单例为准（防伪造）；其余请求头原样保留。
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        [LOCAL_TOKEN_HEADER]: getLocalApiToken()
      }
    })
  })

  // ── 响应腿：注入 CORS 让 Chromium 放行 file://（Origin null）跨 origin（仅打包态）──
  // dev renderer=localhost:5173 已在 serve-api _DEV_CORS 白名单，不在此覆盖以免坏 dev。
  if (is.dev) return

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers: Record<string, string[]> = { ...details.responseHeaders }
    // 去重：删掉 serve-api 可能已回的 access-control-*（白名单外 origin 通常不回 ACAO，
    // 但 preflight_headers 含 ACAM/ACAH）—— 统一由本拦截器单一来源注入，避免重复头。
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('access-control-')) delete headers[key]
    }
    // credentials:'include' → ACAO 不能 '*'，echo file:// 的固定 Origin 'null'。
    headers['Access-Control-Allow-Origin'] = ['null']
    headers['Access-Control-Allow-Credentials'] = ['true']
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PATCH, DELETE, OPTIONS']
    headers['Access-Control-Allow-Headers'] = ['Content-Type', LOCAL_TOKEN_HEADER]
    // Starlette 对 disallowed origin 的 preflight 返 400 → 改 200（CORS 头已注入）。
    // 仅 OPTIONS + 4xx 时改，不动正常响应的状态行。
    const fixPreflight = details.method === 'OPTIONS' && details.statusCode >= 400
    callback(
      fixPreflight
        ? { responseHeaders: headers, statusLine: 'HTTP/1.1 200 OK' }
        : { responseHeaders: headers }
    )
  })
}
