// DavMail 认证失效自助重连数据层 —— serve-api `/api/davmail/reauth/*` 的薄 fetch 面。
//
// 样板 = mcp_service_api.ts：每个方法直接 `request()`，envelope 解包与 `Error & {code}`
// 抛出都在 http_client 一处。baseUrl 同 connector（web = HttpApi baseUrl，electron =
// loopback serve-api），path 不带 `/api` 前缀。
//
// 🔴 不变式：零 Electron import（pnpm build:web 验）。只引 shared/api。

import { request } from './http_client'
import type { DavMailApi, DavMailReauthResult, DavMailReauthStart } from './types/davmail'

const PREFIX = '/davmail/reauth'

export function createDavMailApi(baseUrl: string): DavMailApi {
  return {
    startReauth(): Promise<DavMailReauthStart> {
      return request<DavMailReauthStart>(baseUrl, 'POST', `${PREFIX}/start`)
    },

    completeReauth(sessionId: string, callback: string): Promise<DavMailReauthResult> {
      return request<DavMailReauthResult>(baseUrl, 'POST', `${PREFIX}/complete`, {
        body: { session_id: sessionId, callback }
      })
    }
  }
}
