// 设置 →「MCP 服务」数据层 —— serve-api `/api/mcp-service/*` 的薄 fetch 面。
//
// 样板 = connector_api.ts：每个方法直接 `request()`，envelope 解包与 `Error & {code}`
// 抛出都在 http_client 一处。🔴 不吞错、不降级返回空 —— 设置页靠 `E_NETWORK` 判断
// serve-api 没在跑，catch 成空数组会把「没在跑」说成「没有密钥」。
//
// baseUrl 与 connector 同源（web = HttpApi baseUrl，electron = loopback serve-api），
// path 不带 `/api` 前缀。
//
// 🔴 不变式：零 Electron import（pnpm build:web 验）。只引 shared/api。

import { request } from './http_client'
import type {
  McpApiKey,
  McpAuditEntry,
  McpExposedTool,
  McpKeyBase,
  McpKeyWithPlaintext,
  McpProbeResult,
  McpScopeOptions,
  McpServiceApi,
  McpServiceStatus
} from './types/mcpService'

const PREFIX = '/mcp-service'

export function createMcpServiceApi(baseUrl: string): McpServiceApi {
  return {
    status(): Promise<McpServiceStatus> {
      return request<McpServiceStatus>(baseUrl, 'GET', `${PREFIX}/status`)
    },

    getScopeOptions(): Promise<McpScopeOptions> {
      return request<McpScopeOptions>(baseUrl, 'GET', `${PREFIX}/scope-options`)
    },

    listKeys(): Promise<McpApiKey[]> {
      return request<{ keys: McpApiKey[] }>(baseUrl, 'GET', `${PREFIX}/keys`).then((d) => d.keys)
    },

    createKey(label: string, base: McpKeyBase, extra: string[]): Promise<McpKeyWithPlaintext> {
      return request<McpKeyWithPlaintext>(baseUrl, 'POST', `${PREFIX}/keys`, {
        body: { label, base, extra }
      })
    },

    updateKeyScopes(id: string, base: McpKeyBase, extra: string[]): Promise<McpApiKey> {
      return request<{ key: McpApiKey }>(
        baseUrl,
        'PATCH',
        `${PREFIX}/keys/${encodeURIComponent(id)}/scopes`,
        { body: { base, extra } }
      ).then((d) => d.key)
    },

    rotateKey(id: string): Promise<McpKeyWithPlaintext> {
      return request<McpKeyWithPlaintext>(
        baseUrl,
        'POST',
        `${PREFIX}/keys/${encodeURIComponent(id)}/rotate`
      )
    },

    revokeKey(id: string): Promise<McpApiKey> {
      return request<{ key: McpApiKey }>(
        baseUrl,
        'POST',
        `${PREFIX}/keys/${encodeURIComponent(id)}/revoke`
      ).then((d) => d.key)
    },

    tools(): Promise<McpExposedTool[]> {
      return request<{ tools: McpExposedTool[] }>(baseUrl, 'GET', `${PREFIX}/tools`).then(
        (d) => d.tools
      )
    },

    audit(limit = 20): Promise<McpAuditEntry[]> {
      return request<{ entries: McpAuditEntry[] }>(baseUrl, 'GET', `${PREFIX}/audit`, {
        query: { limit }
      }).then((d) => d.entries)
    },

    probe(url: string): Promise<McpProbeResult> {
      return request<McpProbeResult>(baseUrl, 'POST', `${PREFIX}/probe`, { body: { url } })
    }
  }
}
